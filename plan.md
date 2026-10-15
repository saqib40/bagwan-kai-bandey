# Shift: Graph-Governed Codebase Migration Engine (`plan.md` v3)

## 1. Project Overview & Hackathon Positioning

* **Event:** Graph Hacks: Context for AI Agents (Powered by FalkorDB)
* **Target Track:** Track 01 — Agents That Act on Connected Data (Single-track focus; `(:MigrationEpisode)` nodes serve strictly as explainable audit trails)
* **One-Line Pitch:** *"Universal laws, pluggable packs. Shift is a graph-governed migration engine powered by FalkorDB that computes leaf-first execution order, collapses circular dependencies, enforces dual-signature shims with automatic de-shimming, and verifies edge-level invariants—keeping `tsc` green at every step, tests green at every checkpoint, and the final Fastify route table identical to the original Express app."*

---

## 2. The 3-Layer Architecture (Strict Separation of Concerns)

1. **Layer 1: The Universal Migration Engine (`src/engine/`)**
   * **Hard Rule:** Zero mentions of `"express"`, `"fastify"`, or `".ts"` are permitted in `src/engine/`.
   * **Responsibilities:** Owns the FalkorDB connection, GraphBLAS algorithm calls (`algo.pageRank`), Tarjan's Strongly Connected Components (SCC) condensation, transitive leaf-first ordering, the `SHIMMED` $\rightarrow$ `DE_SHIM` $\rightarrow$ `VERIFIED` lifecycle, tiered verification gates, and audit trail generation.

2. **Layer 2: The Language Adapter (`src/adapters/`)**
   * **Responsibilities:** Parses source files into universal modules, exported symbol signatures, and imports using `web-tree-sitter` (WASM), and evaluates AST queries defined by a Migration Pack.
   * **MVP Scope:** `TypeScriptAdapter` (`src/adapters/typescriptAdapter.ts`).

3. **Layer 3: The Migration Pack (`packs/`)**
   * **Responsibilities:** Declarative JSON configuration (`packs/express-to-fastify.json`) specifying legacy/target packages, Tree-sitter detection queries, dual-signature shim patterns, AST invariants, and verification commands.

---

## 3. The 5 Universal Laws of Topological Migration

1. **Principle 1: Transitive Callee-First Order & Risk-First Leaf Policy**
   * If Module $A$ depends on Module $B$ along any path ($A \xrightarrow{\text{IMPORTS}^+} B$), $B$ must be migrated (`VERIFIED` or `SHIMMED`) before $A$.
   * **Universal Rule:** A node (or SCC) is **Unblocked** if and only if zero transitive paths `[:IMPORTS*1..10]` lead to any node outside its SCC with status `'PENDING'` or `'IN_PROGRESS'`.
   * **Risk-First Policy:** Among unblocked leaves of minimal SCC size, the engine orders candidates by `pagerank DESC` so the most-imported shared helpers are migrated and shimmed first, stabilizing foundational contracts early.

2. **Principle 2: Atomic Cycle Collapse (The SCC Law)**
   * Circular dependencies ($A \rightarrow B \rightarrow A$) cannot be migrated file-by-file without breaking intermediate typechecks.
   * **Universal Rule:** Any Strongly Connected Component (SCC) with size $> 1$ is collapsed into a single atomic batch (`scc_id`). All members of the SCC (including `'CLEAN'` peers that must compile alongside `'PENDING'` peers) are included in the context slice and verified together.

3. **Principle 3: Dual-Signature Shims & Deterministic De-Shimming (The Strangler Fig Law)**
   * Migrating a leaf module $B$ that still has unmigrated callers (`pending_callers_count > 0`) will break those callers unless $B$ preserves backward compatibility.
   * **Shim Rule:** When `pending_callers_count > 0`, the agent writes a dual-signature shim (marking legacy compatibility lines with `// @shift-shim`) and commits the module as `'SHIMMED'`. `'SHIMMED'` unblocks upstream callers.
   * **De-Shim Cleanup Rule:** As soon as a `'SHIMMED'` module's `pending_callers_count` drops to $0$, `claim_next_leaf` surfaces it with `phase: 'DE_SHIM'`. The agent removes the shim wrapper and `// @shift-shim` markers, transitioning the module to `'VERIFIED'`.

