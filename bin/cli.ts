#!/usr/bin/env node
/**
 * Bagwan Kai Bandey (BKB) CLI & Bootstrapper (`bin/cli.ts`).
 * Stdio discipline: all logging goes to console.error so stdout remains clean
 * for MCP JSON-RPC protocol frames when the MCP server runs.
 */

import { resolve, join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { ensureFalkorDB } from '../src/engine/docker';
import { MigrationGraphManager } from '../src/engine/graphManager';
import { MigrationOps } from '../src/engine/operations';
import { startMcpServer } from '../src/mcp/server';
import { adapterRegistry } from '../src/adapters/registry';
import { loadConfig, type BkbConfig } from '../src/engine/config';
import { validatePack, loadPack, registerPackDir } from '../src/engine/packLoader';
import { validatePackQueries } from '../src/engine/packSemantics';
import { runDiagnostics, formatDoctorReport } from '../src/cli/doctor';
import { installMcpConfig, formatMcpInstallReport, type McpTarget } from '../src/cli/mcpInstaller';
import { runInteractiveInit } from '../src/cli/wizard';
import { buildPackTemplate } from '../src/cli/packScaffold';
import { runAutonomousMigration } from '../src/runner/autonomousRunner';
import { rollbackToCheckpoint, listCheckpoints } from '../src/runner/rollback';
import { loadManifest } from '../src/engine/manifest';

function printHelp() {
  console.error(`
Bagwan Kai Bandey (bkb): Graph-Governed Codebase Migration Engine (Powered by FalkorDB)

Usage:
  bkb doctor [--repo <path>]
  bkb mcp install [cursor|claude|vscode|windsurf|opencode|all]
  bkb init [--interactive] [--repo <path>] [--pack <id>] [--reset] [--adapter <path>]
  bkb status [--repo <path>] [--pack <id>] [--json]
  bkb run [--repo <path>] [--pack <id>] [--provider <p>] [--model <m>] [--dry-run] [--no-rollback]
  bkb rollback [step] [--repo <path>] [--pack <id>] [--list]
  bkb claim --repo <path> --pack <id>
  bkb slice --repo <path> --pack <id> --module <path> --phase <MIGRATE|SHIM|DE_SHIM>
  bkb blast-radius --repo <path> --pack <id> --module <path>
  bkb verify --repo <path> --pack <id> --module <path> [--summary <text>]
  bkb audit --repo <path> --pack <id> [--checkpoint]
  bkb serve [--repo <path>] [--pack <id>]
  bkb cockpit [--port <port>] [--repo <path>] [--pack <id>]
  bkb pack init <pack-id> [--lang <language>]
  bkb pack validate <path>
  bkb adapter init <language>
  bkb --help

Commands:
  doctor         Run pre-flight environment diagnostics (Node, Docker, FalkorDB, Git)
  mcp install    1-Click install BKB MCP server config into Cursor, Claude, VS Code, Windsurf, or OpenCode
  init           Initialize the migration graph in FalkorDB (interactive wizard if -i)
  status         Show current migration progress, unblocked leaves, and Git manifest sync
  run, auto      Autonomously execute the migration loop (claim -> slice -> transform -> verify)
  cockpit, ui    Start the live visual migration flight deck (browser GUI with real-time SSE sync)
  rollback       Rollback source files and FalkorDB graph to a previous checkpoint (or latest)
  claim          Claim the next unblocked leaf / SCC for migration
  slice          Get the migration slice (source, 1-hop context) for claimed modules
  blast-radius   Simulate the blast radius of changing a module
  verify         Re-parse, gate-check, and commit a migrated module
  audit          Show the full migration audit trail
  serve          Start the Model Context Protocol (MCP) server (stdio transport)
  pack init      Scaffold a new Migration Pack starter template
  pack validate  Validate a Migration Pack schema and detection rules
  adapter init   Scaffold a starter Language Adapter template
  --help         Show this help message

Options:
  --interactive, -i  Run interactive setup wizard for bkb init
  --repo <path>      Path to target repository (default: ./demo-repo)
  --pack <id>        Migration pack id or path (default: express-to-fastify)
  --provider <p>     LLM provider for run: mock (default / zero-cost), opencode, ollama, openai, anthropic
  --model <id>       Model identifier (e.g. deepseek-v4.1-flash-free, gpt-4o, qwen2.5-coder:latest)
  --dry-run          Run autonomous migration using deterministic mock transforms (zero API cost)
  --list             List available checkpoints for bkb rollback
  --no-rollback      Disable automatic rollback on unrecoverable step failure
  --max-steps <num>  Maximum number of migration steps to run (default: 50)
  --adapter <path>   Path to custom Language Adapter (.ts / .js) to inject
  --pack-dir <path>  Additional directory to search for migration packs
  --module <path>    Relative path to target module (can be repeated)
  --phase <phase>    Migration phase: MIGRATE, SHIM, or DE_SHIM
  --summary <text>   Agent summary for audit trail (default: "CLI verify")
  --checkpoint       Run full checkpoint gate during audit
  --reset            Drop and recreate graph before ingest
  --port <port>      Port for Migration Cockpit web server (default: 4200)
  --json             Output machine-readable JSON for status
  --no-ui            Disable auto-launching Migration Cockpit web server during run
  --wait             Keep Migration Cockpit web server running after run completes
`);
}

function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const multiFlags: Record<string, string[]> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--interactive' || arg === '-i') {
      flags.interactive = true;
    } else if (
      arg === '--reset' ||
      arg === '--checkpoint' ||
      arg === '--dry-run' ||
      arg === '--list' ||
      arg === '--json' ||
      arg === '--no-rollback'
    ) {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        // Support repeated --module flags
        if (key === 'module') {
          multiFlags.module = multiFlags.module ?? [];
          multiFlags.module.push(next);
        }
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command: positional[0] ?? 'help', subCommand: positional[1], arg: positional[2], positional, flags, multiFlags };
}

