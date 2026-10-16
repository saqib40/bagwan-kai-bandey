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
2. **Pre-Existing Passing Tests:** Must have a working, reproducible automated test suite (`npm test`, `pytest`, etc.) at baseline before migration begins.
3. **Topological Depth:** Must contain distinct architectural layers (leaf utilities $\rightarrow$ services/models $\rightarrow$ controllers/routes $\rightarrow$ entrypoint).
4. **Deterministic Version Pinning:** Every repository is pinned to an exact release tag or commit SHA.
5. **Workspace Isolation:** All repositories are cloned exclusively into the git-ignored `scratch/` directory and never committed to BKB's source tree.

---

## 2. Complete Open-Source Repository Catalog

All options across all four migration packs are detailed below.

### 2.1 Pack: `express-to-fastify` (TypeScript / JavaScript)

#### Option A: `gothinkster/node-express-realworld-example-app` (Primary — REST Architecture)
- **Repository URL:** `https://github.com/gothinkster/node-express-realworld-example-app`
- **Pinned Commit:** `b24b896` (or `master` branch)
- **Language / Runtime:** JavaScript (Node.js)
- **Module Count:** ~18 files (`routes/api/`, `models/`, `config/`, `app.js`)
- **Baseline Test Command:** `npm test` (Mocha/Supertest)
- **Architectural Highlights:**
  - Standard "Conduit" RealWorld backend specification.
  - Multi-tier router structure: `routes/index.js` mounts sub-routers (`/api/users`, `/api/articles`, `/api/tags`).
  - Middleware: JWT authentication (`express-jwt`), Mongoose schema validation, centralized error handler.
- **What it Validates:**
  - Express router hierarchy unnesting into Fastify plugin scopes.
  - Middleware conversion (`req.payload`, `res.json()`, `res.status()`).
  - Route-surface parity snapshot matching.

#### Option B: `microsoft/TypeScript-Node-Starter` (Alternative — TypeScript Native)
- **Repository URL:** `https://github.com/microsoft/TypeScript-Node-Starter`
- **Pinned Commit:** `7c06159` (or `master` branch)
- **Language / Runtime:** TypeScript (Node.js)
- **Module Count:** ~14 TypeScript files in `src/` (`controllers/`, `models/`, `config/`, `app.ts`, `server.ts`)
- **Baseline Test Command:** `npm test` (Jest/Supertest)
- **Architectural Highlights:**
  - Microsoft's official starter for Express and TypeScript.
  - Strict typing: Uses `@types/express` (`Request`, `Response`, `NextFunction`).
  - Clean controller layer (`user.ts`, `api.ts`, `contact.ts`).
- **What it Validates:**
  - Strict TypeScript compiler verification (`tsc --noEmit`) throughout every intermediate migration step.
  - Type-safe route handler conversions to Fastify `FastifyRequest` / `FastifyReply`.

---

### 2.2 Pack: `flask-to-fastapi` (Python)

#### Option A: `pallets/flask` Tutorial App (`flaskr`) (Primary — Clean & Official)
- **Repository URL:** `https://github.com/pallets/flask` (path: `examples/tutorial`)
- **Pinned Tag:** `3.0.3` (or `main` branch)
- **Language / Runtime:** Python 3.10+
- **Module Count:** ~7 Python files (`flaskr/__init__.py`, `flaskr/db.py`, `flaskr/auth.py`, `flaskr/blog.py`, plus tests)
- **Baseline Test Command:** `pytest` (100% test coverage)
- **Architectural Highlights:**
  - Official reference application authored and maintained by the Pallets core team.
  - Blueprint-driven architecture (`auth.py`, `blog.py`) registered via application factory pattern.
  - Authentication session decorators (`@login_required`), SQLite database interactions.
- **What it Validates:**
  - Python AST parsing and import graph construction via `PythonAdapter`.
  - Converting Flask Blueprint routing to FastAPI `APIRouter`.
  - Route canonicalizer (`dump_routes.py`) parity against `pytest`.

