/**
 * Test Suite: Autonomous Runner & Rollback System (`test/runner.test.ts`).
 *
 * Validates:
 *  1. saveCheckpoint, listCheckpoints, rollbackToCheckpoint, and clearCheckpoints
 *  2. runAutonomousMigration with mock deterministic provider on scratch demo repo
 *  3. Verifies post-migration route parity and tests pass cleanly
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import {
  saveCheckpoint,
  listCheckpoints,
  rollbackToCheckpoint,
  clearCheckpoints,
} from '../src/runner/rollback';
import { runAutonomousMigration } from '../src/runner/autonomousRunner';
import { ensureFalkorDB } from '../src/engine/docker';

const WORKSPACE = resolve(import.meta.dirname, '..');
const SOURCE_REPO = resolve(WORKSPACE, 'demo-repo');
const SCRATCH_DIR = resolve(WORKSPACE, 'scratch');
const RUNNER_TEST_REPO = resolve(SCRATCH_DIR, 'runner-test-repo');
const TEST_GRAPH = 'bkb_runner_test';

describe('BKB Checkpoint & Rollback System', () => {
  const dummyRepo = resolve(SCRATCH_DIR, 'dummy-rollback-repo');

  it('saves checkpoints and lists them in order', () => {
    rmSync(dummyRepo, { recursive: true, force: true });
    mkdirSync(join(dummyRepo, 'src'), { recursive: true });
    writeFileSync(join(dummyRepo, 'src', 'index.ts'), 'export const a = 1;\n');

    clearCheckpoints(dummyRepo);
    assert.deepEqual(listCheckpoints(dummyRepo), []);

    saveCheckpoint(dummyRepo, 1, ['src/index.ts']);
    assert.deepEqual(listCheckpoints(dummyRepo), [1]);

    saveCheckpoint(dummyRepo, 2, ['src/index.ts']);
    assert.deepEqual(listCheckpoints(dummyRepo), [1, 2]);

    clearCheckpoints(dummyRepo);
    assert.deepEqual(listCheckpoints(dummyRepo), []);
    rmSync(dummyRepo, { recursive: true, force: true });
  });

  it('restores files on disk when rolling back to checkpoint', async () => {
    rmSync(dummyRepo, { recursive: true, force: true });
    mkdirSync(join(dummyRepo, 'src'), { recursive: true });
    mkdirSync(join(dummyRepo, 'scripts'), { recursive: true });
    writeFileSync(join(dummyRepo, 'scripts', 'dump-routes.mjs'), 'console.log("[]");\n');
    const file = join(dummyRepo, 'src', 'index.ts');

    // Original state
    writeFileSync(file, 'export const version = "v1.0.0";\n');
    saveCheckpoint(dummyRepo, 1, ['src/index.ts']);

    // Modified state
    writeFileSync(file, 'export const version = "v2.0.0-broken";\n');
    saveCheckpoint(dummyRepo, 2, ['src/index.ts']);

    // Further modified
    writeFileSync(file, 'export const version = "v3.0.0-worse";\n');

    // Rollback to step 1
    const res = await rollbackToCheckpoint(dummyRepo, 'express-to-fastify', 1, 'bkb_dummy_test');
    assert.equal(res.ok, true);
    assert.equal(res.restoredStep, 1);
    assert.equal(readFileSync(file, 'utf8'), 'export const version = "v1.0.0";\n');

    clearCheckpoints(dummyRepo);
    rmSync(dummyRepo, { recursive: true, force: true });
  });
});

describe('BKB Autonomous Migration Runner (`runAutonomousMigration`)', () => {
  it('executes full autonomous migration loop on demo-repo using mock provider', async () => {
    // 1. Ensure FalkorDB container is running
    await ensureFalkorDB();

    // 2. Setup isolated scratch copy of demo-repo
    rmSync(RUNNER_TEST_REPO, { recursive: true, force: true });
    mkdirSync(RUNNER_TEST_REPO, { recursive: true });

    cpSync(resolve(SOURCE_REPO, 'src'), resolve(RUNNER_TEST_REPO, 'src'), { recursive: true });
    cpSync(resolve(SOURCE_REPO, 'scripts'), resolve(RUNNER_TEST_REPO, 'scripts'), { recursive: true });
    cpSync(resolve(SOURCE_REPO, 'test'), resolve(RUNNER_TEST_REPO, 'test'), { recursive: true });
    cpSync(resolve(SOURCE_REPO, 'package.json'), resolve(RUNNER_TEST_REPO, 'package.json'));
    cpSync(resolve(SOURCE_REPO, 'tsconfig.json'), resolve(RUNNER_TEST_REPO, 'tsconfig.json'));
    symlinkSync(resolve(SOURCE_REPO, 'node_modules'), resolve(RUNNER_TEST_REPO, 'node_modules'), 'junction');

    const progressLogs: string[] = [];

    // 3. Run autonomous migration
    const result = await runAutonomousMigration({
      repoPath: RUNNER_TEST_REPO,
      packId: 'express-to-fastify',
      graphName: TEST_GRAPH,
      provider: 'mock',
      maxSteps: 30,
      reset: true,
      autoRollbackOnFailure: true,
      onProgress: (p) => {
        progressLogs.push(`Step ${p.step} [${p.phase}]: ${p.action}`);
      },
    });

    // 4. Assert migration run succeeded
    assert.equal(result.ok, true, `Migration failed with error: ${result.error}`);
    assert.ok(result.totalSteps >= 7, `Expected at least 7 steps, got ${result.totalSteps}`);
    assert.equal(result.routeParity, true);
    assert.equal(result.checkpointPassed, true);
    assert.ok(progressLogs.length > 5);

    // 5. Verify the migrated target repository compiles and tests pass
    const tscRes = execSync('npm run typecheck', { cwd: RUNNER_TEST_REPO, encoding: 'utf8' });
    assert.ok(!tscRes.includes('error TS'));

    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;
    const testRes = execSync('npm test', { cwd: RUNNER_TEST_REPO, encoding: 'utf8', env: cleanEnv });
    assert.ok(testRes.includes('pass 6') || testRes.includes('pass 5'));
    assert.ok(testRes.includes('fail 0'));

    const routesOut = execSync('node scripts/dump-routes.mjs', { cwd: RUNNER_TEST_REPO, encoding: 'utf8' }).trim();
    const migratedRoutes = JSON.parse(routesOut);
    assert.equal(migratedRoutes.length, 5);

    // Cleanup scratch repo
    rmSync(RUNNER_TEST_REPO, { recursive: true, force: true });
  });
});
