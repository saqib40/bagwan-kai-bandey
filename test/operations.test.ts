/**
 * Milestone 2 unit tests for MigrationOps.
 *
 * These tests validate the operations module with a mock FalkorClient
 * to avoid requiring a live FalkorDB container during CI.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FalkorClient } from '../src/engine/falkorClient';
import type { MigrationPack } from '../src/adapters/types';
import { MigrationOps } from '../src/engine/operations';

// ─── Mock FalkorClient ───────────────────────────────────

function createMockClient(responses: Record<string, any[]> = {}): FalkorClient {
  const queryFn = async (cypher: string, _params?: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(responses)) {
      if (cypher.includes(key)) return value;
    }
    return [];
  };

  return {
    graphName: 'test',
    query: queryFn,
    roQuery: queryFn,
    reset: async () => {},
    ensureIndex: async () => {},
    close: async () => {},
  } as unknown as FalkorClient;
}

// ─── Mock Pack ───────────────────────────────────────────

const MOCK_PACK: MigrationPack = {
  id: 'test-pack',
  name: 'Test Pack',
  language: 'typescript',
  sourceGlobs: { include: ['src/**/*.ts'] },
  packages: { legacy: ['old-lib'], target: ['new-lib'] },
  detectionRules: [
    { id: 'OLD_API', description: 'Old API usage', astQuery: '(call_expression)' },
  ],
  agentGuidance: {
    MIGRATE: 'Replace old API calls with new API equivalents.',
    SHIM: 'Add // @shift-shim comments to bridge old and new.',
    DE_SHIM: 'Remove all @shift-shim lines and legacy branches.',
  },
  invariants: [
    { id: 'routes', scope: 'per-step', type: 'route-surface', description: 'Route surface', astExtractor: '(route_registration)' },
  ],
  verification: {
    perStepTypecheckCmd: 'echo tsc-pass',
    checkpointTestCmd: 'echo tests-pass',
    routeSnapshotCmd: 'echo []',
  },
};

// ─── Tests ───────────────────────────────────────────────

describe('MigrationOps.claimNextLeaf', () => {
  it('returns null when no unblocked modules exist', async () => {
    const client = createMockClient();
    const ops = new MigrationOps(client, MOCK_PACK, '/tmp/test-repo');

    const result = await ops.claimNextLeaf();
    assert.equal(result, null);
  });

  it('claims a de-shim target (Pass A) when available', async () => {
    const client = createMockClient({
      DE_SHIM: [
        {
          phase: 'DE_SHIM',
          sccId: 1,
          allClusterPaths: ['src/utils/hash.ts'],
          targetPaths: ['src/utils/hash.ts'],
          pendingCallersCount: 0,
          pendingCallerPaths: [],
        },
      ],
    });
    const ops = new MigrationOps(client, MOCK_PACK, '/tmp/test-repo');

    const result = await ops.claimNextLeaf();
    assert.notEqual(result, null);
    assert.equal(result!.phase, 'DE_SHIM');
    assert.deepEqual(result!.targetPaths, ['src/utils/hash.ts']);
    assert.equal(result!.pendingCallersCount, 0);
    assert.ok(result!.proof.includes('DE_SHIM'));
    assert.ok(result!.proof.includes('@bkb-shim'));
    assert.ok(result!.proof.includes('@shift-shim'));
  });

  it('reclaims an in-progress module instead of claiming a new leaf', async () => {
    const client = createMockClient({
      'reclaim-active-claim': [
        { path: 'src/utils/response.ts', sccId: 2, phase: 'SHIM', pagerank: 0.4 },
      ],
      pendingCallers: [{ pendingCallers: 1, callerPaths: ['src/app.ts'] }],
    });
    const ops = new MigrationOps(client, MOCK_PACK, '/tmp/test-repo');

    const result = await ops.claimNextLeaf();
    assert.notEqual(result, null);
    assert.equal(result!.phase, 'SHIM');
    assert.equal(result!.sccId, 2);
    assert.deepEqual(result!.targetPaths, ['src/utils/response.ts']);
    assert.deepEqual(result!.pendingCallerPaths, ['src/app.ts']);
  });

  it('claims a leaf target (Pass B) when no de-shim available', async () => {
    let callCount = 0;
    const client = createMockClient();
    (client as any).query = async (cypher: string) => {
      callCount++;
      if (callCount === 1) return []; // no in-progress claim
      if (callCount === 2) return []; // de-shim pass empty
      if (callCount === 3) {
        return [
          {
            phase: 'MIGRATE',
            sccId: 3,
            allClusterPaths: ['src/routes/users.ts'],
            targetPaths: ['src/routes/users.ts'],
            pendingCallersCount: 0,
            pendingCallerPaths: [],
          },
        ];
      }
      return [];
    };

    const ops = new MigrationOps(client, MOCK_PACK, '/tmp/test-repo');
    const result = await ops.claimNextLeaf();
    assert.notEqual(result, null);
    assert.equal(result!.phase, 'MIGRATE');
    assert.equal(result!.sccId, 3);
  });

  it('returns SHIM phase when pending callers exist', async () => {
    let callCount = 0;
    const client = createMockClient();
    (client as any).query = async () => {
      callCount++;
      if (callCount === 1) return []; // no in-progress claim
      if (callCount === 2) return []; // de-shim pass empty
      if (callCount === 3) {
        return [
          {
            phase: 'SHIM',
            sccId: 5,
            allClusterPaths: ['src/middleware/auth.ts'],
            targetPaths: ['src/middleware/auth.ts'],
            pendingCallersCount: 2,
            pendingCallerPaths: ['src/routes/users.ts', 'src/routes/orders.ts'],
          },
        ];
      }
      return [];
    };

    const ops = new MigrationOps(client, MOCK_PACK, '/tmp/test-repo');
    const result = await ops.claimNextLeaf();
    assert.notEqual(result, null);
    assert.equal(result!.phase, 'SHIM');
    assert.equal(result!.pendingCallersCount, 2);
    assert.deepEqual(result!.pendingCallerPaths, ['src/routes/users.ts', 'src/routes/orders.ts']);
  });
});

