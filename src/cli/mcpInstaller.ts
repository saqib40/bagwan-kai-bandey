/**
 * 1-Click MCP Configuration Installer (`src/cli/mcpInstaller.ts`).
 *
 * Automatically registers Bagwan Kai Bandey (`bkb-migration-engine`) in:
 *  - Cursor (~/.cursor/mcp.json or .cursor/mcp.json)
 *  - Claude Desktop (macOS, Windows, Linux config locations)
 *  - VS Code (.vscode/mcp.json)
 *  - Windsurf (~/.codeium/windsurf/mcp_config.json)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';

export type McpTarget = 'cursor' | 'claude' | 'vscode' | 'windsurf' | 'all';

export interface InstallResult {
  target: string;
  configPath: string;
  status: 'created' | 'updated' | 'already_configured' | 'skipped' | 'failed';
  message: string;
  serverKey: string;
}

export function getMcpConfigPath(target: 'cursor' | 'claude' | 'vscode' | 'windsurf', workspaceRoot = process.cwd()): string {
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
  }
}

export function generateServerConfig(cliPath: string, repoPath?: string, packId?: string) {
  const resolvedCli = resolve(cliPath);
  const args = [resolvedCli, 'serve'];
  if (repoPath) {
    args.push('--repo', resolve(repoPath));
  }
  if (packId) {
    args.push('--pack', packId);
  }

  return {
    command: 'tsx',
    args,
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

  const targetsToProcess: Array<'cursor' | 'claude' | 'vscode' | 'windsurf'> =
    target === 'all' ? ['cursor', 'claude', 'vscode', 'windsurf'] : [target];

  const results: InstallResult[] = [];

  for (const t of targetsToProcess) {
    const configPath = getMcpConfigPath(t, workspaceRoot);
    const parentDir = dirname(configPath);

    // If target is 'all' and parent directory doesn't exist (e.g. user doesn't have Windsurf installed), skip gracefully
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

    try {
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      let existing: Record<string, any> = {};
      let isNew = true;

      if (existsSync(configPath)) {
        isNew = false;
        try {
          const raw = readFileSync(configPath, 'utf8');
          existing = JSON.parse(raw);
        } catch {
          existing = {};
        }
      }

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
    lines.push('  1. Restart your editor (Cursor / Claude Desktop / VS Code).');
    lines.push('  2. Ask your AI Agent:');
    lines.push('     \x1b[33m"Migrate this codebase using the BKB MCP tools."\x1b[0m');
  } else {
    lines.push('  No active editors were configured. Please specify target: `bkb mcp install cursor` or `bkb mcp install claude`.');
  }
  lines.push('');

  return lines.join('\n');
}
