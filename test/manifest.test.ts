/**
 * Tests for Git-Native Migration Manifest (`src/engine/manifest.ts`).
 * Validates manifest initialization, persistence, step recording, and graph reconciliation.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
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

  test('initOrUpdateManifest creates a per-pack manifest with baseline and modules', () => {
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

    const manifestPath = getManifestPath(tempRepo, 'express-to-fastify');
    assert.ok(existsSync(manifestPath));
    assert.ok(manifestPath.endsWith(join('.bkb', 'manifests', 'express-to-fastify.json')));
    const loaded = loadManifest(tempRepo, 'express-to-fastify');
    assert.ok(loaded);
    assert.equal(loaded.packId, 'express-to-fastify');
    // No pack id is fine when only one manifest exists.
    assert.equal(loadManifest(tempRepo)?.packId, 'express-to-fastify');
  });

  test('per-pack manifests are isolated (a second pack does not clobber the first)', () => {
    initOrUpdateManifest({
      repoPath: tempRepo,
      packId: 'express-to-fastify',
      baselineSnapshot: { snapshotType: 'route-surface', entryCount: 2, entries: ['GET /a', 'GET /b'] },
      modules: [{ path: 'src/a.ts', status: 'PENDING' }],
    });
    recordStepInManifest(tempRepo, {
      packId: 'express-to-fastify',
      step: 1,
      phase: 'SHIM',
      modules: ['src/a.ts'],
      status: 'SHIMMED',
      action: 'shim a',
    });

    initOrUpdateManifest({
      repoPath: tempRepo,
      packId: 'jest-to-vitest',
      baselineSnapshot: { snapshotType: 'test-counts', entryCount: 10, entries: ['10 tests'] },
      modules: [{ path: 'test/a.test.ts', status: 'PENDING' }],
    });

    // Both manifests coexist on disk.
    const express = loadManifest(tempRepo, 'express-to-fastify');
    const jest = loadManifest(tempRepo, 'jest-to-vitest');
    assert.equal(express?.packId, 'express-to-fastify');
    assert.equal(express?.modules['src/a.ts'].status, 'SHIMMED');
    assert.equal(express?.baseline.entryCount, 2);
    assert.equal(jest?.packId, 'jest-to-vitest');
    assert.equal(jest?.baseline.entryCount, 10);

    // Without a pack id the result is ambiguous, so it must not guess.
    assert.equal(loadManifest(tempRepo), null);
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

  test('initOrUpdateManifest persists all snapshots and per-module baseline sets', () => {
    const manifest = initOrUpdateManifest({
      repoPath: tempRepo,
      packId: 'express-to-fastify',
      baselineSnapshot: {
        snapshotType: 'route-surface',
        entryCount: 1,
        entries: ['GET /a'],
        snapshots: { 'route-surface': '["GET /a"]', 'export-surface': '["foo","bar"]' },
      },
      modules: [
        {
          path: 'src/a.ts',
          status: 'PENDING',
          baselineSets: { routes: ['GET /a'] },
        },
      ],
    });

    assert.deepEqual(manifest.baseline.snapshots, {
      'route-surface': '["GET /a"]',
      'export-surface': '["foo","bar"]',
    });
    assert.deepEqual(manifest.modules['src/a.ts'].baselineSets, { routes: ['GET /a'] });

    const onDisk = loadManifest(tempRepo);
    assert.deepEqual(onDisk?.baseline.snapshots, {
      'route-surface': '["GET /a"]',
      'export-surface': '["foo","bar"]',
    });
    assert.deepEqual(onDisk?.modules['src/a.ts'].baselineSets, { routes: ['GET /a'] });
  });

  test('saveManifest writes atomically and leaves no temp/lock artifacts', () => {
    initOrUpdateManifest({
      repoPath: tempRepo,
      packId: 'express-to-fastify',
      baselineSnapshot: { snapshotType: 'route-surface', entryCount: 0, entries: [] },
      modules: [{ path: 'src/a.ts', status: 'PENDING' }],
    });

    for (let i = 0; i < 20; i++) {
      recordStepInManifest(tempRepo, {
        packId: 'express-to-fastify',
        step: i + 1,
        phase: 'SHIM',
        modules: ['src/a.ts'],
        status: 'SHIMMED',
        action: `step ${i}`,
      });
    }

    const bkbDir = join(tempRepo, '.bkb');
    const leftovers = (readdirSync(bkbDir, { recursive: true }) as string[]).filter(
      (f) => f.endsWith('.tmp') || f.endsWith('.lock'),
    );
    assert.deepEqual(leftovers, []);

    const manifest = loadManifest(tempRepo);
    assert.equal(manifest?.history.length, 21);
    assert.equal(manifest?.modules['src/a.ts'].step, 20);
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
            baselineSets: { routes: ['GET /a'] },
          },
          'src/b.ts': {
            status: 'PENDING',
          },
        },
        history: [],
      };

      const { reconciledNodes, restoredBaselineSets } = await reconcileGraphWithManifest(client, manifest);
      assert.equal(reconciledNodes, 1);
      assert.equal(restoredBaselineSets, 1);

      // Verify node status in FalkorDB
      const rows = await client.roQuery<{ path: string; status: string; phase: string; baselineSets: string }>(
        `MATCH (m:Module) RETURN m.path AS path, m.status AS status, m.claimed_phase AS phase, m.baseline_sets AS baselineSets ORDER BY m.path`,
      );

      assert.equal(rows[0].path, 'src/a.ts');
      assert.equal(rows[0].status, 'SHIMMED');
      assert.equal(rows[0].phase, 'SHIM');
      assert.deepEqual(JSON.parse(rows[0].baselineSets), { routes: ['GET /a'] });

      assert.equal(rows[1].path, 'src/b.ts');
      assert.equal(rows[1].status, 'PENDING');
    } finally {
      await client.close();
    }
  });
});
