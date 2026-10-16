# Testing Guide — Bagwan Kai Bandey (BKB)

This document is the authoritative testing plan for the polyglot migration engine after
Milestones **M0–M6** (Python adapter, 4 built-in migration packs, Ajv schema validation,
global snapshots, and the multi-pack Cockpit Flight Deck).

It has been verified against the current repository state (commands, scripts, pack files,
and test inventory). **No application code changes are required to execute this plan.**

---

## 1. Objectives

The plan verifies three dimensions:

1. **Engine correctness & polyglot foundations** — language-agnostic Tree-sitter query
   evaluation, Python import resolution (dotted, relative, `__init__.py`), and pure manifest
   package detectors (`package.json`, `pyproject.toml`/PEP 621, Poetry, `go.mod`, `requirements.txt`).
2. **Pack conformance & end-to-end governance** — all 4 built-in packs run their migration loop
   under FalkorDB graph governance with no compilation failures, no dropped tests, and no
   diverging invariant snapshots.
3. **Developer experience & Cockpit** — CLI pack validation/scaffolding, MCP registration,
   and the multi-pack Flight Deck (dynamic pack metadata, language/shim badges, SSE updates,
   `.bkb-steps.json` canned playback).

---

## 2. Verified repository facts

Use these as the source of truth; the commands below rely on them.

### 2.1 npm scripts (`package.json`)

