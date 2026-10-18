/**
 * Tests for Git-Native Migration Manifest (`src/engine/manifest.ts`).
 * Validates manifest initialization, persistence, step recording, and graph reconciliation.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initOrUpdateManifest,
  loadManifest,
  saveManifest,
  recordStepInManifest,
  reconcileGraphWithManifest,
  getManifestPath,
  type MigrationManifest,
} from '../src/engine/manifest';
import { FalkorClient } from '../src/engine/falkorClient';
import { ensureFalkorDB } from '../src/engine/docker';
import * as Q from '../src/engine/queries';

describe('Git-Native Migration Manifest Subsystem', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = mkdtempSync(join(tmpdir(), 'bkb-manifest-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempRepo, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('initOrUpdateManifest creates a new .bkb/manifest.json with baseline and modules', () => {
    const manifest = initOrUpdateManifest({
      repoPath: tempRepo,
      packId: 'express-to-fastify',
      baselineSnapshot: {
        snapshotType: 'route-surface',
        entryCount: 2,
        entries: ['GET /api/health', 'POST /api/login'],
        command: 'node scripts/dump-routes.mjs',
      },
      modules: [
        { path: 'src/utils/resp.ts', status: 'PENDING', sccId: 1 },
        { path: 'src/config.ts', status: 'CLEAN', sccId: 2 },
      ],
    });

    assert.equal(manifest.version, '1.0.0');
    assert.equal(manifest.packId, 'express-to-fastify');
    assert.equal(manifest.phase, 'SHIM');
    assert.equal(manifest.baseline.entryCount, 2);
    assert.deepEqual(manifest.baseline.entries, ['GET /api/health', 'POST /api/login']);
    assert.equal(manifest.modules['src/utils/resp.ts'].status, 'PENDING');
    assert.equal(manifest.modules['src/config.ts'].status, 'CLEAN');
    assert.equal(manifest.history.length, 1);
    assert.equal(manifest.history[0].phase, 'INIT');

    const manifestPath = getManifestPath(tempRepo);
    assert.ok(existsSync(manifestPath));
    const loaded = loadManifest(tempRepo);
    assert.ok(loaded);
    assert.equal(loaded.packId, 'express-to-fastify');
  });

  test('recordStepInManifest records progress, invariants, and updates module status', () => {
    initOrUpdateManifest({
      repoPath: tempRepo,
      packId: 'express-to-fastify',
      baselineSnapshot: {
        snapshotType: 'route-surface',
        entryCount: 2,
        entries: ['GET /api/health', 'POST /api/login'],
      },
      modules: [
        { path: 'src/utils/resp.ts', status: 'PENDING' },
        { path: 'src/routes/auth.ts', status: 'PENDING' },
      ],
    });

    const updated = recordStepInManifest(tempRepo, {
      step: 1,
      phase: 'SHIM',
      modules: ['src/utils/resp.ts'],
      status: 'SHIMMED',
      action: 'Applied dual Express/Fastify shim to response helper',
      verifiedBy: 'DeepSeek-V4.1-Flash',
      commitSha: 'abc1234',
      invariants: {
        compilerErrors: 0,
        matchedRoutes: 2,
        legacyUsageShimmed: true,
      },
    });

    assert.ok(updated);
    assert.equal(updated.modules['src/utils/resp.ts'].status, 'SHIMMED');
    assert.equal(updated.modules['src/utils/resp.ts'].phase, 'SHIM');
    assert.equal(updated.modules['src/utils/resp.ts'].step, 1);
    assert.equal(updated.modules['src/utils/resp.ts'].verifiedCommit, 'abc1234');
    assert.equal(updated.modules['src/routes/auth.ts'].status, 'PENDING');

    assert.equal(updated.history.length, 2);
    const last = updated.history[1];
    assert.equal(last.step, 1);
    assert.equal(last.phase, 'SHIM');
    assert.equal(last.commitSha, 'abc1234');
    assert.deepEqual(last.modules, ['src/utils/resp.ts']);

    // Verify it was persisted to disk
    const onDisk = loadManifest(tempRepo);
    assert.equal(onDisk?.modules['src/utils/resp.ts'].status, 'SHIMMED');
  });

  test('recordStepInManifest advances the top-level manifest phase', () => {
    initOrUpdateManifest({
      repoPath: tempRepo,
      packId: 'express-to-fastify',
      baselineSnapshot: {
        snapshotType: 'route-surface',
        entryCount: 1,
        entries: ['GET /api/health'],
      },
      modules: [{ path: 'src/utils/resp.ts', status: 'PENDING' }],
    });
    assert.equal(loadManifest(tempRepo)?.phase, 'SHIM');

    const updated = recordStepInManifest(tempRepo, {
      step: 2,
      phase: 'DE_SHIM',
      modules: ['src/utils/resp.ts'],
      status: 'VERIFIED',
      action: 'Removed legacy shim',
    });

    assert.equal(updated?.phase, 'DE_SHIM');
    assert.equal(loadManifest(tempRepo)?.phase, 'DE_SHIM');
  });

  test('initOrUpdateManifest preserves existing verified module states on repeated init', () => {
    initOrUpdateManifest({
      repoPath: tempRepo,
      packId: 'express-to-fastify',
      baselineSnapshot: {
        snapshotType: 'route-surface',
        entryCount: 2,
        entries: ['GET /api/health', 'POST /api/login'],
      },
      modules: [
        { path: 'src/utils/resp.ts', status: 'PENDING' },
        { path: 'src/routes/auth.ts', status: 'PENDING' },
      ],
    });

    recordStepInManifest(tempRepo, {
      step: 1,
      phase: 'SHIM',
      modules: ['src/utils/resp.ts'],
      status: 'SHIMMED',
      action: 'Shimmed response',
      commitSha: 'commit111',
    });

    // Re-run init as if another engineer ran `bkb init`
    const reloaded = initOrUpdateManifest({
      repoPath: tempRepo,
      packId: 'express-to-fastify',
      baselineSnapshot: {
        snapshotType: 'route-surface',
        entryCount: 99,
        entries: ['NEW DUMP ROUTE SHOULD BE IGNORED'],
      },
      modules: [
        { path: 'src/utils/resp.ts', status: 'PENDING' },
        { path: 'src/routes/auth.ts', status: 'PENDING' },
        { path: 'src/routes/new.ts', status: 'PENDING' },
      ],
    });

    // src/utils/resp.ts should still be SHIMMED, not PENDING!
    assert.equal(reloaded.modules['src/utils/resp.ts'].status, 'SHIMMED');
    assert.equal(reloaded.modules['src/utils/resp.ts'].verifiedCommit, 'commit111');
    assert.equal(reloaded.modules['src/routes/new.ts'].status, 'PENDING');
    // Baseline entries should be preserved
    assert.equal(reloaded.baseline.entryCount, 2);
  });

  test('initOrUpdateManifest resets module states when reset: true is specified', () => {
    initOrUpdateManifest({
      repoPath: tempRepo,
      packId: 'express-to-fastify',
      baselineSnapshot: {
        snapshotType: 'route-surface',
        entryCount: 2,
        entries: ['GET /api/health', 'POST /api/login'],
      },
      modules: [{ path: 'src/utils/resp.ts', status: 'PENDING' }],
    });

    recordStepInManifest(tempRepo, {
      step: 1,
      phase: 'SHIM',
      modules: ['src/utils/resp.ts'],
      status: 'SHIMMED',
      action: 'Shimmed response',
    });

    // Now re-run with reset: true
    const resetManifest = initOrUpdateManifest({
      repoPath: tempRepo,
      packId: 'express-to-fastify',
      reset: true,
      baselineSnapshot: {
        snapshotType: 'route-surface',
        entryCount: 1,
        entries: ['GET /api/health'],
      },
      modules: [{ path: 'src/utils/resp.ts', status: 'PENDING' }],
    });

    assert.equal(resetManifest.modules['src/utils/resp.ts'].status, 'PENDING');
  });

  test('reconcileGraphWithManifest synchronizes FalkorDB node statuses from manifest', async () => {
    await ensureFalkorDB();
    const client = await FalkorClient.connect({
      url: 'falkor://127.0.0.1:6379',
      graphName: 'bkb_manifest_reconcile_test',
    });

    try {
      await client.reset();

      // Create test nodes in FalkorDB
      await client.query(`
        CREATE (m1:Module {path: 'src/a.ts', status: 'PENDING', in_degree: 0, pending_callers_count: 0})
        CREATE (m2:Module {path: 'src/b.ts', status: 'PENDING', in_degree: 1, pending_callers_count: 1})
        CREATE (m2)-[:CALLS {count: 1, symbols: '["foo"]'}]->(m1)
      `);

      const manifest: MigrationManifest = {
        version: '1.0.0',
        packId: 'express-to-fastify',
        migrationEpoch: new Date().toISOString(),
        phase: 'SHIM',
        baseline: {
          snapshotType: 'route-surface',
          entryCount: 1,
          entries: ['GET /test'],
        },
        modules: {
          'src/a.ts': {
            status: 'SHIMMED',
            phase: 'SHIM',
            step: 1,
          },
          'src/b.ts': {
            status: 'PENDING',
          },
        },
        history: [],
      };

      const { reconciledNodes } = await reconcileGraphWithManifest(client, manifest);
      assert.equal(reconciledNodes, 1);

      // Verify node status in FalkorDB
      const rows = await client.roQuery<{ path: string; status: string; phase: string }>(
        `MATCH (m:Module) RETURN m.path AS path, m.status AS status, m.claimed_phase AS phase ORDER BY m.path`,
      );

      assert.equal(rows[0].path, 'src/a.ts');
      assert.equal(rows[0].status, 'SHIMMED');
      assert.equal(rows[0].phase, 'SHIM');

      assert.equal(rows[1].path, 'src/b.ts');
      assert.equal(rows[1].status, 'PENDING');
    } finally {
      await client.close();
    }
  });
});
