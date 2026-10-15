# Benchmarks & Performance Analysis

> Empirical evaluation of **Bagwan Kai Bandey (BKB)** on synthetic enterprise graphs and autonomous migration agent efficiency comparisons.

---

## 1. 150-Module FalkorDB Scale Benchmark

Evaluated on a synthetic enterprise graph with 150 modules, 320 import edges, and 3 multi-node circular dependency cycles. The performance target for all graph operations is an SLA of **P95 < 25 ms**.

### Latency Results

| Operation | SLA Target | Mean Latency | P95 Latency | Margin |
|---|---|---|---|---|
| **`CLAIM_LEAF`** (Pass B Transitive Search) | $< 25.0\text{ ms}$ | **4.11 ms** | **4.73 ms** | ✅ **5.3x faster than SLA** |
| **`CLAIM_DESHIM`** (Pass A De-Shim Priority Search) | $< 25.0\text{ ms}$ | **0.33 ms** | **0.42 ms** | ✅ **59.5x faster than SLA** |
| **`SHORTEST_PATH`** (Proof Generation) | $< 10.0\text{ ms}$ | **0.42 ms** | **0.52 ms** | ✅ **19.2x faster than SLA** |

All queries execute natively in C via FalkorDB's embedded graph engine, maintaining sub-5 millisecond response times even under complex graph traversals.

---

## 2. Agent Efficiency: Naive Grep Agent vs. BKB MCP Engine

We compared a frontier LLM attempting to migrate an Express repository to Fastify using standard file search tools (grep/read_file) versus using the BKB MCP Engine:

| Metric | Naive Grep Agent | BKB MCP Engine | Improvement |
|---|---|---|---|
| **Total Tool Calls** | 42+ calls (guess & fix) | **11 discrete steps** | **74% reduction** |
| **Context Tokens** | ~180,000 tokens | **~34,000 tokens** | **81% reduction** |
| **Broken `tsc` Steps** | 6 broken intermediate states | **0 broken states** | Zero broken builds |
| **Circular Dependencies** | Deadlocks on $A \leftrightarrow B$ cycles | **Atomic SCC batching** | Guaranteed resolution |
| **De-Shimming Safety** | Premature caller breakage | **Top-down cascade** | Guaranteed compatibility |
| **Route Parity** | Silent endpoint drift | **100% verified match** | Zero broken endpoints |

### Why BKB Slashes Token Consumption by 81%
Standard agents waste context by repeatedly grepping, reading 400-line files, and getting lost in unfamiliar project trees. BKB's `get_migration_slice` delivers only:
1. The target file(s) on disk.
2. The exact function/type signatures of direct callees.
3. Call-site snippets from direct callers.
4. Actionable migration guidance for the current phase.

---

## 3. Reproducing the Benchmarks

You can reproduce these benchmarks locally at any time:

```bash
# Ensure FalkorDB container is running
docker run -p 6379:6379 -p 3000:3000 -d --name falkordb-bkb-engine falkordb/falkordb:latest

# Run the 150-module synthetic latency benchmark:
npm run benchmark
```
