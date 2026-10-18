/**
 * Layer 1 — Migration Graph Manager.
 * Manages the FalkorDB graph state, initial ingest, and invariants.
 *
 * Hard Rule: Zero mentions of language or framework specifics.
 */

import { execSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { FalkorClient } from './falkorClient';
import { tarjanScc } from './scc';
import { loadPack } from './packLoader';
import { buildRepoExecEnv } from './execEnv';
import { adapterRegistry } from '../adapters/registry';
import type { MigrationPack, ParsedModule } from '../adapters/types';
import { broadcastLiveEvent } from './telemetry';
import { getPackSnapshots, normalizeSnapshotOutput } from './snapshots';
import { evaluatePackageDetectors, formatPackageDetectorAdvisories } from './packageDetectors';
import { assertRuntimeInteropSupport } from './runtimePreflight';
import {
  loadManifest,
  initOrUpdateManifest,
  reconcileGraphWithManifest,
  getManifestPath,
} from './manifest';
import * as Q from './queries';

/**
 * Returns an isolated FalkorDB graph name unique to the specified repository.
 * Respects explicit BKB_GRAPH or SHIFT_GRAPH overrides when set.
 */
export function getGraphNameForRepo(repoPath: string): string {
  if (process.env.BKB_GRAPH) return process.env.BKB_GRAPH;
  if (process.env.SHIFT_GRAPH) return process.env.SHIFT_GRAPH;
  const abs = resolve(repoPath);
  const dirName = basename(abs).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8);
  return `bkb_${dirName}_${hash}`;
}

export interface InitGraphOptions {
  repoPath: string;
  packId: string;
  graphName?: string;
  client?: FalkorClient;
  reset?: boolean;
}

export interface GraphSummary {
  repoPath: string;
  packId: string;
  totalModules: number;
  cleanModules: number;
  pendingModules: number;
  shimmedModules?: number;
  verifiedModules?: number;
  baselineRoutesCount: number;
  sccCount: number;
  manifestPath?: string;
}

export class MigrationGraphManager {
  private constructor(
    readonly db: FalkorClient,
    readonly pack: MigrationPack,
    readonly repoPath: string,
  ) {}

  static async create(repoPath: string, packId: string, opts: { graphName?: string; client?: FalkorClient } = {}): Promise<MigrationGraphManager> {
    const absRepoPath = resolve(repoPath);
    const pack = loadPack(packId);
    const client = opts.client ?? (await FalkorClient.connect({ graphName: opts.graphName ?? getGraphNameForRepo(absRepoPath) }));
    return new MigrationGraphManager(client, pack, absRepoPath);
  }

