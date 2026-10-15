/**
 * Milestone 4: 150-Module Scale Benchmark (`scripts/benchmark-scale.ts`).
 *
 * Generates a realistic synthetic graph of 150 TypeScript modules with:
 *  - 10 foundational shared utilities (high PageRank, high in-degree)
 *  - 30 service modules containing 3 circular dependency SCC cycles (sizes 2, 3, and 5)
 *  - 80 domain feature routes
 *  - 30 top-level application controllers / entrypoints
 * Total: ~500 [:IMPORTS] edges.
 *
 * Measures FalkorDB query execution latency for Query 6.1:
 *  - Pass A: CLAIM_DESHIM (zero-pending-callers de-shim prioritization)
 *  - Pass B: CLAIM_LEAF (unblocked transitive leaf / atomic SCC search)
 *
 * Asserts P95 latency is strictly under 25ms.
 */

import { FalkorClient } from '../src/engine/falkorClient';
import { tarjanScc } from '../src/engine/scc';
import * as Q from '../src/engine/queries';

const BENCH_GRAPH = 'shift_benchmark_scale';
const MODULE_COUNT = 150;
const WARMUP_RUNS = 10;
const BENCH_RUNS = 100;

interface TimingStats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

function computeStats(samples: number[]): TimingStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const p = (pct: number) => sorted[Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))];

  return {
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
    mean: Number((sum / sorted.length).toFixed(3)),
    p50: Number(p(50).toFixed(3)),
    p90: Number(p(90).toFixed(3)),
    p95: Number(p(95).toFixed(3)),
    p99: Number(p(99).toFixed(3)),
  };
}

