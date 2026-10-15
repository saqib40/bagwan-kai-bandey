/**
 * Automated test for Milestone 4: 150-Module Scale Benchmark.
 * Verifies that FalkorDB topological search on 150 modules meets P95 < 25ms SLA.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScaleBenchmark } from '../scripts/benchmark-scale';

test('150-Module Benchmark: Query 6.1 execution latency meets P95 < 25ms SLA', async () => {
  const result = await runScaleBenchmark(true);

  assert.equal(result.moduleCount, 150);
  assert.ok(result.edgeCount >= 300);
  assert.equal(result.passTarget, true);
  assert.ok(result.claimLeafStats.p95 < 25.0, `Expected CLAIM_LEAF P95 (${result.claimLeafStats.p95}ms) to be < 25ms`);
  assert.ok(result.claimDeshimStats.p95 < 25.0, `Expected CLAIM_DESHIM P95 (${result.claimDeshimStats.p95}ms) to be < 25ms`);
});
