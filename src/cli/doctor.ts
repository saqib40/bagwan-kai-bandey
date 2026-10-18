/**
 * Bagwan Kai Bandey (BKB) Pre-Flight Diagnostics Engine (`src/cli/doctor.ts`).
 *
 * Checks:
 * 1. Node.js runtime compatibility (v18+)
 * 2. Docker daemon status & FalkorDB container state
 * 3. FalkorDB graph connection (:6379) & Browser UI (:3000)
 * 4. Git repository & working tree cleanliness
 * 5. Available migration packs & registered language adapters
 */

import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import net from 'node:net';
import { FalkorClient } from '../engine/falkorClient';
import { adapterRegistry } from '../adapters/registry';
import { discoverPackIds } from '../engine/packLoader';

export interface DoctorCheckResult {
  title: string;
  ok: boolean;
  message: string;
  remediation?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheckResult[];
}

export function checkPortReachable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

export async function runDiagnostics(repoRoot = process.cwd()): Promise<DoctorReport> {
  const checks: DoctorCheckResult[] = [];

  // 1. Node.js version
  const nodeMajor = parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (nodeMajor >= 18) {
    checks.push({
      title: 'Node.js Runtime',
      ok: true,
      message: `${process.version} (${process.platform}-${process.arch})`,
    });
  } else {
    checks.push({
      title: 'Node.js Runtime',
      ok: false,
      message: `${process.version} is unsupported. BKB requires Node.js >= 18.0.0.`,
      remediation: 'Upgrade Node.js: https://nodejs.org or run `nvm install 22`.',
    });
  }

  // 2. Docker Daemon
  let dockerOk = false;
  let dockerStatusMsg = '';
  try {
    const dockerVer = execSync('docker --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    // Test if daemon responds
    execSync('docker ps -q', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    dockerOk = true;
    dockerStatusMsg = `${dockerVer} (daemon active)`;
  } catch (err: any) {
    dockerOk = false;
    dockerStatusMsg = 'Docker daemon not running or docker CLI not found.';
  }

  checks.push({
    title: 'Docker Engine',
    ok: dockerOk,
    message: dockerStatusMsg,
    remediation: dockerOk
      ? undefined
      : 'Start Docker Desktop or start the Docker daemon (`sudo systemctl start docker`).',
  });

  // 3. FalkorDB Port (:6379) & Client Ping
  const port6379Up = await checkPortReachable(6379);
  let falkorPingOk = false;
  let falkorErrMsg = '';
  if (port6379Up) {
    try {
      const client = await FalkorClient.connect({
        url: process.env.FALKORDB_URL ?? 'falkor://127.0.0.1:6379',
        graphName: 'bkb_doctor_ping',
      });
      await client.query('RETURN 1');
      await client.close();
      falkorPingOk = true;
    } catch (err: any) {
      falkorErrMsg = err.message ?? String(err);
    }
  }

  checks.push({
    title: 'FalkorDB Graph Engine (:6379)',
    ok: falkorPingOk,
    message: falkorPingOk
      ? 'Listening & responding to openCypher ping queries'
      : port6379Up
        ? `Port 6379 is open but FalkorDB ping failed: ${falkorErrMsg}`
        : 'Port 6379 is closed. FalkorDB is not currently running.',
    remediation: falkorPingOk
      ? undefined
      : 'Start FalkorDB: `docker run -p 6379:6379 -p 3000:3000 -d falkordb/falkordb:latest` (or run `bkb init` to auto-bootstrap).',
  });

  // 4. FalkorDB Browser UI (:3000)
  const port3000Up = await checkPortReachable(3000);
  checks.push({
    title: 'FalkorDB Browser UI (:3000)',
    ok: port3000Up,
    message: port3000Up
      ? 'Accessible at http://localhost:3000'
      : 'Port 3000 is inactive (Browser UI disabled or occupied)',
    remediation: port3000Up
      ? undefined
      : 'Optional: Map port 3000 when starting Docker container to use FalkorDB openCypher visualizer.',
  });

  // 5. Git Repository & Cleanliness
  let isGit = false;
  let isClean = true;
  let gitMsg = '';
  try {
    const isWorkTree = execSync('git rev-parse --is-inside-work-tree', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    isGit = isWorkTree === 'true';

    if (isGit) {
      const statusOut = execSync('git status --porcelain', {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      isClean = statusOut.length === 0;
      gitMsg = isClean ? 'Git repository found (working tree clean)' : 'Git repository found (has uncommitted changes)';
    }
  } catch {
    isGit = false;
    gitMsg = 'Not a git repository.';
  }

  checks.push({
    title: 'Git Workspace',
    ok: isGit,
    message: gitMsg,
    remediation: !isGit
      ? 'Current directory is not a git repository. Target an existing codebase with `bkb doctor --repo <path>` or run `git init` to enable automatic rollbacks.'
      : !isClean
        ? 'Recommended: Commit or stash uncommitted changes before running migrations for easy rollback.'
        : undefined,
  });

  // 6. Migration Packs Available
  const builtInPacksDir = resolve(import.meta.dirname, '../../packs');
  const packDirs = [
    builtInPacksDir,
    join(repoRoot, 'packs'),
    join(process.cwd(), 'packs'),
    join(repoRoot, '.bkb/packs'),
  ];
  const discoveredPacks = new Set<string>();

  for (const d of packDirs) {
    for (const id of discoverPackIds(d)) discoveredPacks.add(id);
  }

  checks.push({
    title: 'Available Migration Packs',
    ok: discoveredPacks.size > 0,
    message: discoveredPacks.size > 0
      ? `Found ${discoveredPacks.size} pack(s): [${[...discoveredPacks].join(', ')}]`
      : 'No migration packs found in ./packs or .bkb/packs.',
    remediation: discoveredPacks.size === 0
      ? 'Scaffold a new migration pack with `bkb pack init <id>`.'
      : undefined,
  });

  // 7. Language Adapters Registered
  const adapters = adapterRegistry.list();
  checks.push({
    title: 'Language Adapters',
    ok: adapters.length > 0,
    message: `Registered: [${adapters.join(', ')}]`,
    remediation: undefined,
  });

  const overallOk = checks.filter((c) => c.title !== 'FalkorDB Browser UI (:3000)').every((c) => c.ok);

  return { ok: overallOk, checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  === Bagwan Kai Bandey (BKB) Environment Diagnostics ===');
  lines.push('');

  for (const check of report.checks) {
    const icon = check.ok ? '  \x1b[32m✔\x1b[0m' : '  \x1b[31m✖\x1b[0m';
    const titleColor = check.ok ? '\x1b[1m' : '\x1b[1;31m';
    lines.push(`${icon} ${titleColor}${check.title}\x1b[0m: ${check.message}`);
    if (check.remediation) {
      lines.push(`    \x1b[33m└─ Suggestion:\x1b[0m ${check.remediation}`);
    }
  }

  lines.push('');
  if (report.ok) {
    lines.push('  \x1b[32m✔ System is fully configured and ready for migration!\x1b[0m');
    lines.push('  Run \x1b[36mbkb init\x1b[0m to initialize a codebase, or \x1b[36mbkb serve\x1b[0m to start the MCP server.');
  } else {
    lines.push('  \x1b[31m✖ Some environment requirements need attention before running migrations.\x1b[0m');
    lines.push('  Please review the suggestions above.');
  }
  lines.push('');

  return lines.join('\n');
}