| Script | Command | Notes |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit` | Strict TypeScript check. **There is no `lint` script** — do not assume one. |
| `npm test` | `tsx --test test/**/*.test.ts` | Umbrella suite; globstar includes `test/packs/**` and `test/server/**`. |
| `npm run demo` | `tsx src/server/demoServer.ts` | Starts the Cockpit (default `PORT=4200`). |
| `npm run benchmark` | `tsx scripts/benchmark-scale.ts` | Scale/latency benchmark. |
| `npm run validate:queries` | `tsx scripts/validate-queries.ts` | Query compilation smoke. |
| `npm run validate:cypher` | `tsx scripts/validate-cypher.ts` | Cypher validation smoke. |

### 2.2 Test inventory (25 files)

```
test/operations.test.ts               test/packSchema.test.ts            test/extensibility.test.ts
test/doctor.test.ts                   test/packSemantics.test.ts         test/runtimePreflight.test.ts
test/llmClient.test.ts                test/packScaffold.test.ts          test/shimStrategy.test.ts
test/benchmark.test.ts                test/packageDetectors.test.ts      test/snapshots.test.ts
test/runner.test.ts                   test/typescriptAdapter.test.ts     test/cockpitSecurity.test.ts
test/e2eDryRun.test.ts                test/adapters/pythonAdapter.test.ts
test/initMigrationGraph.test.ts       test/server/cockpitPacks.test.ts
test/mcpServer.test.ts                test/packs/cjsToEsm.test.ts
test/mcpInstaller.test.ts             test/packs/jestToVitest.test.ts
test/telemetry.test.ts                test/packs/flaskToFastapi.test.ts
```

Current umbrella baseline: **36 tests / 9 suites / 0 fail** (with FalkorDB up and fixture
toolchains installed).

### 2.3 Migration packs (`packs/`)

`express-to-fastify.json`, `cjs-to-esm.json`, `jest-to-vitest.json`, `flask-to-fastapi.json`,
plus `PACK_SPEC.schema.json`.

### 2.4 CLI surface (`bin/cli.ts`, `bin/bkb.js`)

| Command | Verified |
|---|---|
| `./bin/bkb.js doctor [--repo <path>]` | yes |
| `./bin/bkb.js pack validate <path>` | yes |
| `./bin/bkb.js pack init <id> --lang <lang>` | yes (`--lang` defaults to `typescript`) |
| `./bin/bkb.js adapter init <lang>` | yes |
| `./bin/bkb.js init [--repo <path>] [--pack <id>] [--reset]` | yes |
| `./bin/bkb.js run \| auto [--repo] [--pack] [--provider] [--model] [--dry-run]` | yes |
| `./bin/bkb.js mcp install [cursor\|claude\|vscode\|windsurf\|opencode\|all]` | yes |

### 2.5 Failing-test fixtures & baselines

| Fixture | Source files | Baseline signal |
|---|---|---|
| `demo-repo` | 9 `.ts` | 5 routes (`scripts/dump-routes.mjs`), `tsc` clean |
| `demo-repo-cjs` | 8 `.js` | export surface via `scripts/dump-exports.mjs`, circular `cycleA↔cycleB` |
| `demo-repo-jest` | 4 test files (7 total) | 3 suites / 12 tests (`scripts/test-counts.mjs`) |
| `demo-repo-flask` | 10 `.py` | 5 routes (`scripts/dump_routes.py`), `pytest -q` = 7 passed |

### 2.6 Critical caveat — mock dry-run identity fallback

The `mock` LLM provider resolves a transform by key `"${targetPath}:${phase}"` from
`<repoPath>/.bkb-mocks.json`; when no entry matches it **returns the original source
unchanged** (`src/runner/llmClient.ts:~508`). Therefore:

> `bkb run --dry-run` against an **arbitrary** repo validates topology, Tarjan SCCs, and the
> claim schedule **only**. It performs **no real code transforms** unless matching mocks exist
> or a real provider (`ollama`/`anthropic`/`openai`) is used.

---

## 3. Test tiers

```
┌──────────────────────────────────────────────────────────────┐
│ Tier 6: CLI & Tooling Smoke            (~3s, no Docker)        │
├──────────────────────────────────────────────────────────────┤
│ Tier 5: Cockpit Server & Security      (~5s, no Docker)        │
├──────────────────────────────────────────────────────────────┤
│ Tier 4: Autonomous MCP E2E Loop        (Docker + toolchains)   │
├──────────────────────────────────────────────────────────────┤
│ Tier 3: Snapshot & Checkpoint Gating   (Docker + toolchains)   │
├──────────────────────────────────────────────────────────────┤
│ Tier 2: Polyglot AST & Adapters        (~3s, WASM only)        │
├──────────────────────────────────────────────────────────────┤
│ Tier 1: Types, Schema & Pure Units     (~2s, no Docker)        │
└──────────────────────────────────────────────────────────────┘
```

### Tier 1 — Types, schema & pure units (no Docker)

```bash
npm run typecheck
npx tsx --test \
  test/packSchema.test.ts \
  test/packSemantics.test.ts \
  test/packScaffold.test.ts \
  test/packageDetectors.test.ts \
  test/shimStrategy.test.ts \
  test/runtimePreflight.test.ts \
  test/snapshots.test.ts \
  test/llmClient.test.ts \
  test/extensibility.test.ts
```

**Asserts**
- `PACK_SPEC.schema.json` compiled with Ajv rejects invalid scopes/properties with
  allowed-value hints; `validatePack` + `validatePackSemantics` catch structural/logical errors.
- `bkb pack init` template passes full validation and compiles its AST queries.
- `packageDetectors` parses PEP 621 / Poetry / Go / JS manifests case-insensitively and collapses
  PEP 503 names (`psycopg2_binary` → `psycopg2-binary`).
- `runtimePreflight` blocks `runtime-interop` on Node < 22.12 before any graph mutation.
- `snapshots` handles `set` (parse + sort), `count` (parse), `exact` (trim) kinds.
- `llmClient` extracts the correct fenced code per language (Python fence gated to `python`).
- `extensibility` covers adapter registry registration/errors and pack validation.

### Tier 2 — Polyglot AST & adapters (WASM only)

```bash
npx tsx --test test/adapters/pythonAdapter.test.ts test/typescriptAdapter.test.ts
```

**Asserts**
- **Python**: resolves relative (`from ..utils.response import ok`), dotted, and mixed imports;
  discovers `.py`/`__init__.py`; prunes `.venv`, `venv`, `__pycache__`, `.pytest_cache`,
  `.mypy_cache`, `.tox`; groups cyclic imports via Tarjan SCC; extracts functions/classes/methods.
- **TypeScript**: resolves `.cjs`/`.mjs`/extensionless, tsconfig path aliases, and AST queries.

### Tier 3 — Snapshot & checkpoint gating (FalkorDB + toolchains)

**Preconditions:** FalkorDB on `6379`, `demo-repo-jest/node_modules`, `demo-repo-flask/.venv`,
root `node_modules`.

```bash
npx tsx --test test/packs/cjsToEsm.test.ts
npx tsx --test test/packs/jestToVitest.test.ts
npx tsx --test test/packs/flaskToFastapi.test.ts
npx tsx --test test/runner.test.ts test/operations.test.ts test/initMigrationGraph.test.ts
```

**Asserts**
- **cjs→esm**: 8 modules migrated incl. circular pair; zero `require(`, zero `module.exports`,
  zero `@bkb-shim`; export surface (names + callable shapes) identical to baseline.
- **jest→vitest**: 4 modules; `jest.*` → `vi.*`; runner-agnostic script executes Vitest;
  test-count snapshot preserves **3 suites / 12 tests**.
- **flask→fastapi**: views converted, thread-local `request` un-nested, typed endpoints;
  route canonicalizer proves **5 routes** parity; `pytest -q` = 7 passed; `mypy` clean.
- **runner/operations/init**: checkpoint + rollback round-trip; `claimNextLeaf` pass ordering
  (DE_SHIM Pass A, leaf Pass B, SHIM when pending callers exist); SCC atomic claims; graph init.

### Tier 4 — Autonomous MCP E2E loop (FalkorDB)

```bash
npx tsx --test test/e2eDryRun.test.ts
npx tsx --test test/mcpServer.test.ts
```

**Asserts**
- Full `demo-repo` Express→Fastify migration driven through the MCP client/transport:
  `response.ts`/`auth.ts` transition `PENDING → SHIMMED → VERIFIED`; `auditA`/`auditB` migrate
  atomically as one SCC; `tsc --noEmit` passes at every intermediate step; `npm test` +
  `dump-routes.mjs` match 100% at checkpoint and completion (5 routes).
- MCP server exposes the expected tool set and executes end-to-end tool calls.

### Tier 5 — Cockpit server & security (no Docker for `/api/info`)

```bash
npx tsx --test test/cockpitSecurity.test.ts test/server/cockpitPacks.test.ts
npm run demo   # http://localhost:4200
```

**Asserts (automated)**
- `isOriginAllowed` blocks external web origins, allows localhost; HTTP requests with untrusted
  `Origin` → 403.
- `isPathContained` rejects symlink escapes and `../` traversal; `/api/file` returns 403 for
  escaping paths; `/api/target` and `/api/broadcast` reject out-of-workspace repos.
- `getActivePackMeta()` returns the default pack's `language`/`shimStrategy`;
  `loadRepoStepStates()` parses `.bkb-steps.json`, returns `null` when absent or malformed;
  live `GET /api/info` with `flask-to-fastapi` active reports `language: python`,
  `shimStrategy: in-file-branch`, and lists all four packs.

**Asserts (manual UI)**
- Header pack pill shows the active pack plus a **language tag** (`TS`/`PYTHON`) and a
  **shim-strategy tag** (`in-file-branch`/`runtime-interop`).
- `POST /api/target { packId }` updates badges/topology via the `target-changed` SSE event.
- A repo shipping `.bkb-steps.json` plays its own reference diffs instead of the built-in
  Express constants.

### Tier 6 — CLI & tooling smoke

```bash
./bin/bkb.js doctor
for p in express-to-fastify cjs-to-esm jest-to-vitest flask-to-fastapi; do
  ./bin/bkb.js pack validate packs/$p.json
done
./bin/bkb.js pack init test-pack --lang python
./bin/bkb.js pack validate packs/test-pack.json
rm packs/test-pack.json
npx tsx --test test/mcpServer.test.ts test/mcpInstaller.test.ts test/doctor.test.ts test/telemetry.test.ts test/benchmark.test.ts
```

**Asserts**
- `doctor` reports node/docker/git/pack health and exits non-zero on failure.
- All 4 packs validate (language, rule count, invariants, typecheck command printed).
- Scaffolded pack validates out-of-the-box; adapter scaffold compiles.
- MCP installer writes valid/idempotent configs for each target and won't overwrite unparseable configs.
- Telemetry broadcast is safe offline and delivers to a listening server; benchmark meets latency SLA.

---

## 4. Coverage map

| Test file | Milestone | Needs |
|---|---|---|
| `packSchema` / `packSemantics` / `packScaffold` | M1 | none |
| `packageDetectors` / `shimStrategy` / `runtimePreflight` / `snapshots` | M0/M1 | none |
| `llmClient` / `extensibility` | M0/M1 | none |
| `adapters/pythonAdapter` | M4 | WASM only |
| `typescriptAdapter` | M0 | WASM only |
| `packs/cjsToEsm` | M2 | FalkorDB + node |
| `packs/jestToVitest` | M3 | FalkorDB + jest/vitest deps |
| `packs/flaskToFastapi` | M5 | FalkorDB + `.venv` (flask/fastapi/pytest/mypy) |
| `e2eDryRun` / `mcpServer` / `operations` / `runner` / `initMigrationGraph` | M1 | FalkorDB |
| `cockpitSecurity` / `server/cockpitPacks` | M6 | none (HTTP `/api/info`) |
| `doctor` / `mcpInstaller` / `telemetry` / `benchmark` | M1 | benchmark needs FalkorDB |

---

## 5. Recommended execution order

| Phase | Command | Expected | Time |
|---|---|---|---|
| 1. Sanity & types | `npm run typecheck` | 0 errors | ~2s |
| 2. Schema & adapters | Tier 1 + Tier 2 test list | all pass | ~5s |
| 3. Start infra | `docker run -p 6379:6379 -p 3000:3000 -d falkordb/falkordb:latest` | healthy | ~5s |
| 4. Migration packs | Tier 3 + Tier 4 list | all pass | ~30s |
| 5. Cockpit & security | Tier 5 list | all pass | ~5s |
| 6. CLI & tooling | Tier 6 list | all pass | ~5s |
| 7. Umbrella regression | `npm test` | 36 tests / 9 suites green | ~20s |

> Toolchains for fixture packs must be present: `demo-repo-jest` (`npm install` inside it) and
> `demo-repo-flask/.venv` (flask, fastapi, uvicorn, pytest, httpx, mypy). The Jest/Vitest and
> Flask E2E suites self-skip when their prerequisites are absent.

---

## 6. Open-source real-world validation

Synthetic fixtures prove the algorithms; OSS repos prove resilience to barrels, path aliases,
monorepos, real middleware chains, and messy test runners. Keep targets **small/medium
(10–50 modules)** to bound token/latency cost.

### 6.1 Candidate repositories

| Pack | Candidate | Why |
|---|---|---|
| express-to-fastify | `gothinkster/node-express-realworld-example-app` (or `microsoft/TypeScript-Node-Starter`) | Real auth/JWT/middleware, Mongoose models, integration tests |
| cjs-to-esm | `sindresorhus/is-plain-obj` (pinned legacy CJS tag) or `isaacs/node-glob@v7` | Real `module.exports`/`require()` chains, small |
| jest-to-vitest | `typicode/lowdb@v1` or a small Express test suite | Real `jest.mock()`/`jest.fn()`/timers |
| flask-to-fastapi | `gothinkster/flask-realworld-example-app` | Blueprints, SQLAlchemy, existing pytest suite |

**Always pin an exact tag/commit** for reproducibility and **never commit** cloned repos.

### 6.2 Phase 1 — Ingestion & topology (zero LLM cost)

```bash
git clone --depth 1 <repo-url> scratch/oss-<pack>
cd scratch/oss-<pack> && npm install   # or: python -m venv .venv && pip install -r requirements.txt
cd -
./bin/bkb.js init --repo ./scratch/oss-<pack> --pack <pack>
```

Verify: every source file parsed without syntax errors; relative/barrel imports resolved;
cycles grouped as SCCs; topology renders in the Cockpit at `http://localhost:4200`.

### 6.3 Phase 2 — Claim schedule dry run (zero LLM cost)

```bash
./bin/bkb.js run --repo ./scratch/oss-<pack> --pack <pack> --dry-run
```

Verify: callee-first claim order (leaf utilities → entrypoints); cycle nodes claimed as atomic
batches; schedule reaches 100% with no deadlock.
**Remember:** with the `mock` provider and no `.bkb-mocks.json`, transforms are identity-only —
this phase tests the **planner**, not code output.

### 6.4 Phase 3 — Active migration (real transforms)

**Option A — MCP pair-programming**

```bash
./bin/bkb.js mcp install opencode   # or cursor | claude | vscode | windsurf | all
```

Prompt the agent to call `bkb_claim_module`, follow slice signatures/guidance, apply edits, and
call `bkb_verify_step`, fixing compiler-gate failures before proceeding.

**Option B — Autonomous runner**

```bash
# Zero-cost local:
./bin/bkb.js run --repo ./scratch/oss-<pack> --pack <pack> --provider ollama --model qwen2.5-coder:latest
# Or a frontier model:
ANTHROPIC_API_KEY=... ./bin/bkb.js run --repo ./scratch/oss-<pack> --pack <pack> --provider anthropic --model claude-3-5-sonnet-20241022
```

All progress is governed by the per-step typecheck gate and checkpoint snapshot parity.

### 6.5 OSS guardrails & risks

- Packs hardcode `perStepTypecheckCmd` (`npx tsc --noEmit`) and `checkpointTestCmd` (`pytest -q`).
  OSS repos lacking a `tsconfig`/pytest config will fail gates — supply a per-repo config or a
  tailored pack before Phase 3.
- For deterministic dry runs of transformed output, provide `<repoPath>/.bkb-mocks.json`
  keyed as `"<relativePath>:<PHASE>"`.
- Clone into `scratch/` only (already git-ignored).
- **Future work:** add a `test/oss/` harness that runs Phases 1–2 automatically so OSS ingestion
  regressions get CI coverage without LLM cost.

---

## 7. Known gaps / future work

- No dedicated lint step; consider adding ESLint and a `lint` script.
- No automated UI/browser test for the Cockpit (Tier 5 UI checks are manual today).
- `test/benchmark.test.ts` and other FalkorDB-dependent tests must not be run in parallel against
  a shared graph name; use isolated graph names (as fixture E2E tests already do).
- OSS ingestion harness (see 6.5) is not yet implemented.