4. **Principle 4: Per-Step Typechecking & Tiered Verification Gates**
   * **Per-Step Gate (`verify_and_commit_node`):** Runs on every single step:
     1. Re-parses modified files with Tree-sitter (asserts zero syntax `ERROR` nodes).
     2. Asserts strict legacy-edge bounds (`0` legacy edges allowed for `'VERIFIED'`; legacy edges allowed *only* on `// @shift-shim` lines when `pending_callers_count > 0`).
     3. Asserts per-module AST invariants against immutable `baseline_sets`.
     4. Runs whole-project `npx tsc --noEmit` to prove shims compile cleanly against all untouched callers and `'CLEAN'` pass-through modules.
   * **Checkpoint Gate (`run_checkpoint_gate`):** Runs after an SCC completes, after a de-shim pass, and when `pending_modules == 0`. Executes `npx tsc --noEmit`, `npm test`, and the Runtime Route Inventory Snapshot comparison.

5. **Principle 5: Scoped 1-Hop Subgraph Context (Minimum Viable Context)**
   * `get_migration_slice` returns only the full source code of the target module(s) (including `'CLEAN'` SCC peers), the exported `(:Symbol)` signatures of direct callees ($X \rightarrow Y$), and the import/usage snippets of direct callers ($Z \rightarrow X$).

---

## 4. Universal FalkorDB Graph Schema

*(Note: Cross-module `(:Symbol)-[:CALLS]->(:Symbol)` is intentionally omitted from the MVP; module-level `[:IMPORTS]` and `[:DECLARES]` signatures provide 100% of required ordering and slicing context.)*

### Node Labels

1. **`:MigrationMeta`** (Singleton Graph Metadata Node)
   * `repo_path`: `STRING`
   * `pack_id`: `STRING`
   * `baseline_routes`: `STRING` (Immutable JSON array of `"METHOD /full/path"` captured via runtime snapshot at `init_migration_graph`)

2. **`:Module`**
   * `path`: `STRING` (Primary key, relative to repo root, e.g., `"src/utils/response.ts"`)
   * `status`: `STRING` (`'CLEAN'` | `'PENDING'` | `'IN_PROGRESS'` | `'SHIMMED'` | `'VERIFIED'`)
   * `scc_id`: `INTEGER` (Tarjan cluster ID)
   * `scc_size`: `INTEGER` (Total modules in this SCC)
   * `in_degree`: `INTEGER` (Total incoming `[:IMPORTS]` edges)
   * `pending_callers_count`: `INTEGER` (Incoming callers outside this SCC with status `'PENDING'` or `'IN_PROGRESS'`)
   * `pagerank`: `FLOAT` (Computed via FalkorDB native `CALL algo.pageRank('Module', 'IMPORTS')`)
   * `baseline_sets`: `STRING` (Immutable JSON map of AST invariant sets captured once at initial ingest)
   * `current_sets`: `STRING` (JSON map of AST invariant sets updated on each verify step)
   * `shim_line_count`: `INTEGER` (Count of lines containing `// @shift-shim`)

3. **`:Symbol`**
   * `id`: `STRING` (`"{modulePath}#{symbolName}"`)
   * `module_path`: `STRING`
   * `name`: `STRING`
   * `kind`: `STRING` (`'function'` | `'class'` | `'type'` | `'variable'`)
   * `signature`: `STRING` (Exported declaration signature without function body)

4. **`:ExternalAPI`**
   * `id`: `STRING` (Rule ID from Pack, e.g., `"express-res-methods"`)
   * `role`: `STRING` (`'LEGACY'` | `'TARGET'`)
   * `description`: `STRING`

5. **`:MigrationEpisode`** (Audit Trail Node)
   * `step`: `INTEGER`
   * `timestamp`: `INTEGER`
   * `phase`: `STRING` (`'MIGRATE'` | `'SHIM'` | `'DE_SHIM'`)
   * `modules`: `STRING` (JSON array of module paths)
   * `new_status`: `STRING` (`'SHIMMED'` | `'VERIFIED'`)
   * `evidence_path`: `STRING` (Cypher proof explaining why the target was selected)
   * `agent_summary`: `STRING`

### Edge Types

* `(:Module)-[:IMPORTS]->(:Module)`
* `(:Module)-[:DECLARES]->(:Symbol)`
* `(:Module)-[:USES_API {line: INTEGER, snippet: STRING, is_shimmed: BOOLEAN}]->(:ExternalAPI)`
* `(:MigrationEpisode)-[:AFFECTED]->(:Module)`

