/**
 * 1-Click MCP Configuration Installer (`src/cli/mcpInstaller.ts`).
 *
 * Automatically registers Bagwan Kai Bandey (`bkb-migration-engine`) in:
 *  - Cursor (~/.cursor/mcp.json or .cursor/mcp.json)
 *  - Claude Desktop (macOS, Windows, Linux config locations)
 *  - VS Code (.vscode/mcp.json)
 *  - Windsurf (~/.codeium/windsurf/mcp_config.json)
 *  - OpenCode (~/.config/opencode/opencode.jsonc or opencode.json)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';

export type McpTarget = 'cursor' | 'claude' | 'vscode' | 'windsurf' | 'opencode' | 'all';

export interface InstallResult {
  target: string;
  configPath: string;
  status: 'created' | 'updated' | 'already_configured' | 'skipped' | 'failed';
  message: string;
  serverKey: string;
}

export function getMcpConfigPath(
  target: 'cursor' | 'claude' | 'vscode' | 'windsurf' | 'opencode',
  workspaceRoot = process.cwd(),
): string {
  const home = homedir();
  const osType = platform();

  switch (target) {
    case 'cursor': {
      // Preference: workspace .cursor/mcp.json if exists or home ~/.cursor/mcp.json
      const local = join(workspaceRoot, '.cursor', 'mcp.json');
      if (existsSync(local)) return local;
      return join(home, '.cursor', 'mcp.json');
    }
    case 'claude': {
      if (osType === 'darwin') {
        return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      } else if (osType === 'win32') {
        return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
      } else {
        return join(home, '.config', 'Claude', 'claude_desktop_config.json');
      }
    }
    case 'vscode': {
      return join(workspaceRoot, '.vscode', 'mcp.json');
    }
    case 'windsurf': {
      return join(home, '.codeium', 'windsurf', 'mcp_config.json');
    }
    case 'opencode': {
      const localJson = join(workspaceRoot, 'opencode.json');
      const localJsonc = join(workspaceRoot, 'opencode.jsonc');
      if (existsSync(localJson)) return localJson;
      if (existsSync(localJsonc)) return localJsonc;
      if (workspaceRoot === process.cwd()) {
        const globalJsonc = join(home, '.config', 'opencode', 'opencode.jsonc');
        const globalJson = join(home, '.config', 'opencode', 'opencode.json');
        if (existsSync(globalJsonc)) return globalJsonc;
        if (existsSync(globalJson)) return globalJson;
      }
      return localJson;
    }
  }
}

export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildOpencodeAddCommand(args: string[]): string {
  return `opencode mcp add bkb -- ${args.map(shellQuote).join(' ')}`;
}

function readJsonConfig(
  configPath: string,
): { ok: true; value: Record<string, any>; isNew: boolean } | { ok: false; message: string } {
  if (!existsSync(configPath)) return { ok: true, value: {}, isNew: true };
  try {
    const value = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, message: `Refusing to overwrite non-object config at ${configPath}` };
    }
    return { ok: true, value, isNew: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Refusing to overwrite unparseable config at ${configPath}: ${message}`,
    };
  }
}

export function generateServerConfig(cliPath: string, repoPath?: string, packId?: string) {
  const resolvedCli = resolve(cliPath);
  const args = ['-y', 'tsx', resolvedCli, 'serve'];
  if (repoPath) {
    args.push('--repo', resolve(repoPath));
  }
  if (packId) {
    args.push('--pack', packId);
  }

  return {
    command: 'npx',
    args,
  };
}

export function generateOpencodeConfig(cliPath: string, repoPath?: string, packId?: string) {
  const resolvedCli = resolve(cliPath);
  const command = ['npx', '-y', 'tsx', resolvedCli, 'serve'];
  if (repoPath) {
    command.push('--repo', resolve(repoPath));
  }
  if (packId) {
    command.push('--pack', packId);
  }

  return {
    type: 'local',
    command,
    enabled: true,
  };
}

export async function installMcpConfig(
  target: McpTarget = 'all',
  options: {
    cliPath?: string;
    repoPath?: string;
    packId?: string;
    workspaceRoot?: string;
  } = {},
): Promise<InstallResult[]> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const cliPath = options.cliPath ?? resolve(import.meta.dirname, '../../bin/cli.ts');
  const serverConfig = generateServerConfig(cliPath, options.repoPath, options.packId);

  const targetsToProcess: Array<'cursor' | 'claude' | 'vscode' | 'windsurf' | 'opencode'> =
    target === 'all' ? ['cursor', 'claude', 'vscode', 'windsurf', 'opencode'] : [target];

  const results: InstallResult[] = [];

  for (const t of targetsToProcess) {
    const configPath = getMcpConfigPath(t, workspaceRoot);
    const parentDir = dirname(configPath);

    // If target is 'all' and parent directory doesn't exist, skip gracefully
    if (target === 'all' && (t === 'claude' || t === 'windsurf') && !existsSync(parentDir)) {
      results.push({
        target: t,
        configPath,
        status: 'skipped',
        message: `App directory not found (${parentDir}). Skipped.`,
        serverKey: 'bkb',
      });
      continue;
    }

    // Special handling for OpenCode: supports both CLI registration and JSON configuration
    if (t === 'opencode') {
      let hasCli = false;
      try {
        execSync('opencode --version', { stdio: 'pipe' });
        hasCli = true;
      } catch {
        hasCli = false;
      }

      if (target === 'all' && !hasCli && !existsSync(parentDir) && !existsSync(configPath)) {
        results.push({
          target: t,
          configPath,
          status: 'skipped',
          message: 'OpenCode not detected. Skipped.',
          serverKey: 'bkb',
        });
        continue;
      }

      const shouldUseCli = hasCli && (!options.workspaceRoot || options.workspaceRoot === process.cwd());

      try {
        if (shouldUseCli) {
          const resolvedCli = resolve(cliPath);
          const args = ['npx', '-y', 'tsx', resolvedCli, 'serve'];
          if (options.repoPath) args.push('--repo', resolve(options.repoPath));
          if (options.packId) args.push('--pack', options.packId);

          execSync(buildOpencodeAddCommand(args), { stdio: 'pipe' });

          results.push({
            target: t,
            configPath: configPath.includes('.config') ? configPath : 'OpenCode Global Config',
            status: 'updated',
            message: `Registered "bkb" MCP server into OpenCode CLI.`,
            serverKey: 'bkb',
          });
        } else {
          // File-based configuration (e.g. project-level opencode.json or isolated test directory)
          if (!existsSync(parentDir)) {
            mkdirSync(parentDir, { recursive: true });
          }

          const loaded = readJsonConfig(configPath);
          if (!loaded.ok) {
            results.push({
              target: t,
              configPath,
              status: 'failed',
              message: loaded.message,
              serverKey: 'bkb',
            });
            continue;
          }
          const existing = loaded.value;
          const isNew = loaded.isNew;

          if (!existing.mcp || typeof existing.mcp !== 'object') existing.mcp = {};
          if (!existing.mcp.servers || typeof existing.mcp.servers !== 'object') existing.mcp.servers = {};

          const opencodeConfig = generateOpencodeConfig(cliPath, options.repoPath, options.packId);
          const current = existing.mcp.servers.bkb;
          const alreadyConfigured =
            current &&
            current.type === opencodeConfig.type &&
            JSON.stringify(current.command) === JSON.stringify(opencodeConfig.command);

          existing.mcp.servers.bkb = opencodeConfig;

          writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');

          results.push({
            target: t,
            configPath,
            status: alreadyConfigured ? 'already_configured' : isNew ? 'created' : 'updated',
            message: alreadyConfigured
              ? `Already up to date at ${configPath}`
              : isNew
                ? `Created new OpenCode config at ${configPath}`
                : `Updated "bkb" server in ${configPath}`,
            serverKey: 'bkb',
          });
        }
      } catch (err: any) {
        results.push({
          target: t,
          configPath,
          status: 'failed',
          message: err.message ?? String(err),
          serverKey: 'bkb',
        });
      }
      continue;
    }

    try {
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      const loaded = readJsonConfig(configPath);
      if (!loaded.ok) {
        results.push({
          target: t,
          configPath,
          status: 'failed',
          message: loaded.message,
          serverKey: 'bkb',
        });
        continue;
      }
      const existing = loaded.value;
      const isNew = loaded.isNew;

      if (!existing.mcpServers || typeof existing.mcpServers !== 'object') {
        existing.mcpServers = {};
      }

      // Check if already configured identically
      const current = existing.mcpServers.bkb;
      const alreadyConfigured =
        current &&
        current.command === serverConfig.command &&
        JSON.stringify(current.args) === JSON.stringify(serverConfig.args);

      existing.mcpServers.bkb = serverConfig;

      writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');

      results.push({
        target: t,
        configPath,
        status: alreadyConfigured ? 'already_configured' : isNew ? 'created' : 'updated',
        message: alreadyConfigured
          ? `Already up to date at ${configPath}`
          : isNew
            ? `Created new MCP config at ${configPath}`
            : `Updated "bkb" server in ${configPath}`,
        serverKey: 'bkb',
      });
    } catch (err: any) {
      results.push({
        target: t,
        configPath,
        status: 'failed',
        message: err.message ?? String(err),
        serverKey: 'bkb',
      });
    }
  }

  return results;
}

export function formatMcpInstallReport(results: InstallResult[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  === Bagwan Kai Bandey (BKB) 1-Click MCP Setup ===');
  lines.push('');

  let anySuccess = false;
  for (const res of results) {
    if (res.status === 'created' || res.status === 'updated') {
      anySuccess = true;
      lines.push(`  \x1b[32m✔ [${res.target.toUpperCase()}]\x1b[0m ${res.message}`);
    } else if (res.status === 'already_configured') {
      anySuccess = true;
      lines.push(`  \x1b[36mℹ [${res.target.toUpperCase()}]\x1b[0m ${res.message}`);
    } else if (res.status === 'skipped') {
      lines.push(`  \x1b[90m- [${res.target.toUpperCase()}]\x1b[0m ${res.message}`);
    } else {
      lines.push(`  \x1b[31m✖ [${res.target.toUpperCase()}]\x1b[0m Failed: ${res.message}`);
    }
  }

  lines.push('');
  if (anySuccess) {
    lines.push('  \x1b[32m✔ Successfully installed BKB MCP configuration!\x1b[0m');
    lines.push('  Next steps:');
    lines.push('  1. Restart your editor or CLI (Cursor / Claude Desktop / VS Code / Windsurf / OpenCode).');
    lines.push('  2. In OpenCode, verify status with `opencode mcp list` or `/mcps`.');
    lines.push('  3. Ask your AI Agent:');
    lines.push('     \x1b[33m"Migrate this codebase using the BKB MCP tools."\x1b[0m');
  } else {
    lines.push('  No active editors were configured. Please specify target: `bkb mcp install cursor`, `bkb mcp install claude`, or `bkb mcp install opencode`.');
  }
  lines.push('');

  return lines.join('\n');
}
