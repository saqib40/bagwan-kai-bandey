/**
 * Layer 1 MCP Server (`src/mcp/server.ts`).
 * Exposes the 6 Bagwan Kai Bandey (BKB) Migration Engine tools defined in plan §8.
 *
 * Stdio discipline: Redirects all diagnostic logging to console.error so that
 * stdout is strictly reserved for JSON-RPC transport frames.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureFalkorDB } from '../engine/docker';
import { MigrationGraphManager } from '../engine/graphManager';
import { MigrationOps, type Phase } from '../engine/operations';

import { FalkorClient } from '../engine/falkorClient';

export interface BkbServerOptions {
  defaultRepoPath?: string;
  defaultPackId?: string;
  graphName?: string;
  client?: FalkorClient;
}

export type ShiftServerOptions = BkbServerOptions;

export function createBkbMcpServer(options: BkbServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: 'bkb-migration-engine',
      version: '0.2.0',
    },
    {
      instructions: [
        'Prefer advance_migration. Call it with no edits to get the batch. Call it again with edits: [{path, content}] for every targetPath. That writes the files, verifies them, and returns the next batch or the errors. Do not grep, read, or write files with other tools.',
        'claim_next_leaf, get_migration_slice, and verify_and_commit_node remain for a manual loop. claim_next_leaf resumes an in-progress batch.',
        'Call init_migration_graph once. Omit reset unless the graph should be dropped.',
        'Do not call simulate_blast_radius or get_migration_audit_trail inside the edit loop.',
      ].join(' '),
    },
  );

  let activeRepoPath = resolve(options.defaultRepoPath ?? './demo-repo');
  let activePackId = options.defaultPackId ?? 'express-to-fastify';
  const activeGraphName = options.graphName ?? process.env.BKB_GRAPH ?? process.env.SHIFT_GRAPH ?? 'bkb';
  let activeClient: FalkorClient | null = options.client ?? null;

  async function getClient(): Promise<FalkorClient> {
    if (!activeClient) {
      activeClient = await FalkorClient.connect({ graphName: activeGraphName });
    }
    return activeClient;
  }

  // Override close to also disconnect FalkorClient
  const origClose = server.close.bind(server);
  server.close = async () => {
    await origClose();
    if (activeClient) {
      await activeClient.close();
      activeClient = null;
    }
  };

  // Helper to obtain MigrationOps for the active or overridden repo/pack
  async function getOps(targetRepo?: string, targetPack?: string): Promise<MigrationOps> {
    const repo = resolve(targetRepo ?? activeRepoPath);
    const pack = targetPack ?? activePackId;
    const client = await getClient();
    const mgr = await MigrationGraphManager.create(repo, pack, { graphName: activeGraphName, client });
    return new MigrationOps(mgr.db, mgr.pack, mgr.repoPath);
  }

  // ─── 1. init_migration_graph (§8.1) ──────────────────────
  server.tool(
    'init_migration_graph',
    'Initialize the migration graph in FalkorDB for a repository and migration pack, computing PageRank and baseline route invariants.',
    {
      repoPath: z.string().describe('Path to the target repository (relative or absolute)'),
      packId: z.string().describe('Pack identifier (e.g. "express-to-fastify") or path to pack JSON'),
      reset: z.boolean().optional().default(false).describe('Drop the graph before ingest. Default false so a repeated init does not wipe progress.'),
    },
    async ({ repoPath, packId, reset }) => {
      try {
        await ensureFalkorDB();
        const resolvedRepo = resolve(repoPath);
        activeRepoPath = resolvedRepo;
        activePackId = packId;

        const client = await getClient();
        const summary = await MigrationGraphManager.initMigrationGraph({
          repoPath: resolvedRepo,
          packId,
          graphName: activeGraphName,
          client,
          reset: reset ?? false,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  message: 'Migration graph successfully initialized.',
                  summary,
                  nextAction: 'Call advance_migration with no edits to take the first batch.',
                },
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Failed to initialize migration graph: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── 1b. advance_migration (one call per batch) ─────────
  server.tool(
    'advance_migration',
    'Take the current migration batch, or apply full-file edits for that batch and verify them. Prefer this over claim_next_leaf, get_migration_slice, and verify_and_commit_node. Do not read or edit the repository with other tools.',
    {
      edits: z
        .array(
          z.object({
            path: z.string().describe('Repo-relative path from the current batch'),
            content: z.string().describe('Full new file contents'),
          }),
        )
        .optional()
        .describe('Full contents for every file in the current batch. Omit to fetch the batch.'),
      agentSummary: z.string().optional().describe('Audit summary for this batch'),
      repoPath: z.string().optional().describe('Target repository path (defaults to initialized repo)'),
      packId: z.string().optional().describe('Pack identifier (defaults to initialized pack)'),
    },
    async ({ edits, agentSummary, repoPath, packId }) => {
      try {
        const ops = await getOps(repoPath, packId);
        const result = await ops.advance(edits, agentSummary ?? '');
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: result.ok === false,
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Failed to advance migration: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── 2. claim_next_leaf (§8.2) ───────────────────────────
  server.tool(
    'claim_next_leaf',
    'Claim the next unblocked leaf module or atomic cycle (SCC) for migration, prioritizing de-shim cleanup. Returns target paths and phase. Do NOT manually grep or explore the repo—immediately call get_migration_slice with the returned targetPaths to receive the pre-packaged 1-hop slice.',
    {
      repoPath: z.string().optional().describe('Target repository path (defaults to initialized repo)'),
      packId: z.string().optional().describe('Pack identifier (defaults to initialized pack)'),
    },
    async ({ repoPath, packId }) => {
      try {
        const ops = await getOps(repoPath, packId);
        const claim = await ops.claimNextLeaf();

        if (!claim) {
          const counts = await ops.db.roQuery<{ status: string; n: number }>(
            'MATCH (m:Module) RETURN m.status AS status, count(m) AS n',
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    claimed: false,
                    message: 'No unblocked modules remaining to claim. Migration may be complete!',
                    statusCounts: counts,
                  },
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  claimed: true,
                  phase: claim.phase,
                  sccId: claim.sccId,
                  allClusterPaths: claim.allClusterPaths,
                  targetPaths: claim.targetPaths,
                  pendingCallersCount: claim.pendingCallersCount,
                  pendingCallerPaths: claim.pendingCallerPaths,
                  proof: claim.proof,
                  nextAction: `Do NOT explore other files. Call get_migration_slice with modulePaths=${JSON.stringify(claim.targetPaths)} and phase="${claim.phase}" to get the complete disk source and callee/caller context.`,
                },
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Failed to claim next target: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── 3. get_migration_slice (§8.3) ───────────────────────
  server.tool(
    'get_migration_slice',
    'Get the 1-hop context slice for a set of modules: full disk source, callee symbol signatures, caller snippets, and phase guidance. Contains ALL context needed to perform the edit—do NOT read additional files, grep, or crawl directories.',
    {
      modulePaths: z.array(z.string()).describe('Array of relative module paths in the target cluster'),
      phase: z.enum(['MIGRATE', 'SHIM', 'DE_SHIM']).describe('Target migration phase'),
      repoPath: z.string().optional().describe('Target repository path (defaults to initialized repo)'),
      packId: z.string().optional().describe('Pack identifier (defaults to initialized pack)'),
    },
    async ({ modulePaths, phase, repoPath, packId }) => {
      try {
        const ops = await getOps(repoPath, packId);
        const slice = await ops.getMigrationSlice(modulePaths, phase as Phase);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(slice),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Failed to get migration slice: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── 4. simulate_blast_radius (§8.4) ────────────────────
  server.tool(
    'simulate_blast_radius',
    'Simulate the multi-hop upstream impact (blast radius) of changing a module before making edits.',
    {
      modulePath: z.string().describe('Relative path of module to inspect'),
      repoPath: z.string().optional().describe('Target repository path (defaults to initialized repo)'),
      packId: z.string().optional().describe('Pack identifier (defaults to initialized pack)'),
    },
    async ({ modulePath, repoPath, packId }) => {
      try {
        const ops = await getOps(repoPath, packId);
        const blast = await ops.simulateBlastRadius(modulePath);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  targetModule: modulePath,
                  impactedCount: blast.length,
                  impactedModules: blast,
                },
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Failed to simulate blast radius: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── 5. verify_and_commit_node (§8.5) ───────────────────
  server.tool(
    'verify_and_commit_node',
    'Verify migrated module(s) (re-parse, shim gate, route invariant, tsc --noEmit) and only then update FalkorDB edges, SCC, and the audit episode.',
    {
      modulePaths: z.array(z.string()).describe('Array of relative module paths that were modified'),
      agentSummary: z
        .string()
        .optional()
        .describe('Summary of the changes made by the agent for the audit trail'),
      repoPath: z.string().optional().describe('Target repository path (defaults to initialized repo)'),
      packId: z.string().optional().describe('Pack identifier (defaults to initialized pack)'),
    },
    async ({ modulePaths, agentSummary, repoPath, packId }) => {
      try {
        const ops = await getOps(repoPath, packId);
        const result = await ops.verifyAndCommitNode(modulePaths, agentSummary ?? '');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
          isError: !result.ok,
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Failed to verify and commit node: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // ─── 6. get_migration_audit_trail (§8.6) ────────────────
  server.tool(
    'get_migration_audit_trail',
    'Retrieve the complete migration episode audit trail and optionally run the final checkpoint gate.',
    {
      runCheckpointNow: z.boolean().optional().default(false).describe('Whether to run full checkpoint gate (tsc, tests, route diff) now'),
      repoPath: z.string().optional().describe('Target repository path (defaults to initialized repo)'),
      packId: z.string().optional().describe('Pack identifier (defaults to initialized pack)'),
    },
    async ({ runCheckpointNow, repoPath, packId }) => {
      try {
        const ops = await getOps(repoPath, packId);
        const trail = await ops.getAuditTrail(runCheckpointNow);

        let reportMarkdown = `# Bagwan Kai Bandey Migration Audit Trail\n\n`;
        reportMarkdown += `* **Repository:** \`${ops.repoPath}\`\n`;
        reportMarkdown += `* **Migration Pack:** \`${ops.pack.id}\`\n`;
        reportMarkdown += `* **Total Episodes:** ${trail.episodes.length}\n\n`;

        if (trail.checkpoint) {
          const cp = trail.checkpoint;
          reportMarkdown += `## Checkpoint Gate Status\n\n`;
          reportMarkdown += `- **Typecheck (tsc --noEmit):** ${cp.tscPass ? '✅ PASSED' : '❌ FAILED'}\n`;
          reportMarkdown += `- **Integration Tests (npm test):** ${cp.testPass ? '✅ PASSED' : '❌ FAILED'}\n`;
          reportMarkdown += `- **Route Invariant Parity:** ${cp.routeMatch ? '✅ IDENTICAL (100% MATCH)' : '❌ MISMATCH'}\n`;
          reportMarkdown += `- **Remaining Shims:** ${cp.shimCount}\n`;
          reportMarkdown += `- **Pending Modules:** ${cp.pendingCount}\n`;
          reportMarkdown += `- **Shimmed Modules:** ${cp.shimmedCount}\n`;
          if (cp.errors.length) {
            reportMarkdown += `\n**Errors:**\n${cp.errors.map((e) => `- ${e}`).join('\n')}\n`;
          }
          reportMarkdown += `\n`;
        }

        reportMarkdown += `## Migration Episodes\n\n`;
        if (trail.episodes.length === 0) {
          reportMarkdown += `*No migration episodes recorded yet.*\n`;
        } else {
          for (const ep of trail.episodes) {
            const dateStr = new Date(ep.timestamp).toISOString();
            reportMarkdown += `### Step ${ep.step}: [${ep.phase}] → \`${ep.newStatus}\`\n`;
            reportMarkdown += `- **Timestamp:** ${dateStr}\n`;
            reportMarkdown += `- **Modules:** ${ep.modules.map((m) => `\`${m}\``).join(', ')}\n`;
            reportMarkdown += `- **Evidence:** ${ep.evidencePath}\n`;
            reportMarkdown += `- **Summary:** ${ep.agentSummary}\n\n`;
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  totalEpisodes: trail.episodes.length,
                  checkpoint: trail.checkpoint,
                  episodes: trail.episodes,
                  reportMarkdown,
                },
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Failed to retrieve audit trail: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

export const createShiftMcpServer = createBkbMcpServer;

export async function startMcpServer(options: BkbServerOptions = {}): Promise<void> {
  const mcpServer = createBkbMcpServer(options);
  const transport = new StdioServerTransport();
  console.error('[bkb] Starting BKB MCP server over stdio transport...');
  await mcpServer.connect(transport);
  console.error('[bkb] BKB MCP server running and listening for requests.');
}

// Auto-start if executed directly as entrypoint
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer().catch((err) => {
    console.error('[bkb] Fatal server error:', err);
    process.exit(1);
  });
}
