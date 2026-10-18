import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { rmSync, mkdirSync, cpSync, symlinkSync, existsSync } from 'node:fs';
import { FalkorClient } from '../src/engine/falkorClient';
import { MigrationGraphManager } from '../src/engine/graphManager';
import * as Q from '../src/engine/queries';

const sourceRepo = resolve(import.meta.dirname, '../demo-repo');
const scratchRepo = resolve(import.meta.dirname, '../scratch/init-graph-test-repo');
const packId = 'express-to-fastify';
const testGraphName = 'shift_m1_test';

test('initMigrationGraph initializes demo-repo in FalkorDB', async () => {
  rmSync(scratchRepo, { recursive: true, force: true });
  mkdirSync(scratchRepo, { recursive: true });
  cpSync(resolve(sourceRepo, 'src'), resolve(scratchRepo, 'src'), { recursive: true });
  cpSync(resolve(sourceRepo, 'scripts'), resolve(scratchRepo, 'scripts'), { recursive: true });
  cpSync(resolve(sourceRepo, 'test'), resolve(scratchRepo, 'test'), { recursive: true });
  cpSync(resolve(sourceRepo, 'package.json'), resolve(scratchRepo, 'package.json'));
  cpSync(resolve(sourceRepo, 'tsconfig.json'), resolve(scratchRepo, 'tsconfig.json'));
  if (existsSync(resolve(sourceRepo, 'node_modules'))) {
    symlinkSync(resolve(sourceRepo, 'node_modules'), resolve(scratchRepo, 'node_modules'), 'junction');
  }

  const client = await FalkorClient.connect({ graphName: testGraphName });

  try {
    const summary = await MigrationGraphManager.initMigrationGraph({
      repoPath: scratchRepo,
      packId,
      client,
      reset: true,
    });

    console.log('initMigrationGraph summary:', summary);
    assert.equal(summary.totalModules, 9);
    assert.equal(summary.cleanModules, 2);
    assert.equal(summary.pendingModules, 7);
    assert.equal(summary.baselineRoutesCount, 5);

    // 1. Verify :MigrationMeta node
    const metaRows = await client.query<any>(
      `MATCH (meta:MigrationMeta {repo_path: $repoPath, pack_id: $packId}) RETURN meta.baseline_routes AS routes`,
      { repoPath: scratchRepo, packId },
    );
    assert.equal(metaRows.length, 1);
    const routes = JSON.parse(metaRows[0].routes);
    assert.deepEqual(routes, [
      'GET /orders',
      'GET /orders/:id',
      'GET /users',
      'GET /users/:id',
      'POST /users',
    ]);

    // 2. Verify :Module nodes and statuses
    const modRows = await client.query<any>(
      `MATCH (m:Module) RETURN m.path AS path, m.status AS status, m.scc_size AS scc_size, m.pagerank AS pr ORDER BY m.path`,
    );
    assert.equal(modRows.length, 9);

    const hashMod = modRows.find((r) => r.path === 'src/utils/hash.ts');
    assert.equal(hashMod.status, 'CLEAN');

    const serverMod = modRows.find((r) => r.path === 'src/server.ts');
    assert.equal(serverMod.status, 'CLEAN');

    const respMod = modRows.find((r) => r.path === 'src/utils/response.ts');
    assert.equal(respMod.status, 'PENDING');
    assert.ok(respMod.pr > 0);

    // 3. Verify audit SCC cycle
    const auditA = await client.query<any>(`MATCH (m:Module {path: 'src/services/auditA.ts'}) RETURN m.scc_id AS sccId, m.scc_size AS size`);
    const auditB = await client.query<any>(`MATCH (m:Module {path: 'src/services/auditB.ts'}) RETURN m.scc_id AS sccId, m.scc_size AS size`);
    assert.equal(auditA[0].sccId, auditB[0].sccId);
    assert.equal(auditA[0].size, 2);

    // 4. Verify symbols
    const symRows = await client.query<any>(
      `MATCH (m:Module {path: 'src/utils/response.ts'})-[:DECLARES]->(s:Symbol) RETURN s.name AS name, s.kind AS kind`,
    );
    const symNames = symRows.map((r) => r.name);
    assert.ok(symNames.includes('sendSuccess'));
    assert.ok(symNames.includes('sendError'));

    // 5. Verify USES_API edges
    const apiUsages = await client.query<any>(
      `MATCH (m:Module {path: 'src/utils/response.ts'})-[r:USES_API]->(api:ExternalAPI) RETURN api.id AS ruleId, r.line AS line`,
    );
    assert.ok(apiUsages.length > 0);
    assert.ok(apiUsages.some((u) => u.ruleId === 'express-res-methods'));

    // 6. Verify pending callers count on response.ts
    const respCallers = await client.query<any>(
      `MATCH (m:Module {path: 'src/utils/response.ts'}) RETURN m.pending_callers_count AS callers`,
    );
    assert.equal(respCallers[0].callers, 3);
  } finally {
    await client.reset();
    await client.close();
    rmSync(scratchRepo, { recursive: true, force: true });
  }
});
