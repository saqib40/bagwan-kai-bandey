/**
 * Layer 1 — Migration Operations.
 * Implements the 6 MCP tool operations (§8): claim_next_leaf,
 * get_migration_slice, simulate_blast_radius, verify_and_commit_node,
 * and get_migration_audit_trail (checkpoint gate).
 *
 * Hard Rule: Zero mentions of language or framework specifics.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FalkorClient } from './falkorClient';
import { tarjanScc } from './scc';
import { adapterRegistry } from '../adapters/registry';
import { shimMarkerList, type MigrationPack, type ParsedModule } from '../adapters/types';
import * as Q from './queries';

// ─── Result Types ────────────────────────────────────────

export type Phase = 'MIGRATE' | 'SHIM' | 'DE_SHIM';

export interface ClaimResult {
  phase: Phase;
  sccId: number;
  allClusterPaths: string[];
  targetPaths: string[];
  pendingCallersCount: number;
  pendingCallerPaths: string[];
  proof: string;
}

export interface MigrationSlice {
  phase: Phase;
  guidance: string;
  targetModules: Array<{
    path: string;
    fullSource: string;
    baselineSets: Record<string, string[]>;
  }>;
  calleeSignatures: Array<{
    modulePath: string;
    symbolId: string;
    symbolName: string;
    kind: string;
    signature: string;
  }>;
  callerSnippets: Array<{
    callerPath: string;
    importSnippet: string;
  }>;
}

export interface BlastRadiusEntry {
  path: string;
  status: string;
  hops: number;
  pagerank: number;
}

export interface VerifyResult {
  ok: boolean;
  newStatus: string;
  errors: string[];
  step: number;
  checkpointTriggered: boolean;
  checkpointResult?: CheckpointResult;
}

export interface CheckpointResult {
  tscPass: boolean;
  testPass: boolean;
  routeMatch: boolean;
  shimCount: number;
  pendingCount: number;
  shimmedCount: number;
  errors: string[];
}

export interface AuditEntry {
  step: number;
  timestamp: number;
  phase: string;
  modules: string[];
  newStatus: string;
  agentSummary: string;
  evidencePath: string;
}

// ─── Operations Class ────────────────────────────────────

export class MigrationOps {
  constructor(
    readonly db: FalkorClient,
    readonly pack: MigrationPack,
    readonly repoPath: string,
  ) {}

  // ─── claim_next_leaf (§8.2) ────────────────────────────

  async claimNextLeaf(): Promise<ClaimResult | null> {
    const reclaimed = await this.reclaimInProgress();
    if (reclaimed) return reclaimed;

    const params = {
      blocking: [...Q.BLOCKING_STATUSES],
      legacyCallers: [...Q.LEGACY_CALLER_STATUSES],
    };

    // Pass A: De-shim cleanup priority
    let rows = await this.db.query<any>(Q.CLAIM_DESHIM);
    if (!rows.length) {
      // Pass B: Unblocked PENDING leaf / SCC
      rows = await this.db.query<any>(Q.CLAIM_LEAF, params);
    }

    if (!rows.length) return null;

    const c = rows[0];
    const phase = c.phase as Phase;
    const targetPaths: string[] = Array.isArray(c.targetPaths) ? c.targetPaths : [];
    const allClusterPaths: string[] = Array.isArray(c.allClusterPaths) ? c.allClusterPaths : [];
    const pendingCallerPaths: string[] = Array.isArray(c.pendingCallerPaths) ? c.pendingCallerPaths : [];

    // Persist claimed_phase on target modules
    if (targetPaths.length) {
      await this.db.query(Q.SET_CLAIMED_PHASE, { paths: targetPaths, phase });
    }

    // Build human-readable proof via shortestPath
    const proof = await this.buildProof(targetPaths, phase);

    return {
      phase,
      sccId: Number(c.sccId),
      allClusterPaths,
      targetPaths,
      pendingCallersCount: Number(c.pendingCallersCount),
      pendingCallerPaths,
      proof,
    };
  }

  private async reclaimInProgress(): Promise<ClaimResult | null> {
    const rows = await this.db.query<{
      path: string;
      sccId: number;
      phase: string | null;
      pagerank: number;
    }>(Q.RECLAIM_IN_PROGRESS);
    if (!rows.length) return null;

    const sccId = Number(rows[0].sccId);
    const cluster = rows.filter((row) => Number(row.sccId) === sccId);
    const targetPaths = cluster.map((row) => row.path).filter(Boolean);
    if (!targetPaths.length) return null;

    const stored = cluster
      .map((row) => row.phase)
      .find((phase): phase is Phase => phase === 'MIGRATE' || phase === 'SHIM' || phase === 'DE_SHIM');

    const callerInfo = await this.db.roQuery<{ pendingCallers: number; callerPaths: string[] }>(
      Q.SCC_PENDING_CALLERS,
      { sccId, legacyCallers: [...Q.LEGACY_CALLER_STATUSES] },
    );
    const pendingCallerPaths = Array.isArray(callerInfo[0]?.callerPaths) ? callerInfo[0].callerPaths : [];
    const pendingCallersCount = Number(callerInfo[0]?.pendingCallers ?? pendingCallerPaths.length);
    const phase: Phase = stored ?? (pendingCallersCount > 0 ? 'SHIM' : 'MIGRATE');

    if (!stored) {
      await this.db.query(Q.SET_CLAIMED_PHASE, { paths: targetPaths, phase });
    }

    return {
      phase,
      sccId,
      allClusterPaths: targetPaths,
      targetPaths,
      pendingCallersCount,
      pendingCallerPaths,
      proof: await this.buildProof(targetPaths, phase),
    };
  }

  private async buildProof(targetPaths: string[], phase: Phase): Promise<string> {
    const lines: string[] = [`Phase: ${phase}`];

    if (phase === 'DE_SHIM') {
      lines.push(
        `All upstream callers have been migrated. pending_callers_count = 0.`,
        `Target module(s): ${targetPaths.join(', ')}`,
        `Action: Remove all ${shimMarkerList()} lines and legacy fallback branches.`,
      );
      return lines.join('\n');
    }

    // For MIGRATE / SHIM, show the dependency chain from a caller to the target
    for (const target of targetPaths.slice(0, 3)) {
      try {
        // Find who imports the target for context
        const callers = await this.db.roQuery<any>(
          `MATCH (caller:Module)-[:IMPORTS]->(m:Module {path: $path})
           WHERE caller.scc_id <> m.scc_id
           RETURN caller.path AS callerPath, caller.status AS status
           ORDER BY caller.pagerank DESC LIMIT 3`,
          { path: target },
        );
        if (callers.length) {
          const chain = await this.db.roQuery<any>(Q.SHORTEST_PATH, {
            callerPath: callers[0].callerPath,
            calleePath: target,
          });
          if (chain.length && chain[0].dependencyChain) {
            const short = (p: string) => p.replace(/^src\//, '').replace(/\.[^/.]+$/, '');
            lines.push(
              `Dependency proof: ${chain[0].dependencyChain.map(short).join(' → ')}`,
            );
          }
        }
      } catch {
        // shortestPath may fail on edge cases; proof is advisory
      }
    }

    lines.push(`Target module(s): ${targetPaths.join(', ')}`);
    return lines.join('\n');
  }

  // ─── get_migration_slice (§8.3) ────────────────────────

  async getMigrationSlice(modulePaths: string[], phase: Phase): Promise<MigrationSlice> {
    const guidance = this.pack.agentGuidance[phase] ?? '';

    // Full source + baseline_sets for target modules
    const targetModules = await Promise.all(
      modulePaths.map(async (path) => {
        const fullPath = resolve(this.repoPath, path);
        let fullSource: string;
        try {
          fullSource = readFileSync(fullPath, 'utf8');
        } catch {
          fullSource = `// [bkb] File not found: ${path}`;
        }
        const row = await this.db.roQuery<any>(
          `MATCH (m:Module {path: $path}) RETURN m.baseline_sets AS baseline`,
          { path },
        );
        let baselineSets: Record<string, string[]> = {};
        if (row[0]?.baseline) {
          try {
            baselineSets = JSON.parse(row[0].baseline);
          } catch { /* use empty */ }
        }
        return { path, fullSource, baselineSets };
      }),
    );

    // 1-hop downstream: exported symbol signatures from direct callees
    const calleeSignatures: MigrationSlice['calleeSignatures'] = [];
    for (const mp of modulePaths) {
      const syms = await this.db.roQuery<any>(
        `MATCH (m:Module {path: $path})-[:IMPORTS]->(callee:Module)-[:DECLARES]->(s:Symbol)
         RETURN DISTINCT callee.path AS modulePath, s.id AS symbolId, s.name AS symbolName, s.kind AS kind, s.signature AS signature
         ORDER BY callee.path, s.name`,
        { path: mp },
      );
      for (const s of syms) {
        if (!calleeSignatures.some((cs) => cs.symbolId === s.symbolId)) {
          calleeSignatures.push({
            modulePath: s.modulePath,
            symbolId: s.symbolId,
            symbolName: s.symbolName,
            kind: s.kind,
            signature: s.signature,
          });
        }
      }
    }

    // 1-hop upstream: import/usage snippets from direct callers
    const callerSnippets: MigrationSlice['callerSnippets'] = [];
    for (const mp of modulePaths) {
      const callers = await this.db.roQuery<any>(
        `MATCH (caller:Module)-[:IMPORTS]->(m:Module {path: $path})
         WHERE caller.scc_id <> m.scc_id
         RETURN caller.path AS callerPath
         ORDER BY caller.path`,
        { path: mp },
      );
      for (const c of callers) {
        try {
          const callerSource = readFileSync(resolve(this.repoPath, c.callerPath), 'utf8');
          const lines = callerSource.split('\n');
          // Extract import lines and usage lines referencing the target module
          const baseName = mp.replace(/.*\//, '').replace(/\.[^/.]+$/, '');
          const snippetLines = lines
            .filter((l) => l.includes(baseName) || l.includes(mp))
            .slice(0, 5);
          if (snippetLines.length) {
            callerSnippets.push({
              callerPath: c.callerPath,
              importSnippet: snippetLines.join('\n'),
            });
          }
        } catch {
          // File might not exist
        }
      }
    }

    return {
      phase,
      guidance,
      targetModules,
      calleeSignatures,
      callerSnippets,
    };
  }

  // ─── simulate_blast_radius (§8.4) ─────────────────────

  async simulateBlastRadius(modulePath: string): Promise<BlastRadiusEntry[]> {
    const rows = await this.db.roQuery<any>(Q.BLAST_RADIUS, { modulePath });
    return rows.map((r) => ({
      path: r.path,
      status: r.status,
      hops: Number(r.hops),
      pagerank: Number(r.pagerank ?? 0),
    }));
  }

  // ─── verify_and_commit_node (§8.5) ────────────────────

  async verifyAndCommitNode(
    modulePaths: string[],
    agentSummary: string,
  ): Promise<VerifyResult> {
    const errors: string[] = [];
    const adapter = adapterRegistry.get(this.pack.language);
    await adapter.init();

    // ── Step 1: Re-parse modified files + check syntax errors ──

    const parsedModules: ParsedModule[] = [];
    for (const mp of modulePaths) {
      const parsed = await adapter.parseModule(this.repoPath, mp, undefined, this.pack);
      parsedModules.push(parsed);

      // Reject syntax errors
      if (parsed.hasSyntaxError) {
        errors.push(`[Step 1] Syntax error in ${mp}: ${parsed.syntaxErrors.join('; ')}`);
      }
    }

    if (errors.length) {
      return this.revertAndReturn(modulePaths, errors, 1);
    }

    // Replace outgoing edges in FalkorDB only after syntax checks pass
    for (const parsed of parsedModules) {
      const mp = parsed.path;
      const setsJson = JSON.stringify(parsed.invariantSets);
      await this.db.query(Q.REPLACE_OUTGOING, {
        modulePath: mp,
        currentSetsJson: setsJson,
        shimLineCount: parsed.shimLineCount,
      });

      // Re-insert symbols
      for (const sym of parsed.symbols) {
        await this.db.query(
          `MATCH (m:Module {path: $modulePath})
           MERGE (s:Symbol {id: $id})
           SET s.module_path = $modulePath, s.name = $name, s.kind = $kind, s.signature = $signature
           MERGE (m)-[:DECLARES]->(s)`,
          {
            modulePath: mp,
            id: sym.id,
            name: sym.name,
            kind: sym.kind,
            signature: sym.signature,
          },
        );
      }

      // Re-insert import edges
      for (const target of parsed.imports) {
        await this.db.query(
          `MATCH (a:Module {path: $fromPath}), (b:Module {path: $toPath})
           MERGE (a)-[:IMPORTS]->(b)`,
          { fromPath: mp, toPath: target },
        );
      }

      // Re-insert USES_API edges
      for (const usage of parsed.apiUsages) {
        await this.db.query(
          `MATCH (m:Module {path: $modulePath}), (api:ExternalAPI {id: $ruleId})
           MERGE (m)-[r:USES_API {line: $line}]->(api)
           SET r.snippet = $snippet, r.is_shimmed = $isShimmed`,
          {
            modulePath: mp,
            ruleId: usage.ruleId,
            line: usage.line,
            snippet: usage.snippet,
            isShimmed: usage.isShimmed,
          },
        );
      }
    }

    // ── Step 2: Recompute Tarjan SCCs across the graph ──

    const edgeRows = await this.db.roQuery<{ from: string; to: string[] }>(Q.ALL_IMPORT_EDGES);
    const adjacency = new Map<string, string[]>();
    for (const r of edgeRows) {
      adjacency.set(r.from, (r.to ?? []).filter(Boolean));
    }

    const sccResult = tarjanScc(adjacency);
    const sccBatch = [...sccResult.sccOf.entries()].map(([path, sccId]) => ({
      path,
      sccId,
      sccSize: sccResult.members.get(sccId)!.length,
    }));

    if (sccBatch.length) {
      await this.db.query(Q.SET_SCCS, { rows: sccBatch });
    }

    // ── Step 3: Verify Gate & Mutate Status ──

    // 3a. Recompute pending_callers_count for the target SCC
    const targetSccRow = await this.db.roQuery<any>(
      `MATCH (m:Module {path: $path}) RETURN m.scc_id AS sccId`,
      { path: modulePaths[0] },
    );
    const sccId = targetSccRow[0]?.sccId;

    const callerInfo = await this.db.roQuery<any>(Q.SCC_PENDING_CALLERS, {
      sccId,
      legacyCallers: [...Q.LEGACY_CALLER_STATUSES],
    });
    const pendingCallers = Number(callerInfo[0]?.pendingCallers ?? 0);

    // 3b. Get the claimed phase for this module group
    const phaseRow = await this.db.roQuery<any>(
      `MATCH (m:Module {path: $path}) RETURN m.claimed_phase AS phase`,
      { path: modulePaths[0] },
    );
    const claimedPhase: Phase = (phaseRow[0]?.phase as Phase) ?? 'MIGRATE';

    // 3c. Hard Legacy & Shim Gate
    for (const parsed of parsedModules) {
      // Count unshimmed and shimmed legacy usages
      const unshimmed = parsed.apiUsages.filter((u) => !u.isShimmed);
      const shimmed = parsed.apiUsages.filter((u) => u.isShimmed);

      if (pendingCallers === 0 || claimedPhase === 'DE_SHIM') {
        // VERIFIED gate: 0 legacy edges (shimmed or unshimmed), 0 shim_line_count
        if (unshimmed.length > 0) {
          errors.push(
            `[Step 3] ${parsed.path}: Has ${unshimmed.length} unshimmed legacy API usage(s) but pendingCallers=0. All legacy must be removed for VERIFIED status.`,
          );
        }
        if (shimmed.length > 0) {
          errors.push(
            `[Step 3] ${parsed.path}: Has ${shimmed.length} shimmed legacy API usage(s) remaining. Remove all ${shimMarkerList()} lines for VERIFIED status.`,
          );
        }
        if (parsed.shimLineCount > 0) {
          errors.push(
            `[Step 3] ${parsed.path}: ${parsed.shimLineCount} lines still contain ${shimMarkerList()}. Remove all for VERIFIED status.`,
          );
        }
      } else {
        // SHIMMED gate: 0 unshimmed legacy edges
        if (unshimmed.length > 0) {
          errors.push(
            `[Step 3] ${parsed.path}: Has ${unshimmed.length} unshimmed legacy API usage(s). For SHIMMED status, all legacy lines must have ${shimMarkerList()}.`,
          );
        }
      }

      // 3d. Route invariant check (extracted-set-equality)
      const baselineRow = await this.db.roQuery<any>(
        `MATCH (m:Module {path: $path}) RETURN m.baseline_sets AS baseline`,
        { path: parsed.path },
      );
      if (baselineRow[0]?.baseline) {
        try {
          const baseline: Record<string, string[]> = JSON.parse(baselineRow[0].baseline);
          for (const inv of this.pack.invariants) {
            if (inv.scope !== 'per-step') continue;
            const baseSet = baseline[inv.id] ?? [];
            const curSet = parsed.invariantSets[inv.id] ?? [];
            const bStr = JSON.stringify(baseSet);
            const cStr = JSON.stringify(curSet);
            if (bStr !== cStr) {
              errors.push(
                `[Step 3] ${parsed.path}: Invariant "${inv.id}" changed. Baseline=${bStr}, Current=${cStr}`,
              );
            }
          }
        } catch { /* baseline parse failed */ }
      }
    }

    if (errors.length) {
      return this.revertAndReturn(modulePaths, errors, 3);
    }

    // 3e. Run whole-project typecheck
    const tscResult = this.runCommand(this.pack.verification.perStepTypecheckCmd);
    if (!tscResult.ok) {
      errors.push(`[Step 3] Typecheck failed:\n${tscResult.output}`);
      return this.revertAndReturn(modulePaths, errors, 3);
    }

    // 3f. Determine new status
    let newStatus: string;
    if (pendingCallers === 0 || claimedPhase === 'DE_SHIM') {
      newStatus = 'VERIFIED';
    } else {
      // Check if there are any shimmed legacy usages
      const anyShims = parsedModules.some((p) => p.shimLineCount > 0 || p.apiUsages.some((u) => u.isShimmed));
      newStatus = anyShims ? 'SHIMMED' : 'VERIFIED';
    }

    // 3g. Update status on target modules
    for (const mp of modulePaths) {
      await this.db.query(
        `MATCH (m:Module {path: $path})
         SET m.status = $status`,
        { path: mp, status: newStatus },
      );
    }

    // ── Step 4: Global Degree & Unblock Recalculation ──

    await this.db.query(Q.RECOMPUTE_DEGREES, {
      legacyCallers: [...Q.LEGACY_CALLER_STATUSES],
    });

    // Write audit trail episode
    const stepNum = await this.getNextStep();
    await this.db.query(
      `CREATE (e:MigrationEpisode {
         step: $step,
         timestamp: timestamp(),
         phase: $phase,
         modules: $modules,
         new_status: $newStatus,
         evidence_path: $evidence,
         agent_summary: $summary
       })
       WITH e
       UNWIND $modulePaths AS mp
       MATCH (m:Module {path: mp})
       CREATE (e)-[:AFFECTED]->(m)`,
      {
        step: stepNum,
        phase: claimedPhase,
        modules: JSON.stringify(modulePaths),
        newStatus,
        evidence: `SCC ${sccId}, pendingCallers=${pendingCallers}`,
        summary: agentSummary,
        modulePaths,
      },
    );

    // ── Checkpoint Gate Trigger ──

    let checkpointTriggered = false;
    let checkpointResult: CheckpointResult | undefined;

    const shouldCheckpoint = await this.shouldTriggerCheckpoint(modulePaths, sccId, newStatus);
    if (shouldCheckpoint) {
      checkpointTriggered = true;
      checkpointResult = await this.runCheckpointGate();
    }

    return {
      ok: true,
      newStatus,
      errors: [],
      step: stepNum,
      checkpointTriggered,
      checkpointResult,
    };
  }

  // ─── Checkpoint Gate (§4.4) ───────────────────────────

  async runCheckpointGate(): Promise<CheckpointResult> {
    const errors: string[] = [];

    // 1. tsc --noEmit
    const tscResult = this.runCommand(this.pack.verification.perStepTypecheckCmd);
    if (!tscResult.ok) errors.push(`Typecheck failed: ${tscResult.output.slice(0, 500)}`);

    // 2. npm test
    const testResult = this.runCommand(this.pack.verification.checkpointTestCmd);
    if (!testResult.ok) errors.push(`Tests failed: ${testResult.output.slice(0, 500)}`);

    // 3. Route snapshot comparison
    let routeMatch = true;
    const metaRow = await this.db.roQuery<any>(
      `MATCH (meta:MigrationMeta) RETURN meta.baseline_routes AS baseline LIMIT 1`,
    );
    const baselineStr = metaRow[0]?.baseline ?? '[]';

    const routeResult = this.runCommand(this.pack.verification.routeSnapshotCmd);
    if (routeResult.ok) {
      try {
        const currentRoutes = JSON.parse(routeResult.output.trim());
        const currentStr = JSON.stringify(Array.isArray(currentRoutes) ? currentRoutes.sort() : []);
        if (currentStr !== baselineStr) {
          routeMatch = false;
          errors.push(
            `Route mismatch!\n  Baseline: ${baselineStr}\n  Current:  ${currentStr}`,
          );
        }
      } catch (err) {
        routeMatch = false;
        errors.push(`Failed to parse route snapshot output: ${routeResult.output.slice(0, 200)}`);
      }
    } else {
      routeMatch = false;
      errors.push(`Route snapshot command failed: ${routeResult.output.slice(0, 200)}`);
    }

    // 4. Count SHIMMED modules and @bkb-shim markers in source files
    const shimCountRow = await this.db.roQuery<any>(
      `MATCH (m:Module) WHERE m.shim_line_count > 0 RETURN sum(m.shim_line_count) AS totalShims`,
    );
    const shimCount = Number(shimCountRow[0]?.totalShims ?? 0);

    // 5. Status counts
    const counts = await this.db.roQuery<{ status: string; n: number }>(Q.STATUS_COUNTS);
    const countMap = new Map(counts.map((r) => [r.status, Number(r.n)]));
    const pendingCount = countMap.get('PENDING') ?? 0;
    const shimmedCount = countMap.get('SHIMMED') ?? 0;

    return {
      tscPass: tscResult.ok,
      testPass: testResult.ok,
      routeMatch,
      shimCount,
      pendingCount,
      shimmedCount,
      errors,
    };
  }

  // ─── Audit Trail (§8.6) ──────────────────────────────

  async getAuditTrail(runCheckpointNow = false): Promise<{
    episodes: AuditEntry[];
    checkpoint?: CheckpointResult;
  }> {
    const rows = await this.db.roQuery<any>(
      `MATCH (e:MigrationEpisode)
       RETURN e.step AS step, e.timestamp AS timestamp, e.phase AS phase,
              e.modules AS modules, e.new_status AS newStatus,
              e.agent_summary AS agentSummary, e.evidence_path AS evidencePath
       ORDER BY e.step ASC`,
    );

    const episodes: AuditEntry[] = rows.map((r) => ({
      step: Number(r.step),
      timestamp: Number(r.timestamp),
      phase: r.phase,
      modules: JSON.parse(r.modules || '[]'),
      newStatus: r.newStatus,
      agentSummary: r.agentSummary ?? '',
      evidencePath: r.evidencePath ?? '',
    }));

    let checkpoint: CheckpointResult | undefined;
    if (runCheckpointNow) {
      checkpoint = await this.runCheckpointGate();
    }

    return { episodes, checkpoint };
  }

  // ─── Helpers ──────────────────────────────────────────

  private async shouldTriggerCheckpoint(
    modulePaths: string[],
    sccId: number,
    newStatus: string,
  ): Promise<boolean> {
    // Trigger after SCC completes
    if (modulePaths.length > 1) return true;

    // Trigger after a de-shim pass
    const phaseRow = await this.db.roQuery<any>(
      `MATCH (m:Module {path: $path}) RETURN m.claimed_phase AS phase`,
      { path: modulePaths[0] },
    );
    if (phaseRow[0]?.phase === 'DE_SHIM') return true;

    // Trigger when zero PENDING and zero SHIMMED remain
    const counts = await this.db.roQuery<{ status: string; n: number }>(Q.STATUS_COUNTS);
    const countMap = new Map(counts.map((r) => [r.status, Number(r.n)]));
    const pending = countMap.get('PENDING') ?? 0;
    const shimmed = countMap.get('SHIMMED') ?? 0;
    if (pending === 0 && shimmed === 0) return true;

    return false;
  }

  private async getNextStep(): Promise<number> {
    const rows = await this.db.roQuery<any>(
      `MATCH (e:MigrationEpisode) RETURN max(e.step) AS maxStep`,
    );
    return (Number(rows[0]?.maxStep) || 0) + 1;
  }

  private async revertAndReturn(
    modulePaths: string[],
    errors: string[],
    failedAtStep: number,
  ): Promise<VerifyResult> {
    // Revert IN_PROGRESS back to PENDING (or SHIMMED if in DE_SHIM phase)
    for (const mp of modulePaths) {
      const row = await this.db.roQuery<any>(
        `MATCH (m:Module {path: $path}) RETURN m.claimed_phase AS phase`,
        { path: mp },
      );
      const revertStatus = row[0]?.phase === 'DE_SHIM' ? 'SHIMMED' : 'PENDING';
      await this.db.query(
        `MATCH (m:Module {path: $path})
         WHERE m.status = 'IN_PROGRESS'
         SET m.status = $status`,
        { path: mp, status: revertStatus },
      );
    }

    return {
      ok: false,
      newStatus: 'REVERTED',
      errors,
      step: -1,
      checkpointTriggered: false,
    };
  }

  private runCommand(cmd: string): { ok: boolean; output: string } {
    try {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const output = execSync(cmd, {
        cwd: this.repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        env,
      });
      return { ok: true, output: output.trim() };
    } catch (err: any) {
      const output = (err.stdout ?? '') + '\n' + (err.stderr ?? '');
      return { ok: false, output: output.trim() };
    }
  }
}