let activeConfig: BkbConfig | null = null;

function resolveTargetRepo(cliRepoFlag?: string | boolean): string {
  if (typeof cliRepoFlag === 'string' && cliRepoFlag.trim()) {
    return resolve(cliRepoFlag);
  }
  if (activeConfig?.defaultRepo) {
    return resolve(activeConfig.defaultRepo);
  }
  const localDemoRepo = resolve(process.cwd(), 'demo-repo');
  if (existsSync(localDemoRepo) && statSync(localDemoRepo).isDirectory()) {
    return localDemoRepo;
  }
  return process.cwd();
}

async function createOps(flags: Record<string, string | boolean>): Promise<MigrationOps> {
  const repoPath = resolveTargetRepo(flags.repo);
  const packId = String(flags.pack ?? activeConfig?.defaultPack ?? 'express-to-fastify');
  const graphName = typeof flags.graph === 'string' ? flags.graph : activeConfig?.falkor?.graphName;
  const mgr = await MigrationGraphManager.create(repoPath, packId, { graphName });
  return new MigrationOps(mgr.db, mgr.pack, mgr.repoPath);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const { command, subCommand, positional, flags, multiFlags } = parsed;

  if (flags.help || command === 'help') {
    printHelp();
    process.exit(0);
  }

  // 1. Load project config if present (e.g. bkb.config.ts or shift.config.ts)
  try {
    const targetDir = typeof flags.repo === 'string' ? resolve(String(flags.repo)) : process.cwd();
    activeConfig = await loadConfig(targetDir);
  } catch (err) {
    console.error('[bkb] Warning: Failed to load config:', err);
  }

  // 1.5. Register custom pack directory if passed via --pack-dir
  if (flags['pack-dir'] || flags.packDir) {
    const customPackDir = resolve(String(flags['pack-dir'] || flags.packDir));
    registerPackDir(customPackDir);
  }

  // 2. Register custom adapter if passed via --adapter
  if (flags.adapter) {
    const adapterPath = resolve(String(flags.adapter));
    console.error(`[bkb] Injecting custom language adapter from "${adapterPath}"...`);
    await adapterRegistry.registerFromPath(adapterPath);
  }

  // 3. Handle standalone developer scaffolding commands (does not require FalkorDB)
  if (command === 'pack') {
    if (subCommand === 'init') {
      const packId = positional[2] ?? 'my-custom-pack';
      const lang = String(flags.lang ?? 'typescript');
      const packsDir = resolve(process.cwd(), 'packs');
      if (!existsSync(packsDir)) mkdirSync(packsDir, { recursive: true });

      const targetPath = join(packsDir, `${packId}.json`);
      const template = buildPackTemplate(packId, lang);

      writeFileSync(targetPath, JSON.stringify(template, null, 2) + '\n');
      console.error(`[bkb] Successfully scaffolded new Migration Pack at: ${targetPath}`);
      process.exit(0);
    }

    if (subCommand === 'validate') {
      const packPath = positional[2];
      if (!packPath) {
        console.error('[bkb] Error: Path to pack is required (e.g. `bkb pack validate ./packs/my-pack.json`)');
        process.exit(1);
      }
      try {
        const pack = loadPack(packPath);
        const res = validatePack(pack);
        const queries = res.valid
          ? await validatePackQueries(pack, adapterRegistry)
          : { valid: true, errors: [] as string[], warnings: [] as string[] };
        const errors = [...res.errors, ...queries.errors];

        if (errors.length === 0) {
          console.error(`[bkb] ✅ Pack "${pack.id}" is valid and ready for use!`);
          console.error(`  - Language:        ${pack.language}`);
          console.error(`  - Detection Rules: ${pack.detectionRules.length}`);
          console.error(`  - Invariants:      ${pack.invariants?.length ?? 0}`);
          console.error(`  - Verification:    ${pack.verification.perStepTypecheckCmd}`);
          queries.warnings.forEach((w) => console.error(`  ⚠ ${w}`));
          process.exit(0);
        } else {
          console.error(`[bkb] ❌ Validation failed with ${errors.length} error(s):`);
          errors.forEach((e) => console.error(`  - ${e}`));
          queries.warnings.forEach((w) => console.error(`  ⚠ ${w}`));
          process.exit(1);
        }
      } catch (err: any) {
        console.error(`[bkb] ❌ Failed to validate pack:`, err.message);
        process.exit(1);
      }
    }
  }

  if (command === 'adapter' && subCommand === 'init') {
    const lang = positional[2] ?? 'python';
    const adaptersDir = resolve(process.cwd(), 'adapters');
    if (!existsSync(adaptersDir)) mkdirSync(adaptersDir, { recursive: true });

    const targetPath = join(adaptersDir, `${lang}Adapter.ts`);
    const template = `import { BaseLanguageAdapter, type ParsedModule, type MigrationPack } from 'bagwan-kai-bandey';

export class ${lang.charAt(0).toUpperCase() + lang.slice(1)}Adapter extends BaseLanguageAdapter {
  readonly language = '${lang.toLowerCase()}';

  async parseModule(
    repoRoot: string,
    relativePath: string,
    sourceCode?: string,
    pack?: MigrationPack,
  ): Promise<ParsedModule> {
    const fullSource = sourceCode ?? await this.readSource(repoRoot, relativePath);
    
    // Extract imports and symbols using regex or language parser
    const imports: string[] = [];
    const symbols = [];

    return this.createParsedModule({
      path: relativePath,
      fullSource,
      imports,
      symbols,
    });
  }
}

export default ${lang.charAt(0).toUpperCase() + lang.slice(1)}Adapter;
`;

    writeFileSync(targetPath, template);
    console.error(`[bkb] Successfully scaffolded new Language Adapter at: ${targetPath}`);
    process.exit(0);
  }

  // Doctor diagnostics command (does not require FalkorDB to be running)
  if (command === 'doctor') {
    const repoPath = flags.repo ? resolve(String(flags.repo)) : process.cwd();
    const report = await runDiagnostics(repoPath);
    console.error(formatDoctorReport(report));
    process.exit(report.ok ? 0 : 1);
  }

  // 1-Click MCP installer command (does not require FalkorDB)
  if (command === 'mcp') {
    if (subCommand === 'install' || !subCommand) {
      const target = (positional[2] ?? flags.target ?? 'all') as McpTarget;
      const repo = flags.repo ? String(flags.repo) : undefined;
      const pack = flags.pack ? String(flags.pack) : undefined;
      const results = await installMcpConfig(target, { repoPath: repo, packId: pack });
      console.error(formatMcpInstallReport(results));
      const hasSuccess = results.some((r) => r.status === 'created' || r.status === 'updated' || r.status === 'already_configured');
      process.exit(hasSuccess ? 0 : 1);
    }
    console.error(`[bkb] Unknown mcp subcommand "${subCommand}". Usage: bkb mcp install [cursor|claude|vscode|windsurf|opencode|all]`);
    process.exit(1);
  }

  if (command === 'init') {
    let repoPath = flags.repo ? String(flags.repo) : undefined;
    let packId = flags.pack ? String(flags.pack) : undefined;
    let reset = flags.reset !== undefined ? Boolean(flags.reset) : undefined;

    if (flags.interactive || (!flags.repo && !flags.pack && process.stdin.isTTY && flags.reset === undefined)) {
      const wizardRes = await runInteractiveInit(repoPath ?? resolveTargetRepo());
      repoPath = wizardRes.repoPath;
      packId = wizardRes.packId;
      reset = wizardRes.reset;
    } else {
      repoPath = repoPath ?? resolveTargetRepo();
      packId = packId ?? activeConfig?.defaultPack ?? 'express-to-fastify';
      reset = reset ?? false;
    }

    const absRepoPath = resolve(repoPath);

    // Ensure FalkorDB container is up and healthy
    try {
      await ensureFalkorDB();
    } catch (err) {
      console.error('[bkb] Fatal: FalkorDB bootstrap failed:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    console.error(`[bkb] Initializing migration graph for "${absRepoPath}" with pack "${packId}" (reset=${reset})...`);
    try {
      const summary = await MigrationGraphManager.initMigrationGraph({
        repoPath: absRepoPath,
        packId,
        reset,
      });

      console.error('\n--- Graph Initialization Complete ---');
      console.error(`Repository:       ${summary.repoPath}`);
      console.error(`Migration Pack:   ${summary.packId}`);
      console.error(`Total Modules:    ${summary.totalModules}`);
      console.error(`  - Clean:        ${summary.cleanModules}`);
      console.error(`  - Pending:      ${summary.pendingModules}`);
      console.error(`Baseline Routes:  ${summary.baselineRoutesCount}`);
      console.error(`Tarjan SCCs:      ${summary.sccCount}`);
      console.error('FalkorDB UI:      http://localhost:3000\n');
      process.exit(0);
    } catch (err) {
      console.error('[bkb] Failed to initialize migration graph:', err);
      process.exit(1);
    }
  }

  if (command === 'status') {
    const repoPath = resolveTargetRepo(flags.repo);
    const packId = String(flags.pack ?? activeConfig?.defaultPack ?? 'express-to-fastify');
    const isJson = Boolean(flags.json);

    const manifest = loadManifest(repoPath, packId);

    // Attempt to query FalkorDB if running, but do not crash if offline
    let falkorStats: {
      total: number;
      clean: number;
      pending: number;
      inProgress: number;
      shimmed: number;
      verified: number;
      unblocked: Array<{ path: string; status: string; inDegree: number; pagerank: number }>;
    } | null = null;

    try {
      await ensureFalkorDB();
      const ops = await createOps(flags);
      const statusCounts = await ops.db.roQuery<{ status: string; cnt: number }>(
        'MATCH (m:Module) RETURN m.status AS status, count(m) AS cnt',
      );
      const counts = new Map(statusCounts.map((r) => [r.status, Number(r.cnt)]));
      const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);

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

      falkorStats = {
        total,
        clean: counts.get('CLEAN') ?? 0,
        pending: counts.get('PENDING') ?? 0,
        inProgress: counts.get('IN_PROGRESS') ?? 0,
        shimmed: counts.get('SHIMMED') ?? 0,
        verified: counts.get('VERIFIED') ?? 0,
        unblocked: unblockedRows.map((r) => ({
          path: r.path,
          status: r.status,
          inDegree: Number(r.inDegree),
          pagerank: Number(r.pagerank || 0),
        })),
      };
      await ops.db.close();
    } catch {
      // FalkorDB offline or not initialized yet - fall back to manifest data
    }

    // Derive numbers from FalkorDB if available, otherwise from manifest
    let total = 0;
    let clean = 0;
    let pending = 0;
    let inProgress = 0;
    let shimmed = 0;
    let verified = 0;

    if (falkorStats && falkorStats.total > 0) {
      total = falkorStats.total;
      clean = falkorStats.clean;
      pending = falkorStats.pending;
      inProgress = falkorStats.inProgress;
      shimmed = falkorStats.shimmed;
      verified = falkorStats.verified;
    } else if (manifest) {
      const modValues = Object.values(manifest.modules);
      total = modValues.length;
      clean = modValues.filter((m) => m.status === 'CLEAN').length;
      pending = modValues.filter((m) => m.status === 'PENDING').length;
      inProgress = modValues.filter((m) => m.status === 'CLAIMED').length;
      shimmed = modValues.filter((m) => m.status === 'SHIMMED').length;
      verified = modValues.filter((m) => m.status === 'VERIFIED').length;
    }

    // Complete = VERIFIED/CLEAN; half = SHIMMED or in-flight (so claiming a
    // PENDING module never makes reported progress go backwards).
    const percentVal = total > 0 ? ((verified + clean + (shimmed + inProgress) * 0.5) / total) * 100 : 0;
    const percentStr = percentVal.toFixed(1) + '%';

    const lastMilestone = manifest?.history?.length
      ? manifest.history[manifest.history.length - 1]
      : null;

    const statusObj = {
      repoPath,
      packId: manifest?.packId ?? packId,
      phase: manifest?.phase ?? (pending > 0 ? 'SHIM' : 'DE_SHIM'),
      progress: {
        totalModules: total,
        clean,
        pending,
        inProgress,
        shimmed,
        verified,
        percentComplete: percentStr,
      },
      baseline: manifest?.baseline
        ? {
            snapshotType: manifest.baseline.snapshotType,
            entryCount: manifest.baseline.entryCount,
          }
        : null,
      unblockedLeavesReady: falkorStats?.unblocked ?? [],
      lastMilestone,
      manifestSynchronized: Boolean(manifest),
      falkorDbOnline: Boolean(falkorStats),
    };

    if (isJson) {
      console.log(JSON.stringify(statusObj, null, 2));
      process.exit(0);
    }

    const barWidth = 20;
    const filled = Math.round((percentVal / 100) * barWidth);
    const bar = '■'.repeat(filled) + '░'.repeat(barWidth - filled);

    console.error(`
======================================================================
  Bagwan Kai Bandey — Migration Flight Status
======================================================================
Repository:         ${repoPath}
Migration Pack:     ${statusObj.packId}
Current Phase:      ${statusObj.phase}
Manifest:           ${manifest ? `.bkb/manifests/${statusObj.packId}.json (Synchronized with Git)` : 'Not yet initialized (Run "bkb init")'}
FalkorDB Engine:    ${falkorStats ? 'Connected & Synced' : 'Offline / Idle'}

--- Migration Progress [${bar}] ${percentStr} ---
Total Modules:      ${total}
  - Verified:       ${verified}
  - Shimmed:        ${shimmed}
  - Pending:        ${pending}
  - Clean:          ${clean}
`);

    if (manifest?.baseline) {
      console.error(`--- Baseline Invariant Preservation ---`);
      console.error(`Snapshot Kind:      ${manifest.baseline.snapshotType}`);
      console.error(`Recorded Entries:   ${manifest.baseline.entryCount}`);
      if (manifest.baseline.entries?.length) {
        const preview = manifest.baseline.entries.slice(0, 3).join(', ');
        console.error(`Sample Invariants:  ${preview}${manifest.baseline.entries.length > 3 ? '...' : ''}`);
      }
      console.error('');
    }

    if (lastMilestone) {
      console.error(`--- Last Verified Team Milestone ---`);
      console.error(`Step:               ${lastMilestone.step} [${lastMilestone.phase}]`);
      if (lastMilestone.commitSha) {
        console.error(`Git Commit SHA:     ${lastMilestone.commitSha.slice(0, 7)}`);
      }
      console.error(`Action:             ${lastMilestone.action}`);
      console.error(`Timestamp:          ${lastMilestone.timestamp}`);
      console.error('');
    }

    if (falkorStats?.unblocked?.length) {
      console.error(`--- Unblocked Leaves (Ready for Next Claim / Sprint) ---`);
      for (const u of falkorStats.unblocked) {
        console.error(`  - ${u.path} (${u.status}, inDegree: ${u.inDegree})`);
      }
      console.error('');
    }

    console.error('======================================================\n');
    process.exit(0);
  }

  // Ensure FalkorDB container is up and healthy for graph operations
  try {
    await ensureFalkorDB();
  } catch (err) {
    console.error('[bkb] Fatal: FalkorDB bootstrap failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (command === 'claim') {
    try {
      const ops = await createOps(flags);
      const result = await ops.claimNextLeaf();
      if (!result) {
        console.error('[bkb] No unblocked modules to claim. Migration may be complete.');
        // Print status counts
        const counts = await ops.db.roQuery<{ status: string; n: number }>(
          'MATCH (m:Module) RETURN m.status AS status, count(m) AS n',
        );
        console.error('[bkb] Status counts:', JSON.stringify(counts));
        process.exit(0);
      }
      // Output claim result as JSON on stdout (machine-readable)
      console.log(JSON.stringify(result, null, 2));
      await ops.db.close();
      process.exit(0);
    } catch (err) {
      console.error('[bkb] Claim failed:', err);
      process.exit(1);
    }
  }

  if (command === 'slice') {
    const modulePaths = multiFlags.module ?? (flags.module ? [String(flags.module)] : []);
    if (!modulePaths.length) {
      console.error('[bkb] Error: --module <path> is required');
      process.exit(1);
    }
    const phase = String(flags.phase ?? 'MIGRATE') as any;
    try {
      const ops = await createOps(flags);
      const slice = await ops.getMigrationSlice(modulePaths, phase);
      console.log(JSON.stringify(slice, null, 2));
      await ops.db.close();
      process.exit(0);
    } catch (err) {
      console.error('[bkb] Slice failed:', err);
      process.exit(1);
    }
  }

  if (command === 'blast-radius') {
    const modulePath = String(flags.module ?? '');
    if (!modulePath) {
      console.error('[bkb] Error: --module <path> is required');
      process.exit(1);
    }
    try {
      const ops = await createOps(flags);
      const radius = await ops.simulateBlastRadius(modulePath);
      console.log(JSON.stringify(radius, null, 2));
      await ops.db.close();
      process.exit(0);
    } catch (err) {
      console.error('[bkb] Blast radius failed:', err);
      process.exit(1);
    }
  }

  if (command === 'verify') {
    const modulePaths = multiFlags.module ?? (flags.module ? [String(flags.module)] : []);
    if (!modulePaths.length) {
      console.error('[bkb] Error: --module <path> is required');
      process.exit(1);
    }
    const summary = String(flags.summary ?? 'CLI verify');
    try {
      const ops = await createOps(flags);
      const result = await ops.verifyAndCommitNode(modulePaths, summary);
      console.log(JSON.stringify(result, null, 2));
      await ops.db.close();
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      console.error('[bkb] Verify failed:', err);
      process.exit(1);
    }
  }

  if (command === 'audit') {
    try {
      const ops = await createOps(flags);
      const trail = await ops.getAuditTrail(Boolean(flags.checkpoint));
      console.log(JSON.stringify(trail, null, 2));
      await ops.db.close();
      process.exit(0);
    } catch (err) {
      console.error('[bkb] Audit trail failed:', err);
      process.exit(1);
    }
  }

  if (command === 'cockpit' || command === 'ui') {
    const port = Number(flags.port ?? process.env.PORT ?? 4200);
    const repoPath = resolveTargetRepo(flags.repo);
    const packId = String(flags.pack ?? activeConfig?.defaultPack ?? 'express-to-fastify');
    const { startDemoServer } = await import('../src/server/demoServer');

    console.error(`
╭─────────────────────────────────────────────────────────────────╮
│  Bagwan Kai Bandey — Migration Cockpit Flight Deck             │
│  Live URL:   http://localhost:${port}                             │
│  Target:     ${repoPath}
│  Pack:       ${packId}
│  Status:     Listening for CLI & MCP Agent Telemetry (SSE)     │
╰─────────────────────────────────────────────────────────────────╯
`);
    startDemoServer(port, repoPath, packId);
    return;
  }

  if (command === 'serve') {
    const repo = flags.repo ? String(flags.repo) : activeConfig?.defaultRepo;
    const pack = flags.pack ? String(flags.pack) : activeConfig?.defaultPack;
    await startMcpServer({ defaultRepoPath: repo, defaultPackId: pack });
    return;
  }

  if (command === 'rollback') {
    const repoPath = resolveTargetRepo(flags.repo);
    const packId = String(flags.pack ?? activeConfig?.defaultPack ?? 'express-to-fastify');

    if (flags.list) {
      const checkpoints = listCheckpoints(repoPath);
      if (!checkpoints.length) {
        console.error(`[bkb] No checkpoints found for "${repoPath}".`);
      } else {
        console.error(`[bkb] Available checkpoints for "${repoPath}":`);
        for (const cp of checkpoints) {
          console.error(`  - step-${cp}`);
        }
      }
      process.exit(0);
    }

    const stepArg = positional[1] ?? flags.step;
    const targetStep =
      stepArg !== undefined && !isNaN(parseInt(String(stepArg), 10))
        ? parseInt(String(stepArg), 10)
        : undefined;

    console.error(
      `[bkb] Rolling back "${repoPath}" (pack: ${packId})${
        targetStep !== undefined ? ` to step-${targetStep}` : ' to latest checkpoint'
      }...`,
    );

    const result = await rollbackToCheckpoint(repoPath, packId, targetStep);
    if (result.ok) {
      console.error(`[bkb] ✅ ${result.message}`);
      process.exit(0);
    } else {
      console.error(`[bkb] ❌ Rollback failed: ${result.message}`);
      process.exit(1);
    }
  }

  if (command === 'run' || command === 'auto') {
    const repoPath = resolveTargetRepo(flags.repo);
    const packId = String(flags.pack ?? activeConfig?.defaultPack ?? 'express-to-fastify');
    const dryRun = Boolean(flags['dry-run'] || flags.dryRun);
    const provider = dryRun ? 'mock' : ((flags.provider ? String(flags.provider) : undefined) as any);
    const model = flags.model ? String(flags.model) : undefined;
    const maxSteps = flags['max-steps'] ? parseInt(String(flags['max-steps']), 10) : undefined;
    const autoRollback = flags['no-rollback'] === true ? false : true;
    const port = Number(flags.port ?? process.env.BKB_COCKPIT_PORT ?? process.env.PORT ?? 4200);
    const noUi = Boolean(
      flags['no-ui'] || flags['no-cockpit'] || flags.ui === false || flags.cockpit === false,
    );

    let cockpitServer: any;
    if (!noUi) {
      try {
        process.env.BKB_COCKPIT_PORT = String(port);
        const { startDemoServer } = await import('../src/server/demoServer');
        cockpitServer = startDemoServer(port, repoPath, packId, false);
        cockpitServer.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            console.error(
              `[bkb] Live Cockpit: Connected to existing flight deck on http://localhost:${port}`,
            );
          } else {
            console.error(`[bkb] Cockpit flight deck notice: ${err.message}`);
          }
        });
      } catch (err: any) {
        console.error(`[bkb] Could not auto-launch Cockpit: ${err.message}`);
      }
    }

    console.error(`[bkb] Starting autonomous migration runner on "${repoPath}"`);
    console.error(`  - Migration Pack: ${packId}`);
    console.error(
      `  - LLM Provider:   ${
        provider ??
        (process.env.OPENAI_API_KEY
          ? 'openai'
          : process.env.ANTHROPIC_API_KEY
          ? 'anthropic'
          : 'mock (built-in deterministic)')
      }`,
    );
    if (model) console.error(`  - Model:          ${model}`);
    console.error(`  - Auto Rollback:  ${autoRollback ? 'enabled' : 'disabled'}`);
    if (!noUi) console.error(`  - Live Cockpit:   http://localhost:${port}`);
    console.error('');

    const res = await runAutonomousMigration({
      repoPath,
      packId,
      provider,
      model,
      maxSteps,
      reset: Boolean(flags.reset),
      autoRollbackOnFailure: autoRollback,
      onProgress: (p) => {
        const icon =
          p.status === 'success'
            ? '✅'
            : p.status === 'warning'
            ? '⚠️'
            : p.status === 'error'
            ? '❌'
            : '⚡';

        console.error(`[bkb] ${icon} Step ${p.step} [${p.phase}] ${p.action}`);
        if (p.details && p.status === 'warning') {
          console.error(`      ${p.details.split('\n')[0]}`);
        }
      },
    });

    console.error('');
    if (res.ok) {
      console.error('====================================================');
      console.error('🎉 Autonomous Migration Completed Successfully!');
      console.error(`  - Total Steps:      ${res.totalSteps}`);
      console.error(`  - Modules Migrated: ${res.migratedModules}`);
      console.error(`  - Route Parity:     ${res.routeParity ? '100% Match' : 'Mismatch'}`);
      console.error(`  - Checkpoint Tests: ${res.checkpointPassed ? 'Passed' : 'Failed'}`);
      console.error(`  - Total Duration:   ${(res.durationMs / 1000).toFixed(2)}s`);
      console.error('====================================================');
      if (cockpitServer && cockpitServer.listening) {
        if (flags.wait || flags.serve || flags['keep-ui']) {
          console.error(`\n[bkb] 🖥️ Migration Cockpit remains live at http://localhost:${port} (Press Ctrl+C to exit)`);
          return;
        }
        cockpitServer.close();
      }
      process.exit(0);
    } else {
      console.error('====================================================');
      console.error(`❌ Autonomous Migration Failed at step ${res.totalSteps}:`);
      console.error(`  ${res.error ?? 'Unknown error'}`);
      console.error('====================================================');
      if (cockpitServer && cockpitServer.listening) {
        if (flags.wait || flags.serve || flags['keep-ui']) {
          console.error(`\n[bkb] 🖥️ Migration Cockpit remains live at http://localhost:${port} (Press Ctrl+C to exit)`);
          return;
        }
        cockpitServer.close();
      }
      process.exit(1);
    }
  }

  console.error(`[bkb] Unknown command "${command}". Use "bkb --help" for usage.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('[bkb] Unhandled error:', err);
  process.exit(1);
});
