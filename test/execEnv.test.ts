/**
 * Tests for `buildRepoExecEnv`, which makes a repository's local `.venv` and
 * `node_modules/.bin` available to pack-defined commands.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { buildRepoExecEnv } from '../src/engine/execEnv';

function venvBinPath(repo: string): string {
  return resolve(repo, process.platform === 'win32' ? '.venv/Scripts' : '.venv/bin');
}

describe('buildRepoExecEnv', () => {
  test('prepends existing venv and node_modules/.bin to PATH', () => {
    const repo = mkdtempSync(join(tmpdir(), 'bkb-execenv-'));
    try {
      const venvBin = venvBinPath(repo);
      const nodeBin = resolve(repo, 'node_modules/.bin');
      mkdirSync(venvBin, { recursive: true });
      mkdirSync(nodeBin, { recursive: true });

      const env = buildRepoExecEnv({ PATH: '/usr/bin' }, repo);
      assert.equal(env.PATH, [venvBin, nodeBin, '/usr/bin'].join(delimiter));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('ignores tool directories that do not exist', () => {
    const repo = mkdtempSync(join(tmpdir(), 'bkb-execenv-'));
    try {
      const env = buildRepoExecEnv({ PATH: '/usr/bin' }, repo);
      assert.equal(env.PATH, '/usr/bin');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('returns a copy and tolerates a missing PATH', () => {
    const repo = mkdtempSync(join(tmpdir(), 'bkb-execenv-'));
    try {
      const nodeBin = resolve(repo, 'node_modules/.bin');
      mkdirSync(nodeBin, { recursive: true });

      const base: NodeJS.ProcessEnv = {};
      const env = buildRepoExecEnv(base, repo);
      assert.equal(env.PATH, nodeBin);
      assert.equal(base.PATH, undefined);
      assert.notEqual(env, base);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
