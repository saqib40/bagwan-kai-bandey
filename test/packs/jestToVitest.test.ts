/**
 * Tests for the `jest-to-vitest` migration pack and `demo-repo-jest` fixture (M3).
 *
 * The AST/query, pack-conformance, and fixture-baseline checks here run without
 * FalkorDB. The full autonomous migration loop is appended in M3.4.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPack, validatePack } from '../../src/engine/packLoader';
import { validatePackQueries } from '../../src/engine/packSemantics';
import { adapterRegistry } from '../../src/adapters/registry';
import { getShimStrategy } from '../../src/adapters/types';

const PACK_PATH = resolve(import.meta.dirname, '../../packs/jest-to-vitest.json');

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
