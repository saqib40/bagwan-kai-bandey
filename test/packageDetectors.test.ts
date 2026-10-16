/**
 * Unit tests for manifest package detectors (Milestone M1.1).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PackageDetector } from '../src/adapters/types';
import {
  evaluatePackageDetectors,
  formatPackageDetectorAdvisories,
} from '../src/engine/packageDetectors';

let repo: string;

function write(file: string, content: string): void {
  const abs = join(repo, file);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'bkb-pkgdet-'));
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('evaluatePackageDetectors', () => {
  it('returns an empty list when no detectors are declared', () => {
    assert.deepEqual(evaluatePackageDetectors(repo, undefined), []);
    assert.deepEqual(evaluatePackageDetectors(repo, []), []);
  });

  it('matches package.json dependencies case-insensitively across sections', () => {
    write(
      'package.json',
      JSON.stringify({
        dependencies: { express: '^4.0.0', lodash: '^4.0.0' },
        devDependencies: { jest: '^29.0.0' },
      }),
    );
    const detectors: PackageDetector[] = [
      {
        id: 'express-project',
        file: 'package.json',
        description: 'Uses Express',
        match: { legacy: ['express'], target: ['fastify'] },
      },
    ];
    const [result] = evaluatePackageDetectors(repo, detectors);
    assert.equal(result.fileFound, true);
    assert.deepEqual(result.present, ['express']);
    assert.deepEqual(result.missing, ['fastify']);
    assert.equal(result.satisfied, false);
    assert.equal(result.required, false);
  });

  it('parses PEP 621 pyproject dependencies, including multi-line arrays', () => {
    write(
      'pyproject.toml',
      [
        '[project]',
        'name = "svc"',
        'dependencies = [',
        '  "flask>=2.0",',
        '  "requests[socks]>=2",',
        ']',
        '',
        '[project.optional-dependencies]',
        'dev = ["pytest", "ruff"]',
      ].join('\n'),
    );
    const [result] = evaluatePackageDetectors(repo, [
      { id: 'flask-app', file: 'pyproject.toml', match: { legacy: ['flask'], target: ['fastapi'] } },
    ]);
    assert.deepEqual(result.present, ['flask']);
    assert.deepEqual(result.missing, ['fastapi']);
  });

  it('parses Poetry dependency tables and normalizes underscores', () => {
    write(
      'pyproject.toml',
      [
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        'flask = "^2.3"',
        'psycopg2_binary = "^2.9"',
        '',
        '[tool.poetry.group.dev.dependencies]',
        'pytest = "^7.0"',
      ].join('\n'),
    );
    const [result] = evaluatePackageDetectors(repo, [
      { id: 'any', file: 'pyproject.toml', match: { legacy: ['flask', 'psycopg2-binary'] } },
    ]);
    assert.deepEqual(result.present, ['flask', 'psycopg2-binary']);
    assert.deepEqual(result.missing, []);
    assert.equal(result.satisfied, true);
  });

  it('parses requirements.txt lines and ignores options/comments', () => {
    write('requirements.txt', ['# web stack', '-r base.txt', 'flask==2.3.0', 'requests  # http', ''].join('\n'));
    const [result] = evaluatePackageDetectors(repo, [
      { id: 'req', file: 'requirements.txt', match: { legacy: ['flask', 'requests'] } },
    ]);
    assert.deepEqual(result.present, ['flask', 'requests']);
    assert.equal(result.satisfied, true);
  });

  it('parses go.mod require blocks', () => {
    write(
      'go.mod',
      ['module example.com/svc', '', 'require (', '\tgithub.com/gin-gonic/gin v1.9.0', ')', '', 'require github.com/pkg/errors v0.9.1'].join(
        '\n',
      ),
    );
    const [result] = evaluatePackageDetectors(repo, [
      { id: 'gin', file: 'go.mod', match: { legacy: ['github.com/gin-gonic/gin'] } },
    ]);
    assert.deepEqual(result.present, ['github.com/gin-gonic/gin']);
    assert.equal(result.satisfied, true);
  });

  it('reports missing manifests and preserves the required flag', () => {
    const [result] = evaluatePackageDetectors(repo, [
      { id: 'absent', file: 'does-not-exist.json', required: true, match: { legacy: ['x'] } },
    ]);
    assert.equal(result.fileFound, false);
    assert.equal(result.satisfied, false);
    assert.equal(result.required, true);
  });

  it('reuses a single manifest read across multiple detectors', () => {
    write('package.json', JSON.stringify({ dependencies: { alpha: '1', beta: '1' } }));
    const results = evaluatePackageDetectors(repo, [
      { id: 'a', file: 'package.json', match: { legacy: ['alpha'] } },
      { id: 'b', file: 'package.json', match: { legacy: ['beta', 'gamma'] } },
    ]);
    assert.equal(results[0].satisfied, true);
    assert.deepEqual(results[1].missing, ['gamma']);
  });
});

describe('formatPackageDetectorAdvisories', () => {
  it('emits warn/FAIL lines only for unmet detectors', () => {
    const lines = formatPackageDetectorAdvisories([
      { id: 'ok', file: 'package.json', required: false, fileFound: true, present: ['a'], missing: [], satisfied: true },
      { id: 'soft', file: 'package.json', required: false, fileFound: true, present: [], missing: ['b'], satisfied: false },
      { id: 'hard', file: 'pyproject.toml', required: true, fileFound: false, present: [], missing: ['c'], satisfied: false },
    ]);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[warn\] package detector "soft"/);
    assert.match(lines[1], /^\[FAIL\] package detector "hard".*manifest "pyproject.toml" not found/);
  });
});
