/**
 * Unit tests for `bkb pack init` scaffolding (Milestone M1.4).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPackTemplate } from '../src/cli/packScaffold';
import { validatePack } from '../src/engine/packLoader';
import { validatePackSemantics, validatePackQueries } from '../src/engine/packSemantics';
import { adapterRegistry } from '../src/adapters/registry';

describe('buildPackTemplate', () => {
  it('produces a pack that passes full validation for typescript', () => {
    const pack = buildPackTemplate('my-pack', 'typescript');
    assert.equal(validatePack(pack).valid, true, validatePack(pack).errors.join('\n'));
    assert.equal(validatePackSemantics(pack).valid, true);
  });

  it('produces a pack that passes structural + schema validation for python', () => {
    const pack = buildPackTemplate('py-pack', 'python');
    assert.equal(validatePack(pack).valid, true, validatePack(pack).errors.join('\n'));
  });

  it('uses per-step invariants and global snapshots', () => {
    const pack = buildPackTemplate('my-pack', 'typescript');
    assert.ok(pack.invariants.every((i) => i.scope === 'per-step'));
    assert.ok(pack.invariants.length > 0);
    assert.equal(pack.verification.snapshots?.[0]?.id, 'route-surface');
    assert.equal(pack.verification.snapshots?.[0]?.kind, 'set');
  });

  it('emits AST queries that compile under the TypeScript adapter', async () => {
    const pack = buildPackTemplate('my-pack', 'typescript');
    const result = await validatePackQueries(pack, adapterRegistry);
    assert.equal(result.skipped, false);
    assert.equal(result.valid, true, result.errors.join('\n'));
  });
});
