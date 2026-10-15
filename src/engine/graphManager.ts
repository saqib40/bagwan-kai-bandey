/**
 * Layer 1 — Migration Graph Manager.
 * Manages the FalkorDB graph state, initial ingest, and invariants.
 *
 * Hard Rule: Zero mentions of language or framework specifics.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { FalkorClient } from './falkorClient';
import { tarjanScc } from './scc';
import { loadPack } from './packLoader';
import { adapterRegistry } from '../adapters/registry';
import type { MigrationPack, ParsedModule } from '../adapters/types';
import * as Q from './queries';

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
  baselineRoutesCount: number;
  sccCount: number;
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
    const client = opts.client ?? (await FalkorClient.connect({ graphName: opts.graphName ?? 'bkb' }));
    return new MigrationGraphManager(client, pack, absRepoPath);
  }

  /**
   * Initializes the migration graph for a repository and migration pack (§8.1).
   */
  static async initMigrationGraph(opts: InitGraphOptions): Promise<GraphSummary> {
    const absRepoPath = resolve(opts.repoPath);
    const pack = loadPack(opts.packId);
    const adapter = adapterRegistry.get(pack.language);
    await adapter.init();

    const ownClient = !opts.client;
    const client = opts.client ?? (await FalkorClient.connect({ graphName: opts.graphName ?? 'bkb' }));

    try {
      if (opts.reset) {
        console.error(`[bkb] Resetting graph "${client.graphName}"...`);
        await client.reset();
      }

      // 1. Ensure indexes
      for (const ix of Q.INDEXES) {
        await client.ensureIndex(ix);
      }

      // 2. Capture baseline route snapshot using pack's command
      console.error(`[bkb] Capturing baseline routes via "${pack.verification.routeSnapshotCmd}"...`);
      let baselineRoutesJson = '[]';
      try {
        const out = execSync(pack.verification.routeSnapshotCmd, {
          cwd: absRepoPath,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        const parsedRoutes = JSON.parse(out);
        baselineRoutesJson = JSON.stringify(Array.isArray(parsedRoutes) ? parsedRoutes.sort() : []);
      } catch (err) {
        console.error('[bkb] Warning: Failed to run routeSnapshotCmd:', err);
      }

      // 3. Upsert singleton :MigrationMeta node
      await client.query(
        `MERGE (meta:MigrationMeta {repo_path: $repoPath, pack_id: $packId})
         ON CREATE SET meta.baseline_routes = $baselineRoutesJson, meta.created_at = timestamp()
         ON MATCH SET meta.updated_at = timestamp()`,
        {
          repoPath: absRepoPath,
          packId: pack.id,
          baselineRoutesJson,
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

      // Query summary
      const counts = await client.query<{ status: string; n: number }>(Q.STATUS_COUNTS);
      const countMap = new Map(counts.map((r) => [r.status, Number(r.n)]));

      const baselineRoutes = JSON.parse(baselineRoutesJson);

      return {
        repoPath: absRepoPath,
        packId: pack.id,
        totalModules: parsedModules.length,
        cleanModules: countMap.get('CLEAN') ?? 0,
        pendingModules: countMap.get('PENDING') ?? 0,
        baselineRoutesCount: baselineRoutes.length,
        sccCount: sccResult.members.size,
      };
    } finally {
      if (ownClient) {
        await client.close();
      }
    }
  }
}