describe('MigrationOps.getMigrationSlice', () => {
  it('returns guidance and module data for a given phase', async () => {
    const client = createMockClient({
      baseline: [{ baseline: '{"routes":["GET /users"]}' }],
    });
    const ops = new MigrationOps(client, MOCK_PACK, '/tmp/test-repo');

    const slice = await ops.getMigrationSlice(['src/nonexistent.ts'], 'MIGRATE');
    assert.equal(slice.phase, 'MIGRATE');
    assert.equal(slice.guidance, 'Replace old API calls with new API equivalents.');
    assert.equal(slice.targetModules.length, 1);
    assert.equal(slice.targetModules[0].path, 'src/nonexistent.ts');
    assert.ok(slice.targetModules[0].fullSource.includes('File not found'));
  });

  it('includes callee signatures from downstream imports', async () => {
    const client = createMockClient();
    (client as any).roQuery = async (cypher: string) => {
      if (cypher.includes('DECLARES')) {
        return [
          {
            modulePath: 'src/utils/hash.ts',
            symbolId: 'src/utils/hash.ts#hashPassword',
            symbolName: 'hashPassword',
            kind: 'function',
            signature: 'function hashPassword(pw: string): string',
          },
        ];
      }
      if (cypher.includes('baseline')) {
        return [{ baseline: '{}' }];
      }
      return [];
    };

    const ops = new MigrationOps(client, MOCK_PACK, '/tmp/test-repo');
    const slice = await ops.getMigrationSlice(['src/routes/users.ts'], 'MIGRATE');
    assert.equal(slice.calleeSignatures.length, 1);
    assert.equal(slice.calleeSignatures[0].symbolName, 'hashPassword');
  });
});

