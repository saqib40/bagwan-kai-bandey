# Shift Codebase Audit & Bug Report (`review.md`)

## Overview
This review audits the current implementation of `shift-migration-engine` against the `plan.md` v3 specification. While the 3-layer separation, Tarjan SCC condensation, Top-Down De-Shim Cascade (`LEGACY_CALLER_STATUSES`), and 150-module benchmark are in place, there are **2 critical bugs**, **2 medium edge-case bugs**, and **3 polish/compliance items** that must be fixed before recording the hackathon demo.

---

## 1. Critical Bugs (Must Fix Immediately)

### Bug 1.1: Copy-Paste Typo in `src/server/demoServer.ts` Breaks Step 8 Live in the Cockpit UI
- **Location:** `src/server/demoServer.ts` (Line 272, inside `STEP_CODE_STATES['src/routes/users.ts:DE_SHIM']`)
- **Symptom:** When running the Shift Migration Cockpit (`npm run demo` at `http://localhost:4200`), clicking **Step Forward** or **Auto-Play** succeeds through Step 7, but on **Step 8 (`DE_SHIM` of `src/routes/users.ts`)**, the **Integration Tests** verification gate (`#gate-test`) flips to `❌ FAIL`.
- **Root Cause:** In `STEP_CODE_STATES['src/routes/users.ts:DE_SHIM']`, the 404 handler in `users.ts` says `'Order not found'` instead of `'User not found'`:
  ```typescript
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = users.find((o) => o.id === Number(request.params.id));
    if (!user) return sendError(reply, 'Order not found', 404); // <-- BUG: Should be 'User not found'
    return sendSuccess(reply, user);
  });
  ```
  Because `shouldTriggerCheckpoint()` runs `runCheckpointGate()` after every `DE_SHIM` step, `demo-repo/test/api.test.ts` executes `GET /users/999` and fails on `assert.deepEqual(miss.body, { ok: false, error: 'User not found' })`.
- **Fix:** In `src/server/demoServer.ts`, change `(o) => o.id` to `(u) => u.id` and `'Order not found'` to `'User not found'` inside `STEP_CODE_STATES['src/routes/users.ts:DE_SHIM']`.

---

### Bug 1.2: Silent Status Update Failure When an Agent Retries `verify_and_commit_node`
- **Location:** `src/engine/operations.ts` (Lines 426–433 in `verifyAndCommitNode` Step 3g, and Lines 564–586 in `revertAndReturn`)
- **Symptom:** If an LLM agent via MCP submits code that fails verification on its first attempt (e.g., a `tsc --noEmit` error or forgotten `// @shift-shim` comment) and then fixes the file and calls `verify_and_commit_node` a second time, `verify_and_commit_node` returns `{ ok: true, newStatus: 'SHIMMED' | 'VERIFIED' }`, **but the module status in FalkorDB silently stays `'PENDING'` (or `'SHIMMED'`)**.
- **Root Cause:**
  1. On the first failed verify call, `revertAndReturn()` reverts `m.status` from `'IN_PROGRESS'` back to `'PENDING'` (or `'SHIMMED'` if `claimed_phase === 'DE_SHIM'`).
  2. When the agent fixes the code on disk and re-runs `verify_and_commit_node` without calling `claim_next_leaf` again, Step 3g executes:
     ```typescript
     for (const mp of modulePaths) {
       await this.db.query(
         `MATCH (m:Module {path: $path})
          WHERE m.status = 'IN_PROGRESS'
          SET m.status = $status`,
         { path: mp, status: newStatus },
       );
     }
     ```
  3. Because `m.status` is no longer `'IN_PROGRESS'`, the `WHERE` clause matches 0 rows and never updates `m.status`.
- **Fix:** Remove `WHERE m.status = 'IN_PROGRESS'` in Step 3g of `src/engine/operations.ts` (or widen it to `WHERE m.status IN ['IN_PROGRESS', 'PENDING', 'SHIMMED']`), AND keep `m.status = 'IN_PROGRESS'` on failed verification attempts so a claimed node remains claimed by the agent until verification passes.

---

## 2. Medium Bugs (Edge Cases in Engine & Verification)

### Bug 2.1: Step 1 Mutates FalkorDB Graph Edges Before Checking for Syntax Errors
- **Location:** `src/engine/operations.ts` (Lines 271–331 in `verifyAndCommitNode` Step 1)
- **Symptom:** If an agent introduces a syntax error in a file and calls `verify_and_commit_node`, Step 1 detects `parsed.hasSyntaxError`, records the error, **but still runs `Q.REPLACE_OUTGOING`** and inserts broken/partial symbols and imports into FalkorDB before returning at Line 333 (`if (errors.length) return this.revertAndReturn(...)`).
- **Root Cause:** Graph edge replacement is inside the same loop as `adapter.parseModule()` instead of running after all files in `modulePaths` are validated to be syntax-error-free.
- **Fix:** Split Step 1 into two loops:
  1. Parse all `modulePaths` with `adapter.parseModule()` and check `if (parsed.hasSyntaxError)`. If `errors.length > 0`, return `this.revertAndReturn(modulePaths, errors, 1)` immediately without touching FalkorDB edges.
  2. Only after all files parse cleanly, execute `Q.REPLACE_OUTGOING` and re-insert `[:DECLARES]`, `[:IMPORTS]`, and `[:USES_API]` edges.