---

## 5. Graph Algorithms (FalkorDB Native vs. Engine)

All FalkorDB queries use standard openCypher syntax tested against `falkordb/falkordb:latest` (avoiding Neo4j-specific `WHERE NOT EXISTS { MATCH ... }` subqueries in favor of `OPTIONAL MATCH ... WITH count()`):

1. **PageRank Risk Ranking (FalkorDB Native Procedure):**
   ```cypher
   CALL algo.pageRank('Module', 'IMPORTS') YIELD node, score
   SET node.pagerank = score
   RETURN node.path AS path, score ORDER BY score DESC
   ```

2. **Shortest Dependency Path (FalkorDB Native `shortestPath`):**
   ```cypher
   MATCH (caller:Module {path: $callerPath}), (callee:Module {path: $calleePath})
   MATCH p = shortestPath((caller)-[:IMPORTS*1..10]->(callee))
   RETURN [n IN nodes(p) | n.path] AS dependencyChain
   ```

3. **Strongly Connected Components (Tarjan's Algorithm in `src/engine/scc.ts`):**
   * Runs in TypeScript over the `[:IMPORTS]` adjacency list on initial ingest and during Step 2 of every `verify_and_commit_node` call, writing `scc_id` and `scc_size` to FalkorDB.

---

## 6. Core Cypher Queries & Re-Ingest Ordering (`src/engine/queries.ts`)

### 6.1 Claim Next Target: De-Shim Priority + Unblocked Leaf / SCC (`claim_next_leaf`)

**Pass A (De-Shim Cleanup Priority):** First checks if any `'SHIMMED'` module now has `pending_callers_count = 0`:

```cypher
MATCH (m:Module {status: 'SHIMMED'})
WHERE m.pending_callers_count = 0
WITH m ORDER BY m.pagerank DESC, m.path ASC LIMIT 1
MATCH (peer:Module {scc_id: m.scc_id})
SET peer.status = CASE WHEN peer.status = 'SHIMMED' THEN 'IN_PROGRESS' ELSE peer.status END
RETURN
  'DE_SHIM' AS phase,
  m.scc_id AS sccId,
  collect(peer.path) AS allClusterPaths,
  collect(CASE WHEN peer.status = 'IN_PROGRESS' THEN peer.path ELSE null END) AS targetPaths,
  0 AS pendingCallersCount,
  [] AS pendingCallerPaths
```

**Pass B (Unblocked Leaf / Atomic SCC Claim):** If Pass A returns 0 rows, finds an unblocked `'PENDING'` module using FalkorDB-compatible `OPTIONAL MATCH` aggregation, includes *all* SCC peers in `allClusterPaths` (even `'CLEAN'` peers), and atomically transitions `'PENDING'` members to `'IN_PROGRESS'`:

```cypher
MATCH (m:Module {status: 'PENDING'})
OPTIONAL MATCH (m)-[:IMPORTS*1..10]->(blocker:Module)
WHERE blocker.scc_id <> m.scc_id
  AND blocker.status IN ['PENDING', 'IN_PROGRESS']
WITH m, count(DISTINCT blocker) AS blockerCount
WHERE blockerCount = 0
ORDER BY m.scc_size ASC, m.pagerank DESC, m.path ASC
LIMIT 1
MATCH (peer:Module {scc_id: m.scc_id})
WITH m.scc_id AS sccId, collect(peer) AS clusterNodes
FOREACH (n IN [x IN clusterNodes WHERE x.status = 'PENDING'] | SET n.status = 'IN_PROGRESS')
WITH sccId, clusterNodes
UNWIND clusterNodes AS node
OPTIONAL MATCH (caller:Module)-[:IMPORTS]->(node)
WHERE caller.scc_id <> sccId AND caller.status IN ['PENDING', 'IN_PROGRESS']
RETURN
  CASE WHEN count(DISTINCT caller) > 0 THEN 'SHIM' ELSE 'MIGRATE' END AS phase,
  sccId,
  collect(DISTINCT node.path) AS allClusterPaths,
  [x IN clusterNodes WHERE x.status = 'IN_PROGRESS' | x.path] AS targetPaths,
  count(DISTINCT caller) AS pendingCallersCount,
  collect(DISTINCT caller.path) AS pendingCallerPaths
```

### 6.2 Strict 4-Step Ordering Inside `verify_and_commit_node`

To prevent stale cycle IDs or statuses from corrupting `pending_callers_count`, `verify_and_commit_node` **must** execute in this exact sequence:

1. **Step 1 (Edge Replacement):** Delete outgoing `[:IMPORTS]`, `[:USES_API]`, and `[:DECLARES]` edges from the modified `modulePaths`, and insert the newly parsed edges and `current_sets`:
   ```cypher
   MATCH (m:Module {path: $modulePath})
   SET m.current_sets = $currentSetsJson, m.shim_line_count = $shimLineCount
   WITH m
   OPTIONAL MATCH (m)-[rImp:IMPORTS]->(:Module) DELETE rImp
   WITH m
   OPTIONAL MATCH (m)-[rApi:USES_API]->(:ExternalAPI) DELETE rApi
   WITH m
   OPTIONAL MATCH (m)-[:DECLARES]->(sym:Symbol) DETACH DELETE sym
   ```
2. **Step 2 (Recompute Tarjan SCCs):** Query all `(a:Module)-[:IMPORTS]->(b:Module)` edges, run Tarjan's algorithm in TypeScript, and batch-update `scc_id` and `scc_size` on all `(:Module)` nodes.
3. **Step 3 (Verify Gate & Mutate Status):**
   * Recompute `pending_callers_count` for the target SCC.
   * Enforce the **Hard Legacy & Shim Gate**:
     * If `pending_callers_count == 0` (either direct migration or `DE_SHIM` phase): require **0** `[:USES_API]` edges (shimmed or unshimmed) and `shim_line_count == 0`. Target status becomes `'VERIFIED'`.
     * If `pending_callers_count > 0`: require **0** unshimmed `[:USES_API {is_shimmed: false}]` edges. If shimmed legacy edges or `// @shift-shim` lines exist, target status becomes `'SHIMMED'`; if 0 legacy edges exist, target status becomes `'VERIFIED'`.
   * Run `npx tsc --noEmit`. If `tsc` fails, revert status to `'PENDING'` (or `'SHIMMED'` if in `DE_SHIM` phase) and return compiler errors.
4. **Step 4 (Global Degree & Unblock Recalculation):** Now that `[:IMPORTS]`, `scc_id`, and `status` are all updated, recompute `in_degree` and `pending_callers_count` across the entire graph:
   ```cypher
   MATCH (target:Module)
   OPTIONAL MATCH (caller:Module)-[:IMPORTS]->(target)
   WITH target,
        count(DISTINCT caller) AS totalInDegree,
        sum(CASE WHEN caller.scc_id <> target.scc_id AND caller.status IN ['PENDING', 'IN_PROGRESS'] THEN 1 ELSE 0 END) AS pendingCallers
   SET target.in_degree = totalInDegree,
       target.pending_callers_count = pendingCallers
   ```

---

## 7. Layer 3: Built-In Migration Pack & Dual-Compatible Middleware Pattern (`packs/express-to-fastify.json`)

### Concrete Dual-Signature Patterns (Tested for Express + Fastify)

1. **`src/utils/response.ts` (Response Helper Shim):**
   Accepts either Fastify `FastifyReply` or Express `Response` by checking `typeof replyOrRes.code === 'function'`:
   ```typescript
   export function sendSuccess(replyOrRes: any, data: unknown, statusCode = 200) {
     if (typeof replyOrRes.code === 'function') {
       return replyOrRes.code(statusCode).send({ ok: true, data });
     }
     return replyOrRes.status(statusCode).json({ ok: true, data }); // @shift-shim
   }
   ```
2. **`src/middleware/auth.ts` (Middleware / Hook Shim):**
   *Why naive 3-arg async functions fail:* Fastify throws `FST_ERR_HOOK_INVALID_ASYNC_HANDLER` if an `async` hook function declares 3 formal parameters `(req, reply, done)` (`fn.length === 3`).
   *The Winning Rest-Param Pattern:* Declare 2 formal parameters `(req, reply, ...legacyRest)` so `requireAuth.length === 2` for Fastify's `preHandler`, while Express passes `next` as `legacyRest[0]`:
   ```typescript
   export async function requireAuth(req: any, replyOrRes: any, ...legacyRest: any[]) {
     const apiKey = req.headers?.['x-api-key'];
     if (apiKey !== 'secret-token') {
       return sendError(replyOrRes, 'Unauthorized', 401);
     }
     const next = legacyRest[0]; // @shift-shim
     if (typeof next === 'function') next(); // @shift-shim
   }
   ```

### `packs/express-to-fastify.json`

```json
{
  "$schema": "./PACK_SPEC.schema.json",
  "id": "express-to-fastify",
  "name": "Express.js to Fastify Migration Pack",
  "language": "typescript",
  "trustedExecutionNote": "Packs execute shell commands (typecheckCmd, testCmd, routeSnapshotCmd). Only load trusted packs.",
  "knownLimitations": [
    "AST route extraction matches receiver identifiers named app, router, fastify, or server. Full prefixed route verification relies on the runtime routeSnapshotCmd."
  ],
  "packages": {
    "legacy": ["express", "@types/express"],
    "target": ["fastify"]
  },
  "detectionRules": [
    {
      "id": "express-import-esm",
      "description": "ESM import from express",
      "astQuery": "(import_statement source: (string (string_fragment) @pkg (#eq? @pkg \"express\")))"
    },
    {
      "id": "express-import-cjs",
      "description": "CommonJS require('express')",
      "astQuery": "(call_expression function: (identifier) @fn (#eq? @fn \"require\") arguments: (arguments (string (string_fragment) @pkg (#eq? @pkg \"express\"))))"
    },
    {
      "id": "express-res-methods",
      "description": "Express response methods: res.json(), res.send(), res.status(), res.sendStatus()",
      "astQuery": "(call_expression function: (member_expression object: (identifier) @obj (#match? @obj \"^(res|response|replyOrRes)$\") property: (property_identifier) @prop (#match? @prop \"^(json|sendStatus|status)$\")))"
    },
    {
      "id": "express-router-mount",
      "description": "Express router creation or mounting: express.Router(), Router(), app.use()",
      "astQuery": "(call_expression function: (member_expression object: (identifier) @obj (#match? @obj \"^(express|app|router)$\") property: (property_identifier) @prop (#match? @prop \"^(Router|use)$\")))"
    },
    {
      "id": "express-middleware-arrow",
      "description": "3-argument arrow middleware (req, res, next) => ...",
      "astQuery": "(arrow_function parameters: (formal_parameters (required_parameter) (required_parameter) (required_parameter pattern: (identifier) @next (#eq? @next \"next\"))))"
    },
    {
      "id": "express-middleware-fn",
      "description": "3-argument function middleware function(req, res, next)",
      "astQuery": "(function_declaration parameters: (formal_parameters (required_parameter) (required_parameter) (required_parameter pattern: (identifier) @next (#eq? @next \"next\"))))"
    }
  ],
  "agentGuidance": {
    "MIGRATE": "Convert Express imports, routers, and handlers to Fastify (`FastifyPluginAsync`, `request`, `reply.code(c).send(d)`). Do NOT include any `// @shift-shim` comments.",
    "SHIM": "This module has unmigrated upstream callers (`pendingCallersCount > 0`). Write a dual-compatible shim so untouched Express callers still compile and pass tests. For response helpers, check `typeof reply.code === 'function'`. For middleware/hooks, declare `(req: any, reply: any, ...legacyRest: any[])` so `fn.length === 2` for Fastify while calling `legacyRest[0]?.()` for Express. Tag ONLY the legacy fallback lines with `// @shift-shim`.",
    "DE_SHIM": "All upstream callers of this module are now migrated (`pendingCallersCount == 0`). Remove all Express fallback branches and remove all `// @shift-shim` comments so the module uses pure Fastify types."
  },
  "invariants": [
    {
      "id": "module-route-surface-preserved",
      "scope": "per-step",
      "type": "extracted-set-equality",
      "description": "Every (HTTP_METHOD, PATH) registered on app/router/fastify/server in this file must match baseline_sets.",
      "astExtractor": "(call_expression function: (member_expression object: (identifier) @obj (#match? @obj \"^(app|router|fastify|server)$\") property: (property_identifier) @method (#match? @method \"^(get|post|put|delete|patch)$\")) arguments: (arguments . (string (string_fragment) @path)))"
    }
  ],
  "verification": {
    "perStepTypecheckCmd": "npx tsc --noEmit",
    "checkpointTestCmd": "npm test",
    "routeSnapshotCmd": "node scripts/dump-routes.mjs"
  }
}
```

---

## 8. Complete Specification of the 6 MCP Tools (`src/mcp/server.ts`)

1. **`init_migration_graph({ repoPath, packId })`**
   * Ensures FalkorDB is running, parses all files via `TypeScriptAdapter`, computes Tarjan SCCs, and runs `CALL algo.pageRank('Module', 'IMPORTS')`.
   * Sets `baseline_sets` (using `ON CREATE SET` so re-init never clobbers baseline invariants).
   * Runs `node scripts/dump-routes.mjs` and stores the canonical JSON route array on `(:MigrationMeta {baseline_routes})`.
   * Classifies modules with 0 legacy edges as `'CLEAN'` and $\ge 1$ legacy edge as `'PENDING'`.

2. **`claim_next_leaf()`**
   * Runs Query 6.1 (Pass A for `DE_SHIM` cleanup first; Pass B for unblocked `'PENDING'` leaves/SCCs).
   * Queries `shortestPath` to generate a human-readable dependency proof string.
   * Returns `{ phase: 'MIGRATE' | 'SHIM' | 'DE_SHIM', sccId, allClusterPaths, targetPaths, pendingCallersCount, pendingCallerPaths, proof }`.

3. **`get_migration_slice({ modulePaths, phase })`**
   * Reads full disk source for `modulePaths` (which includes `'CLEAN'` SCC peers if part of a cycle).
   * Queries FalkorDB for 1-hop downstream `(:Symbol)` signatures and 1-hop upstream caller snippets.
   * Returns the compact slice + phase-specific `agentGuidance[phase]` + immutable `baseline_sets`.

4. **`simulate_blast_radius({ modulePath })`**
   * Runs multi-hop traversal `MATCH p = (m:Module {path: $modulePath})<-[:IMPORTS*1..6]-(caller:Module)` and returns impacted modules, their statuses, hop distance, and `m.pagerank`.

5. **`verify_and_commit_node({ modulePaths, agentSummary })`**
   * Executes the strict 4-step sequence in Section 6.2:
     1. Re-parse `modulePaths` with Tree-sitter (rejects on AST `ERROR` nodes) & replace outgoing edges.
     2. Re-run Tarjan SCCs across the graph.
     3. Enforce the `// @shift-shim` & `zero-legacy-usages` gate + `module-route-surface-preserved` set equality + run `npx tsc --noEmit`.
     4. Update status (`'SHIMMED'` or `'VERIFIED'`), recompute global `in_degree` and `pending_callers_count`, and write a `(:MigrationEpisode)` node.
   * Automatically triggers the Checkpoint Gate (`npm test` + `dump-routes.mjs` diff) whenever an SCC finishes, a de-shim pass completes, or `count(PENDING) == 0 && count(SHIMMED) == 0`.