describe('MigrationOps.simulateBlastRadius', () => {
  it('returns blast radius entries sorted by hops', async () => {
    const client = createMockClient({
      'min(length(p)) AS hops': [
        { path: 'src/app.ts', status: 'CLEAN', hops: 2, pagerank: 0.5 },
        { path: 'src/routes/users.ts', status: 'PENDING', hops: 1, pagerank: 0.3 },
      ],
    });
    const ops = new MigrationOps(client, MOCK_PACK, process.cwd());

    const radius = await ops.simulateBlastRadius('src/utils/hash.ts');
    assert.equal(radius.length, 2);
    assert.equal(radius[0].path, 'src/app.ts');
    assert.equal(radius[1].hops, 1);
  });

  it('returns empty array when module has no callers', async () => {
    const client = createMockClient();
    const ops = new MigrationOps(client, MOCK_PACK, process.cwd());

    const radius = await ops.simulateBlastRadius('src/isolated.ts');
    assert.deepEqual(radius, []);
  });
});

describe('MigrationOps.getAuditTrail', () => {
  it('returns episodes sorted by step', async () => {
    const client = createMockClient({
      MigrationEpisode: [
        {
          step: 1,
          timestamp: 1700000000,
          phase: 'MIGRATE',
          modules: '["src/utils/hash.ts"]',
          newStatus: 'VERIFIED',
          agentSummary: 'Migrated hash utility',
          evidencePath: 'SCC 0',
        },
        {
          step: 2,
          timestamp: 1700000100,
          phase: 'SHIM',
          modules: '["src/middleware/auth.ts"]',
          newStatus: 'SHIMMED',
          agentSummary: 'Shimmed auth middleware',
          evidencePath: 'SCC 1',
        },
      ],
    });
    const ops = new MigrationOps(client, MOCK_PACK, process.cwd());

    const { episodes } = await ops.getAuditTrail(false);
    assert.equal(episodes.length, 2);
    assert.equal(episodes[0].step, 1);
    assert.equal(episodes[0].phase, 'MIGRATE');
    assert.equal(episodes[1].step, 2);
    assert.equal(episodes[1].newStatus, 'SHIMMED');
  });
});

describe('MigrationOps checkpoint gate', () => {
  it('runCheckpointGate validates tsc, tests, and route invariant', async () => {
    const client = createMockClient({
      baseline: [{ baseline: '[]' }],
      totalShims: [{ totalShims: 0 }],
      status: [
        { status: 'VERIFIED', n: 5 },
        { status: 'CLEAN', n: 3 },
      ],
    });
    const ops = new MigrationOps(client, MOCK_PACK, process.cwd());

    const result = await ops.runCheckpointGate();
    assert.equal(result.tscPass, true);
    assert.equal(result.testPass, true);
  });

  it('skips snapshot comparison cleanly when no snapshots are declared', async () => {
    const pack: MigrationPack = {
      ...MOCK_PACK,
      verification: { perStepTypecheckCmd: 'echo tsc-pass', checkpointTestCmd: 'echo tests-pass' },
    };
    const client = createMockClient();
    const ops = new MigrationOps(client, pack, process.cwd());

    const result = await ops.runCheckpointGate();
    assert.equal(result.routeMatch, true);
    assert.deepEqual(result.errors, []);
  });

  it('matches declared snapshots against the captured baseline', async () => {
    const pack: MigrationPack = {
      ...MOCK_PACK,
      verification: {
        perStepTypecheckCmd: 'echo tsc-pass',
        checkpointTestCmd: 'echo tests-pass',
        snapshots: [{ id: 'export-surface', command: "echo '[\"a\",\"b\"]'", kind: 'set' }],
      },
    };
    const client = createMockClient({
      MigrationMeta: [{ baseline: '[]', snapshots: JSON.stringify({ 'export-surface': '["a","b"]' }) }],
    });
    const ops = new MigrationOps(client, pack, process.cwd());

    const result = await ops.runCheckpointGate();
    assert.equal(result.routeMatch, true);
    assert.deepEqual(result.errors, []);
  });

  it('reports a mismatch when a snapshot diverges from baseline', async () => {
    const pack: MigrationPack = {
      ...MOCK_PACK,
      verification: {
        perStepTypecheckCmd: 'echo tsc-pass',
        checkpointTestCmd: 'echo tests-pass',
        snapshots: [{ id: 'export-surface', command: "echo '[\"a\",\"c\"]'", kind: 'set' }],
      },
    };
    const client = createMockClient({
      MigrationMeta: [{ baseline: '[]', snapshots: JSON.stringify({ 'export-surface': '["a","b"]' }) }],
    });
    const ops = new MigrationOps(client, pack, process.cwd());

    const result = await ops.runCheckpointGate();
    assert.equal(result.routeMatch, false);
    assert.ok(result.errors.some((e) => e.includes('export-surface')));
  });
});

