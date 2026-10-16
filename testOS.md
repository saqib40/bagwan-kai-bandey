# Open-Source Testing Blueprint — Bagwan Kai Bandey (BKB)

This document is the authoritative plan and execution protocol for validating Bagwan Kai Bandey (BKB) against **real-world, third-party open-source repositories**.

While synthetic fixtures (`demo-repo`, `demo-repo-cjs`, `demo-repo-jest`, `demo-repo-flask`) prove the engine's graph algorithms, topological sorting, and Tarjan cycle clustering mathematically, testing against real open-source codebases verifies BKB's resilience against:
- Complex barrel exports and re-export chains (`index.ts` re-exporting multiple modules).
- Custom `tsconfig.json` path aliases, monorepo structures, and ambiguous `.js` file extensions.
- Framework-specific middleware pipelines, error handlers, and dependency injection patterns.
- Real-world test suites featuring database mocks, lifecycle hooks, and asynchronous fixtures.

---

## 1. Selection Criteria & Guardrails

To prevent token exhaustion, long execution stalls, or combinatorial graph explosion, candidate repositories must satisfy five strict criteria:

1. **Module Count (10–35 source files):** Sufficiently complex to exercise multi-tier dependencies; small enough to migrate within bounded time and token budgets.
   - *Sub-10 Module Smoke-Test Exception:* Micro-libraries with 2–8 modules (such as `is-plain-obj` or `node-glob`) are permitted as rapid Phase 1–2 smoke targets to verify export shapes and CJS interop without long execution times.
2. **Pre-Existing Passing Tests:** Must have a working, reproducible automated test suite (`npm test`, `pytest`, etc.) at baseline before migration begins.
3. **Topological Depth:** Must contain distinct architectural layers (leaf utilities → services/models → controllers/routes → entrypoint).
4. **Deterministic Version Pinning:** Every repository is pinned to an exact release tag or default branch commit (verify at checkout).
5. **Workspace Isolation:** All repositories are cloned exclusively into the git-ignored `scratch/` directory and never committed to BKB's source tree.

---

## 2. Complete Open-Source Repository Catalog

> **Read before using any entry:** the built-in packs assume BKB's synthetic fixture layout.
> Every target below requires the **Phase 0 pack adaptation** (globs, typecheck command, and
> snapshot/test scripts) described in §4 before Phase 3. Entries marked *Phase 1–2 only* are
> ingestion/schedule probes and are not expected to complete an active migration.

### 2.1 Pack: `express-to-fastify` (TypeScript / JavaScript)

#### Option A (Primary — Real REST API): `gothinkster/node-express-realworld-example-app`
- **Repository URL:** `https://github.com/gothinkster/node-express-realworld-example-app`
- **Pinned Ref:** Branch `master` (verify commit at checkout)
- **Language / Runtime:** JavaScript (Node.js)
- **Module Count:** ~18 files (`routes/api/`, `models/`, `config/`, `app.js`)
- **Baseline Test Command:** `npm test` (Mocha/Supertest)
- **Architectural Highlights:**
  - Standard "Conduit" RealWorld backend specification (pure JSON REST API).
  - Multi-tier router structure: `routes/index.js` mounts sub-routers (`/api/users`, `/api/articles`, `/api/tags`).
  - Middleware: JWT authentication (`express-jwt`), Mongoose schema validation, centralized error handler.
- **What it Validates:**
  - Express router hierarchy unnesting into Fastify plugin scopes.
  - Middleware conversion (`req.payload`, `res.json()`, `res.status()`).
  - Route-surface parity snapshot matching.

#### Option B (Secondary — Ingestion & Strict Typecheck Target): `microsoft/TypeScript-Node-Starter`
- **Repository URL:** `https://github.com/microsoft/TypeScript-Node-Starter` *(Note: Archived by Microsoft)*
- **Pinned Ref:** Branch `master` (verify commit at checkout)
- **Language / Runtime:** TypeScript (Node.js)
- **Module Count:** ~14 TypeScript files in `src/` (`controllers/`, `models/`, `config/`, `app.ts`, `server.ts`)
- **Baseline Test Command:** `npm test` (Jest/Supertest)
- **Architectural Highlights:**
  - Microsoft's official starter for Express and TypeScript.
  - Uses `@types/express` (`Request`, `Response`, `NextFunction`).
  - *Caveat:* Contains server-rendered Pug templates, session cookies, and Lusca CSRF; serves primarily as a Phase 1–2 AST ingestion, import resolution, and strict TypeScript compiler (`tsc --noEmit`) verification target.
