/**
 * Test Suite: Checkpoint self-healing (`test/runnerCheckpointHeal.test.ts`).
 *
 * A checkpoint-gate failure is a runtime/behavioural regression (failing tests,
 * snapshot mismatch, boot error). The runner must feed those errors back to the
 * LLM for one self-healing pass *inside the loop* instead of aborting, so
 * fidelity problems are resolved along the way rather than at Phase 4.
 *
 * Strategy: reuse the real demo-repo + express-to-fastify pack (which reliably
 * reaches a checkpoint), but override `checkpointTestCmd` with a gate that fails
 * the first time it runs and passes afterwards.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, cpSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runAutonomousMigration } from '../src/runner/autonomousRunner';
import { ensureFalkorDB } from '../src/engine/docker';

const WORKSPACE = resolve(import.meta.dirname, '..');
const SOURCE_REPO = resolve(WORKSPACE, 'demo-repo');
const SCRATCH_DIR = resolve(WORKSPACE, 'scratch');
const REPO = resolve(SCRATCH_DIR, 'checkpoint-heal-repo');
const PACK = resolve(SCRATCH_DIR, 'checkpoint-heal-pack.json');
const GRAPH = 'bkb_checkpoint_heal_test';

describe('Autonomous runner — checkpoint self-healing', () => {
  it('re-prompts the LLM on a checkpoint failure instead of aborting', async () => {
    await ensureFalkorDB();

    // 1. Isolated copy of demo-repo
    rmSync(REPO, { recursive: true, force: true });
    mkdirSync(REPO, { recursive: true });
    for (const entry of ['src', 'scripts', 'test']) {
      cpSync(resolve(SOURCE_REPO, entry), resolve(REPO, entry), { recursive: true });
    }
    cpSync(resolve(SOURCE_REPO, 'package.json'), resolve(REPO, 'package.json'));
    cpSync(resolve(SOURCE_REPO, 'tsconfig.json'), resolve(REPO, 'tsconfig.json'));
    symlinkSync(resolve(SOURCE_REPO, 'node_modules'), resolve(REPO, 'node_modules'), 'junction');

    // 2. Stateful gate: fails on first run, passes afterwards.
    writeFileSync(
      join(REPO, 'checkpoint-gate.mjs'),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        "if (existsSync('.healed')) process.exit(0);",
        "writeFileSync('.healed', '1');",
        "console.error('checkpoint not yet healed');",
        'process.exit(1);',
      ].join('\n'),
    );

    // 3. Clone the express-to-fastify pack, swap in the stateful checkpoint gate.
    const basePack = JSON.parse(readFileSync(resolve(WORKSPACE, 'packs', 'express-to-fastify.json'), 'utf8'));
    basePack.id = 'checkpoint-heal-test';
    basePack.sourceGlobs = { include: ['src/**/*.ts'], exclude: ['**/*.d.ts', '**/node_modules/**'] };
    basePack.verification = {
      ...basePack.verification,
      checkpointTestCmd: 'node checkpoint-gate.mjs',
    };
    writeFileSync(PACK, JSON.stringify(basePack, null, 2));

    const actions: string[] = [];
    const result = await runAutonomousMigration({
      repoPath: REPO,
      packId: PACK,
      graphName: GRAPH,
      provider: 'mock',
      maxSteps: 30,
      reset: true,
      autoRollbackOnFailure: true,
      onProgress: (p) => actions.push(p.action),
    });

    assert.equal(result.ok, true, `expected the run to recover, got: ${result.error}`);
    assert.equal(result.checkpointPassed, true);
    assert.ok(
      actions.some((a) => a.includes('Self-healing: fixing checkpoint')),
      `expected a checkpoint self-heal attempt; actions were:\n${actions.join('\n')}`,
    );
    assert.ok(
      actions.some((a) => a.includes('Checkpoint re-gate after self-heal passed')),
      `expected a passing re-gate after self-heal; actions were:\n${actions.join('\n')}`,
    );

    rmSync(REPO, { recursive: true, force: true });
    rmSync(PACK, { force: true });
  });
});
