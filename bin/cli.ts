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

function printHelp() {
  console.error(`
Shift: Graph-Governed Codebase Migration Engine (Powered by FalkorDB)

Usage:
  shift init --repo <path> --pack <id> [--reset] [--adapter <path>]
  shift claim --repo <path> --pack <id>
  shift slice --repo <path> --pack <id> --module <path> --phase <MIGRATE|SHIM|DE_SHIM>
  shift blast-radius --repo <path> --pack <id> --module <path>
  shift verify --repo <path> --pack <id> --module <path> [--summary <text>]
  shift audit --repo <path> --pack <id> [--checkpoint]
  shift serve [--repo <path>] [--pack <id>]
  shift pack init <pack-id> [--lang <language>]
  shift pack validate <path>
  shift adapter init <language>
  shift --help

Commands:
  init           Initialize the migration graph in FalkorDB for a repo and pack
  claim          Claim the next unblocked leaf / SCC for migration
  slice          Get the migration slice (source, 1-hop context) for claimed modules
  blast-radius   Simulate the blast radius of changing a module
  verify         Re-parse, gate-check, and commit a migrated module
  audit          Show the full migration audit trail
  serve          Start the Shift MCP server (stdio transport)
  pack init      Scaffold a new Migration Pack starter template
  pack validate  Validate a Migration Pack schema and detection rules
  adapter init   Scaffold a starter Language Adapter template
  --help         Show this help message

Options:
  --repo <path>      Path to target repository (default: ./demo-repo)
  --pack <id>        Migration pack id or path (default: express-to-fastify)
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
    } else if (arg === '--reset' || arg === '--checkpoint') {
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

  // 1. Load project config if present (e.g. shift.config.ts)
  try {
    await loadConfig();
  } catch (err) {
    console.error('[shift] Warning: Failed to load shift.config:', err);
  }

  // 2. Register custom adapter if passed via --adapter
  if (flags.adapter) {
    const adapterPath = resolve(String(flags.adapter));
    console.error(`[shift] Injecting custom language adapter from "${adapterPath}"...`);
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
      console.error(`[shift] Successfully scaffolded new Migration Pack at: ${targetPath}`);
      process.exit(0);
    }

    if (subCommand === 'validate') {
      const packPath = positional[2];
      if (!packPath) {
        console.error('[shift] Error: Path to pack is required (e.g. `shift pack validate ./packs/my-pack.json`)');
        process.exit(1);
      }
      try {
        const pack = loadPack(packPath);
        const res = validatePack(pack);
        if (res.valid) {
          console.error(`[shift] ✅ Pack "${pack.id}" is structurally valid and ready for use!`);
          console.error(`  - Language:        ${pack.language}`);
          console.error(`  - Detection Rules: ${pack.detectionRules.length}`);
          console.error(`  - Verification:    ${pack.verification.perStepTypecheckCmd}`);
          process.exit(0);
        } else {
          console.error(`[shift] ❌ Validation failed with ${res.errors.length} error(s):`);
          res.errors.forEach((e) => console.error(`  - ${e}`));
          process.exit(1);
        }
      } catch (err: any) {
        console.error(`[shift] ❌ Failed to validate pack:`, err.message);
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
    console.error(`[shift] Successfully scaffolded new Language Adapter at: ${targetPath}`);
    process.exit(0);
  }

  // Ensure FalkorDB container is up and healthy for graph operations
  try {
    await ensureFalkorDB();
  } catch (err) {
    console.error('[shift] Fatal: FalkorDB bootstrap failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (command === 'init') {
    const repoPath = resolve(String(flags.repo ?? './demo-repo'));
    const packId = String(flags.pack ?? 'express-to-fastify');
    const reset = Boolean(flags.reset ?? true);

    console.error(`[shift] Initializing migration graph for "${repoPath}" with pack "${packId}" (reset=${reset})...`);
    try {
      const summary = await MigrationGraphManager.initMigrationGraph({
        repoPath,
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
      console.error('[shift] Failed to initialize migration graph:', err);
      process.exit(1);
    }
  }

  if (command === 'claim') {
    try {
      const ops = await createOps(flags);
      const result = await ops.claimNextLeaf();
      if (!result) {
        console.error('[shift] No unblocked modules to claim. Migration may be complete.');
        // Print status counts
        const counts = await ops.db.roQuery<{ status: string; n: number }>(
          'MATCH (m:Module) RETURN m.status AS status, count(m) AS n',
        );
        console.error('[shift] Status counts:', JSON.stringify(counts));
        process.exit(0);
      }
      // Output claim result as JSON on stdout (machine-readable)
      console.log(JSON.stringify(result, null, 2));
      await ops.db.close();
      process.exit(0);
    } catch (err) {
      console.error('[shift] Claim failed:', err);
      process.exit(1);
    }
  }

  if (command === 'slice') {
    const modulePaths = multiFlags.module ?? (flags.module ? [String(flags.module)] : []);
    if (!modulePaths.length) {
      console.error('[shift] Error: --module <path> is required');
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
      console.error('[shift] Slice failed:', err);
      process.exit(1);
    }
  }

  if (command === 'blast-radius') {
    const modulePath = String(flags.module ?? '');
    if (!modulePath) {
      console.error('[shift] Error: --module <path> is required');
      process.exit(1);
    }
    try {
      const ops = await createOps(flags);
      const radius = await ops.simulateBlastRadius(modulePath);
      console.log(JSON.stringify(radius, null, 2));
      await ops.db.close();
      process.exit(0);
    } catch (err) {
      console.error('[shift] Blast radius failed:', err);
      process.exit(1);
    }
  }

  if (command === 'verify') {
    const modulePaths = multiFlags.module ?? (flags.module ? [String(flags.module)] : []);
    if (!modulePaths.length) {
      console.error('[shift] Error: --module <path> is required');
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
      console.error('[shift] Verify failed:', err);
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
      console.error('[shift] Audit trail failed:', err);
      process.exit(1);
    }
  }

  if (command === 'serve') {
    const repo = flags.repo ? String(flags.repo) : undefined;
    const pack = flags.pack ? String(flags.pack) : undefined;
    await startMcpServer({ defaultRepoPath: repo, defaultPackId: pack });
    return;
  }

  console.error(`[shift] Unknown command "${command}". Use "shift --help" for usage.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('[shift] Unhandled error:', err);
  process.exit(1);
});
