/**
 * Tests for migration pack discovery (`discoverPackIds`).
 * Guards against schema sidecar files (e.g. `PACK_SPEC.schema.json`) leaking
 * into the list of available packs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPackIds } from '../src/engine/packLoader';

describe('discoverPackIds', () => {
  test('lists pack ids and skips schema sidecar files and non-pack files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bkb-pack-discovery-'));
    try {
      for (const f of [
        'express-to-fastify.json',
        'flask-to-fastapi.json',
        'cjs-to-esm.ts',
        'PACK_SPEC.schema.json',
        'README.md',
        'notes.txt',
      ]) {
        writeFileSync(join(dir, f), '');
      }

      assert.deepEqual(discoverPackIds(dir).sort(), ['cjs-to-esm', 'express-to-fastify', 'flask-to-fastapi']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('excludes schema files regardless of their base name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bkb-pack-discovery-'));
    try {
      writeFileSync(join(dir, 'pack.schema.ts'), '');
      writeFileSync(join(dir, 'real-pack.json'), '');

      assert.deepEqual(discoverPackIds(dir), ['real-pack']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns an empty array for a missing directory', () => {
    assert.deepEqual(discoverPackIds(join(tmpdir(), 'bkb-pack-discovery-missing-xyz')), []);
  });
});
