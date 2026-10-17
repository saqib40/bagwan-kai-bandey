# Bagwan Kai Bandey: Graph-Governed Codebase Migration Engine

[![npm version](https://img.shields.io/npm/v/bagwan-kai-bandey.svg?color=cb3837)](https://www.npmjs.com/package/bagwan-kai-bandey)
[![Powered by FalkorDB](https://img.shields.io/badge/Powered%20by-FalkorDB-purple.svg)](https://www.falkordb.com/)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-blue.svg)](https://modelcontextprotocol.io/)
[![Tests: 170+ Passing](https://img.shields.io/badge/Tests-170%2B%20Pass-brightgreen.svg)]()
[![Typecheck: Clean](https://img.shields.io/badge/Typecheck-tsc%20green-success.svg)]()
[![Languages: TypeScript & Python](https://img.shields.io/badge/Languages-TypeScript%20%7C%20Python-blue.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Universal laws, pluggable packs, polyglot reach.** Bagwan Kai Bandey (BKB) is an autonomous, graph-governed migration engine powered by **FalkorDB**. It computes callee-first execution order, collapses circular dependencies into atomic batches via Tarjan's SCC algorithm, enforces dual-signature shims with automatic de-shimming, and verifies edge-level invariants—keeping compilers green at every single step, test suites green at every checkpoint, and route and export surfaces 100% identical.

---

## Why Bagwan Kai Bandey?

Standard AI coding agents attempting major framework or ecosystem migrations (e.g., Express $\rightarrow$ Fastify, CJS $\rightarrow$ ESM, Jest $\rightarrow$ Vitest, Flask $\rightarrow$ FastAPI) fail predictably:
1. **Topological Inversion:** They migrate root entrypoints first, breaking all downstream callers.
2. **Circular Dependency Deadlock:** When modules import each other ($A \leftrightarrow B$), file-by-file edits leave the codebase uncompilable in intermediate states.
3. **Premature De-Shimming:** Removing backward compatibility wrappers before all upstream callers have migrated causes cascading compilation and runtime failures.
4. **Token Exhaustion:** Crawling whole repositories with grep consumes tens of thousands of wasted tokens without structural understanding.
5. **Context Window & Sprint Fragmentation:** Real enterprise codebases cannot fit in a single prompt or finish in one sitting. Without a Git-native manifest, migrations cannot be paused, resumed across sprints, or handed off between distributed teams without corrupting baseline invariants.

**Bagwan Kai Bandey eliminates these failure modes** by governing migrations with an active FalkorDB knowledge graph and Git-native `.bkb/manifest.json`. It computes topological callee-first order (bounded to 15 transitive dependency hops to guarantee sub-25ms graph SLA without combinatorial path explosion), groups cycles into atomic batches, enforces Strangler Fig shims until all callers are safely migrated, and persists progress to Git for seamless multi-sprint team handoff.

---

## 📦 Built-In Migration Packs & Polyglot Adapters

Bagwan Kai Bandey ships with four production-ready migration packs spanning **TypeScript / JavaScript** and **Python**:

| Migration Pack | Language | Source $\rightarrow$ Target | Shim Strategy | Key Invariant & Snapshots |
|---|---|---|---|---|
| **`express-to-fastify`** | TypeScript / JS | Express.js $\rightarrow$ Fastify | `in-file-branch` | 100% route parity snapshot (`dump-routes.mjs`) |
| **`cjs-to-esm`** | TypeScript / JS | CommonJS $\rightarrow$ ES Modules | `runtime-interop` (Node $\ge 22.12$) | Export surface and callable shape preservation (`dump-exports.mjs`) |
| **`jest-to-vitest`** | TypeScript / JS | Jest $\rightarrow$ Vitest | `in-file-branch` | Runner-agnostic test wrapper + test-count snapshot (`test-counts.mjs`) |
| **`flask-to-fastapi`** | Python | Flask $\rightarrow$ FastAPI | `in-file-branch` | Dual-framework route canonicalizer snapshot (`dump_routes.py`) |

### Core Architectural Capabilities
- **Dual Shim Strategies**:
  - `in-file-branch`: In-file dual-compatibility branches tagged with `@bkb-shim` markers, automatically pruned during the `DE_SHIM` phase.
  - `runtime-interop`: Emits pure target syntax while preserving CommonJS export shape (`export default` + `export { X as "module.exports" }`) under Node $\ge 22.12$ synchronous `require(esm)` with automated preflight version checks.
- **Polyglot AST Language Adapters**:
  - `TypeScriptAdapter`: Parses TS, TSX, JS, and JSX; resolves ESM `.js` $\rightarrow$ `.ts` mappings, relative `.cjs`/`.mjs` paths, and `tsconfig.json` path aliases.
  - `PythonAdapter`: Tree-sitter WASM parser for Python (`.py`); resolves relative (`..foo`) and dotted (`app.bar`) package imports; prunes virtual environments (`.venv`, `venv`) and caches; clusters circular dependencies with Tarjan SCC.
- **Authoritative Pack Specification**: Formal draft-07 JSON Schema (`packs/PACK_SPEC.schema.json`) compiled with Ajv, providing semantic checks, unique ID guarantees, and instant AST query validation via `bkb pack validate`.
- **Pure Manifest Package Detectors**: Declaratively checks `package.json`, `pyproject.toml` (PEP 621 & Poetry), `go.mod`, and `requirements.txt` as advisory preconditions without mutating graph state.
- **Global Verification Snapshots**: Compares system surface invariants across checkpoints (`kind: "set" | "count" | "exact"`), with configurable execution timeouts (`verification.timeoutMs`).

---

## 🤝 Phased Multi-Sprint Migrations & Distributed Team Handoff

Real enterprise migrations cannot happen in a single prompt or sprint. When a codebase contains hundreds of modules, multiple squads and engineers migrate services incrementally over weeks.

Bagwan Kai Bandey provides native distributed team handoff via **Git-Native Manifests (`.bkb/manifest.json`)**:

```text
.bkb/
├── manifest.json       # Committed directly to Git at each verified milestone
└── checkpoints/        # Local disk checkpoints for instant rollback
```

### Key Guarantees:
1. **Pre-Migration Baseline Invariance**:
   When engineer Alice initializes the migration, BKB records the pure pre-migration route, export, or test baseline into `.bkb/manifest.json`. When engineer Bob clones the repository two weeks later (with 40% of modules already shimmed), BKB reuses the committed baseline snapshot rather than re-running snapshot commands against a half-migrated codebase.
2. **Instant Graph Reconciliation**:
   Running `bkb init` on any developer machine or CI container automatically reads `.bkb/manifest.json`, restores all completed `SHIMMED` and `VERIFIED` node states in FalkorDB, and recomputes unblocked leaves in milliseconds without losing completed work.
3. **Native MCP Milestone Commits**:
   AI agents (Cursor, Claude Desktop, Windsurf, OpenCode) call `bkb_commit_milestone` to atomically stage modified code and `.bkb/manifest.json`, commit with structured invariant audit notes, and embed the new Git commit SHA into the manifest history.
4. **Instant Flight Status**:
   ```bash
   bkb status --repo /path/to/your-repo
   ```
   Outputs an instant ASCII flight deck progress bar (`[■■■■░░░░░░░░░░░░░░░░]`), module counts, baseline snapshot health, last team milestone, and unblocked leaves ready for the next sprint or LLM claim.

---

## ⚡ Quickstart

### Option 1: Zero-Install via `npx` (Recommended)
No installation or cloning required. Run instantly across macOS, Linux, and WSL:
```bash
# 1. Check environment health (Node, Docker, FalkorDB, Git)
npx bagwan-kai-bandey doctor

# 2. 1-Click register MCP tools in your favorite editor/agent
npx bagwan-kai-bandey mcp install opencode   # or: cursor, claude, vscode, windsurf

# 3. Ingest your codebase into FalkorDB with a chosen pack
npx bagwan-kai-bandey init --repo /path/to/your-repo --pack express-to-fastify
# Or for other ecosystems:
# npx bagwan-kai-bandey init --repo /path/to/your-repo --pack cjs-to-esm
# npx bagwan-kai-bandey init --repo /path/to/your-repo --pack jest-to-vitest
# npx bagwan-kai-bandey init --repo /path/to/your-repo --pack flask-to-fastapi
```

### Option 2: Global CLI (`npm i -g`)
Install once to have the `bkb` command available globally in your shell:
```bash
npm install -g bagwan-kai-bandey

# Verify installation
bkb doctor
```

### Option 3: From Source (For Contributors & Local Hacking)
```bash
git clone https://github.com/saqib40/bagwan-kai-bandey.git
cd bagwan-kai-bandey
npm install
./bin/bkb.js doctor
```

---

### Step 3: Start FalkorDB
```bash
docker run -p 6379:6379 -p 3000:3000 -d --name falkordb-bkb-engine falkordb/falkordb:latest
```
*(BKB will also auto-start this container if Docker is running).*

### Step 4: Initialize Your Target Codebase
Ingest your repository, compute circular dependencies, and snapshot baseline invariants:
```bash
bkb init --repo /path/to/your-repo --pack express-to-fastify
```

---

## 🚀 Migration Modes

### Mode A: Autonomous AI Agent via MCP (Recommended)

BKB turns **Cursor**, **Claude Desktop**, **VS Code**, **Windsurf**, or **OpenCode** into a graph-governed migration engineer that never deadlocks, never inverts dependencies, and never breaks the build.

#### Step 1: 1-Click Connect Your Agent
```bash
# Register BKB MCP tools in your chosen environment:
bkb mcp install cursor     # Cursor (.cursor/mcp.json)
bkb mcp install claude     # Claude Desktop (claude_desktop_config.json)
bkb mcp install vscode     # VS Code (.vscode/mcp.json)
bkb mcp install windsurf   # Windsurf (.codeium/windsurf/mcp_config.json)
bkb mcp install opencode   # OpenCode CLI / opencode.jsonc
bkb mcp install all        # All detected editors & agents at once
```

#### Step 2: Initialize Graph & Open Visual Cockpit
```bash
# Ingest target codebase and capture baseline invariants
bkb init --repo /path/to/your-repo --pack express-to-fastify

# In another terminal, launch the live real-time flight deck
bkb cockpit --repo /path/to/your-repo
```

#### Step 3: Copy-Paste the Production Agent Prompt
Paste this prompt into your agent's chat interface (Cursor Composer, Claude Desktop, or Windsurf Cascade). This is the exact prompt that successfully governed our automated end-to-end migrations:

```markdown
You are an autonomous codebase migration engineer governed by Bagwan Kai Bandey (BKB) MCP tools.

Your objective: Safely and incrementally migrate this codebase using the active migration pack, preserving all compiler gates, invariant snapshots, and backward compatibility.

Protocol:
1. CHECK STATUS:
   Start by calling `bkb_get_migration_status` to inspect overall progress, the active phase (SHIM, MIGRATE, or DE_SHIM), and unblocked leaves ready for migration.

2. CLAIM & INSPECT BATCH:
   Call `advance_migration` with NO arguments (`{}`) to claim the next topological batch.
   - The response provides the full disk source, callee symbol signatures, caller snippets, and specific pack guidance.
   - Do NOT grep or crawl the workspace; everything needed is in the returned slice.

3. TRANSFORM WITH DUAL COMPATIBILITY:
   Write the migrated code adhering strictly to the returned slice instructions:
   - In SHIM phase: Preserve existing exports and caller call patterns (using @bkb-shim dual branches or runtime-interop export shapes). Downstream callers must not break!
   - In DE_SHIM phase: Strip the legacy shims cleanly once all upstream callers are verified.

4. VERIFY & ADVANCE:
   Call `advance_migration` with `edits: [{ path: "<path>", content: "<full new code>" }]` and an `agentSummary`.
   - The engine writes the file, runs AST re-parsing, executes compiler typechecks (tsc/mypy), and verifies invariant snapshots.
   - If verification passes: The engine commits the node in FalkorDB, updates .bkb/manifest.json, and returns the next batch.
   - If verification fails: Inspect the compiler error returned, fix the types, and re-call `advance_migration`.

5. COMMIT MILESTONES:
   Whenever an atomic batch or sprint milestone is verified, call `bkb_commit_milestone` to create an atomic Git commit with structured audit notes so other team members can track progress.

Repeat this loop until `bkb_get_migration_status` confirms 100% of modules are VERIFIED.
```

#### What Happens Under the Hood (Real Interaction Trace)
1. 🔍 **Agent calls `bkb_get_migration_status`**: Reads `.bkb/manifest.json` and FalkorDB. Discovers `src/utils/response.ts` is unblocked.
2. 📥 **Agent calls `advance_migration({})`**: BKB atomically claims `src/utils/response.ts` (Phase: `SHIM`) and returns the file source, export signatures, and `@bkb-shim` dual-compatibility template.
3. ✏️ **Agent submits edits**: Agent calls `advance_migration({ edits: [{ path: "src/utils/response.ts", content: "..." }] })`.
4. 🛡️ **BKB verifies invariants**: Engine runs AST parser, checks `tsc --noEmit`, compares route snapshots, and marks node `SHIMMED` in FalkorDB.
5. 💾 **Agent commits milestone**: Agent calls `bkb_commit_milestone({ message: "chore: shim response utility to Fastify" })`. Git commit is created and `.bkb/manifest.json` is updated.
6. 🔁 **Repeat**: Agent receives next unblocked leaf until migration is 100% complete.

---

### Mode B: Terminal Autonomous Runner (`bkb run`)
Run the migration autonomously right from your command line:

```bash
# 1. Zero-cost deterministic dry run (instant simulation):
bkb run --dry-run

# 2. Local zero-cost LLM via Ollama (e.g. Qwen2.5-Coder):
bkb run --provider ollama --model qwen2.5-coder:latest

# 3. Cloud LLMs (OpenAI GPT-4o / Anthropic Claude):
export OPENAI_API_KEY="sk-..."
bkb run --provider openai --model gpt-4o
```

**Instant Rollback Safety Net:**
```bash
bkb rollback            # Rollback to latest checkpoint
bkb rollback 3          # Rollback to specific Step 3
bkb rollback --list     # View all available step snapshots
```

---

## 🖥️ Live Visual Cockpit (`bkb cockpit` / `http://localhost:4200`)

Launch the dedicated **Live Sync Flight Deck & Visualizer**:
```bash
bkb cockpit --repo /path/to/your-repo --pack express-to-fastify
# or via npx:
npx bagwan-kai-bandey cockpit --repo /path/to/your-repo
# or from source:
npm run demo
```

- **Multi-Pack Flight Deck**: Header dropdown and metadata badges display the active migration pack, target source language (`TS`, `PYTHON`), and active `shimStrategy` (`in-file-branch`, `runtime-interop`).
- **Dynamic Step States**: Canned executions load reference states dynamically from `<repo>/.bkb-steps.json`, decoupling demonstrations from hardcoded presets.
- **Pure Real-Time Observability**: Streamlined for live telemetry visualization. Keep it open side-by-side with your terminal or AI coding agent.
- **Instant CLI & MCP Synchronization (SSE)**: Powered by a Server-Sent Events event bus. Whenever your CLI (`bkb claim`, `bkb verify`, `bkb run`) or AI agent calls MCP tools, the browser immediately mirrors the action:
  - 🟠 **Pulsing Amber/Blue:** Module claimed and currently under migration.
  - 🟢 **Glowing Emerald:** Invariants verified, compilation passed, and committed to graph.
  - 🔴 **Tarjan SCC Rings:** Circular dependencies visually highlighted and tracked.
- **Mission Deck & Verification HUD**: Live single-line status for typechecks (`tsc` / `mypy`), checkpoint tests, snapshot parity, and sub-2ms FalkorDB query latency.
- **Cryptographic Audit Ledger**: Real-time chronological audit trail of claimed modules, gate evaluations, and verified git commit hashes.
- **Interactive AST & Blast-Radius Inspection**: Click any node to instantly view inward callers, outward dependencies, exported symbols, and reverse multi-hop blast radius.
- **FalkorDB Browser**: Direct access to inspect raw openCypher graph nodes and relationships at `http://localhost:3000`.

---

## 📖 Complete Documentation Index

For in-depth architectural details, custom framework extensions, and benchmark results, explore the dedicated documentation guides:

| Guide | Description |
|---|---|
| 📐 **[Architecture & Universal Laws](docs/architecture.md)** | The 3-Layer engine design, The 5 Universal Laws of Topological Migration, and the FalkorDB openCypher graph schema. |
| 🤝 **[Phased Migrations & Team Handoff](docs/phased-migrations-and-team-handoff.md)** | The Git-native `.bkb/manifest.json` schema, baseline snapshot invariance, and MCP milestone commits across multi-sprint enterprise lifecycles. |
| 🔌 **[Extensibility: Custom Packs & Adapters](docs/extensibility.md)** | How to build custom Migration Packs (`defineMigrationPack`), custom Language Adapters (`BaseLanguageAdapter`), and `bkb.config.ts`. |
| 🤖 **[MCP Server & AI Agent Guide](docs/mcp-guide.md)** | Detailed reference for the 9 MCP tools, manual JSON-RPC configs, and optimal agent prompts. |
| 📊 **[Benchmarks & Performance](docs/benchmarks.md)** | 150-Module scale evaluation ($< 25\text{ms}$ SLA) and Naive Grep vs. BKB MCP comparison (81% token reduction). |
| 🛠️ **[Developer & Contributor Setup](docs/contributing.md)** | Development environment setup, running tests (`npm test`), and AST validators. |

---

## ⌨️ CLI Command Reference

| Command | Arguments / Flags | Description |
|---|---|---|
| `bkb doctor` | `[--repo <path>]` | Evaluates environment health (Node.js, Docker, FalkorDB ports, Git status). |
| `bkb mcp install` | `[cursor\|claude\|vscode\|windsurf\|opencode\|all]` | 1-Click registers BKB MCP server into your editor or agent configuration. |
| `bkb init` | `[--interactive\|-i] [--repo <path>] [--pack <id>] [--reset] [--adapter <path>]` | Ingests codebase into FalkorDB, calculates Tarjan SCCs, captures baseline snapshots. |
| `bkb status` | `[--repo <path>] [--pack <id>] [--json]` | Displays live migration flight status, progress bar, unblocked leaves, and Git manifest sync. |
| `bkb run` / `bkb auto`| `[--repo <path>] [--pack <id>] [--provider <p>] [--model <m>] [--dry-run]` | Autonomously executes migration loop (claim $\rightarrow$ checkpoint $\rightarrow$ slice $\rightarrow$ transform $\rightarrow$ verify $\rightarrow$ gate). |
| `bkb cockpit` / `bkb ui` | `[--port <port>] [--repo <path>] [--pack <id>]` | Launches the live visual migration flight deck with multi-pack header badges & SSE. |
| `bkb rollback` | `[step] [--repo <path>] [--pack <id>] [--list]` | Rollback source files and FalkorDB graph state to a previous step (or latest checkpoint). |
| `bkb claim` | `--repo <path> --pack <id>` | Computes transitive callee graph and claims the next unblocked leaf or circular SCC cluster. |
| `bkb slice` | `--repo <path> --pack <id> --module <path> --phase <phase>` | Returns 1-hop contextual slice (target files, callee signatures, caller snippets, guidance). |
| `bkb blast-radius` | `--repo <path> --pack <id> --module <path>` | Evaluates reverse multi-hop dependencies (`[:IMPORTS*1..6]`) before editing. |
| `bkb verify` | `--repo <path> --pack <id> --module <path> [--summary <text>]` | Re-parses AST, checks invariants, runs compiler verification, and commits state in FalkorDB. |
| `bkb audit` | `--repo <path> --pack <id> [--checkpoint]` | Streams cryptographic episode audit log; runs full checkpoint gates (tests + snapshot diffs). |
| `bkb serve` | `[--repo <path>] [--pack <id>]` | Starts the BKB Model Context Protocol (MCP) server over standard I/O (stdio). |
| `bkb pack init` | `<pack-id> [--lang <ts\|py\|go>]` | Scaffolds a new schema-validated Migration Pack starter template. |
| `bkb pack validate`| `<path-to-pack>` | Validates Migration Pack structure, Ajv schema, and compiles Tree-sitter AST queries. |
| `bkb adapter init` | `<language>` | Scaffolds a new Language Adapter starter template extending `BaseLanguageAdapter`. |

---

## License
MIT
