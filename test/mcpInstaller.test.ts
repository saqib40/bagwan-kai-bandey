import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateServerConfig,
  generateOpencodeConfig,
  installMcpConfig,
  formatMcpInstallReport,
  buildOpencodeAddCommand,
} from '../src/cli/mcpInstaller';

test('bkb mcp install: generates valid server configuration', () => {
  const config = generateServerConfig('/path/to/cli.ts', '/my/repo', 'express-to-fastify');
  assert.equal(config.command, 'npx');
  assert.deepEqual(config.args, [
    '-y',
    'tsx',
    '/path/to/cli.ts',
    'serve',
    '--repo',
    '/my/repo',
    '--pack',
    'express-to-fastify',
  ]);
});

test('bkb mcp install: quotes opencode arguments that contain spaces', () => {
  const command = buildOpencodeAddCommand(['npx', '-y', 'tsx', '/path/My Repo/cli.ts', 'serve']);
  assert.equal(
    command,
    "opencode mcp add bkb -- npx -y tsx '/path/My Repo/cli.ts' serve",
  );
});

test('bkb mcp install: generates valid opencode configuration', () => {
  const config = generateOpencodeConfig('/path/to/cli.ts', '/my/repo', 'express-to-fastify');
  assert.equal(config.type, 'local');
  assert.equal(config.enabled, true);
  assert.deepEqual(config.command, [
    'npx',
    '-y',
    'tsx',
    '/path/to/cli.ts',
    'serve',
    '--repo',
    '/my/repo',
    '--pack',
    'express-to-fastify',
  ]);
});

test('bkb mcp install: installs into custom workspace directory idempotently', async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'bkb-mcp-test-'));

  try {
    const results = await installMcpConfig('vscode', {
      cliPath: '/test/bin/cli.ts',
      repoPath: '/test/repo',
      packId: 'express-to-fastify',
      workspaceRoot: scratchDir,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.status, 'created');

    const expectedFile = join(scratchDir, '.vscode', 'mcp.json');
    assert.ok(existsSync(expectedFile));

    const content = JSON.parse(readFileSync(expectedFile, 'utf8'));
    assert.ok(content.mcpServers?.bkb);
    assert.equal(content.mcpServers.bkb.command, 'npx');
    assert.equal(content.mcpServers.bkb.args[0], '-y');
    assert.equal(content.mcpServers.bkb.args[1], 'tsx');

    // Second run: test idempotency
    const rerun = await installMcpConfig('vscode', {
      cliPath: '/test/bin/cli.ts',
      repoPath: '/test/repo',
      packId: 'express-to-fastify',
      workspaceRoot: scratchDir,
    });

    assert.equal(rerun[0]?.status, 'already_configured');

    const report = formatMcpInstallReport(results);
    assert.ok(report.includes('1-Click MCP Setup'));
    assert.ok(report.includes('[VSCODE]'));
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('bkb mcp install: installs opencode config into custom workspace directory idempotently', async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'bkb-mcp-opencode-test-'));

  try {
    const results = await installMcpConfig('opencode', {
      cliPath: '/test/bin/cli.ts',
      repoPath: '/test/repo',
      packId: 'express-to-fastify',
      workspaceRoot: scratchDir,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.status, 'created');

    const expectedFile = join(scratchDir, 'opencode.json');
    assert.ok(existsSync(expectedFile));

    const content = JSON.parse(readFileSync(expectedFile, 'utf8'));
    assert.ok(content.mcp?.servers?.bkb);
    assert.equal(content.mcp.servers.bkb.type, 'local');
    assert.deepEqual(content.mcp.servers.bkb.command, [
      'npx',
      '-y',
      'tsx',
      '/test/bin/cli.ts',
      'serve',
      '--repo',
      '/test/repo',
      '--pack',
      'express-to-fastify',
    ]);

    // Second run: test idempotency
    const rerun = await installMcpConfig('opencode', {
      cliPath: '/test/bin/cli.ts',
      repoPath: '/test/repo',
      packId: 'express-to-fastify',
      workspaceRoot: scratchDir,
    });

    assert.equal(rerun[0]?.status, 'already_configured');

    const report = formatMcpInstallReport(results);
    assert.ok(report.includes('1-Click MCP Setup'));
    assert.ok(report.includes('[OPENCODE]'));
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('bkb mcp install: does not overwrite a config it cannot parse', async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'bkb-mcp-jsonc-'));
  const configPath = join(scratchDir, '.vscode', 'mcp.json');
  const original = '{\n  // comment\n  "mcpServers": {}\n}\n';

  try {
    mkdirSync(join(scratchDir, '.vscode'), { recursive: true });
    writeFileSync(configPath, original);

    const results = await installMcpConfig('vscode', {
      cliPath: '/test/bin/cli.ts',
      workspaceRoot: scratchDir,
    });

    assert.equal(results[0]?.status, 'failed');
    assert.equal(readFileSync(configPath, 'utf8'), original);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

