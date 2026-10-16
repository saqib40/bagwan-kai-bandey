/**
 * Unit tests for pack semantic + AST-query validation (Milestone M1.3).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MigrationPack } from '../src/adapters/types';
import type { AdapterRegistry } from '../src/adapters/registry';
import { adapterRegistry } from '../src/adapters/registry';
import { validatePack } from '../src/engine/packLoader';
import { validatePackSemantics, validatePackQueries } from '../src/engine/packSemantics';

const EXPRESS_PACK: MigrationPack = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../packs/express-to-fastify.json'), 'utf8'),
);

function pack(overrides: Partial<MigrationPack> = {}): MigrationPack {
  return {
    id: 'p',
    name: 'Pack',
    language: 'typescript',
    sourceGlobs: { include: ['src/**/*.ts'] },
    packages: { legacy: [], target: [] },
    detectionRules: [{ id: 'r', description: 'r', astQuery: '(identifier) @id' }],
    agentGuidance: {},
    invariants: [],
    verification: { perStepTypecheckCmd: 'true', checkpointTestCmd: 'true' },
    ...overrides,
  };
}

describe('validatePackSemantics', () => {
  it('accepts a conforming pack', () => {
    const result = validatePackSemantics(pack());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('rejects checkpoint-scope invariants and points at snapshots', () => {
    const result = validatePackSemantics(
      pack({
        invariants: [{ id: 'legacy-route', scope: 'checkpoint' as any, type: 'route-set', description: 'd', astExtractor: '(id)' }],
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('legacy-route') && e.includes('verification.snapshots')));
  });

  it('reports duplicate detection rule, invariant, and snapshot ids', () => {
    const result = validatePackSemantics(
      pack({
        detectionRules: [
          { id: 'dup', description: 'a', astQuery: '(id)' },
          { id: 'dup', description: 'b', astQuery: '(id)' },
        ],
        invariants: [
          { id: 'inv', scope: 'per-step', type: 't', description: 'd', astExtractor: '(id)' },
          { id: 'inv', scope: 'per-step', type: 't', description: 'd', astExtractor: '(id)' },
        ],
        verification: {
          perStepTypecheckCmd: 'true',
          checkpointTestCmd: 'true',
          snapshots: [
            { id: 's', command: 'echo 1', kind: 'count' },
            { id: 's', command: 'echo 2', kind: 'count' },
          ],
        },
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Duplicate detectionRule id(s): dup')));
    assert.ok(result.errors.some((e) => e.includes('Duplicate invariant id(s): inv')));
    assert.ok(result.errors.some((e) => e.includes('Duplicate snapshot id(s): s')));
  });

  it('is wired into validatePack ahead of schema errors', () => {
    const result = validatePack(
      pack({
        invariants: [{ id: 'legacy-route', scope: 'checkpoint' as any, type: 't', description: 'd', astExtractor: '(id)' }],
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('verification.snapshots')));
    assert.ok(result.errors.every((e) => !e.startsWith('[schema]')));
  });
});

describe('validatePackQueries', () => {
  it('compiles the built-in express pack queries with the TypeScript adapter', async () => {
    const result = await validatePackQueries(EXPRESS_PACK, adapterRegistry);
    assert.equal(result.skipped, false);
    assert.equal(result.valid, true, result.errors.join('\n'));
  });

  it('skips validation when no adapter is registered for the language', async () => {
    const fakeRegistry = { has: () => false } as unknown as AdapterRegistry;
    const result = await validatePackQueries(pack(), fakeRegistry);
    assert.equal(result.skipped, true);
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some((w) => w.includes('no "typescript" adapter')));
  });

  it('skips validation when the adapter does not support it', async () => {
    const fakeRegistry = {
      has: () => true,
      get: () => ({ language: 'typescript' }),
    } as unknown as AdapterRegistry;
    const result = await validatePackQueries(pack(), fakeRegistry);
    assert.equal(result.skipped, true);
    assert.equal(result.warnings.length, 1);
  });

  it('reports malformed AST queries', async () => {
    const result = await validatePackQueries(
      pack({ detectionRules: [{ id: 'bad', description: 'bad', astQuery: '(unclosed_call' }] }),
      adapterRegistry,
    );
    assert.equal(result.skipped, false);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.startsWith('Detection rule "bad":')));
  });
});
