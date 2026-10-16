/**
 * Tests for the `cjs-to-esm` migration pack (Milestone M2).
 *
 * The AST/query and pack-conformance checks here run without FalkorDB. The full
 * autonomous migration loop is added in M2.5 and requires FalkorDB/Docker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadPack, validatePack } from '../../src/engine/packLoader';
import { validatePackQueries } from '../../src/engine/packSemantics';
import { adapterRegistry } from '../../src/adapters/registry';
import { getShimStrategy } from '../../src/adapters/types';

const PACK_PATH = resolve(import.meta.dirname, '../../packs/cjs-to-esm.json');

describe('cjs-to-esm pack', () => {
  it('loads and passes structural + semantic + schema validation', () => {
    const pack = loadPack(PACK_PATH);
    assert.equal(pack.id, 'cjs-to-esm');
    assert.equal(pack.language, 'typescript');
    assert.equal(validatePack(pack).valid, true, validatePack(pack).errors.join('\n'));
  });

  it('declares the runtime-interop shim strategy', () => {
    const pack = loadPack(PACK_PATH);
    assert.equal(getShimStrategy(pack), 'runtime-interop');
  });

  it('compiles every detection query under the TypeScript adapter', async () => {
    const pack = loadPack(PACK_PATH);
    const result = await validatePackQueries(pack, adapterRegistry);
    assert.equal(result.skipped, false);
    assert.equal(result.valid, true, result.errors.join('\n'));
  });

  it('declares an export-surface set snapshot', () => {
    const pack = loadPack(PACK_PATH);
    const snap = pack.verification.snapshots?.find((s) => s.id === 'export-surface');
    assert.ok(snap);
    assert.equal(snap?.kind, 'set');
    assert.equal(snap?.command, 'node scripts/dump-exports.mjs');
  });

  it('records the runtime-interop constraints as known limitations', () => {
    const pack = loadPack(PACK_PATH);
    const limitations = (pack.knownLimitations ?? []).join(' ').toLowerCase();
    assert.match(limitations, /22\.12/);
    assert.match(limitations, /top-level await/);
  });
});
