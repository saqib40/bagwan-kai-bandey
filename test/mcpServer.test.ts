/**
 * Integration tests for Shift MCP Server (`src/mcp/server.ts`).
 * Uses InMemoryTransport and official MCP Client to exercise all 6 tools.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createShiftMcpServer } from '../src/mcp/server';
import { setupScratchRepo, cleanupScratchRepo } from './helpers/scratchRepo';

const sourceRepo = resolve(import.meta.dirname, '../demo-repo');
const scratchRepo = resolve(import.meta.dirname, '../scratch/mcp-server-test-repo');
const packId = 'express-to-fastify';
const testGraphName = 'shift_mcp_test';

test('verify_and_commit_node accepts a call that omits agentSummary', async () => {
  setupScratchRepo(sourceRepo, scratchRepo);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createShiftMcpServer({
    defaultRepoPath: scratchRepo,
    defaultPackId: packId,
    graphName: testGraphName,
  });
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);

  try {
    const { tools } = await client.listTools();
    const verify = tools.find((t) => t.name === 'verify_and_commit_node');
    const required = (verify?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
    assert.ok(required.includes('modulePaths'));
    assert.equal(required.includes('agentSummary'), false);
    const init = tools.find((t) => t.name === 'init_migration_graph');
    const resetDefault = (init?.inputSchema as { properties?: { reset?: { default?: boolean } } } | undefined)
      ?.properties?.reset?.default;
    assert.equal(resetDefault, false);
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /advance_migration/);
    assert.match(instructions, /claim_next_leaf/);
    assert.match(instructions, /get_migration_slice/);
    assert.match(instructions, /verify_and_commit_node/);
  } finally {
    await client.close();
    await server.close();
    cleanupScratchRepo(scratchRepo);
  }
});

test('BKB MCP Server exposes 6 tools and executes end-to-end tool calls', async () => {
  setupScratchRepo(sourceRepo, scratchRepo);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = createShiftMcpServer({
    defaultRepoPath: scratchRepo,
    defaultPackId: packId,
    graphName: testGraphName,
  });

  await server.connect(serverTransport);

  const client = new Client(
    { name: 'test-agent', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(clientTransport);

  try {
    // 1. List tools and verify all tools exist
    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name).sort();
    const expectedTools = [
      'advance_migration',
      'bkb_commit_milestone',
      'bkb_get_migration_status',
      'claim_next_leaf',
      'commit_milestone',
      'get_migration_audit_trail',
      'get_migration_slice',
      'get_migration_status',
      'init_migration_graph',
      'simulate_blast_radius',
      'verify_and_commit_node',
    ].sort();

    assert.deepEqual(toolNames, expectedTools);

    // 2. Test init_migration_graph
    const initRes = await client.callTool({
      name: 'init_migration_graph',
      arguments: {
        repoPath: scratchRepo,
        packId,
        reset: true,
      },
    });

    assert.equal(initRes.isError ?? false, false);
    const initData = JSON.parse((initRes.content as any)[0].text);
    assert.equal(initData.summary.totalModules, 9);
    assert.equal(initData.summary.cleanModules, 2);
    assert.equal(initData.summary.pendingModules, 7);
    assert.equal(initData.summary.baselineRoutesCount, 5);

    // 3. Test claim_next_leaf
    const claimRes = await client.callTool({
      name: 'claim_next_leaf',
      arguments: {},
    });

    assert.equal(claimRes.isError ?? false, false);
    const claimData = JSON.parse((claimRes.content as any)[0].text);
    assert.equal(claimData.claimed, true);
    assert.equal(claimData.phase, 'SHIM');
    assert.deepEqual(claimData.targetPaths, ['src/utils/response.ts']);
    assert.equal(claimData.pendingCallersCount, 3);
    assert.ok(claimData.proof.includes('src/utils/response.ts'));

    // 4. Test get_migration_slice
    const sliceRes = await client.callTool({
      name: 'get_migration_slice',
      arguments: {
        modulePaths: ['src/utils/response.ts'],
        phase: 'SHIM',
      },
    });

    assert.equal(sliceRes.isError ?? false, false);
    const sliceData = JSON.parse((sliceRes.content as any)[0].text);
    assert.equal(sliceData.phase, 'SHIM');
    assert.equal(sliceData.targetModules.length, 1);
    assert.equal(sliceData.targetModules[0].path, 'src/utils/response.ts');
    assert.ok(sliceData.targetModules[0].fullSource.includes('sendSuccess'));
    assert.ok(sliceData.guidance.includes('// @shift-shim'));

    // 5. Test simulate_blast_radius
    const blastRes = await client.callTool({
      name: 'simulate_blast_radius',
      arguments: {
        modulePath: 'src/utils/response.ts',
      },
    });

    assert.equal(blastRes.isError ?? false, false);
    const blastData = JSON.parse((blastRes.content as any)[0].text);
    assert.equal(blastData.targetModule, 'src/utils/response.ts');
    assert.ok(blastData.impactedCount >= 3);

    // 6. Test get_migration_audit_trail
    const auditRes = await client.callTool({
      name: 'get_migration_audit_trail',
      arguments: {
        runCheckpointNow: false,
      },
    });

    assert.equal(auditRes.isError ?? false, false);
    const auditData = JSON.parse((auditRes.content as any)[0].text);
    assert.ok(typeof auditData.reportMarkdown === 'string');
    assert.ok(
      auditData.reportMarkdown.includes('# Bagwan Kai Bandey Migration Audit Trail') ||
      auditData.reportMarkdown.includes('# Shift Migration Audit Trail'),
    );

    // 7. Test get_migration_status & bkb_get_migration_status
    const statusRes = await client.callTool({
      name: 'get_migration_status',
      arguments: {},
    });
    assert.equal(statusRes.isError ?? false, false);
    const statusData = JSON.parse((statusRes.content as any)[0].text);
    assert.equal(statusData.packId, packId);
    assert.ok(statusData.progress.totalModules > 0);
    assert.ok(typeof statusData.progress.percentComplete === 'string');

    const bkbStatusRes = await client.callTool({
      name: 'bkb_get_migration_status',
      arguments: {},
    });
    assert.equal(bkbStatusRes.isError ?? false, false);
  } finally {
    await client.close();
    await server.close();
    cleanupScratchRepo(scratchRepo);
  }
});
