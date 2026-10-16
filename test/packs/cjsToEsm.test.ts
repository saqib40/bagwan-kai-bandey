/**
 * Tests for the `cjs-to-esm` migration pack and demo fixture (Milestone M2).
 *
 * The AST/query, pack-conformance, and fixture-baseline checks here run without
 * FalkorDB. The full autonomous migration loop is appended in M2.5.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPack, validatePack } from '../../src/engine/packLoader';
import { validatePackQueries } from '../../src/engine/packSemantics';
import { adapterRegistry } from '../../src/adapters/registry';
import { getShimStrategy, RUNTIME_INTEROP_MARKER } from '../../src/adapters/types';

const PACK_PATH = resolve(import.meta.dirname, '../../packs/cjs-to-esm.json');
const FIXTURE = resolve(import.meta.dirname, '../../demo-repo-cjs');

const BASELINE_SURFACE = [
  'echoA=function:string',
  'find=function:undefined',
  'formatLine=function:string',
  'labelA=function:string',
  'labelB=function:string',
  'list=function:object',
  'main=function:object',
  'record=function:object',
  'shortHash=function:string',
  'summarize=function:object',
];

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

describe('demo-repo-cjs fixture', () => {
  it('captures the baseline CommonJS export surface', () => {
    const out = execSync('node scripts/dump-exports.mjs', { cwd: FIXTURE, encoding: 'utf8' }).trim();
    assert.deepEqual(JSON.parse(out), BASELINE_SURFACE);
  });

  it('passes the checkpoint smoke test at baseline', () => {
    const out = execSync('node scripts/smoke.mjs', { cwd: FIXTURE, encoding: 'utf8' }).trim();
    assert.equal(out, 'smoke ok');
  });

  it('provides MIGRATE/SHIM/DE_SHIM mocks for every source module', () => {
    const mocks = JSON.parse(readFileSync(resolve(FIXTURE, '.bkb-mocks.json'), 'utf8'));
    const sources = ['src/utils/hash.js', 'src/utils/format.js', 'src/services/ledger.js', 'src/services/audit.js', 'src/services/cycleA.js', 'src/services/cycleB.js', 'src/routes/api.js', 'src/index.js'];
    for (const src of sources) {
      assert.ok(existsSync(resolve(FIXTURE, src)), `${src} must exist`);
      for (const phase of ['MIGRATE', 'SHIM', 'DE_SHIM']) {
        assert.ok(mocks[`${src}:${phase}`]?.code, `missing mock ${src}:${phase}`);
      }
      assert.ok(mocks[`${src}:SHIM`].code.includes(RUNTIME_INTEROP_MARKER), `${src}:SHIM must carry the interop marker`);
      assert.ok(!mocks[`${src}:MIGRATE`].code.includes('@bkb-shim'), `${src}:MIGRATE must not carry shim markers`);
    }
  });

  it('detects CommonJS usage in the baseline sources via the pack rules', async () => {
    const pack = loadPack(PACK_PATH);
    const adapter = adapterRegistry.get('typescript');
    await adapter.init();
    const parsed = await adapter.parseModule(FIXTURE, 'src/index.js', undefined, pack);
    assert.equal(parsed.hasSyntaxError, false, parsed.syntaxErrors.join('; '));
    const ruleIds = new Set(parsed.apiUsages.map((u) => u.ruleId));
    assert.ok(ruleIds.has('cjs-require'));
    assert.ok(ruleIds.has('cjs-module-exports'));
  });
});