#### Option B: `gothinkster/flask-realworld-example-app` (Alternative — Full REST API)
- **Repository URL:** `https://github.com/gothinkster/flask-realworld-example-app`
- **Pinned Commit:** `master` branch
- **Language / Runtime:** Python 3.10+
- **Module Count:** ~16 Python files (`conduit/user/`, `conduit/articles/`, `conduit/profile/`, `conduit/app.py`)
- **Baseline Test Command:** `pytest`
- **Architectural Highlights:**
  - RealWorld specification with SQLAlchemy ORM and JWT extensions.
  - Nested blueprint routes, relational data models, user profiles, comments, and tagging.
- **What it Validates:**
  - Thread-local global unnesting: replacing `flask.request` and `flask.g` with explicit dependency injection (`Depends`) and typed Pydantic models.
  - Multi-tier service and model import graph traversal.

---

### 2.3 Pack: `cjs-to-esm` (CommonJS $\rightarrow$ Pure ES Modules)

#### Option A: `isaacs/node-glob` (Primary — Cyclic & High Complexity)
- **Repository URL:** `https://github.com/isaacs/node-glob`
- **Pinned Tag:** `v7.2.3` (Legacy CommonJS branch)
- **Language / Runtime:** JavaScript (CommonJS, Node $\ge 22.12$)
- **Module Count:** ~6 source files (`glob.js`, `sync.js`, `common.js`)
- **Baseline Test Command:** `npm test`
- **Architectural Highlights:**
  - The canonical file-system globbing utility for Node.js.
  - Features real mutual/circular helper dependencies between `glob.js` and `sync.js`.
  - Heavy usage of `module.exports = function glob(...)` and `__dirname`.
- **What it Validates:**
  - Tarjan SCC cycle grouping on real-world Node.js code.
  - Node $\ge 22.12$ synchronous `require(esm)` runtime interop.
  - Preservation of callable export shapes (`dump-exports.mjs`) when converting from `module.exports = fn` to `export default fn` + `export { fn as "module.exports" }`.

#### Option B: `sindresorhus/is-plain-obj` (Alternative — Rapid Leaf Verification)
- **Repository URL:** `https://github.com/sindresorhus/is-plain-obj`
- **Pinned Tag:** `v2.1.0` (Legacy CJS release before ESM conversion)
- **Language / Runtime:** JavaScript (CommonJS)
- **Module Count:** 2 files (`index.js`, `index.d.ts`)
- **Baseline Test Command:** `npm test`
- **Architectural Highlights:**
  - Ultra-focused utility library with zero external dependencies.
- **What it Validates:**
  - Fast, zero-overhead smoke test of `cjs-to-esm` detection queries, type preservation, and export surface snapshots.

---

### 2.4 Pack: `jest-to-vitest` (Testing Frameworks)

#### Option A: `typicode/lowdb` (Primary — Real Testing Patterns)
- **Repository URL:** `https://github.com/typicode/lowdb`
- **Pinned Tag:** `v1.0.0` (CommonJS/Jest release)
- **Language / Runtime:** JavaScript / Node.js
- **Module Count:** ~8 test files in `test/`
- **Baseline Test Command:** `npm test` (Jest)
- **Architectural Highlights:**
  - Widely-used embedded JSON database.
  - Tests include mock disk adapters, custom spies (`jest.fn()`), and lifecycle hooks (`beforeEach`, `afterEach`).
- **What it Validates:**
  - In-place conversion of test assertions and spies: `jest.fn()` $\rightarrow$ `vi.fn()`, `jest.spyOn()` $\rightarrow$ `vi.spyOn()`.
  - Runner-agnostic execution wrapper (`run-tests.mjs`) selecting Jest initially, then Vitest post-migration.
  - Test-count snapshot invariance (`test-counts.mjs`) proving 100% of test cases pass without dropped tests.

#### Option B: `microsoft/TypeScript-Node-Starter` Test Suite (Alternative — Combined Express + Jest)
- **Repository URL:** `https://github.com/microsoft/TypeScript-Node-Starter` (path: `test/`)
- **Pinned Commit:** `7c06159`
- **Language / Runtime:** TypeScript + Jest
- **Module Count:** ~6 test files (`user.test.ts`, `api.test.ts`, `contact.test.ts`)
- **Baseline Test Command:** `npm test`
- **Architectural Highlights:**
  - Integration test suite combining Supertest HTTP assertions with Jest mocks.