---

### Bug 2.2: Async `createApp()` Thenable Trap in `dump-routes.mjs` & Pack Guidance
- **Location:** `demo-repo/scripts/dump-routes.mjs` (Lines 57–59) and `packs/express-to-fastify.json` (`agentGuidance.MIGRATE`)
- **Symptom:** When a live LLM migrates `demo-repo/src/app.ts` to Fastify, it frequently writes `export async function createApp()` and `await app.register(usersRoutes, { prefix: '/users' })`. If `createApp()` is `async`, `dump-routes.mjs` fails to capture routes or throws an error.
- **Root Cause:** In `demo-repo/scripts/dump-routes.mjs`:
  ```javascript
  const isFastifyInstance = (x) => typeof x?.inject === 'function' && typeof x?.register === 'function';
  const created = createApp();
  const app = isFastifyInstance(created) ? created : await created;
  ```
  Because a `FastifyInstance` defines a `.then()` method (making it a JS thenable), returning a `FastifyInstance` from an `async function createApp()` causes `await created` to invoke `app.then()`, which automatically runs `app.ready()` and seals the Fastify server **before** `fastifyRoutes(app)` can attach `app.addHook('onRoute', ...)`.
- **Fix:** Update `agentGuidance.MIGRATE` in `packs/express-to-fastify.json` to explicitly state:
  > *"Keep `createApp()` synchronous (do NOT mark `createApp` as `async`, and do NOT `await app.register(...)` inside `createApp`) so `onRoute` hooks can attach before `app.ready()`."*

---

## 3. Architectural Compliance & Polish Items

### Item 3.1: Layer 1 Language-Agnostic Rule Violation in `src/engine/operations.ts`
- **Location:** `src/engine/operations.ts` (Line 163 in `buildProof` and Line 236 in `getMigrationSlice`)
- **Issue:** Both lines use `.replace(/\.[jt]sx?$/, '')`, which hardcodes JavaScript/TypeScript file extensions inside `src/engine/`, violating the Layer 1 boundary rule (`"Zero mentions of language or framework specifics in src/engine/"`).
- **Fix:** Replace `.replace(/\.[jt]sx?$/, '')` with the universal extension regex `.replace(/\.[^/.]+$/, '')`.

---

### Item 3.2: Cockpit UI Hardcoded Latency Badge & Reset State (`public/app.js`)
- **Location:** `public/index.html` (Line 70) and `public/app.js` (`showActiveTarget` & `resetCodebase`)
- **Issues:**
  1. `#graph-latency` in the top graph header (`⚡ FalkorDB: 1.5 ms`) is static and never updates with the real `claimLatencyMs` returned by `/api/step`.
  2. `resetCodebase()` in `public/app.js` does not reset `#gate-tsc`, `#gate-test`, `#gate-routes`, `#gate-falkor`, or `#gate-overall-badge` back to their initial green baseline state.
- **Fix:**
  1. In `showActiveTarget(claim, claimLatencyMs)` (`public/app.js`), add:
     ```javascript
     document.getElementById('graph-latency').textContent = `⚡ FalkorDB: ${claimLatencyMs ?? '1.2'} ms`;
     ```
  2. In `resetCodebase()` (`public/app.js`), reset the 4 gate tiles and `#gate-overall-badge`.

---

### Item 3.3: Missing `packs/PACK_SPEC.md` and `test/` Excluded from Root `tsconfig.json`
- **Location:** `packs/` directory and root `tsconfig.json`
- **Issues:**
  1. `plan.md` and `packs/express-to-fastify.json` reference `PACK_SPEC` documentation/schema in `packs/`, which is missing from the repository.
  2. Root `tsconfig.json` has `"include": ["src", "bin", "scripts"]`, omitting `"test"`, so `npm run typecheck` does not typecheck the test suite.
- **Fix:** Add `"test"` to `"include"` in root `tsconfig.json`, and add `packs/PACK_SPEC.md` documenting the declarative pack format and trusted command execution model.

---

## Verification Checklist After Applying Fixes
- [x] Run `npm run typecheck` (with `"test"` included in `tsconfig.json`) and verify 0 errors.
- [x] Run `npm test` and verify all 28 tests pass.
- [x] Start the Cockpit (`npm run demo`), click **Auto-Play ▶**, and verify all 11 steps complete with **Integration Tests (`6/6 PASS`)** staying green on Step 8 (`users.ts` `DE_SHIM`) through Step 11.
