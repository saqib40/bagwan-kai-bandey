/**
 * Structural + Ajv schema-validation tests for the authoritative pack schema
 * (Milestones M0.4 and M1.2).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { validatePackSchema } from '../src/engine/packSchema';
import { validatePack } from '../src/engine/packLoader';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SCHEMA_PATH = resolve(REPO_ROOT, 'packs/PACK_SPEC.schema.json');
const EXPRESS_PACK = resolve(REPO_ROOT, 'packs/express-to-fastify.json');

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function minimalPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p',
    name: 'Pack',
    language: 'typescript',
    sourceGlobs: { include: ['src/**/*.ts'] },
    packages: { legacy: [], target: [] },
    detectionRules: [{ id: 'r', description: 'r', astQuery: '(identifier)' }],
    agentGuidance: {},
    invariants: [],
    verification: { perStepTypecheckCmd: 'true', checkpointTestCmd: 'true' },
    ...overrides,
  };
}

describe('PACK_SPEC.schema.json', () => {
  it('exists and is valid JSON', () => {
    assert.ok(existsSync(SCHEMA_PATH), 'packs/PACK_SPEC.schema.json must exist');
    const schema = readJson(SCHEMA_PATH);
    assert.equal(schema.type, 'object');
    assert.ok(Array.isArray(schema.required));
  });

  it('express-to-fastify pack satisfies the schema top-level required keys', () => {
    const schema = readJson(SCHEMA_PATH);
    const pack = readJson(resolve(REPO_ROOT, 'packs/express-to-fastify.json'));
    for (const key of schema.required) {
      assert.ok(key in pack, `pack is missing schema-required key "${key}"`);
    }
  });

  it('express-to-fastify detection rules satisfy nested required keys', () => {
    const schema = readJson(SCHEMA_PATH);
    const pack = readJson(EXPRESS_PACK);
    const ruleRequired: string[] = schema.properties.detectionRules.items.required;
    for (const rule of pack.detectionRules) {
      for (const key of ruleRequired) {
        assert.ok(key in rule, `detection rule "${rule.id}" missing "${key}"`);
      }
    }
  });
});

describe('validatePackSchema (Ajv)', () => {
  it('accepts the built-in express-to-fastify pack', () => {
    const result = validatePackSchema(readJson(EXPRESS_PACK));
    assert.equal(result.valid, true, result.errors.join('\n'));
    assert.deepEqual(result.errors, []);
  });

  it('accepts a minimal conforming pack', () => {
    assert.equal(validatePackSchema(minimalPack()).valid, true);
  });

  it('rejects checkpoint-scope invariants with an allowed-values hint', () => {
    const pack = minimalPack({
      invariants: [
        { id: 'i', scope: 'checkpoint', type: 'route-set', description: 'd', astExtractor: '(id)' },
      ],
    });
    const result = validatePackSchema(pack);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('invariants.0.scope') && e.includes('per-step')));
  });

  it('rejects unknown nested properties', () => {
    const pack = minimalPack({ verification: { perStepTypecheckCmd: 'true', checkpointTestCmd: 'true', bogus: 1 } });
    const result = validatePackSchema(pack);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.startsWith('verification:') && e.includes('additional')));
  });

  it('rejects a non-object and reports the root path', () => {
    const result = validatePackSchema('not-a-pack');
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.startsWith('(root):')));
  });
});

describe('built-in pack conformance', () => {
  it('express-to-fastify passes full validatePack (structural + semantic + schema)', () => {
    const result = validatePack(readJson(EXPRESS_PACK));
    assert.equal(result.valid, true, result.errors.join('\n'));
  });

  it('express-to-fastify declares manifest package detectors', () => {
    const pack = readJson(EXPRESS_PACK);
    assert.ok(Array.isArray(pack.packageDetectors));
    assert.equal(pack.packageDetectors.length, 1);
    assert.equal(pack.packageDetectors[0].file, 'package.json');
  });
});

describe('validatePack schema integration', () => {
  it('surfaces schema errors with a [schema] prefix once structural checks pass', () => {
    const pack = minimalPack({ verification: { perStepTypecheckCmd: 'true', checkpointTestCmd: 'true', nope: true } });
    const result = validatePack(pack);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.startsWith('[schema]')));
  });

  it('keeps friendly structural errors ahead of schema errors', () => {
    const result = validatePack({ id: 'broken' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('language')));
    assert.ok(result.errors.every((e) => !e.startsWith('[schema]')));
  });
});