- **What it Validates:**
  - Strict TypeScript compiler verification throughout intermediate migration steps.

---

### 2.2 Pack: `flask-to-fastapi` (Python)

#### Option A (Primary — Real REST API): `gothinkster/flask-realworld-example-app`
- **Repository URL:** `https://github.com/gothinkster/flask-realworld-example-app`
- **Pinned Ref:** Branch `master` (verify commit at checkout)
- **Language / Runtime:** Python 3.10+
- **Module Count:** ~16 Python files (`conduit/user/`, `conduit/articles/`, `conduit/profile/`, `conduit/app.py`)
- **Baseline Test Command:** `pytest`
- **Architectural Highlights:**
  - RealWorld specification with SQLAlchemy ORM, marshmallow schemas, and JWT extensions (pure JSON REST API).
  - Nested blueprint routes, relational data models, user profiles, comments, and tagging.
- **What it Validates:**
  - Thread-local global unnesting: replacing `flask.request` and `flask.g` with explicit dependency injection (`Depends`) and typed Pydantic models.
  - Multi-tier service and model import graph traversal via `PythonAdapter`.
  - Route canonicalizer (`dump_routes.py`) parity against the `pytest` suite.

#### Option B (Secondary — Ingestion & Blueprint Smoke Target): `pallets/flask` Tutorial App (`flaskr`)
- **Repository URL:** `https://github.com/pallets/flask` (path: `examples/tutorial`)
- **Pinned Tag:** `3.0.3` (or branch `main`)
- **Language / Runtime:** Python 3.10+
- **Module Count:** ~7 Python files (`flaskr/__init__.py`, `flaskr/db.py`, `flaskr/auth.py`, `flaskr/blog.py`, plus tests)
- **Baseline Test Command:** `pytest` (100% test coverage)
- **Architectural Highlights:**
  - Official reference application authored and maintained by the Pallets core team.
  - *Caveat:* Server-rendered HTML app using Jinja templates, form POSTs, session cookies, and SQLite. FastAPI does not directly replace Jinja form rendering; this app serves as a Phase 1–2 AST ingestion, blueprint discovery, and import graph smoke test rather than an active REST migration target.
- **What it Validates:**
  - Python AST parsing, Blueprint registration, and `PythonAdapter` import graph construction.

---

### 2.3 Pack: `cjs-to-esm` (CommonJS → Pure ES Modules)

#### Option A (Primary — High Complexity): `isaacs/node-glob`
- **Repository URL:** `https://github.com/isaacs/node-glob`
- **Pinned Tag:** `v7.2.3` (verify tag at checkout; legacy CommonJS branch)
- **Language / Runtime:** JavaScript (CommonJS, Node ≥ 22.12)
- **Module Count:** 3 migrated sources at repo root (`glob.js`, `sync.js`, `common.js`); `benchclean.js` is a benchmark helper (excluded)
- **Baseline Test Command:** `npm test`
- **Architectural Highlights:**
  - The canonical file-system globbing utility for Node.js.
  - Multi-file CommonJS architecture with callable `module.exports = glob` and `__dirname`.
  - **Verified mutual cycle:** `glob.js:51` requires `./sync.js`, and `sync.js:7` requires
    `./glob.js` → both must be claimed as one SCC (BKB detects this on ingestion).
- **What it Validates:**
  - `runtime-interop` shim strategy under Node ≥ 22.12 synchronous `require(esm)`.
  - Tarjan SCC grouping on a genuine real-world circular dependency.
  - Export surface preservation and callable function shapes (`scripts/dump-modules.mjs`).
- **Pack Adaptation (as applied):** `cjs-to-esm` globs `src/**/*.js`, but `node-glob@v7`'s sources
  live at the repo root. Extend `sourceGlobs` to root `*.js` (exclude `benchclean.js`,
  `node_modules/`), replace `npx tsc --noEmit` with JS-safe `node scripts/check-all.mjs`
  (no `tsconfig.json` exists), and snapshot the module list via `scripts/dump-modules.mjs`.
  Result on ingestion: **3 modules / 2 SCCs**.

