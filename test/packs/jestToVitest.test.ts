/**
 * Tests for the `jest-to-vitest` migration pack and `demo-repo-jest` fixture (M3).
 *
 * The AST/query, pack-conformance, and fixture-baseline checks here run without
 * FalkorDB. The full autonomous migration loop is appended in M3.4.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPack, validatePack } from '../../src/engine/packLoader';
import { validatePackQueries } from '../../src/engine/packSemantics';
import { adapterRegistry } from '../../src/adapters/registry';
import { getShimStrategy } from '../../src/adapters/types';
import { runAutonomousMigration } from '../../src/runner/autonomousRunner';
import { checkPortReachable } from '../../src/cli/doctor';

const PACK_PATH = resolve(import.meta.dirname, '../../packs/jest-to-vitest.json');
const FIXTURE = resolve(import.meta.dirname, '../../demo-repo-jest');
const WORKSPACE = resolve(import.meta.dirname, '../..');

describe('jest-to-vitest pack', () => {
  it('loads and passes structural + semantic + schema validation', () => {
    const pack = loadPack(PACK_PATH);
    assert.equal(pack.id, 'jest-to-vitest');
    assert.equal(pack.language, 'typescript');
    assert.equal(validatePack(pack).valid, true, validatePack(pack).errors.join('\n'));
  });

  it('declares the in-file-branch shim strategy', () => {
    const pack = loadPack(PACK_PATH);
    assert.equal(getShimStrategy(pack), 'in-file-branch');
  });

  it('compiles every detection query under the TypeScript adapter', async () => {
    const pack = loadPack(PACK_PATH);
    const result = await validatePackQueries(pack, adapterRegistry);
    assert.equal(result.skipped, false);
    assert.equal(result.valid, true, result.errors.join('\n'));
  });

  it('declares a test-counts count snapshot', () => {
    const pack = loadPack(PACK_PATH);
    const snap = pack.verification.snapshots?.find((s) => s.id === 'test-counts');
    assert.ok(snap);
    assert.equal(snap?.kind, 'count');
    assert.equal(snap?.command, 'node scripts/test-counts.mjs');
  });

  it('detects jest usage on a sample test module', async () => {
    const pack = loadPack(PACK_PATH);
    const adapter = adapterRegistry.get('typescript');
    await adapter.init();
    const root = mkdtempSync(join(tmpdir(), 'bkb-jest-'));
    try {
      mkdirSync(join(root, 'test'), { recursive: true });
      const source = [
        "import { jest } from '@jest/globals';",
        "const spy = jest.spyOn(console, 'log');",
        "const fn: jest.Mock<string> = jest.fn();",
        "jest.mock('./thing');",
      ].join('\n');
      writeFileSync(join(root, 'test/example.test.ts'), source);
      const parsed = await adapter.parseModule(root, 'test/example.test.ts', undefined, pack);
      assert.equal(parsed.hasSyntaxError, false, parsed.syntaxErrors.join('; '));
      const ruleIds = new Set(parsed.apiUsages.map((u) => u.ruleId));
      assert.ok(ruleIds.has('jest-calls'), 'jest-calls should match');
      assert.ok(ruleIds.has('jest-types'), 'jest-types should match');
      assert.ok(ruleIds.has('jest-globals-import'), 'jest-globals-import should match');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('jest-to-vitest autonomous migration (requires FalkorDB + fixture deps)', () => {
  it('migrates demo-repo-jest from Jest to Vitest without dropping tests', async (t) => {
    if (!existsSync(join(FIXTURE, 'node_modules', '.bin', 'jest')) || !existsSync(join(FIXTURE, 'node_modules', '.bin', 'vitest'))) {
      t.skip('run `npm install` in demo-repo-jest to enable this test');
      return;
    }
    if (!(await checkPortReachable(6379))) {
      t.skip('FalkorDB is not reachable on :6379');
      return;
    }

    const target = resolve(WORKSPACE, 'scratch/jest-vitest-e2e');
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const entry of ['src', 'test', 'scripts']) {
      cpSync(join(FIXTURE, entry), join(target, entry), { recursive: true });
    }
    for (const file of ['package.json', 'tsconfig.json', 'jest.config.cjs', 'vitest.config.mjs', '.bkb-mocks.json']) {
      cpSync(join(FIXTURE, file), join(target, file));
    }
    symlinkSync(join(FIXTURE, 'node_modules'), join(target, 'node_modules'), 'junction');

    const baselineCounts = execSync('node scripts/test-counts.mjs', { cwd: target, encoding: 'utf8' }).trim();

    try {
      const res = await runAutonomousMigration({
        repoPath: target,
        packId: 'jest-to-vitest',
        provider: 'mock',
        graphName: 'bkb_jest_e2e_test',
        reset: true,
        maxSteps: 60,
      });

      assert.equal(res.ok, true, res.error ?? 'migration should succeed');
      assert.equal(res.migratedModules, 4);
      assert.equal(res.checkpointPassed, true);
      assert.equal(res.routeParity, true);

      // 1. No Jest syntax remains anywhere under test/.
      const sources: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.ts')) sources.push(full);
        }
      };
      walk(join(target, 'test'));
      assert.equal(sources.length, 4);
      for (const file of sources) {
        const code = readFileSync(file, 'utf8');
        assert.doesNotMatch(code, /\bjest\./, `${file} still uses jest.*`);
        assert.doesNotMatch(code, /@bkb-shim/, `${file} still contains a shim marker`);
      }

      // 2. Test-count snapshot is unchanged (no dropped tests).
      const migratedCounts = execSync('node scripts/test-counts.mjs', { cwd: target, encoding: 'utf8' }).trim();
      assert.equal(migratedCounts, baselineCounts);
      assert.deepEqual(JSON.parse(migratedCounts), { suites: 3, tests: 12 });

      // 3. Runner-agnostic checkpoint command passes on the migrated suite.
      const out = execSync('node scripts/run-tests.mjs', { cwd: target, encoding: 'utf8' });
      assert.match(out, /vitest/i);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
