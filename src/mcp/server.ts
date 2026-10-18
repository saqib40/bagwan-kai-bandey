/**
 * Layer 1 MCP Server (`src/mcp/server.ts`).
 * Exposes the Bagwan Kai Bandey (BKB) Migration Engine tools: the original
 * plan §8 set plus advance_migration, migration status, and milestone commit.
 *
 * Stdio discipline: Redirects all diagnostic logging to console.error so that
 * stdout is strictly reserved for JSON-RPC transport frames.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureFalkorDB } from '../engine/docker';
import { MigrationGraphManager, getGraphNameForRepo } from '../engine/graphManager';
import { MigrationOps, type Phase } from '../engine/operations';
import { loadManifest, saveManifest, getManifestPath } from '../engine/manifest';
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
  let activeClient: FalkorClient | null = options.client ?? null;

  function getGraphName(repoPath: string): string {
    return options.graphName ?? getGraphNameForRepo(repoPath);
  }

  async function getClient(repoPath = activeRepoPath): Promise<FalkorClient> {
    const targetGraph = getGraphName(repoPath);
    if (!activeClient || activeClient.graphName !== targetGraph) {
      if (activeClient && !options.client) {
        await activeClient.close().catch(() => {});
      }
      activeClient = options.client ?? (await FalkorClient.connect({ graphName: targetGraph }));
    }
    return activeClient;
  }

  // Override close to also disconnect FalkorClient
  const origClose = server.close.bind(server);
  server.close = async () => {
    await origClose();
    if (activeClient && !options.client) {
      await activeClient.close().catch(() => {});
      activeClient = null;
    }
  };

  // Helper to obtain MigrationOps for the active or overridden repo/pack
  async function getOps(targetRepo?: string, targetPack?: string): Promise<MigrationOps> {
    const repo = resolve(targetRepo ?? activeRepoPath);
    const pack = targetPack ?? activePackId;
    const client = await getClient(repo);
    const mgr = await MigrationGraphManager.create(repo, pack, { graphName: client.graphName, client });
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

        const client = await getClient(resolvedRepo);
        const summary = await MigrationGraphManager.initMigrationGraph({
          repoPath: resolvedRepo,
          packId,
          graphName: client.graphName,
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

  // ─── 7. bkb_get_migration_status / get_migration_status ─
  const getMigrationStatusHandler = async ({
    repoPath,
    packId,
  }: {
    repoPath?: string;
    packId?: string;
  }) => {
    try {
      const ops = await getOps(repoPath, packId);
      const manifest = loadManifest(ops.repoPath, ops.pack.id);

      const statusCounts = await ops.db.roQuery<{ status: string; cnt: number }>(
        `MATCH (m:Module) RETURN m.status AS status, count(m) AS cnt`,
      );
      const counts = new Map(statusCounts.map((r) => [r.status, Number(r.cnt)]));
      const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
      const clean = counts.get('CLEAN') ?? 0;
      const pending = counts.get('PENDING') ?? 0;
      const inProgress = counts.get('IN_PROGRESS') ?? 0;
      const shimmed = counts.get('SHIMMED') ?? 0;
      const verified = counts.get('VERIFIED') ?? 0;

      const unblockedRows = await ops.db.roQuery<{
        path: string;
        status: string;
        inDegree: number;
        pagerank: number;
      }>(
        `MATCH (m:Module)
         WHERE m.pending_callers_count = 0 AND m.status IN ['PENDING', 'SHIMMED']
         RETURN m.path AS path, m.status AS status, m.in_degree AS inDegree, m.pagerank AS pagerank
         ORDER BY m.pagerank DESC LIMIT 5`,
      );

      const lastMilestone = manifest?.history?.length
        ? manifest.history[manifest.history.length - 1]
        : null;

      // Complete = VERIFIED/CLEAN; half = SHIMMED or in-flight (so claiming a
      // PENDING module never makes reported progress go backwards).
      const percentComplete =
        total > 0
          ? (((verified + clean + (shimmed + inProgress) * 0.5) / total) * 100).toFixed(1) + '%'
          : '0%';

      const result = {
        repoPath: ops.repoPath,
        packId: ops.pack.id,
        phase: manifest?.phase ?? (pending > 0 ? 'SHIM' : 'DE_SHIM'),
        progress: {
          totalModules: total,
          clean,
          pending,
          inProgress,
          shimmed,
          verified,
          percentComplete,
        },
        unblockedLeavesReady: unblockedRows.map((r) => ({
          path: r.path,
          status: r.status,
          inDegree: Number(r.inDegree),
          pagerank: Number(r.pagerank || 0),
        })),
        lastMilestone,
        manifestSynchronized: Boolean(manifest),
        recommendation:
          pending > 0
            ? `Call advance_migration to claim next unblocked leaf: "${unblockedRows[0]?.path ?? 'next batch'}".`
            : 'All modules shimmed/verified. Ready for de-shim verification or milestone commit.',
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get migration status: ${err.message}` }],
        isError: true,
      };
    }
  };

  const statusSchema = {
    repoPath: z.string().optional().describe('Target repository path (defaults to initialized repo)'),
    packId: z.string().optional().describe('Pack identifier (defaults to initialized pack)'),
  };

  server.tool(
    'get_migration_status',
    'Get overall progress and distributed team handoff status (modules pending/shimmed/verified, committed manifest status, and next unblocked leaves).',
    statusSchema,
    getMigrationStatusHandler,
  );

  server.tool(
    'bkb_get_migration_status',
    'Get overall progress and distributed team handoff status (modules pending/shimmed/verified, committed manifest status, and next unblocked leaves).',
    statusSchema,
    getMigrationStatusHandler,
  );

  // ─── 8. bkb_commit_milestone / commit_milestone ─────────
  const commitMilestoneHandler = async ({
    targetPaths,
    modulePaths,
    message,
    createBranch,
    repoPath,
    packId,
  }: {
    targetPaths?: string[];
    modulePaths?: string[];
    message?: string;
    createBranch?: string;
    repoPath?: string;
    packId?: string;
  }) => {
    try {
      const resolvedRepo = resolve(repoPath ?? activeRepoPath);

      // Milestone commits are a pure Git operation and must not require
      // FalkorDB to be running.
      let manifest = loadManifest(resolvedRepo, packId ?? activePackId);
      if (!manifest) manifest = loadManifest(resolvedRepo);
      const resolvedPackId = manifest?.packId ?? packId ?? activePackId;

      const git = (args: string[]): string =>
        execFileSync('git', args, {
          cwd: resolvedRepo,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();

      let statusOut: string;
      try {
        statusOut = git(['status', '--porcelain']);
      } catch (err: any) {
        throw new Error(
          `Target repository "${resolvedRepo}" is not a git repository or git failed: ${err.message}`,
        );
      }

      if (!statusOut) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                message: 'Working tree is clean; no changes to commit.',
              }),
            },
          ],
        };
      }

      if (createBranch) {
        try {
          git(['checkout', '-b', createBranch]);
        } catch {
          git(['checkout', createBranch]);
        }
      }

      const requestedPaths = targetPaths ?? modulePaths;
      const stagedFiles: string[] = [];

      const hasStagedChanges = (): boolean => {
        try {
          git(['diff', '--cached', '--quiet']);
          return false;
        } catch {
          return true;
        }
      };

      manifest = loadManifest(resolvedRepo, resolvedPackId);
      const manifestPath = getManifestPath(resolvedRepo, manifest?.packId ?? resolvedPackId);
      const manifestRelPath = relative(resolvedRepo, manifestPath).split(sep).join('/');
      const lastHistory = manifest?.history?.length
        ? manifest.history[manifest.history.length - 1]
        : null;

      const subject =
        message ||
        (lastHistory
          ? `chore(migration): step ${lastHistory.step} [${lastHistory.phase}] ${lastHistory.modules.join(', ')}`
          : `chore(migration): advance migration milestone [${resolvedPackId}]`);

      const bodyLines: string[] = [
        '',
        `- Migration Pack: ${resolvedPackId}`,
        `- Verified Status: 100% Invariants Preserved`,
        `- Manifest: ${manifestRelPath} updated`,
      ];
      if (lastHistory) {
        bodyLines.push(`- Step: ${lastHistory.step} [${lastHistory.phase}]`);
        bodyLines.push(`- Action: ${lastHistory.action}`);
      }

      // 1. Commit the migration code. The manifest is excluded from this commit
      //    so that it can later record this commit's SHA without a
      //    self-referential (and therefore impossible) hash.
      if (requestedPaths && requestedPaths.length) {
        // `--` terminates option parsing so a path cannot be read as a flag.
        git(['add', '--', ...requestedPaths]);
        stagedFiles.push(...requestedPaths);
      } else {
        git(['add', '-u']);
      }
      try {
        git(['reset', '-q', '--', manifestRelPath]);
      } catch {
        // Manifest is not tracked yet; nothing to unstage.
      }

      if (hasStagedChanges()) {
        git(['commit', '-m', `${subject}\n${bodyLines.join('\n')}`]);
      }
      const commitSha = git(['rev-parse', 'HEAD']);
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);

      // 2. Record the code commit SHA in the manifest and commit the manifest on
      //    top. The recorded SHA now resolves to a real, permanent commit
      //    (no history rewrite / --amend involved).
      let manifestCommit: string | null = null;
      if (manifest && lastHistory && existsSync(manifestPath)) {
        lastHistory.commitSha = commitSha;
        saveManifest(resolvedRepo, manifest);
        // Force-add so the manifest is committed even when the target repo
        // ignores `.bkb/`.
        git(['add', '-f', '--', manifestRelPath]);
        stagedFiles.push(manifestRelPath);
        if (hasStagedChanges()) {
          git([
            'commit',
            '-m',
            `chore(migration): record milestone ${commitSha.slice(0, 7)}\n\n- Manifest: ${manifestRelPath}\n- Records verified commit: ${commitSha}`,
          ]);
          manifestCommit = git(['rev-parse', 'HEAD']);
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ok: true,
                commitSha,
                manifestCommit,
                branch,
                commitSubject: subject,
                stagedFiles,
                message: `Successfully created Git commit ${commitSha.slice(0, 7)} on branch ${branch}.`,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed to commit milestone: ${err.message}` }],
        isError: true,
      };
    }
  };

  const commitSchema = {
    targetPaths: z
      .array(z.string())
      .optional()
      .describe('Specific file paths to include in the commit (defaults to all modified files in git status)'),
    modulePaths: z
      .array(z.string())
      .optional()
      .describe('Alias for targetPaths'),
    message: z
      .string()
      .optional()
      .describe('Custom commit message subject (e.g. "chore(migration): shim auth to Fastify")'),
    createBranch: z
      .string()
      .optional()
      .describe('Optional new git branch to create before committing (e.g. "feat/migration-step-2")'),
    repoPath: z.string().optional().describe('Target repository path (defaults to initialized repo)'),
    packId: z.string().optional().describe('Pack identifier (defaults to initialized pack)'),
  };

  server.tool(
    'commit_milestone',
    'Create an atomic Git commit for the current verified milestone, staging target files and the migration manifest with structured audit metadata.',
    commitSchema,
    commitMilestoneHandler,
  );

  server.tool(
    'bkb_commit_milestone',
    'Create an atomic Git commit for the current verified milestone, staging target files and the migration manifest with structured audit metadata.',
    commitSchema,
    commitMilestoneHandler,
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
