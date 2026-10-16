/**
 * Structural consistency tests for the authoritative pack schema (Milestone M0.4).
 * Full JSON-Schema validation (Ajv) lands with the pack CLI in M1.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SCHEMA_PATH = resolve(REPO_ROOT, 'packs/PACK_SPEC.schema.json');

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
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
    const pack = readJson(resolve(REPO_ROOT, 'packs/express-to-fastify.json'));
    const ruleRequired: string[] = schema.properties.detectionRules.items.required;
    for (const rule of pack.detectionRules) {
      for (const key of ruleRequired) {
        assert.ok(key in rule, `detection rule "${rule.id}" missing "${key}"`);
      }
    }
  });
});