6. **`get_migration_audit_trail({ runCheckpointNow?: boolean })`**
   * Runs the full Checkpoint Gate if requested: asserts `tsc --noEmit` passes, `npm test` passes, `count(SHIMMED) == 0`, zero `@shift-shim` markers exist in files, and `dump-routes.mjs` output equals `(:MigrationMeta).baseline_routes`.
   * Queries all `(:MigrationEpisode)` nodes in step order and generates a Markdown audit report with Cypher evidence paths.

---

## 9. Hardened CLI & Docker Bootstrapper (`bin/cli.ts`)

* **Stdio Discipline:** Redirect all logs to `console.error()`. Never write to `stdout` outside `@modelcontextprotocol/sdk` transport frames.
* **Docker Lifecycle (`falkordb-shift-engine`):**
  1. If `process.env.FALKORDB_URL` is set, connect directly.
  2. Otherwise inspect `docker ps -a --filter "name=^/falkordb-shift-engine$" --format "{{.Status}}"`.
  3. If stopped, run `docker start falkordb-shift-engine`.
  4. If missing, check that port `6379` (Redis/FalkorDB) and port `3000` (FalkorDB Browser UI) are free, then run:
     `docker run -d --name falkordb-shift-engine -p 6379:6379 -p 3000:3000 -v falkordb_shift_data:/data falkordb/falkordb:latest`
  5. Wait until `PING` succeeds before starting the MCP server.