#### Option B (Secondary — Micro Smoke Target): `sindresorhus/is-plain-obj`
- **Repository URL:** `https://github.com/sindresorhus/is-plain-obj`
- **Pinned Tag:** `v2.1.0` (verify tag at checkout; legacy CJS release before ESM conversion)
- **Language / Runtime:** JavaScript (CommonJS)
- **Module Count:** 2 files (`index.js`, `index.d.ts`)
- **Baseline Test Command:** `npm test`
- **Architectural Highlights:**
  - Ultra-focused utility library with zero external dependencies.
- **What it Validates:**
  - Fast, zero-overhead smoke test of `cjs-to-esm` detection queries, type preservation, and export surface snapshots.
- **Pack Adaptation (as applied):** root-level `index.js` falls outside the `src/**/*.js` glob;
  `sourceGlobs` set to `index.js`, JS-safe typecheck `node --check index.js`, snapshot export
  surface via `scripts/dump-exports.mjs`. Result on ingestion: **1 module**. **CJS confirmed** at
  `v2.1.0` (`module.exports = value => {…}`); a deterministic `.bkb-mocks.json` completed a full
  mock migration with export surface preserved 1:1 (`["default=function","module.exports"]`).
- **Pin risk (highest in catalog):** `is-plain-obj`'s current `main` is pure ESM; **`v2.1.0` was
  verified to be genuinely CommonJS** at checkout (keep confirming on re-clone).

---

### 2.4 Pack: `jest-to-vitest` (Testing Frameworks)

#### Option A (Primary — Real Jest Suite): `hagopj13/node-express-boilerplate`
- **Repository URL:** `https://github.com/hagopj13/node-express-boilerplate`
- **Pinned Ref:** Branch `master` (verify commit at checkout)
- **Language / Runtime:** JavaScript / Node.js
- **Module Count:** ~12 test files (`tests/unit/`, `tests/integration/`)
- **Baseline Test Command:** `npm test` (Jest: `jest -i --colors --verbose --detectOpenHandles`)
- **Architectural Highlights:**
  - Production-ready Express boilerplate with a comprehensive, genuine Jest test suite.
  - Tests utilize `jest.fn()`, mocks, `describe`/`it`/`expect`, and Supertest integration tests.
- **What it Validates:**
  - Converting Jest APIs and spies: `jest.fn()` → `vi.fn()`, `jest.spyOn()` → `vi.spyOn()`, `jest.mock()` → `vi.mock()`.
  - Runner-agnostic execution wrapper (`run-tests.mjs`) selecting Jest initially, then Vitest post-migration.
  - Test-count snapshot invariance (`test-counts.mjs`) proving 100% of test cases pass without dropped tests.