  /**
   * Initializes the migration graph for a repository and migration pack (§8.1).
   */
  static async initMigrationGraph(opts: InitGraphOptions): Promise<GraphSummary> {
    const absRepoPath = resolve(opts.repoPath);
    const pack = loadPack(opts.packId);
    assertRuntimeInteropSupport(pack);
    const adapter = adapterRegistry.get(pack.language);
    await adapter.init();

    // Advisory package preconditions (pure; never mutates the graph).
    for (const line of formatPackageDetectorAdvisories(evaluatePackageDetectors(absRepoPath, pack.packageDetectors))) {
      console.error(`[bkb] ${line}`);
    }

    const ownClient = !opts.client;
    const client = opts.client ?? (await FalkorClient.connect({ graphName: opts.graphName ?? getGraphNameForRepo(absRepoPath) }));

    try {
      if (opts.reset) {
        console.error(`[bkb] Resetting graph "${client.graphName}"...`);
        await client.reset();
      }

      // 1. Ensure indexes
      for (const ix of Q.INDEXES) {
        await client.ensureIndex(ix);
      }

      // 2. Capture baseline snapshots using the pack's declared commands
      const existingManifest = loadManifest(absRepoPath, pack.id);
      const snapshots = getPackSnapshots(pack);
      const baselineSnapshots: Record<string, string> = {};

      const primarySnap =
        snapshots.find((s) => s.id === 'route-surface') ??
        snapshots.find((s) => s.kind === 'set') ??
        snapshots[0];

      const captureSnapshot = (snap: (typeof snapshots)[number]): string => {
        console.error(`[bkb] Capturing baseline snapshot "${snap.id}" via "${snap.command}"...`);
        try {
          const env = buildRepoExecEnv(process.env, absRepoPath);
          const out = execSync(snap.command, {
            cwd: absRepoPath,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: pack.verification.timeoutMs ?? 60_000,
            env,
          });
          return normalizeSnapshotOutput(snap.kind, out);
        } catch (err: any) {
          const raw = (err?.stderr || err?.message || String(err)).toString();
          const detail = raw
            .split('\n')
            .map((l: string) => l.trim())
            .find((l: string) => l.length > 0 && !l.startsWith('Command failed') && !l.startsWith('node:')) || 'command failed';
          console.error(`[bkb] Notice: Optional snapshot "${snap.id}" skipped (${detail})`);
          return normalizeSnapshotOutput(snap.kind, '');
        }
      };

      // If manifest already exists with a baseline and we are not resetting, preserve it
      if (
        existingManifest &&
        existingManifest.packId === pack.id &&
        !opts.reset &&
        existingManifest.baseline?.entries
      ) {
        console.error(
          `[bkb] Reusing committed baseline snapshots from .bkb/manifests/${pack.id}.json (${existingManifest.baseline.entryCount} entries)...`,
        );
        const savedSnapshots = existingManifest.baseline.snapshots ?? {};
        for (const snap of snapshots) {
          if (primarySnap && snap.id === primarySnap.id) {
            baselineSnapshots[snap.id] = JSON.stringify(existingManifest.baseline.entries);
          } else if (typeof savedSnapshots[snap.id] === 'string') {
            baselineSnapshots[snap.id] = savedSnapshots[snap.id];
          } else {
            // Legacy manifest predating multi-snapshot persistence: capture best-effort.
            baselineSnapshots[snap.id] = captureSnapshot(snap);
          }
        }
      } else {
        for (const snap of snapshots) {
          baselineSnapshots[snap.id] = captureSnapshot(snap);
        }
      }
      const baselineSnapshotsJson = JSON.stringify(baselineSnapshots);

      // Backward-compat: expose the primary route/`set` snapshot under `baseline_routes`.
      const legacyRouteSnap =
        snapshots.find((s) => s.id === 'route-surface') ?? snapshots.find((s) => s.kind === 'set');
      const baselineRoutesJson = legacyRouteSnap ? baselineSnapshots[legacyRouteSnap.id] : '[]';

      // Safety check: verify existing graph does not belong to a different repo
      if (!opts.reset) {
        const existingMeta = await client.roQuery<{ repoPath: string }>(
          `MATCH (meta:MigrationMeta) RETURN meta.repo_path AS repoPath LIMIT 1`
        ).catch(() => []);
        if (existingMeta.length > 0 && existingMeta[0].repoPath && resolve(existingMeta[0].repoPath) !== absRepoPath) {
          throw new Error(
            `Graph "${client.graphName}" contains state for "${existingMeta[0].repoPath}", not "${absRepoPath}". Pass --reset or use a distinct graph.`
          );
        }
      }

      // 3. Upsert singleton :MigrationMeta node
      await client.query(
        `MERGE (meta:MigrationMeta {repo_path: $repoPath, pack_id: $packId})
         ON CREATE SET
           meta.baseline_routes = $baselineRoutesJson,
           meta.baseline_snapshots = $baselineSnapshotsJson,
           meta.created_at = timestamp()
         ON MATCH SET meta.updated_at = timestamp()`,
        {
          repoPath: absRepoPath,
          packId: pack.id,
          baselineRoutesJson,
          baselineSnapshotsJson,
        },
      );

      // 4. Upsert :ExternalAPI nodes from pack detection rules
      for (const rule of pack.detectionRules) {
        await client.query(
          `MERGE (api:ExternalAPI {id: $id})
           ON CREATE SET api.role = 'LEGACY', api.description = $description`,
          { id: rule.id, description: rule.description },
        );
      }

      // 5. Scan and parse all source files
      console.error(`[bkb] Scanning source files in "${absRepoPath}"...`);
      const filePaths = await adapter.findSourceFiles(absRepoPath, pack.sourceGlobs);
      console.error(`[bkb] Found ${filePaths.length} source files to parse.`);

      const parsedModules: ParsedModule[] = [];
      const adjacency = new Map<string, string[]>();

      for (const file of filePaths) {
        const parsed = await adapter.parseModule(absRepoPath, file, undefined, pack);
        parsedModules.push(parsed);
        adjacency.set(parsed.path, parsed.imports);
      }

      // 6. Compute Tarjan SCCs
      const sccResult = tarjanScc(adjacency);

      // 7. Insert or update :Module nodes
      for (const mod of parsedModules) {
        const sccId = sccResult.sccOf.get(mod.path) ?? 0;
        const sccSize = sccResult.members.get(sccId)?.length ?? 1;
        const hasLegacy = mod.apiUsages.length > 0;
        const initialStatus = hasLegacy ? 'PENDING' : 'CLEAN';
        const setsJson = JSON.stringify(mod.invariantSets);

        await client.query(
          `MERGE (m:Module {path: $path})
           ON CREATE SET
             m.status = $status,
             m.baseline_sets = $setsJson,
             m.current_sets = $setsJson,
             m.shim_line_count = $shimLineCount,
             m.in_degree = 0,
             m.pending_callers_count = 0,
             m.pagerank = 0.0,
             m.scc_id = $sccId,
             m.scc_size = $sccSize
           ON MATCH SET
             m.current_sets = $setsJson,
             m.shim_line_count = $shimLineCount,
             m.scc_id = $sccId,
             m.scc_size = $sccSize`,
          {
            path: mod.path,
            status: initialStatus,
            setsJson,
            shimLineCount: mod.shimLineCount,
            sccId,
            sccSize,
          },
        );

        // Clean existing outgoing edges for this module
        await client.query(Q.REPLACE_OUTGOING, {
          modulePath: mod.path,
          currentSetsJson: setsJson,
          shimLineCount: mod.shimLineCount,
        });

        // Insert symbols and [:DECLARES]
        for (const sym of mod.symbols) {
          await client.query(
            `MATCH (m:Module {path: $modulePath})
             MERGE (s:Symbol {id: $id})
             SET s.module_path = $modulePath, s.name = $name, s.kind = $kind, s.signature = $signature
             MERGE (m)-[:DECLARES]->(s)`,
            {
              modulePath: mod.path,
              id: sym.id,
              name: sym.name,
              kind: sym.kind,
              signature: sym.signature,
            },
          );
        }

        // Insert [:USES_API] edges
        for (const usage of mod.apiUsages) {
          await client.query(
            `MATCH (m:Module {path: $modulePath}), (api:ExternalAPI {id: $ruleId})
             MERGE (m)-[r:USES_API {line: $line}]->(api)
             SET r.snippet = $snippet, r.is_shimmed = $isShimmed`,
            {
              modulePath: mod.path,
              ruleId: usage.ruleId,
              line: usage.line,
              snippet: usage.snippet,
              isShimmed: usage.isShimmed,
            },
          );
        }
      }

      // 8. Insert [:IMPORTS] edges between modules
      for (const mod of parsedModules) {
        for (const target of mod.imports) {
          await client.query(
            `MATCH (a:Module {path: $fromPath}), (b:Module {path: $toPath})
             MERGE (a)-[:IMPORTS]->(b)`,
            { fromPath: mod.path, toPath: target },
          );
        }
      }

      // 9. Compute PageRank natively in FalkorDB
      try {
        await client.query(Q.PAGERANK);
      } catch (err) {
        console.error('[bkb] Warning: Failed to run FalkorDB algo.pageRank procedure:', err);
      }

      // 10. Recompute global in_degree and pending_callers_count
      await client.query(Q.RECOMPUTE_DEGREES, {
        legacyCallers: [...Q.LEGACY_CALLER_STATUSES],
      });

      // 11. Sync with the Git-native migration manifest
      const baselineEntries =
        primarySnap && baselineSnapshots[primarySnap.id]
          ? (() => {
              try {
                return JSON.parse(baselineSnapshots[primarySnap.id]);
              } catch {
                return [];
              }
            })()
          : [];

      const manifest = initOrUpdateManifest({
        repoPath: absRepoPath,
        packId: pack.id,
        reset: opts.reset,
        baselineSnapshot: {
          snapshotType: primarySnap?.id ?? 'route-surface',
          entryCount: Array.isArray(baselineEntries) ? baselineEntries.length : 0,
          entries: Array.isArray(baselineEntries) ? baselineEntries : [],
          command: primarySnap?.command,
          snapshots: baselineSnapshots,
        },
        modules: parsedModules.map((m) => {
          const sccId = sccResult.sccOf.get(m.path) ?? 0;
          const hasLegacy = m.apiUsages.length > 0;
          return {
            path: m.path,
            status: hasLegacy ? 'PENDING' : 'CLEAN',
            sccId,
            baselineSets: m.invariantSets,
          };
        }),
      });

      // Reconcile FalkorDB node statuses if manifest had previously completed nodes
      if (manifest && !opts.reset) {
        await reconcileGraphWithManifest(client, manifest);
      }

      // Query summary after reconciliation
      const counts = await client.query<{ status: string; n: number }>(Q.STATUS_COUNTS);
      const countMap = new Map(counts.map((r) => [r.status, Number(r.n)]));

      const baselineRoutes = JSON.parse(baselineRoutesJson);

      broadcastLiveEvent({
        type: 'init',
        repoPath: absRepoPath,
        packId: pack.id,
      });

      return {
        repoPath: absRepoPath,
        packId: pack.id,
        totalModules: parsedModules.length,
        cleanModules: countMap.get('CLEAN') ?? 0,
        pendingModules: countMap.get('PENDING') ?? 0,
        shimmedModules: countMap.get('SHIMMED') ?? 0,
        verifiedModules: countMap.get('VERIFIED') ?? 0,
        baselineRoutesCount: baselineRoutes.length,
        sccCount: sccResult.members.size,
        manifestPath: getManifestPath(absRepoPath, pack.id),
      };
    } finally {
      if (ownClient) {
        await client.close();
      }
    }
  }
}