---

## 10. Demo Repository Specification (`demo-repo/`)

Build a self-contained 8-file Express TypeScript repository where `app.ts` exports the app factory separately from `server.ts` so tests and `dump-routes.mjs` can inspect it without binding a port:

1. `src/utils/hash.ts` — Pure helper (`CLEAN` on init; imported by `auditA.ts`).
2. `src/utils/response.ts` — Calls `res.status(code).json(...)` (`PENDING`, imported by `auth.ts`, `users.ts`, `orders.ts` $\rightarrow$ claimed 1st with `phase: 'SHIM'`, de-shimmed after callers migrate).
3. `src/middleware/auth.ts` — Reads `req.get('x-api-key')` (tests that `req.get` is NOT misclassified as a route!) and uses `(req, res, next)` ($\rightarrow$ claimed 2nd with `phase: 'SHIM'`, de-shimmed after routes migrate).
4. `src/services/auditA.ts` & `src/services/auditB.ts` — Mutually importing modules formatting request metadata (**forms a 2-node Tarjan SCC cycle $\rightarrow$ claimed and migrated atomically**).
5. `src/routes/users.ts` & `src/routes/orders.ts` — Express routers mounted under `/users` and `/orders` prefixes in `app.ts`.
6. `src/app.ts` — Mounts middleware and routers (`app.use('/users', usersRouter)` $\rightarrow$ `app.register(usersRoutes, { prefix: '/users' })`) and exports `createApp()`.
7. `src/server.ts` — Thin entrypoint calling `createApp()` and `.listen(4000)`.
8. `scripts/dump-routes.mjs` — Imports `createApp()`, boots the instance without network listen, extracts mounted routes from either Express (`app._router.stack` with mount prefix resolution) or Fastify (`onRoute` collector / `app.ready()`), and prints sorted JSON:
   `["GET /orders", "GET /orders/:id", "GET /users", "GET /users/:id", "POST /users"]`.
