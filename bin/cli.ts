#!/usr/bin/env node
/**
 * Shift CLI & Bootstrapper (`bin/cli.ts`).
 * Stdio discipline: all logging goes to console.error so stdout remains clean
 * for MCP JSON-RPC protocol frames when the MCP server runs.
 */

import { resolve, join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { ensureFalkorDB } from '../src/engine/docker';
import { MigrationGraphManager } from '../src/engine/graphManager';
import { MigrationOps } from '../src/engine/operations';
import { startMcpServer } from '../src/mcp/server';
import { adapterRegistry } from '../src/adapters/registry';
import { loadConfig } from '../src/engine/config';
import { validatePack, loadPack } from '../src/engine/packLoader';
import { runDiagnostics, formatDoctorReport } from '../src/cli/doctor';
import { installMcpConfig, formatMcpInstallReport, type McpTarget } from '../src/cli/mcpInstaller';
import { runInteractiveInit } from '../src/cli/wizard';
import { runAutonomousMigration } from '../src/runner/autonomousRunner';
import { rollbackToCheckpoint, listCheckpoints } from '../src/runner/rollback';

function printHelp() {
  console.error(`
Bagwan Kai Bandey (bkb): Graph-Governed Codebase Migration Engine (Powered by FalkorDB)

Usage:
  bkb doctor [--repo <path>]
  bkb mcp install [cursor|claude|vscode|windsurf|all]
  bkb init [--interactive] [--repo <path>] [--pack <id>] [--reset] [--adapter <path>]
  bkb run [--repo <path>] [--pack <id>] [--provider <p>] [--model <m>] [--dry-run] [--no-rollback]
  bkb rollback [step] [--repo <path>] [--pack <id>] [--list]
  bkb claim --repo <path> --pack <id>
  bkb slice --repo <path> --pack <id> --module <path> --phase <MIGRATE|SHIM|DE_SHIM>
  bkb blast-radius --repo <path> --pack <id> --module <path>
  bkb verify --repo <path> --pack <id> --module <path> [--summary <text>]
  bkb audit --repo <path> --pack <id> [--checkpoint]
  bkb serve [--repo <path>] [--pack <id>]
  bkb pack init <pack-id> [--lang <language>]
  bkb pack validate <path>
  bkb adapter init <language>
  bkb --help

Commands:
  doctor         Run pre-flight environment diagnostics (Node, Docker, FalkorDB, Git)
  mcp install    1-Click install BKB MCP server config into Cursor, Claude, or VS Code
  init           Initialize the migration graph in FalkorDB (interactive wizard if -i)
  run, auto      Autonomously execute the migration loop (claim -> slice -> transform -> verify)
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
  --provider <p>     LLM provider for run: mock (default / zero-cost), ollama, openai, anthropic
  --model <id>       Model identifier (e.g. gpt-4o, qwen2.5-coder:latest, claude-3-5-sonnet-20241022)
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

async function createOps(flags: Record<string, string | boolean>): Promise<MigrationOps> {
  const repoPath = resolve(String(flags.repo ?? './demo-repo'));
  const packId = String(flags.pack ?? 'express-to-fastify');
  const mgr = await MigrationGraphManager.create(repoPath, packId);
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
    await loadConfig();
  } catch (err) {
    console.error('[bkb] Warning: Failed to load config:', err);
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
      const template = {
        $schema: 'https://raw.githubusercontent.com/saqib40/bagwan-kai-bandey/main/packs/schema.json',
        id: packId,
        name: `${packId} Migration Pack`,
        language: lang,
        sourceGlobs: {
          include: [`**/*.${lang === 'python' ? 'py' : lang === 'go' ? 'go' : 'ts'}`],
          exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
        },
        packages: {
          legacy: ['legacy-package'],
          target: ['target-package'],
        },
        detectionRules: [
          {
            id: 'legacy-api-call',
            description: 'Detects usage of legacy package APIs',
            astQuery: '(call_expression (identifier) @api)',
          },
        ],
        agentGuidance: {
          SHIM: 'Implement dual-compatibility adapters for legacy callers.',
          MIGRATE: 'Migrate internal module logic to modern framework semantics.',
          DE_SHIM: 'Remove legacy shims and convert to pure target framework calls.',
        },
        invariants: [
          {
            id: 'api-routes',
            scope: 'checkpoint',
            type: 'route-set',
            description: 'Guarantees 100% route invariant parity across migration',
            astExtractor: 'routes',
          },
        ],
        verification: {
          perStepTypecheckCmd: lang === 'python' ? 'mypy .' : 'npm run typecheck',
          checkpointTestCmd: lang === 'python' ? 'pytest' : 'npm test',
          routeSnapshotCmd: 'node scripts/dump-routes.mjs',
        },
      };

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
        if (res.valid) {
          console.error(`[bkb] ✅ Pack "${pack.id}" is structurally valid and ready for use!`);
          console.error(`  - Language:        ${pack.language}`);
          console.error(`  - Detection Rules: ${pack.detectionRules.length}`);
          console.error(`  - Verification:    ${pack.verification.perStepTypecheckCmd}`);
          process.exit(0);
        } else {
          console.error(`[bkb] ❌ Validation failed with ${res.errors.length} error(s):`);
          res.errors.forEach((e) => console.error(`  - ${e}`));
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
    const template = `import { BaseLanguageAdapter, type ParsedModule, type MigrationPack } from 'shift-migration-engine';

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
    console.error(`[bkb] Unknown mcp subcommand "${subCommand}". Usage: bkb mcp install [cursor|claude|vscode|windsurf|all]`);
    process.exit(1);
  }

  if (command === 'init') {
    let repoPath = flags.repo ? String(flags.repo) : undefined;
    let packId = flags.pack ? String(flags.pack) : undefined;
    let reset = flags.reset !== undefined ? Boolean(flags.reset) : undefined;

    if (flags.interactive || (!flags.repo && !flags.pack && process.stdin.isTTY && flags.reset === undefined)) {
      const wizardRes = await runInteractiveInit(repoPath ?? './demo-repo');
      repoPath = wizardRes.repoPath;
      packId = wizardRes.packId;
      reset = wizardRes.reset;
    } else {
      repoPath = repoPath ?? './demo-repo';
      packId = packId ?? 'express-to-fastify';
      reset = reset ?? true;
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

  if (command === 'serve') {
    const repo = flags.repo ? String(flags.repo) : undefined;
    const pack = flags.pack ? String(flags.pack) : undefined;
    await startMcpServer({ defaultRepoPath: repo, defaultPackId: pack });
    return;
  }

  if (command === 'rollback') {
    const repoPath = flags.repo ? resolve(String(flags.repo)) : resolve('./demo-repo');
    const packId = String(flags.pack ?? 'express-to-fastify');

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
    const repoPath = flags.repo ? resolve(String(flags.repo)) : resolve('./demo-repo');
    const packId = String(flags.pack ?? 'express-to-fastify');
    const dryRun = Boolean(flags['dry-run'] || flags.dryRun);
    const provider = dryRun ? 'mock' : ((flags.provider ? String(flags.provider) : undefined) as any);
    const model = flags.model ? String(flags.model) : undefined;
    const maxSteps = flags['max-steps'] ? parseInt(String(flags['max-steps']), 10) : undefined;
    const autoRollback = flags['no-rollback'] === true ? false : true;

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
      process.exit(0);
    } else {
      console.error('====================================================');
      console.error(`❌ Autonomous Migration Failed at step ${res.totalSteps}:`);
      console.error(`  ${res.error ?? 'Unknown error'}`);
      console.error('====================================================');
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