- **Pack Adaptation (required):** this repo's tests are **`.js`** (`tests/unit/`, `tests/integration/`),
  but `jest-to-vitest` only globs `test/**/*.ts`/`tests/**/*.ts` → it parses 0 modules. Add
  `tests/**/*.js` to `sourceGlobs`, and add `scripts/run-tests.mjs` + `scripts/test-counts.mjs`.
  (Option B's `.ts` tests match the built-in globs and are the safer first Jest target.)

#### Option B (Secondary — TypeScript Jest Suite): `microsoft/TypeScript-Node-Starter` (path: `test/`)
- **Repository URL:** `https://github.com/microsoft/TypeScript-Node-Starter` *(Reuses repository from §2.1 B)*
- **Pinned Ref:** Branch `master`
- **Language / Runtime:** TypeScript + Jest (`ts-jest`)
- **Module Count:** ~6 test files (`test/user.test.ts`, `test/api.test.ts`, `test/contact.test.ts`)
- **Baseline Test Command:** `npm test`
- **Architectural Highlights:**
  - Integration test suite combining Supertest HTTP assertions with Jest mocks under TypeScript.
- **What it Validates:**
  - Converting TypeScript-annotated Jest tests and types (`Mock`, `MockInstance`) to Vitest equivalents.

---

## 3. Comparison Matrix

| Target Repository | Migration Pack | Language | Repo Files | Detected (built-in globs) | Pre-existing Tests | Needs Phase 0 Adaptation | Primary Testing Goal |
|---|---|---|---|---|---|---|---|
| **`node-express-realworld`** | `express-to-fastify` | JavaScript | 18 | 18 | Supertest/Mocha | Yes — add `dump-routes.mjs` | Router tree unnesting & middleware (Primary REST) |
| **`TypeScript-Node-Starter`** | `express-to-fastify` | TypeScript | 14 | 14 | Jest/Supertest | Yes — add `dump-routes.mjs` | Strict `tsc` compiler gate preservation (Archived, ingestion focus) |
| **`flask-realworld`** | `flask-to-fastapi` | Python | 16 | 16 | Pytest | Yes — add `dump_routes.py` | Thread-local unnesting (`request` → `Depends`) (Primary REST) |
| **`flaskr` (Pallets)** | `flask-to-fastapi` | Python | 7 | 7 | Pytest (100%) | Ingestion only (Phases 1–2) | Blueprint unnesting & AST ingestion smoke |
| **`node-glob@v7`** | `cjs-to-esm` | JavaScript (CJS) | 6 | **0** (root-level, glob is `src/**`) | Tap/Node | Yes — extend globs + JS-safe typecheck | Callable export shapes & runtime interop |
| **`is-plain-obj@v2`** | `cjs-to-esm` | JavaScript (CJS) | 2 | **0** (root-level, glob is `src/**`) | Ava/Node | Yes — extend globs + JS-safe typecheck | Rapid export-shape smoke test |
| **`node-express-boilerplate`** | `jest-to-vitest` | JavaScript | 12 | **0** (`.js` tests, glob is `.ts`) | Jest | Yes — add `tests/**/*.js` | Genuine Jest mocks (`vi.fn()`) & test-count snapshot |
| **`TypeScript-Node-Starter (test/)`** | `jest-to-vitest` | TypeScript | 6 | 6 | Jest (`ts-jest`) | Yes — add snapshot scripts | TypeScript type conversions (`MockInstance`) |

> "Detected" is what the built-in pack's `sourceGlobs` match **before** Phase 0 adaptation. A
> detected count of `0` means Phase 3 would have nothing to migrate — adapt the globs first.

---

## 4. Step-by-Step Execution Protocol

Testing an open-source repository follows an orderly 5-phase protocol. Phase 0 is a
prerequisite that adapts the built-in migration pack to the target repo's layout;
skipping it causes Phase 3/4 to fail on the first checkpoint gate.

```
┌────────────────────────────────────────────────────────┐
│ Phase 0: Pack Adaptation (REQUIRED)      (Zero LLM Cost)│ -> Fix sourceGlobs, typecheck cmd, snapshot scripts
├────────────────────────────────────────────────────────┤
│ Phase 1: Ingestion & Topology Smoke      (Zero LLM Cost)│ -> Parse AST, resolve imports, detect SCCs
├────────────────────────────────────────────────────────┤
│ Phase 2: Claim Schedule Dry Run          (Zero LLM Cost)│ -> Verify 100% callee-first claim path
├────────────────────────────────────────────────────────┤
│ Phase 3: Active Governed Migration       (LLM or Agent) │ -> Apply edits, enforce compiler & test gates
├────────────────────────────────────────────────────────┤
│ Phase 4: Snapshot Parity & Verification  (Tooling)      │ -> Verify route surface, exports, & test counts
└────────────────────────────────────────────────────────┘
```

### Phase 0: Pack Adaptation for Open-Source Repos (Zero LLM Cost)

**Why this is mandatory.** Every built-in pack (`packs/*.json`) was authored against BKB's
synthetic `demo-repo*` fixtures. Three assumptions break on a real repository:

1. **Snapshot/test scripts are fixture-bound.** Each pack's `checkpointTestCmd` and snapshot
   command invoke scripts that exist only in the synthetic fixtures. A cloned OSS repo has none
   of them, so the first checkpoint gate or Phase 4 snapshot fails immediately:
   | Pack | `checkpointTestCmd` | Snapshot command(s) | Fixture-only files |
   |---|---|---|---|
   | `express-to-fastify` | `npm test` | `node scripts/dump-routes.mjs` | `scripts/dump-routes.mjs` |
   | `cjs-to-esm` | `node scripts/smoke.mjs` | `node scripts/dump-exports.mjs` | `scripts/smoke.mjs`, `scripts/dump-exports.mjs` |
   | `jest-to-vitest` | `node scripts/run-tests.mjs` | `node scripts/test-counts.mjs` | `scripts/run-tests.mjs`, `scripts/test-counts.mjs` |
   | `flask-to-fastapi` | `python3 -m pytest -q` | `python3 scripts/dump_routes.py` | `scripts/dump_routes.py` |
2. **`sourceGlobs` match the fixture tree, not every repo layout.** `cjs-to-esm` only globs
   `src/**/*.js`; `jest-to-vitest` only globs `test/**/*.ts`/`tests/**/*.ts`. Root-level sources
   (`node-glob@v7`, `is-plain-obj`) and `.js` test suites (`hagopj13/node-express-boilerplate`)
   match **zero** files, so BKB parses nothing.
3. **`perStepTypecheckCmd` assumes TypeScript.** `npx tsc --noEmit` requires a `tsconfig.json`;
   plain-JS CJS repos have none, so every per-step typecheck gate fails.

**Adaptation options (pick one):**
- **A. Repo-local scripts (fastest):** author the missing snapshot/test scripts inside the cloned
  `scratch/<REPO_NAME>/` (never committed), so the pack's commands resolve. Good for a one-off probe.
- **B. Repo-specific pack variant (recommended):** `./bin/bkb.js pack init <name>-oss`, then edit
  `sourceGlobs`, `perStepTypecheckCmd`, `checkpointTestCmd`, and snapshots for the target layout.
- **C. Pass `--pack <path/to/custom.json>`** to `init`/`run` when invoking BKB.

**Per-catalog-repo adaptation:**

| Target Repository | Pack | Adaptation required |
|---|---|---|
| `node-express-realworld` | `express-to-fastify` | Copy in `scripts/dump-routes.mjs`; keep `checkpointTestCmd: npm test`. |
| `TypeScript-Node-Starter` | `express-to-fastify` | Copy in `dump-routes.mjs`; has `tsconfig.json`, so `tsc` gate is OK. Ingestion focus. |
| `flask-realworld` | `flask-to-fastapi` | Copy in `scripts/dump_routes.py`; `pytest`/`mypy` gates OK. |
| `flaskr` (Pallets) | `flask-to-fastapi` | Ingestion-only (Phases 1–2); add `dump_routes.py` only if attempting Phase 4. |
| `node-glob@v7` | `cjs-to-esm` | Extend `sourceGlobs` to root `*.js` (exclude `test/`, `node_modules/`); swap `npx tsc --noEmit` for a JS-safe check (e.g. `node --check` per file or omit); add `smoke.mjs`/`dump-exports.mjs`. |
| `is-plain-obj@v2` | `cjs-to-esm` | Same as `node-glob`; single root `index.js`. |
| `node-express-boilerplate` | `jest-to-vitest` | Add `tests/**/*.js` to `sourceGlobs` (repo tests are `.js`); add `run-tests.mjs`/`test-counts.mjs`. |
| `TypeScript-Node-Starter (test/)` | `jest-to-vitest` | `.ts` tests already match globs; add `run-tests.mjs`/`test-counts.mjs`. |

> Verify the adapted layout during Phase 1 — the Cockpit/`bkb init` should report a **non-zero**
> module count. A count of `0` means Phase 0 was skipped or `sourceGlobs` still don't match.

### Phase 1: Repository Setup & Graph Ingestion (Zero LLM Cost)

1. **Clone into `scratch/` (pin the ref at clone time):**
   ```bash
   # Preferred: clone the exact pinned tag/branch directly.
   git clone --depth 1 --branch <PINNED_TAG_OR_BRANCH> <REPO_URL> scratch/<REPO_NAME>
   cd scratch/<REPO_NAME>
   # If a raw commit SHA is required (not a tag/branch), fetch it explicitly:
   #   git fetch --depth 1 origin <SHA> && git checkout <SHA>
   # `git clone --depth 1` alone only gets the default-branch tip, so a
   # `git checkout <PINNED_REF>` of an arbitrary tag/SHA will fail.
   ```

2. **Install dependencies and verify baseline:**
   ```bash
   # For Node.js / TypeScript projects:
   npm install
   npm test   # Must pass 100% at baseline before touching code

   # For Python projects:
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   pytest     # Must pass 100% at baseline
   ```

3. **Ingest codebase into FalkorDB:**
   ```bash
   ./bin/bkb.js init --repo ./scratch/<REPO_NAME> --pack <PACK_ID> --reset
   ```

4. **Verify Ingestion Quality:**
   - Did Tree-sitter parse all source modules without unhandled syntax errors?
   - Did import resolution successfully connect relative and package dependencies?
   - Did Tarjan's SCC algorithm group any circular imports into atomic components?
   - Open the Cockpit at `http://localhost:4200` to inspect the visual dependency graph, node degrees, and PageRank scores.

---

### Phase 2: Topological Claim Schedule & Dry Run (Zero LLM Cost)

Run the autonomous runner in dry-run simulation mode:
```bash
./bin/bkb.js run --repo ./scratch/<REPO_NAME> --pack <PACK_ID> --dry-run
```

> **Important Caveat (verified):** `bkb run --dry-run` uses the `mock` provider, which returns
> the **original source unchanged** for any module without a matching `<path>:<PHASE>` entry in
> `.bkb-mocks.json`. Because every commit is gated on the verification rules, an unmocked module
> **aborts the run at step 1** with e.g. `index.js: Has 1 unshimmed legacy API usage(s) but
> pendingCallers=0`. It does **not** "reach 100% completion" on identity transforms.
>
> To exercise the full schedule at zero LLM cost you must supply deterministic transforms:
> - add a `.bkb-mocks.json` at the repo root keyed `"<relativePath>:<PHASE>"` (e.g. `index.js:MIGRATE`),
>   **or** run with a real provider (`ollama`, `anthropic`, `openai`).
> With mocks supplied, a full run completes and reports route/snapshot parity. Phase 2 alone
> (no mocks) is only useful to confirm the **first claim** and the abort behavior.

**Verification Checklist:**
- [ ] Does BKB compute a strict callee-first order (leaf utility modules claimed first, root entrypoints claimed last)?
- [ ] Are circular SCC members claimed together in atomic batches?
- [ ] Does the claim schedule reach 100% completion without deadlocking? *(Requires `.bkb-mocks.json` or a real provider — unmocked identity transforms abort at step 1.)*
- [ ] Do package detectors log clean advisory preconditions without aborting graph creation?

---

### Phase 3: Active Governed Migration

Once Phases 1 and 2 pass cleanly, execute the actual code transformations using either an AI coding agent via MCP or the autonomous CLI runner.

#### Option A: Via AI Agent (Cursor / Claude / OpenCode with MCP)
1. Register BKB MCP tools in your editor:
   ```bash
   ./bin/bkb.js mcp install opencode   # or: cursor, claude, vscode, windsurf
   ```
2. Prompt the agent in chat:
   > *"Migrate this repository using BKB MCP tools. Always start by calling `advance_migration` (which atomically claims the next unblocked module and returns slice guidance in one call). Apply edits, and call `advance_migration` or `verify_and_commit_node` to commit. You can also inspect `simulate_blast_radius` or use `claim_next_leaf` + `get_migration_slice` individually if needed. If any compiler gate (`tsc` / `mypy`) fails, fix the types before proceeding. Monitor the live sync cockpit at http://localhost:4200."*

   *(Registered MCP tools in `src/mcp/server.ts`: `init_migration_graph`, `advance_migration`, `claim_next_leaf`, `get_migration_slice`, `simulate_blast_radius`, `verify_and_commit_node`, `get_migration_audit_trail`)*.

#### Option B: Autonomous CLI Runner
```bash
# Using a local, zero-cost model via Ollama:
./bin/bkb.js run --repo ./scratch/<REPO_NAME> --pack <PACK_ID> --provider ollama --model qwen2.5-coder:latest

# Or using cloud frontier models:
export ANTHROPIC_API_KEY="sk-ant-..."
./bin/bkb.js run --repo ./scratch/<REPO_NAME> --pack <PACK_ID> --provider anthropic --model claude-3-5-sonnet-20241022
```

---

### Phase 4: Invariant & Snapshot Verification

After the migration claims the final root entrypoint, evaluate the full verification suite:

1. **Compiler Gates:**
   - For TypeScript: `npx tsc --noEmit` exits with code 0 (requires a `tsconfig.json`).
   - For Python: `python3 -m mypy --ignore-missing-imports .` reports zero type errors.
   - For plain JavaScript (no `tsconfig.json`, e.g. `node-glob`/`is-plain-obj`): use the
     JS-safe `perStepTypecheckCmd` set during Phase 0 adaptation (e.g. `node --check` per file).
2. **Snapshot Invariance:**
   - For Web APIs: Route snapshots match baseline exactly (zero missing or modified routes).
   - For CJS → ESM: Export surface and callable shapes match baseline 1:1.
   - For Jest → Vitest: Test-count snapshot confirms identical suite and test counts.
3. **Automated Test Suite:**
   - Execute the migrated project's test suite (`npm test` / `pytest`). All test cases must pass.
4. **Package Manifest Update (CJS → ESM only):**
   - The `cjs-to-esm` pack rewrites **source files only**. Add `"type": "module"` to the target
     `package.json`; without it Node emits `MODULE_TYPELESS_PACKAGE_JSON` and reparses migrated
     files as ESM on every load.

> **Output-labeling note:** `bkb init` prints a `Baseline Routes:` line for **every** pack, but it
> is really the entry count of the declared snapshot (e.g. an export-surface or module-list `set`).
> For non-route packs (CJS→ESM, Jest→Vitest) read it as "Baseline Snapshot Entries", not HTTP routes.

---

## 5. Failure Recovery & Rollback Protocol

If an unexpected compilation error or broken dependency occurs mid-migration:

1. **Step Rollback:** Roll back to the preceding step using the checkpoint ledger and file snapshots:
   ```bash
   ./bin/bkb.js rollback --repo ./scratch/<REPO_NAME> --pack <PACK_ID>
   ```
2. **Specific Checkpoint Rollback:**
   ```bash
   ./bin/bkb.js rollback 3 --repo ./scratch/<REPO_NAME> --pack <PACK_ID>
   ```
3. **Inspect Audit Trail:**
   ```bash
   ./bin/bkb.js audit --repo ./scratch/<REPO_NAME> --pack <PACK_ID>
   ```
4. **Clean Reset:** If necessary, re-initialize the graph from scratch:
   ```bash
   ./bin/bkb.js init --repo ./scratch/<REPO_NAME> --pack <PACK_ID> --reset
   ```

---

## 6. Open-Source Testing Scorecard & Tracking Matrix

Use this tracking scorecard to record results as each candidate repository is tested:

| Target Repository | Migration Pack | Phase 0: Pack Adapted? | Phase 1: Ingestion & AST | Phase 2: Claim Schedule | Phase 3: Migration Loop | Phase 4: Snapshot Parity | Final Test Suite | Notes / Observations |
|---|---|---|---|---|---|---|---|---|
| `node-express-realworld` | `express-to-fastify` | Pending | Pending | Pending | Pending | Pending | Pending | Primary REST API |
| `TypeScript-Node-Starter` | `express-to-fastify` | Pending | Pending | Pending | Pending | Pending | Pending | Secondary (Archived / Ingestion focus) |
| `flask-realworld` | `flask-to-fastapi` | Pending | Pending | Pending | Pending | Pending | Pending | Primary REST API |
| `flaskr` (Pallets) | `flask-to-fastapi` | Pending | Pending | Pending | Pending | Pending | Pending | Secondary (Jinja / Ingestion smoke only) |
| `node-glob@v7` | `cjs-to-esm` (adapted) | ✅ Adapted | ✅ 3 mod, 2 SCCs | ⚠️ 1st claim only | — | — | — | Real `glob.js:51` ⇄ `sync.js:7` cycle verified; full schedule needs mocks |
| `is-plain-obj@v2` | `cjs-to-esm` (adapted) | ✅ Adapted | ✅ 1 mod | ⚠️ needs mocks | ✅ Mock run completed | ✅ Export surface 1:1 | ✅ `node --check` + smoke | CJS confirmed; add `"type":"module"` post-step |
| `node-express-boilerplate` | `jest-to-vitest` | Pending | Pending | Pending | Pending | Pending | Pending | `.js` tests; needs `tests/**/*.js` glob |
| `TypeScript-Node-Starter (test/)` | `jest-to-vitest` | Pending | Pending | Pending | Pending | Pending | Pending | TypeScript Jest types (`MockInstance`); globs match |

**Legend:** ✅ pass · ⚠️ partial (see Notes) · — not run · `Pending` not started.
Repo-local adapted packs live under `scratch/<repo>/oss-cjs-esm-pack.json` (Phase 0) and are not committed (`scratch/` is gitignored).