export async function runScaleBenchmark(silent = false): Promise<{
  moduleCount: number;
  edgeCount: number;
  sccCount: number;
  claimLeafStats: TimingStats;
  claimDeshimStats: TimingStats;
  shortestPathStats: TimingStats;
  passTarget: boolean;
}> {
  if (!silent) console.error(`[bench] Connecting to FalkorDB for 150-module benchmark...`);
  const client = await FalkorClient.connect({ graphName: BENCH_GRAPH });

  try {
    if (!silent) console.error(`[bench] Resetting benchmark graph "${BENCH_GRAPH}"...`);
    await client.reset();

    // 1. Ensure indexes
    for (const ix of Q.INDEXES) {
      await client.ensureIndex(ix);
    }

    if (!silent) console.error(`[bench] Generating synthetic 150-module topology...`);

    const modules: Array<{ path: string; status: string }> = [];
    const adjacency = new Map<string, string[]>();

    // Layer 0: 10 foundational utils (utils/001..010) - PENDING
    for (let i = 1; i <= 10; i++) {
      const p = `src/utils/u${String(i).padStart(3, '0')}.ts`;
      modules.push({ path: p, status: 'PENDING' });
      adjacency.set(p, []);
    }

    // Layer 1: 30 services (services/001..030) - with 3 SCC cycles
    for (let i = 1; i <= 30; i++) {
      const p = `src/services/s${String(i).padStart(3, '0')}.ts`;
      modules.push({ path: p, status: 'PENDING' });
      adjacency.set(p, []);
    }

    // Layer 2: 80 routes (routes/001..080)
    for (let i = 1; i <= 80; i++) {
      const p = `src/routes/r${String(i).padStart(3, '0')}.ts`;
      modules.push({ path: p, status: 'PENDING' });
      adjacency.set(p, []);
    }

    // Layer 3: 30 controllers/apps (controllers/001..030)
    for (let i = 1; i <= 30; i++) {
      const p = `src/controllers/c${String(i).padStart(3, '0')}.ts`;
      modules.push({ path: p, status: 'PENDING' });
      adjacency.set(p, []);
    }

    let totalEdges = 0;
    const addEdge = (from: string, to: string) => {
      const list = adjacency.get(from) ?? [];
      if (!list.includes(to) && from !== to) {
        list.push(to);
        adjacency.set(from, list);
        totalEdges++;
      }
    };

    // Cycle 1: 2-node SCC in services (s001 <-> s002)
    addEdge('src/services/s001.ts', 'src/services/s002.ts');
    addEdge('src/services/s002.ts', 'src/services/s001.ts');

    // Cycle 2: 3-node SCC in services (s005 -> s006 -> s007 -> s005)
    addEdge('src/services/s005.ts', 'src/services/s006.ts');
    addEdge('src/services/s006.ts', 'src/services/s007.ts');
    addEdge('src/services/s007.ts', 'src/services/s005.ts');

    // Cycle 3: 5-node SCC in services (s010 -> s011 -> s012 -> s013 -> s014 -> s010)
    addEdge('src/services/s010.ts', 'src/services/s011.ts');
    addEdge('src/services/s011.ts', 'src/services/s012.ts');
    addEdge('src/services/s012.ts', 'src/services/s013.ts');
    addEdge('src/services/s013.ts', 'src/services/s014.ts');
    addEdge('src/services/s014.ts', 'src/services/s010.ts');

    // Services import foundational utils (heavy in-degree on utils)
    for (let i = 1; i <= 30; i++) {
      const s = `src/services/s${String(i).padStart(3, '0')}.ts`;
      const targetUtil1 = `src/utils/u${String((i % 10) + 1).padStart(3, '0')}.ts`;
      const targetUtil2 = `src/utils/u${String(((i + 3) % 10) + 1).padStart(3, '0')}.ts`;
      addEdge(s, targetUtil1);
      addEdge(s, targetUtil2);
    }

    // Routes import services and utils
    for (let i = 1; i <= 80; i++) {
      const r = `src/routes/r${String(i).padStart(3, '0')}.ts`;
      const targetSvc = `src/services/s${String((i % 30) + 1).padStart(3, '0')}.ts`;
      const targetUtil = `src/utils/u${String((i % 10) + 1).padStart(3, '0')}.ts`;
      addEdge(r, targetSvc);
      addEdge(r, targetUtil);
    }

    // Controllers import routes and services
    for (let i = 1; i <= 30; i++) {
      const c = `src/controllers/c${String(i).padStart(3, '0')}.ts`;
      const targetRoute1 = `src/routes/r${String(((i * 2) % 80) + 1).padStart(3, '0')}.ts`;
      const targetRoute2 = `src/routes/r${String(((i * 2 + 1) % 80) + 1).padStart(3, '0')}.ts`;
      const targetSvc = `src/services/s${String((i % 30) + 1).padStart(3, '0')}.ts`;
      addEdge(c, targetRoute1);
      addEdge(c, targetRoute2);
      addEdge(c, targetSvc);
    }

    // 2. Tarjan SCC computation
    const sccResult = tarjanScc(adjacency);

    // 3. Insert nodes into FalkorDB in batches
    if (!silent) console.error(`[bench] Ingesting ${modules.length} nodes & ${totalEdges} edges into FalkorDB...`);

    const nodeBatch = modules.map((m) => {
      const sccId = sccResult.sccOf.get(m.path) ?? 0;
      const sccSize = sccResult.members.get(sccId)?.length ?? 1;
      return {
        path: m.path,
        status: m.status,
        sccId,
        sccSize,
      };
    });

    await client.query(
      `UNWIND $batch AS n
       CREATE (m:Module {
         path: n.path,
         status: n.status,
         scc_id: n.sccId,
         scc_size: n.sccSize,
         in_degree: 0,
         pending_callers_count: 0,
         pagerank: 0.0,
         shim_line_count: 0,
         baseline_sets: '{}',
         current_sets: '{}'
       })`,
      { batch: nodeBatch },
    );

    // Insert edges
    const edgeRows: Array<{ from: string; to: string }> = [];
    for (const [from, toList] of adjacency.entries()) {
      for (const to of toList) {
        edgeRows.push({ from, to });
      }
    }

    // Chunk edge inserts to avoid oversized single queries
    const CHUNK_SIZE = 100;
    for (let i = 0; i < edgeRows.length; i += CHUNK_SIZE) {
      const chunk = edgeRows.slice(i, i + CHUNK_SIZE);
      await client.query(
        `UNWIND $chunk AS e
         MATCH (a:Module {path: e.from}), (b:Module {path: e.to})
         CREATE (a)-[:IMPORTS]->(b)`,
        { chunk },
      );
    }

    // 4. Compute PageRank
    if (!silent) console.error(`[bench] Running FalkorDB native PageRank...`);
    await client.query(Q.PAGERANK);

    // 5. Recompute initial degrees
    await client.query(Q.RECOMPUTE_DEGREES, {
      legacyCallers: [...Q.LEGACY_CALLER_STATUSES],
    });

    // ── Benchmarking Query 6.1 Pass B: CLAIM_LEAF ──
    if (!silent) console.error(`[bench] Benchmarking Pass B (CLAIM_LEAF) over ${BENCH_RUNS} runs...`);
    const params = {
      blocking: [...Q.BLOCKING_STATUSES],
      legacyCallers: [...Q.LEGACY_CALLER_STATUSES],
    };

    // Warmup
    for (let i = 0; i < WARMUP_RUNS; i++) {
      await client.query(Q.CLAIM_LEAF, params);
    }

    const claimLeafSamples: number[] = [];
    for (let i = 0; i < BENCH_RUNS; i++) {
      const t0 = performance.now();
      await client.query(Q.CLAIM_LEAF, params);
      const t1 = performance.now();
      claimLeafSamples.push(t1 - t0);
    }

    const claimLeafStats = computeStats(claimLeafSamples);

    // ── Benchmarking Query 6.1 Pass A: CLAIM_DESHIM ──
    // Temporarily mark 5 modules as SHIMMED with pending_callers_count = 0
    await client.query(`
      MATCH (m:Module)
      WHERE m.path STARTS WITH 'src/utils/'
      SET m.status = 'SHIMMED', m.pending_callers_count = 0
    `);

    if (!silent) console.error(`[bench] Benchmarking Pass A (CLAIM_DESHIM) over ${BENCH_RUNS} runs...`);

    // Warmup
    for (let i = 0; i < WARMUP_RUNS; i++) {
      await client.query(Q.CLAIM_DESHIM);
    }

    const claimDeshimSamples: number[] = [];
    for (let i = 0; i < BENCH_RUNS; i++) {
      const t0 = performance.now();
      await client.query(Q.CLAIM_DESHIM);
      const t1 = performance.now();
      claimDeshimSamples.push(t1 - t0);
    }

    const claimDeshimStats = computeStats(claimDeshimSamples);

    // ── Benchmarking Shortest Dependency Path ──
    const shortestPathSamples: number[] = [];
    for (let i = 0; i < BENCH_RUNS; i++) {
      const t0 = performance.now();
      await client.query(Q.SHORTEST_PATH, {
        callerPath: 'src/controllers/c001.ts',
        calleePath: 'src/utils/u001.ts',
      });
      const t1 = performance.now();
      shortestPathSamples.push(t1 - t0);
    }
    const shortestPathStats = computeStats(shortestPathSamples);

    const passTarget = claimLeafStats.p95 < 25.0 && claimDeshimStats.p95 < 25.0;

    return {
      moduleCount: modules.length,
      edgeCount: totalEdges,
      sccCount: sccResult.members.size,
      claimLeafStats,
      claimDeshimStats,
      shortestPathStats,
      passTarget,
    };
  } finally {
    await client.close();
  }
}

