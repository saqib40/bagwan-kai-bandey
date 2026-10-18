/**
 * Layer 1 — Migration Operations.
 * Implements the 6 MCP tool operations (§8): claim_next_leaf,
 * get_migration_slice, simulate_blast_radius, verify_and_commit_node,
 * and get_migration_audit_trail (checkpoint gate).
 *
 * Hard Rule: Zero mentions of language or framework specifics.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { FalkorClient } from './falkorClient';
import { tarjanScc } from './scc';
import { adapterRegistry } from '../adapters/registry';
import { shimMarkerList, type MigrationPack, type ParsedModule } from '../adapters/types';
import { broadcastLiveEvent } from './telemetry';
import { getPackSnapshots, normalizeSnapshotOutput } from './snapshots';
import { recordStepInManifest } from './manifest';
import { buildRepoExecEnv } from './execEnv';
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

export interface AdvanceEdit {
  path: string;
  content: string;
}

export interface AdvanceResult {
  done: boolean;
  ok?: boolean;
  errors?: string[];
  phase?: Phase;
  targetPaths?: string[];
  pendingCallersCount?: number;
  guidance?: string;
  files?: Array<{ path: string; source: string }>;
  calleeSignatures?: Array<{
    modulePath: string;
    symbolName: string;
    kind: string;
    signature: string;
  }>;
  callerSnippets?: MigrationSlice['callerSnippets'];
  message?: string;
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

    // Persist claimed_phase on target modules as fallback safeguard
    if (targetPaths.length) {
      await this.db.query(Q.SET_CLAIMED_PHASE, { paths: targetPaths, phase });
    }

    // Build human-readable proof via shortestPath
    const proof = await this.buildProof(targetPaths, phase);

    broadcastLiveEvent({
      type: 'claim',
      repoPath: this.repoPath,
      packId: this.pack.id,
      targetPaths,
      phase,
      proof,
    });

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

    const proof = await this.buildProof(targetPaths, phase);

    broadcastLiveEvent({
      type: 'claim',
      repoPath: this.repoPath,
      packId: this.pack.id,
      targetPaths,
      phase,
      proof,
    });

    return {
      phase,
      sccId,
      allClusterPaths: targetPaths,
      targetPaths,
      pendingCallersCount,
      pendingCallerPaths,
      proof,
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
        const fullPath = this.resolveInsideRepo(path);
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
          const callerPath = this.resolveInsideRepo(c.callerPath);
          const callerSource = readFileSync(callerPath, 'utf8');
          const lines = callerSource.split('\n');
          // Extract import lines and usage lines referencing the target module
          const baseName = mp.replace(/.*\//, '').replace(/\.[^/.]+$/, '');
          const snippetLines = lines
            .map((text, index) => ({ line: index + 1, text }))
            .filter(({ text }) => text.includes(baseName) || text.includes(mp))
            .slice(0, 5);
          if (snippetLines.length) {
            callerSnippets.push({
              callerPath: c.callerPath,
              importSnippet: snippetLines.map(({ line, text }) => `${line}: ${text}`).join('\n'),
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

  /**
   * One migration step for an agent.
   * No edits: return the current or next batch.
   * Edits: write those files, verify, restore them on failure, then return the next batch.
   */
  async advance(edits?: AdvanceEdit[], agentSummary = ''): Promise<AdvanceResult> {
    const active = await this.reclaimInProgress();

    if (edits?.length) {
      if (!active) {
        return {
          done: false,
          ok: false,
          errors: ['No batch is claimed. Call advance_migration without edits first.'],
        };
      }
      const expected = [...active.targetPaths].sort();
      const received = edits.map((edit) => edit.path).sort();
      if (expected.length !== received.length || expected.some((path, i) => path !== received[i])) {
        return {
          done: false,
          ok: false,
          phase: active.phase,
          targetPaths: active.targetPaths,
          errors: [`Edits must cover exactly [${expected.join(', ')}].`],
        };
      }

      const previous = new Map<string, string | null>();
      try {
        for (const edit of edits) {
          const abs = this.resolveInsideRepo(edit.path);
          previous.set(abs, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, edit.content, 'utf8');
        }
      } catch (err) {
        this.restoreFiles(previous);
        return {
          done: false,
          ok: false,
          phase: active.phase,
          targetPaths: active.targetPaths,
          errors: [err instanceof Error ? err.message : String(err)],
        };
      }

      const verified = await this.verifyAndCommitNode(active.targetPaths, agentSummary);
      if (!verified.ok) {
        this.restoreFiles(previous);
        await this.db.query(
          `UNWIND $paths AS p
           MATCH (m:Module {path: p})
           SET m.status = 'IN_PROGRESS', m.claimed_phase = $phase`,
          { paths: active.targetPaths, phase: active.phase },
        );
        const work = await this.toWorkItem(active);
        return { ...work, ok: false, errors: verified.errors };
      }
    }

    const claim = edits?.length ? await this.claimNextLeaf() : (active ?? await this.claimNextLeaf());
    const work = await this.toWorkItem(claim);
    return edits?.length ? { ...work, ok: true } : work;
  }

  private async toWorkItem(claim: ClaimResult | null): Promise<AdvanceResult> {
    if (!claim || !claim.targetPaths.length) {
      broadcastLiveEvent({
        type: 'complete',
        repoPath: this.repoPath,
        packId: this.pack.id,
      });
      return { done: true, message: 'No unblocked modules remaining. Migration is complete.' };
    }
    const slice = await this.getMigrationSlice(claim.targetPaths, claim.phase);
    return {
      done: false,
      phase: claim.phase,
      targetPaths: claim.targetPaths,
      pendingCallersCount: claim.pendingCallersCount,
      guidance: slice.guidance,
      files: slice.targetModules.map((mod) => ({ path: mod.path, source: mod.fullSource })),
      calleeSignatures: slice.calleeSignatures.map((sym) => ({
        modulePath: sym.modulePath,
        symbolName: sym.symbolName,
        kind: sym.kind,
        signature: sym.signature,
      })),
      callerSnippets: slice.callerSnippets,
      message: 'Call advance_migration with edits for every targetPath. Do not edit these files with another tool.',
    };
  }

  private resolveInsideRepo(relPath: string): string {
    const root = resolve(this.repoPath);
    const abs = resolve(root, relPath);
    const rel = relative(root, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path escapes the repository: ${relPath}`);
    }
    return abs;
  }

  private restoreFiles(previous: Map<string, string | null>): void {
    for (const [abs, content] of previous) {
      if (content === null) {
        rmSync(abs, { force: true });
      } else {
        writeFileSync(abs, content, 'utf8');
      }
    }
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

    // Gates run against an in-memory overlay of the new imports. Edges are
    // written only after syntax, shim, invariant, and typecheck all pass.
    const phaseRow = await this.db.roQuery<any>(
      `MATCH (m:Module {path: $path}) RETURN m.claimed_phase AS phase`,
      { path: modulePaths[0] },
    );
    const claimedPhase: Phase = (phaseRow[0]?.phase as Phase) ?? 'MIGRATE';
    const preview = await this.previewPendingCallers(parsedModules, modulePaths);
    const pendingCallers = preview.pendingCallers;
    const sccId = preview.sccId;

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
      const trimmedOutput = tscResult.output.split('\n').slice(0, 20).join('\n');
      errors.push(`[Step 3] Typecheck failed:\n${trimmedOutput}`);
      return this.revertAndReturn(modulePaths, errors, 3);
    }

    await this.commitParsedModules(parsedModules);

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

    // ── Update the Git-native migration manifest ──
    try {
      recordStepInManifest(this.repoPath, {
        step: stepNum,
        phase: claimedPhase,
        modules: modulePaths,
        status: newStatus as 'SHIMMED' | 'VERIFIED',
        action: agentSummary || `Committed ${modulePaths.join(', ')} to ${newStatus}`,
        verifiedBy: 'BKB Verification Gate',
        packId: this.pack.id,
        invariants: {
          compilerErrors: 0,
          checkpointTriggered,
        },
      });
    } catch (err) {
      console.error('[bkb] Warning: Failed to update the migration manifest:', err);
    }

    broadcastLiveEvent({
      type: 'verify',
      repoPath: this.repoPath,
      packId: this.pack.id,
      targetPaths: modulePaths,
      status: newStatus,
      step: stepNum,
      phase: claimedPhase,
      agentSummary,
    });

    return {
      ok: true,
      newStatus,
      errors: [],
      step: stepNum,
      checkpointTriggered,
      checkpointResult,
    };
  }

  private async previewPendingCallers(
    parsedModules: ParsedModule[],
    modulePaths: string[],
  ): Promise<{ pendingCallers: number; sccId: number }> {
    const edgeRows = await this.db.roQuery<{ from: string; to: string[] }>(Q.ALL_IMPORT_EDGES);
    const statusRows = await this.db.roQuery<{ path: string; status: string }>(
      `MATCH (m:Module) RETURN m.path AS path, m.status AS status`,
    );
    const adjacency = new Map<string, string[]>();
    for (const row of edgeRows) {
      adjacency.set(row.from, (row.to ?? []).filter(Boolean));
    }
    for (const parsed of parsedModules) {
      adjacency.set(parsed.path, parsed.imports);
    }

    const sccResult = tarjanScc(adjacency);
    const sccId = sccResult.sccOf.get(modulePaths[0]) ?? 0;
    const members = new Set(sccResult.members.get(sccId) ?? modulePaths);
    const legacy = new Set<string>(Q.LEGACY_CALLER_STATUSES);
    const statusOf = new Map(statusRows.map((row) => [row.path, row.status]));
    const callers = new Set<string>();
    for (const [from, tos] of adjacency) {
      if (sccResult.sccOf.get(from) === sccId) continue;
      if (!legacy.has(statusOf.get(from) ?? '')) continue;
      if (tos.some((to) => members.has(to))) callers.add(from);
    }
    return { pendingCallers: callers.size, sccId };
  }

  private async commitParsedModules(parsedModules: ParsedModule[]): Promise<void> {
    for (const parsed of parsedModules) {
      const mp = parsed.path;
      const setsJson = JSON.stringify(parsed.invariantSets);
      await this.db.query(Q.REPLACE_OUTGOING, {
        modulePath: mp,
        currentSetsJson: setsJson,
        shimLineCount: parsed.shimLineCount,
      });

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

      for (const target of parsed.imports) {
        await this.db.query(
          `MATCH (a:Module {path: $fromPath}), (b:Module {path: $toPath})
           MERGE (a)-[:IMPORTS]->(b)`,
          { fromPath: mp, toPath: target },
        );
      }

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

    const edgeRows = await this.db.roQuery<{ from: string; to: string[] }>(Q.ALL_IMPORT_EDGES);
    const adjacency = new Map<string, string[]>();
    for (const row of edgeRows) {
      adjacency.set(row.from, (row.to ?? []).filter(Boolean));
    }
    const sccResult = tarjanScc(adjacency);
    const sccBatch = [...sccResult.sccOf.entries()].map(([path, id]) => ({
      path,
      sccId: id,
      sccSize: sccResult.members.get(id)!.length,
    }));
    if (sccBatch.length) {
      await this.db.query(Q.SET_SCCS, { rows: sccBatch });
    }
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

    // 3. Global snapshot comparison (routes, exports, counts, ...). Skipped when none declared.
    let routeMatch = true;
    const snapshots = getPackSnapshots(this.pack);
    const metaRow = await this.db.roQuery<any>(
      `MATCH (meta:MigrationMeta) RETURN meta.baseline_routes AS baseline, meta.baseline_snapshots AS snapshots LIMIT 1`,
    );
    const legacyBaseline = metaRow[0]?.baseline;
    let baselineMap: Record<string, string> = {};
    try {
      if (metaRow[0]?.snapshots) baselineMap = JSON.parse(metaRow[0].snapshots);
    } catch { /* ignore malformed baseline map */ }

    for (const snap of snapshots) {
      const result = this.runCommand(snap.command);
      if (!result.ok) {
        routeMatch = false;
        errors.push(`Snapshot "${snap.id}" command failed: ${result.output.slice(0, 200)}`);
        continue;
      }
      const current = normalizeSnapshotOutput(snap.kind, result.output);
      const baseline =
        baselineMap[snap.id] ??
        (snap.id === 'route-surface' && legacyBaseline !== undefined
          ? normalizeSnapshotOutput(snap.kind, legacyBaseline)
          : '');
      if (current !== baseline) {
        routeMatch = false;
        errors.push(
          `Snapshot "${snap.id}" mismatch!\n  Baseline: ${baseline}\n  Current:  ${current}`,
        );
      }
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

    broadcastLiveEvent({
      type: 'failure',
      repoPath: this.repoPath,
      packId: this.pack.id,
      targetPaths: modulePaths,
      errors,
      step: failedAtStep,
    });

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
      const env = buildRepoExecEnv(process.env, this.repoPath);
      delete env.NODE_TEST_CONTEXT;
      const output = execSync(cmd, {
        cwd: this.repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.pack.verification.timeoutMs ?? 60_000,
        env,
      });
      return { ok: true, output: output.trim() };
    } catch (err: any) {
      const output = (err.stdout ?? '') + '\n' + (err.stderr ?? '');
      return { ok: false, output: output.trim() };
    }
  }
}
