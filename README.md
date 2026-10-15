# Shift: Graph-Governed Codebase Migration Engine

[![Powered by FalkorDB](https://img.shields.io/badge/Powered%20by-FalkorDB-purple.svg)](https://www.falkordb.com/)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-blue.svg)](https://modelcontextprotocol.io/)
[![Tests: 28/28 Passing](https://img.shields.io/badge/Tests-28%2F28%20Pass-brightgreen.svg)]()
[![Typecheck: Clean](https://img.shields.io/badge/Typecheck-tsc%20green-success.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)]()

> **Universal laws, pluggable packs.** Shift is an autonomous, graph-governed migration engine powered by **FalkorDB** that computes callee-first execution order, collapses circular dependencies into atomic batches via Tarjan's SCC algorithm, enforces dual-signature shims with automatic de-shimming, and verifies edge-level invariants—keeping `tsc` green at every single step, test suites green at every checkpoint, and route surfaces 100% identical.

---

## The Core Problem

Standard AI coding agents attempting framework migrations (e.g., Express $\rightarrow$ Fastify) fail predictably:
1. **Topological Inversion:** They migrate root entrypoints first, breaking all downstream callers.
2. **Circular Dependency Deadlock:** When modules import each other ($A \leftrightarrow B$), file-by-file edits leave the codebase uncompilable in intermediate states.
3. **Premature De-Shimming:** Removing backward compatibility wrappers before all upstream callers have migrated causes cascading type failures.
4. **Token Exhaustion:** Crawling files with grep costs tens of thousands of wasted tokens and dozens of speculative tool calls.

---

## The 3-Layer Architecture

```
┌──────────────────────────────────────────────────────────┐
│        Layer 3: Declarative Migration Pack               │
│        (packs/express-to-fastify.json)                   │
│  - Detection Rules (Tree-sitter WASM AST queries)        │
│  - Invariants (Route surfaces, symbol parity)            │
│  - Dual-Signature Shim & De-Shim Guidance                │
│  - Verification Commands (typecheck, test, snapshot)    │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│        Layer 2: Language Adapters                        │
│        (src/adapters/typescriptAdapter.ts)               │
│  - Universal symbol & import extraction                  │
│  - AST query evaluation via web-tree-sitter              │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│        Layer 1: Universal Migration Engine               │
│        (src/engine/ + src/mcp/server.ts)                 │
│  - Zero framework or language specifics in src/engine/   │
│  - FalkorDB graph state & native PageRank (algo.pageRank)│
│  - Tarjan SCC atomic cycle condensation                  │
│  - Model Context Protocol (MCP) server (6 tools)         │
└──────────────────────────────────────────────────────────┘
```

---

## Extensibility: Injecting Layers 2 & 3

Shift is designed for radical extensibility. Developers can inject custom **Language Adapters (Layer 2)** and **Migration Packs (Layer 3)** without ever touching engine internals.

### 1. Injecting a Custom Language Adapter (Layer 2)

Extend the provided `BaseLanguageAdapter` to get automatic glob discovery, source caching, shim counters, and symbol ID hashing:

```typescript
// adapters/pythonAdapter.ts
import { BaseLanguageAdapter, type ParsedModule, type MigrationPack } from 'shift-migration-engine';

export class PythonAdapter extends BaseLanguageAdapter {
  readonly language = 'python';

  async parseModule(
    repoRoot: string,
    relativePath: string,
    sourceCode?: string,
    pack?: MigrationPack,
  ): Promise<ParsedModule> {
    const code = sourceCode ?? await this.readSource(repoRoot, relativePath);
    const imports = this.extractImports(code);
    const symbols = this.extractFunctionsAndClasses(code, relativePath);

    return this.createParsedModule({
      path: relativePath,
      fullSource: code,
      imports,
      symbols,
    });
  }
}

export default PythonAdapter;
```

**Injecting via CLI or Configuration:**
```bash
# Inject directly via CLI flag:
shift init --repo ./my-python-app --pack flask-to-fastapi --adapter ./adapters/pythonAdapter.ts

# Or scaffold a starter adapter:
shift adapter init python
```

---

### 2. Injecting a Custom Migration Pack (Layer 3)

Packs can be written as standard `.json` files or type-safe TypeScript/JavaScript modules with full IDE autocomplete using `defineMigrationPack`:

```typescript
// packs/flask-to-fastapi.ts
import { defineMigrationPack } from 'shift-migration-engine';

export default defineMigrationPack({
  id: 'flask-to-fastapi',
  name: 'Flask to FastAPI Migration Pack',
  language: 'python',
  sourceGlobs: {
    include: ['**/*.py'],
    exclude: ['**/venv/**', '**/__pycache__/**'],
  },
  packages: {
    legacy: ['flask'],
    target: ['fastapi', 'uvicorn'],
  },
  detectionRules: [
    {
      id: 'flask-route-decorator',
      description: 'Flask route decorators @app.route',
      astQuery: '(decorator (call (attribute (identifier) @obj (identifier) @method)))',
    },
  ],
  agentGuidance: {
    SHIM: 'Wrap Flask requests in FastAPI Request compatibility adapters.',
    MIGRATE: 'Convert @app.route to async def with FastAPI APIRouter.',
    DE_SHIM: 'Strip Flask compatibility wrappers; adopt pure Pydantic validation.',
  },
  invariants: [
    {
      id: 'http-endpoints',
      scope: 'checkpoint',
      type: 'route-set',
      description: 'Guarantees 100% endpoint parity',
      astExtractor: 'routes',
    },
  ],
  verification: {
    perStepTypecheckCmd: 'mypy src/',
    checkpointTestCmd: 'pytest test/',
    routeSnapshotCmd: 'python scripts/dump_routes.py',
  },
});
```

**Validating and Scaffolding Packs:**
```bash
# Scaffold a new pack skeleton:
shift pack init my-custom-pack --lang python

# Validate a pack schema before running:
shift pack validate ./packs/my-custom-pack.json
```

---

### 3. Unified Project Configuration (`shift.config.ts`)

Define custom adapters, external pack directories, and default settings in a single config file:

```typescript
// shift.config.ts
import { defineConfig } from 'shift-migration-engine';
import { PythonAdapter } from './adapters/pythonAdapter';

export default defineConfig({
  adapters: [new PythonAdapter()],
  packDirs: ['./custom-packs', './node_modules/@company/migration-packs'],
  defaultRepo: './demo-repo',
  defaultPack: 'express-to-fastify',
});
```

---

## The 5 Universal Laws of Topological Migration

1. **Law 1: Transitive Callee-First Order & Risk-First Leaf Policy**
   * A module is unblocked if and only if zero transitive paths lead to pending dependencies outside its cluster. Foundational helpers with highest PageRank are migrated first.
2. **Law 2: Atomic Cycle Collapse (Tarjan SCC Law)**
   * Circular dependencies ($A \rightarrow B \rightarrow A$) cannot be migrated file-by-file. All modules in an SCC are claimed and verified atomically in a single batch.
3. **Law 3: Dual-Signature Shims & Deterministic De-Shimming (Strangler Fig Law)**
   * When `pending_callers_count > 0`, the engine enforces backward-compatible shims (`// @shift-shim`). As soon as all callers migrate to the target framework, the module is surfaced with `phase: 'DE_SHIM'` to remove all legacy fallback branches.
4. **Law 4: Per-Step Typechecking & Tiered Verification Gates**
   * Every step re-parses modified files with Tree-sitter, checks route set-equality invariants against immutable baselines, and executes `tsc --noEmit`. Checkpoint gates run full test suites and runtime route snapshot diffs.
5. **Law 5: Scoped 1-Hop Subgraph Context (Minimum Viable Context)**
   * Slices provide only the target files, exported signatures of direct callees, and usage snippets of direct callers—slashing token consumption by **81%**.

---

## FalkorDB Graph Schema

* **`:MigrationMeta`**: Baseline route inventory snapshot, repo path, pack metadata.
* **`:Module`**: `path`, `status` (`'CLEAN'` | `'PENDING'` | `'IN_PROGRESS'` | `'SHIMMED'` | `'VERIFIED'`), `scc_id`, `scc_size`, `pagerank`, `in_degree`, `pending_callers_count`, `baseline_sets`.
* **`:Symbol`**: Exported symbol declarations (`id`, `name`, `kind`, `signature`).
* **`:ExternalAPI`**: Rules from the Migration Pack (`express-res-methods`, `express-router-mount`, etc.).
* **`:MigrationEpisode`**: Cryptographically verifiable step audit log with Cypher evidence paths.
* **Edges**: `[:IMPORTS]`, `[:DECLARES]`, `[:USES_API]`, `[:AFFECTED]`.

---

## The 6 Model Context Protocol (MCP) Tools

Shift exposes 6 high-level MCP tools for LLMs:

| Tool | Parameters | Description |
|---|---|---|
| `init_migration_graph` | `repoPath, packId, reset` | Ingests codebase, computes Tarjan SCCs, captures baseline routes, runs PageRank |
| `claim_next_leaf` | `repoPath?, packId?` | Claims next unblocked leaf or atomic SCC (Pass A: De-shim priority, Pass B: Leaf claim) |
| `get_migration_slice` | `modulePaths, phase` | Provides disk source, callee symbol signatures, caller snippets, and phase guidance |
| `simulate_blast_radius`| `modulePath` | Evaluates multi-hop reverse traversal (`[:IMPORTS*1..6]`) before editing |
| `verify_and_commit_node`| `modulePaths, agentSummary` | Strict 4-step re-parse, Tarjan SCC update, Shim gate, `tsc`, degree recalculation |
| `get_migration_audit_trail`| `runCheckpointNow?` | Returns chronological episodes and runs full checkpoint gate (`tsc`, tests, route diff) |

---

## Benchmark Results

### 150-Module FalkorDB Scale Benchmark
Evaluated on a synthetic enterprise graph with 150 modules, 320 edges, and 3 multi-node circular dependency cycles (P95 target: $< 25\text{ ms}$):

| Operation | Target SLA | Mean Latency | P95 Latency | Result |
|---|---|---|---|---|
| **`CLAIM_LEAF`** (Pass B Transitive Search) | $< 25.0\text{ ms}$ | **4.11 ms** | **4.73 ms** | ✅ **5.3x faster** |
| **`CLAIM_DESHIM`** (Pass A De-Shim Search) | $< 25.0\text{ ms}$ | **0.33 ms** | **0.42 ms** | ✅ **59.5x faster** |
| **`SHORTEST_PATH`** (Proof Generation) | $< 10.0\text{ ms}$ | **0.42 ms** | **0.52 ms** | ✅ **19.2x faster** |

### Agent Efficiency: Naive Grep vs. Shift MCP

| Metric | Naive Grep Agent | Shift MCP Engine | Shift Advantage |
|---|---|---|---|
| **Total Tool Calls** | 42+ calls (guess & fix) | **11 discrete steps** | **74% reduction** |
| **Context Tokens** | ~180,000 tokens | **~34,000 tokens** | **81% reduction** |
| **Broken `tsc` Steps** | 6 broken steps | **0 broken steps** | Zero intermediate breakages |
| **Circular Dependencies** | Deadlocks on cycles | **Atomic SCC batching** | Guaranteed cycle resolution |
| **De-Shimming Safety** | Premature caller breakage | **Top-down cascade** | Guaranteed compatibility |
| **Route Parity** | Silent route drift | **100% verified match** | Zero broken endpoints |

---

---

## How to Use Shift for Your Codebase (User Guide)

Whether you are migrating an existing Express repository to Fastify or building a custom migration for your team's internal framework, Shift operates in two primary modes:
1. **Autonomous AI Agent via Model Context Protocol (MCP)** *(Recommended)*
2. **Interactive CLI / Scripted Workflow**

---

### Step 1: Start FalkorDB

Shift requires a running FalkorDB graph instance. Start it via Docker:
```bash
docker run -p 6379:6379 -p 3000:3000 -d --name falkordb-shift falkordb/falkordb:latest
```
*(Shift will also automatically attempt to start the container if Docker is running on your machine).*

---

### Step 2: Ingest & Initialize Your Codebase

Point Shift at your repository root to scan source files, compute baseline route invariants, detect legacy API usages, and condense circular dependencies:

```bash
# Using local CLI:
npm start -- init --repo /path/to/your-repo --pack express-to-fastify

# Or link globally:
npm link
shift init --repo /path/to/your-repo --pack express-to-fastify
```

Output:
```
--- Graph Initialization Complete ---
Repository:       /path/to/your-repo
Migration Pack:   express-to-fastify
Total Modules:    42
  - Clean:        10
  - Pending:      32
Baseline Routes:  24
Tarjan SCCs:      31
FalkorDB UI:      http://localhost:3000
```

---

### Step 3: Run the Migration

#### Option A: Autonomous AI Agent via MCP (Recommended)

Shift turns any LLM into a graph-governed migration engineer with zero chance of breaking intermediate builds or deadlocking on circular imports.

##### 1. Add Shift to your MCP Client Configuration:

**For Claude Desktop (`claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "shift": {
      "command": "npx",
      "args": [
        "-y",
        "tsx",
        "/absolute/path/to/shift/bin/cli.ts",
        "serve",
        "--repo",
        "/absolute/path/to/your-repo",
        "--pack",
        "express-to-fastify"
      ]
    }
  }
}
```

**For Cursor (`.cursor/mcp.json`):**
```json
{
  "mcpServers": {
    "shift": {
      "command": "tsx",
      "args": ["/absolute/path/to/shift/bin/cli.ts", "serve", "--repo", "/absolute/path/to/your-repo", "--pack", "express-to-fastify"]
    }
  }
}
```

##### 2. Instruct Your AI Agent:
Prompt your agent in chat:
> *"Migrate this repository from Express to Fastify using the Shift MCP tools. Follow this loop: call `claim_next_leaf` to get the next unblocked module(s) and phase (`SHIM`, `MIGRATE`, or `DE_SHIM`), inspect context with `get_migration_slice`, apply the changes to disk, and call `verify_and_commit_node`. Repeat until all modules reach `VERIFIED`."*

The agent will execute the topological plan automatically:
1. Claims foundational leaves (highest PageRank helpers) first.
2. Migrates circular dependencies ($A \leftrightarrow B$) atomically in a single batch.
3. Automatically generates dual-signature shims (`// @shift-shim`) for modules with pending callers.
4. Cascades de-shimming top-down once all upstream callers are verified.

---

#### Option B: Step-by-Step CLI Workflow

You can also drive the migration manually or via scripts using the Shift CLI:

```bash
# 1. Claim next unblocked leaf or atomic SCC
shift claim --repo ./my-app --pack express-to-fastify
# Output: Returns JSON with targetPaths: ["src/utils/response.ts"], phase: "SHIM"

# 2. Inspect 1-hop contextual slice and guidance
shift slice --repo ./my-app --pack express-to-fastify --module src/utils/response.ts --phase SHIM

# 3. Edit your file(s) on disk (e.g., adding Fastify types and dual-signature wrappers)

# 4. Gate-check, typecheck, and commit the node in FalkorDB
shift verify --repo ./my-app --pack express-to-fastify --module src/utils/response.ts --summary "Dual-compat response shim"

# 5. Check audit trail and trigger test checkpoint
shift audit --repo ./my-app --pack express-to-fastify --checkpoint
```

Repeat steps 1–4 until `shift claim` reports:
`[shift] No unblocked modules to claim. Migration complete.`

---

### Step 4: Live Visual Cockpit & FalkorDB Browser

#### 1. Interactive Migration Cockpit (`http://localhost:4200`)
Launch Shift's real-time visual cockpit:
```bash
npm run demo
```
- **Live Dependency Topology:** Vis.js canvas showing PageRank-scaled glowing nodes and Tarjan circular cycles.
- **Controls:** Click **"Step Forward"** to execute one topological step, or **"Auto-Play ▶"** to watch the entire codebase migrate with real-time code diffs, FalkorDB sub-millisecond query latency, and green verification gates (`tsc`, integration tests, route parity).

#### 2. FalkorDB Browser (`http://localhost:3000`)
Query the graph directly with openCypher:
```cypher
// View all unblocked modules ready for migration
MATCH (m:Module)
WHERE m.status IN ['PENDING', 'SHIMMED']
  AND NOT (m)-[:IMPORTS]->(:Module {status: 'PENDING'})
RETURN m.path, m.status, m.pagerank
ORDER BY m.pagerank DESC
```

---

## How to Build a Custom Migration (Your Own Framework / Language)

Shift is completely language- and framework-agnostic. To migrate a different library (e.g. Flask $\rightarrow$ FastAPI, React Router 5 $\rightarrow$ 6, Jest $\rightarrow$ Vitest, or internal company SDKs):

### Step 1: Scaffold a Migration Pack
```bash
shift pack init flask-to-fastapi --lang python
```
This generates a starter pack at `packs/flask-to-fastapi.json`.

### Step 2: Configure Detection Rules & Verification Gates
Edit `packs/flask-to-fastapi.json`:
1. **`packages`**: Set legacy and target package names (`flask` $\rightarrow$ `fastapi`).
2. **`detectionRules`**: Define Tree-sitter AST queries matching legacy API calls or decorator patterns.
3. **`verification`**: Set your project's validation commands:
   ```json
   "verification": {
     "perStepTypecheckCmd": "mypy src/",
     "checkpointTestCmd": "pytest test/",
     "routeSnapshotCmd": "python scripts/dump_routes.py"
   }
   ```

### Step 3: Validate Your Pack Schema
```bash
shift pack validate ./packs/flask-to-fastapi.json
```
Output: `[shift] ✅ Pack "flask-to-fastapi" is structurally valid and ready for use!`

### Step 4 (If New Language): Scaffold a Language Adapter
For languages other than TypeScript, scaffold an adapter:
```bash
shift adapter init python
```
This creates `adapters/pythonAdapter.ts` extending `BaseLanguageAdapter`. Implement `parseModule()` to extract imports and symbol signatures.

### Step 5: Run Your Custom Migration
```bash
shift init --repo /path/to/python-app --pack flask-to-fastapi --adapter ./adapters/pythonAdapter.ts
```

---

## CLI Command Reference

| Command | Arguments / Flags | Description |
|---|---|---|
| `shift init` | `--repo <path> --pack <id> [--reset] [--adapter <path>]` | Ingests codebase into FalkorDB, calculates Tarjan SCCs, captures baseline route snapshot. |
| `shift claim` | `--repo <path> --pack <id>` | Computes transitive callee graph and claims the next unblocked leaf or circular SCC cluster. |
| `shift slice` | `--repo <path> --pack <id> --module <path> --phase <phase>` | Returns 1-hop contextual slice (target files, callee signatures, caller snippets, phase guidance). |
| `shift blast-radius` | `--repo <path> --pack <id> --module <path>` | Evaluates reverse multi-hop dependencies (`[:IMPORTS*1..6]`) before editing. |
| `shift verify` | `--repo <path> --pack <id> --module <path> [--summary <text>]` | Re-parses AST, checks invariants, runs `tsc --noEmit`, and commits state in FalkorDB. |
| `shift audit` | `--repo <path> --pack <id> [--checkpoint]` | Streams cryptographic episode audit log; runs full checkpoint gates (tests + route diffs). |
| `shift serve` | `[--repo <path>] [--pack <id>]` | Starts the Shift Model Context Protocol (MCP) server over standard I/O (stdio). |
| `shift pack init` | `<pack-id> [--lang <language>]` | Scaffolds a new validated Migration Pack starter template. |
| `shift pack validate`| `<path-to-pack>` | Validates Migration Pack structure, AST queries, and verification commands. |
| `shift adapter init` | `<language>` | Scaffolds a new Language Adapter starter template extending `BaseLanguageAdapter`. |

---

## Developer & Contributor Quickstart

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Full Test Suite (28 tests)
```bash
npm test
```

### 3. Run Scale Benchmark & AST Validators
```bash
npm run validate:queries  # Validates Tree-sitter AST queries
npm run validate:cypher   # Validates openCypher queries against live FalkorDB
npm run benchmark         # 150-module synthetic P95 latency benchmark
npm run typecheck         # tsc --noEmit
```

### 4. Run the Visual Flight Deck
```bash
npm run demo
```
Open **[http://localhost:4200](http://localhost:4200)** in your browser.

---

## License
MIT
