/**
 * Unit tests for global verification snapshots (Milestone M0.3).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MigrationPack } from '../src/adapters/types';
import { getPackSnapshots, normalizeSnapshotOutput } from '../src/engine/snapshots';

function packWithVerification(verification: MigrationPack['verification']): MigrationPack {
  return {
    id: 'p',
    name: 'p',
    language: 'typescript',
    sourceGlobs: { include: ['src/**/*.ts'] },
    packages: { legacy: [], target: [] },
    detectionRules: [{ id: 'r', description: 'r', astQuery: '(identifier)' }],
    agentGuidance: {},
    invariants: [],
    verification,
  };
}

describe('getPackSnapshots', () => {
  it('returns declared snapshots verbatim', () => {
    const pack = packWithVerification({
      perStepTypecheckCmd: 'true',
      checkpointTestCmd: 'true',
      snapshots: [{ id: 'export-surface', command: 'echo []', kind: 'set' }],
    });
    assert.deepEqual(getPackSnapshots(pack), [
      { id: 'export-surface', command: 'echo []', kind: 'set' },
    ]);
  });

  it('maps a legacy routeSnapshotCmd to a route-surface set snapshot', () => {
    const pack = packWithVerification({
      perStepTypecheckCmd: 'true',
      checkpointTestCmd: 'true',
      routeSnapshotCmd: 'node dump.mjs',
    });
    assert.deepEqual(getPackSnapshots(pack), [
      { id: 'route-surface', command: 'node dump.mjs', kind: 'set' },
    ]);
  });

  it('prefers declared snapshots over the legacy alias', () => {
    const pack = packWithVerification({
      perStepTypecheckCmd: 'true',
      checkpointTestCmd: 'true',
      routeSnapshotCmd: 'legacy',
      snapshots: [{ id: 'test-counts', command: 'echo 0', kind: 'count' }],
    });
    assert.deepEqual(getPackSnapshots(pack), [
      { id: 'test-counts', command: 'echo 0', kind: 'count' },
    ]);
  });

  it('returns an empty array when no snapshots are declared', () => {
    const pack = packWithVerification({ perStepTypecheckCmd: 'true', checkpointTestCmd: 'true' });
    assert.deepEqual(getPackSnapshots(pack), []);
  });
});

describe('normalizeSnapshotOutput', () => {
  it('sorts set snapshots', () => {
    assert.equal(normalizeSnapshotOutput('set', '[ "b", "a" ]'), '["a","b"]');
  });

  it('treats non-array set output as empty', () => {
    assert.equal(normalizeSnapshotOutput('set', '{ "a": 1 }'), '[]');
    assert.equal(normalizeSnapshotOutput('set', 'not json'), '[]');
  });

  it('normalizes count output', () => {
    assert.equal(normalizeSnapshotOutput('count', '{"tests":2,"suites":1}'), '{"tests":2,"suites":1}');
    assert.equal(normalizeSnapshotOutput('count', '5'), '5');
  });

  it('passes exact output through trimmed', () => {
    assert.equal(normalizeSnapshotOutput('exact', '  hello  '), 'hello');
  });
});
