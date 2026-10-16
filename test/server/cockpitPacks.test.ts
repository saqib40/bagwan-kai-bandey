/**
 * Tests for cockpit multi-pack awareness (M6).
 *
 * Verifies the pack metadata surfaced by `GET /api/info` / `POST /api/target`
 * (`getActivePackMeta`) and the dynamic `.bkb-steps.json` loader used by the
 * canned step executor (`loadRepoStepStates`). These run without FalkorDB.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getActivePackMeta, loadRepoStepStates, startDemoServer } from '../../src/server/demoServer';
import { loadPack } from '../../src/engine/packLoader';
import { getShimStrategy } from '../../src/adapters/types';

const WORKSPACE = resolve(import.meta.dirname, '../..');
const PACKS = resolve(WORKSPACE, 'packs');

const EXPECTED: Record<string, { language: string; shimStrategy: string }> = {
  'express-to-fastify': { language: 'typescript', shimStrategy: 'in-file-branch' },
  'cjs-to-esm': { language: 'typescript', shimStrategy: 'runtime-interop' },
  'jest-to-vitest': { language: 'typescript', shimStrategy: 'in-file-branch' },
  'flask-to-fastapi': { language: 'python', shimStrategy: 'in-file-branch' },
};

describe('cockpit multi-pack awareness (M6)', () => {
  it('exposes the default pack metadata for the cockpit header', () => {
    const meta = getActivePackMeta();
    assert.equal(meta.id, 'express-to-fastify');
    assert.equal(meta.language, 'typescript');
    assert.equal(meta.shimStrategy, 'in-file-branch');
    assert.equal(typeof meta.name, 'string');
  });

  it('every registered pack declares a language and a resolvable shim strategy', () => {
    for (const [packId, expected] of Object.entries(EXPECTED)) {
      const pack = loadPack(packId, [PACKS]);
      assert.equal(pack.language, expected.language, `${packId} language`);
      assert.equal(getShimStrategy(pack), expected.shimStrategy, `${packId} shimStrategy`);
    }
  });

  it('loads canned step states from a repo-local .bkb-steps.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bkb-steps-'));
    try {
      assert.equal(loadRepoStepStates(dir), null, 'absent file yields null');

      const payload = {
        'src/utils/response.ts:SHIM': {
          'src/utils/response.ts': 'export const x = 1;\n',
        },
      };
      writeFileSync(join(dir, '.bkb-steps.json'), JSON.stringify(payload));
      assert.deepEqual(loadRepoStepStates(dir), payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null (never throws) for a malformed .bkb-steps.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bkb-steps-bad-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.bkb-steps.json'), '{ not valid json');
      assert.equal(loadRepoStepStates(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves the active pack language and shim strategy over GET /api/info', async () => {
    const port = 4297;
    const server = startDemoServer(port, resolve(WORKSPACE, 'demo-repo-flask'), 'flask-to-fastapi', false);
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/info`);
      assert.equal(res.status, 200);
      const info = (await res.json()) as any;
      assert.equal(info.currentPackId, 'flask-to-fastapi');
      assert.equal(info.pack.id, 'flask-to-fastapi');
      assert.equal(info.pack.language, 'python');
      assert.equal(info.pack.shimStrategy, 'in-file-branch');
      assert.ok(info.availablePacks.includes('cjs-to-esm'));
      assert.ok(info.availablePacks.includes('jest-to-vitest'));
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});