9. `test/api.test.ts` — Integration test suite testing all 5 endpoints and 401 auth rejection.

---

## 11. Execution Milestones (Build Order)

* [ ] **Milestone 0: Build `demo-repo`, Test Queries & Validate FalkorDB Cypher First**
  * Create `demo-repo/` with `scripts/dump-routes.mjs` and `test/api.test.ts`.
  * Manually verify the dual-signature shims in `response.ts` and `auth.ts` compile with `tsc --noEmit` and pass `npm test` while `users.ts` is still on Express.
  * Run a standalone script testing all `packs/express-to-fastify.json` Tree-sitter queries against `demo-repo` files (verifying `req.get('x-api-key')` produces zero false route hits).
  * Start `falkordb/falkordb:latest` and test every Cypher query in Sections 5 & 6 directly against the container.

* [ ] **Milestone 1: FalkorDB Client, Tarjan SCC & `init_migration_graph`**
  * Implement `bin/cli.ts`, `src/engine/falkorClient.ts`, `src/engine/scc.ts`, and `src/adapters/typescriptAdapter.ts`.
  * Verify graph creation and `algo.pageRank` in FalkorDB Browser (`http://localhost:3000`).

* [ ] **Milestone 2: Claim Loop, 1-Hop Slicer, Re-Ingest Verifier & De-Shimming**
  * Implement `claim_next_leaf` (with `DE_SHIM` pass + `SHIM` / `MIGRATE` pass).
  * Implement `get_migration_slice` and `verify_and_commit_node` with the strict 4-step re-ingest order and per-step `npx tsc --noEmit`.

* [ ] **Milestone 3: MCP Server Integration & End-to-End Dry Run**
  * Expose the 6 MCP tools in `src/mcp/server.ts`.
  * Run a complete autonomous migration of `demo-repo`: verify `response.ts` and `auth.ts` transition `PENDING` $\rightarrow$ `SHIMMED` $\rightarrow$ `VERIFIED`, `auditA`/`auditB` migrate atomically as an SCC, `tsc` passes on every step, and `npm test` + `dump-routes.mjs` match 100% at completion.

* [ ] **Milestone 4: Benchmark, Scale Check & Demo Video**
  * Generate a synthetic 150-module graph to benchmark Query 6.1 execution latency ($< 25\text{ ms}$) in case judges ask about scale.
  * Record the benchmark table comparing Naive Grep Agent vs. Shift MCP (tool calls, tokens, broken `tsc` steps).
  * Record the 3-minute demo video showing FalkorDB Browser (`localhost:3000`) updating node colors (`PENDING` $\rightarrow$ `SHIMMED` $\rightarrow$ `VERIFIED`) alongside the editor.