- **What it Validates:**
  - Combined migration workflow: testing `jest-to-vitest` on a real TypeScript Express application suite.

---

## 3. Comparison Matrix

| Target Repository | Migration Pack | Language | Module Count | Pre-existing Tests | Primary Architectural Goal |
|---|---|---|---|---|---|
| **`node-express-realworld`** | `express-to-fastify` | JavaScript | 18 | Supertest/Mocha | Router tree unnesting & middleware |
| **`TypeScript-Node-Starter`** | `express-to-fastify` | TypeScript | 14 | Jest/Supertest | Strict `tsc` compiler gate preservation |
| **`flaskr` (Pallets)** | `flask-to-fastapi` | Python | 7 | Pytest (100%) | Blueprint unnesting & route canonicalizer |
| **`flask-realworld`** | `flask-to-fastapi` | Python | 16 | Pytest | Thread-local unnesting (`request` $\rightarrow$ `Depends`) |
| **`node-glob@v7`** | `cjs-to-esm` | JavaScript (CJS) | 6 | Tap/Node | Tarjan cycle handling & callable exports |
| **`is-plain-obj@v2`** | `cjs-to-esm` | JavaScript (CJS) | 2 | Ava/Node | Rapid export-shape smoke test |
| **`lowdb@v1`** | `jest-to-vitest` | JavaScript | 8 | Jest | Mock spies (`vi.fn()`) & test-count snapshot |
| **`TypeScript-Node-Starter (test/)`** | `jest-to-vitest` | TypeScript | 6 | Jest | TypeScript type conversions (`MockInstance`) |

---

## 4. Step-by-Step Execution Protocol

Testing any open-source repository follows an orderly 4-phase protocol.

```
┌────────────────────────────────────────────────────────┐
│ Phase 1: Ingestion & Topology Smoke      (Zero LLM Cost)│ -> Parse AST, resolve imports, detect SCCs
├────────────────────────────────────────────────────────┤
│ Phase 2: Claim Schedule Dry Run          (Zero LLM Cost)│ -> Verify 100% callee-first claim path
├────────────────────────────────────────────────────────┤
│ Phase 3: Active Governed Migration       (LLM or Agent) │ -> Apply edits, enforce compiler & test gates
├────────────────────────────────────────────────────────┤
│ Phase 4: Snapshot Parity & Verification  (Tooling)      │ -> Verify route surface, exports, & test counts
└────────────────────────────────────────────────────────┘
```

### Phase 1: Repository Setup & Graph Ingestion (Zero LLM Cost)

1. **Clone into `scratch/`:**
   ```bash
   git clone --depth 1 <REPO_URL> scratch/<REPO_NAME>
   cd scratch/<REPO_NAME>
   git checkout <PINNED_TAG_OR_COMMIT>
   ```

2. **Install dependencies and verify baseline:**
   ```bash
   # For Node.js / TypeScript projects:
   npm install
   npm test   # Verify tests pass 100% at baseline before touching code

   # For Python projects:
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   pytest     # Verify baseline passes
   ```

3. **Ingest codebase into FalkorDB:**
   ```bash
   bkb init --repo ./scratch/<REPO_NAME> --pack <PACK_ID> --reset
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
bkb run --repo ./scratch/<REPO_NAME> --pack <PACK_ID> --dry-run
```

**Verification Checklist:**
- [ ] Does BKB compute a strict callee-first order (leaf utility modules claimed first, root entrypoints claimed last)?
- [ ] Are circular SCC members claimed together in atomic batches?
- [ ] Does the claim schedule reach 100% completion without deadlocking or halting on unresolvable dependencies?
- [ ] Do package detectors log clean advisory preconditions without aborting graph creation?

---

### Phase 3: Active Governed Migration

Once Phases 1 and 2 pass cleanly, execute the actual code transformations using either an AI coding agent via MCP or the autonomous CLI runner.