// CLI runner
if (process.argv[1]?.includes('benchmark-scale')) {
  runScaleBenchmark()
    .then((res) => {
      console.log('\n======================================================');
      console.log('       SHIFT ENGINE — 150-MODULE SCALE BENCHMARK      ');
      console.log('======================================================');
      console.log(`Modules:           ${res.moduleCount}`);
      console.log(`Dependency Edges:  ${res.edgeCount}`);
      console.log(`SCC Clusters:      ${res.sccCount} (including 3 multi-node cycles)`);
      console.log('------------------------------------------------------');
      console.log('Query Latencies (ms) [Target: P95 < 25.0 ms]:');
      console.log('------------------------------------------------------');
      console.log('Query 6.1 Pass B (CLAIM_LEAF - Unblocked Transitive Search):');
      console.log(`  Min:   ${res.claimLeafStats.min.toFixed(2)} ms`);
      console.log(`  Mean:  ${res.claimLeafStats.mean.toFixed(2)} ms`);
      console.log(`  P50:   ${res.claimLeafStats.p50.toFixed(2)} ms`);
      console.log(`  P90:   ${res.claimLeafStats.p90.toFixed(2)} ms`);
      console.log(`  P95:   ${res.claimLeafStats.p95.toFixed(2)} ms  ${res.claimLeafStats.p95 < 25 ? '✅ PASS (< 25 ms)' : '❌ FAIL'}`);
      console.log(`  P99:   ${res.claimLeafStats.p99.toFixed(2)} ms`);
      console.log(`  Max:   ${res.claimLeafStats.max.toFixed(2)} ms`);
      console.log('------------------------------------------------------');
      console.log('Query 6.1 Pass A (CLAIM_DESHIM - Cluster Zero-Pending Priority):');
      console.log(`  Min:   ${res.claimDeshimStats.min.toFixed(2)} ms`);
      console.log(`  Mean:  ${res.claimDeshimStats.mean.toFixed(2)} ms`);
      console.log(`  P50:   ${res.claimDeshimStats.p50.toFixed(2)} ms`);
      console.log(`  P90:   ${res.claimDeshimStats.p90.toFixed(2)} ms`);
      console.log(`  P95:   ${res.claimDeshimStats.p95.toFixed(2)} ms  ${res.claimDeshimStats.p95 < 25 ? '✅ PASS (< 25 ms)' : '❌ FAIL'}`);
      console.log(`  P99:   ${res.claimDeshimStats.p99.toFixed(2)} ms`);
      console.log(`  Max:   ${res.claimDeshimStats.max.toFixed(2)} ms`);
      console.log('------------------------------------------------------');
      console.log('Shortest Dependency Path Proof:');
      console.log(`  P50:   ${res.shortestPathStats.p50.toFixed(2)} ms`);
      console.log(`  P95:   ${res.shortestPathStats.p95.toFixed(2)} ms`);
      console.log('======================================================');
      console.log(`Overall Benchmark Result: ${res.passTarget ? 'PASSED ✅' : 'FAILED ❌'}\n`);
      process.exit(res.passTarget ? 0 : 1);
    })
    .catch((err) => {
      console.error('[bench] Error:', err);
      process.exit(1);
    });
}