describe('MigrationOps.advance', () => {
  function claimedClient() {
    return createMockClient({
      'reclaim-active-claim': [
        { path: 'src/a.ts', sccId: 1, phase: 'MIGRATE', pagerank: 1 },
      ],
      pendingCallers: [{ pendingCallers: 0, callerPaths: [] }],
    });
  }

  function quietPack(typecheck = 'false'): MigrationPack {
    return {
      ...MOCK_PACK,
      invariants: [],
      detectionRules: [],
      verification: { ...MOCK_PACK.verification, perStepTypecheckCmd: typecheck },
    };
  }

  it('returns the claimed file without a separate slice call', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bkb-advance-'));
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const hello = 1;\n');
    const ops = new MigrationOps(claimedClient(), quietPack(), repo);
    try {
      const result = await ops.advance();
      assert.equal(result.done, false);
      assert.deepEqual(result.targetPaths, ['src/a.ts']);
      assert.equal(result.files?.[0]?.source, 'export const hello = 1;\n');
      assert.match(result.message ?? '', /advance_migration/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects edits that are not the claimed batch', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bkb-advance-'));
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const hello = 1;\n');
    const ops = new MigrationOps(claimedClient(), quietPack(), repo);
    try {
      const result = await ops.advance([{ path: 'src/other.ts', content: 'export const x = 1;\n' }]);
      assert.equal(result.ok, false);
      assert.equal(existsSync(join(repo, 'src', 'other.ts')), false);
      assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), 'export const hello = 1;\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('restores files when verification fails', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bkb-advance-'));
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const hello = 1;\n');
    const ops = new MigrationOps(claimedClient(), quietPack('false'), repo);
    try {
      const result = await ops.advance(
        [{ path: 'src/a.ts', content: 'export const hello = 2;\n' }],
        'bad edit',
      );
      assert.equal(result.ok, false);
      assert.ok((result.errors ?? []).length > 0);
      assert.equal(readFileSync(join(repo, 'src', 'a.ts'), 'utf8'), 'export const hello = 1;\n');
      assert.equal(result.files?.[0]?.source, 'export const hello = 1;\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses an edit path that escapes the repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bkb-advance-'));
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const hello = 1;\n');
    const client = createMockClient({
      'reclaim-active-claim': [
        { path: '../secret.ts', sccId: 1, phase: 'MIGRATE', pagerank: 1 },
      ],
      pendingCallers: [{ pendingCallers: 0, callerPaths: [] }],
    });
    const ops = new MigrationOps(client, quietPack(), repo);
    const outside = join(repo, '..', 'secret.ts');
    try {
      const result = await ops.advance([{ path: '../secret.ts', content: 'pwned\n' }]);
      assert.equal(result.ok, false);
      assert.equal(existsSync(outside), false);
    } finally {
      rmSync(outside, { force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('MigrationOps.verifyAndCommitNode', () => {
  it('does not rewrite graph edges when typecheck fails', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bkb-verify-'));
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'ok.ts'), 'export const n = 1;\n');
    const writes: string[] = [];
    const client = createMockClient();
    (client as any).query = async (cypher: string) => {
      writes.push(cypher);
      return [];
    };
    const pack: MigrationPack = {
      ...MOCK_PACK,
      invariants: [],
      detectionRules: [],
      verification: { ...MOCK_PACK.verification, perStepTypecheckCmd: 'false' },
    };
    const ops = new MigrationOps(client, pack, repo);
    try {
      const result = await ops.verifyAndCommitNode(['src/ok.ts'], 'attempt');
      assert.equal(result.ok, false);
      assert.equal(
        writes.some((query) => query.includes('DETACH DELETE') || query.includes('MERGE (a)-[:IMPORTS]')),
        false,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