#### Option A: Via AI Agent (Cursor / Claude / OpenCode with MCP)
1. Register BKB MCP tools in your editor:
   ```bash
   bkb mcp install cursor   # or: opencode, claude, vscode, windsurf
   ```
2. Prompt the agent in chat:
   > *"Migrate this repository using BKB MCP tools. Always start by calling `bkb_claim_module`, inspect the slice signatures and pack guidance, apply transformations, and call `bkb_verify_step`. If any compiler gate (`tsc` / `mypy`) fails, fix the types before proceeding. Monitor the live sync cockpit at http://localhost:4200."*

#### Option B: Autonomous CLI Runner
```bash
# Using a local, zero-cost model via Ollama:
bkb run --repo ./scratch/<REPO_NAME> --pack <PACK_ID> --provider ollama --model qwen2.5-coder:latest

# Or using cloud frontier models:
export ANTHROPIC_API_KEY="sk-ant-..."
bkb run --repo ./scratch/<REPO_NAME> --pack <PACK_ID> --provider anthropic --model claude-3-5-sonnet-20241022
```

---

### Phase 4: Invariant & Snapshot Verification

After the migration claims the final root entrypoint, evaluate the full verification suite:

1. **Compiler Gates:**
   - For TypeScript: `npx tsc --noEmit` exits with code 0.
   - For Python: `python3 -m mypy` reports zero type errors.
2. **Snapshot Invariance:**
   - For Web APIs: Route snapshots match baseline exactly (zero missing or modified routes).
   - For CJS $\rightarrow$ ESM: Export names and callable shapes match baseline 1:1.
   - For Jest $\rightarrow$ Vitest: Test-count snapshot confirms identical suite and test counts.
3. **Automated Test Suite:**
   - Execute the migrated project's test suite (`npm test` / `pytest`). All test cases must pass.

---

## 5. Failure Recovery & Rollback Protocol

If an unexpected compilation error or broken dependency occurs mid-migration:

1. **Step Rollback:** Roll back to the preceding step using the cryptographic checkpoint ledger:
   ```bash
   bkb rollback --repo ./scratch/<REPO_NAME> --pack <PACK_ID>
   ```
2. **Specific Checkpoint Rollback:**
   ```bash
   bkb rollback 3 --repo ./scratch/<REPO_NAME> --pack <PACK_ID>
   ```
3. **Inspect Audit Trail:**
   ```bash
   bkb audit --repo ./scratch/<REPO_NAME> --pack <PACK_ID>
   ```
4. **Clean Reset:** If necessary, re-initialize the graph from scratch:
   ```bash
   bkb init --repo ./scratch/<REPO_NAME> --pack <PACK_ID> --reset
   ```

---

## 6. Open-Source Testing Scorecard & Tracking Matrix

Use this tracking scorecard to record results as each candidate repository is tested:

| Target Repository | Migration Pack | Phase 1: Ingestion & AST | Phase 2: Claim Schedule | Phase 3: Migration Loop | Phase 4: Snapshot Parity | Final Test Suite | Notes / Observations |
|---|---|---|---|---|---|---|---|
| `node-express-realworld` | `express-to-fastify` | Pending | Pending | Pending | Pending | Pending | |
| `TypeScript-Node-Starter` | `express-to-fastify` | Pending | Pending | Pending | Pending | Pending | |
| `flaskr` (Pallets) | `flask-to-fastapi` | Pending | Pending | Pending | Pending | Pending | |
| `flask-realworld` | `flask-to-fastapi` | Pending | Pending | Pending | Pending | Pending | |
| `node-glob@v7` | `cjs-to-esm` | Pending | Pending | Pending | Pending | Pending | |
| `is-plain-obj@v2` | `cjs-to-esm` | Pending | Pending | Pending | Pending | Pending | |
| `lowdb@v1` | `jest-to-vitest` | Pending | Pending | Pending | Pending | Pending | |
| `TypeScript-Node-Starter (test/)` | `jest-to-vitest` | Pending | Pending | Pending | Pending | Pending | |
