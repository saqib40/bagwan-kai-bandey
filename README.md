# Bagwan Kai Bandey: Graph-Governed Codebase Migration Engine

[![npm version](https://img.shields.io/npm/v/bagwan-kai-bandey.svg?color=cb3837)](https://www.npmjs.com/package/bagwan-kai-bandey)
[![Powered by FalkorDB](https://img.shields.io/badge/Powered%20by-FalkorDB-purple.svg)](https://www.falkordb.com/)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-blue.svg)](https://modelcontextprotocol.io/)
[![Tests: 170+ Passing](https://img.shields.io/badge/Tests-170%2B%20Pass-brightgreen.svg)]()
[![Typecheck: Clean](https://img.shields.io/badge/Typecheck-tsc%20green-success.svg)]()
[![Languages: TypeScript & Python](https://img.shields.io/badge/Languages-TypeScript%20%7C%20Python-blue.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **The graph-governed codebase migration engine that prevents AI agents from breaking your build.**  
> Powered by **FalkorDB**, Bagwan Kai Bandey (BKB) computes topological callee-first execution order, groups circular dependency cycles into atomic batches via Tarjan's SCC algorithm, enforces dual-signature Strangler Fig shims, and verifies invariant snapshots at every step—keeping compilers green, test suites intact, and API surfaces 100% identical.

---

### Table of Contents
- [Installation & Prerequisites](#installation--prerequisites)
- [Quickstart (Sandbox Demo)](#quickstart-sandbox-demo)
- [Using BKB on Your Codebase](#using-bkb-on-your-codebase)
  - [Workflow A: AI Agent via MCP (Cursor, Claude, VS Code, Windsurf, OpenCode)](#workflow-a-ai-coding-agent-via-mcp-recommended)
  - [Workflow B: Autonomous Terminal CLI (`bkb run`)](#workflow-b-autonomous-terminal-cli-bkb-run)
- [Supported Migration Packs & Polyglot Adapters](#supported-migration-packs--polyglot-adapters)
- [Phased Multi-Sprint Migrations & Team Handoff](#phased-multi-sprint-migrations--team-handoff)
- [Live Visual Cockpit](#live-visual-cockpit-bkb-cockpit)
- [CLI Command Reference](#cli-command-reference)
- [Updating Bagwan Kai Bandey](#updating-bagwan-kai-bandey)
- [Documentation Index](#documentation-index)

---

## Installation & Prerequisites

### 1. Installation Options
Choose how you want to run BKB:

```bash
# Option A: Global CLI (Recommended for fast daily workflows & clean 'bkb' commands)
npm install -g bagwan-kai-bandey
bkb doctor

# Option B: Zero-Install via npx (Instant execution without local installation)
npx bagwan-kai-bandey doctor

# Option C: From Source (For local development & contributors)
git clone https://github.com/saqib40/bagwan-kai-bandey.git
cd bagwan-kai-bandey && npm install
./bin/bkb.js doctor
```

> **CLI Command Syntax:** Throughout this documentation, commands use the short **`bkb`** syntax (e.g. `bkb init`, `bkb cockpit`, `bkb status`). If you prefer zero-install `npx`, simply prepend **`npx bagwan-kai-bandey`** instead (e.g. `npx bagwan-kai-bandey init`). Both forms are 100% interchangeable.

### 2. Prerequisites
- **Node.js**: $\ge 18.0.0$ (Node $\ge 22.12.0$ recommended for CommonJS $\rightarrow$ ESM runtime interop)
- **Docker**: For running the FalkorDB knowledge graph engine:
  ```bash
  docker run -p 6379:6379 -p 3000:3000 -d --name falkordb-bkb-engine falkordb/falkordb:latest
  ```
  *(Note: BKB will also automatically launch this container if Docker is running).*

---

## Quickstart (Sandbox Demo)

Want to see BKB in action without touching your own code? BKB includes a built-in sandbox (`./demo-repo` featuring an Express.js app with circular dependencies, authentication middleware, and integration tests).

```bash
# 1. Run environment diagnostics (verifies Node, Docker, and FalkorDB)
bkb doctor

# 2. Ingest the built-in demo sandbox into FalkorDB
bkb init --repo ./demo-repo --pack express-to-fastify

# 3. Launch the live visual flight deck in your browser
bkb cockpit
```

Open **`http://localhost:4200`** in your browser. You will see the live dependency graph, PageRank risk scores, Tarjan SCC cycle clusters, and invariant verification gates standing by.

---

## Using BKB on Your Codebase

Choose your preferred way of working:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                      HOW DO YOU WANT TO MIGRATE?                       │
├───────────────────────────────────┬────────────────────────────────────┤
│  Workflow A: AI Agent via MCP     │  Workflow B: Autonomous CLI        │
│  (Cursor / Claude / OpenCode)     │  (Terminal / CI Execution)         │
│  • Agent calls graph tools        │  • Single command execution        │
│  • Generates idiomatic code       │  • Uses Mock, Ollama, or Cloud LLM │
│  • Commits milestones to Git      │  • Automated rollback safety net   │
└───────────────────────────────────┴────────────────────────────────────┘
```

---

### Workflow A: AI Coding Agent via MCP (Recommended)

BKB exposes a standardized [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that turns **Cursor**, **Claude Desktop**, **VS Code**, **Windsurf**, or **OpenCode** into a graph-governed migration engineer.

#### Step 1: 1-Click Connect Your Agent
Register the BKB MCP server in your editor with a single command:

```bash
# Target your specific editor:
bkb mcp install cursor     # Cursor (.cursor/mcp.json)
bkb mcp install claude     # Claude Desktop (claude_desktop_config.json)
bkb mcp install vscode     # VS Code (.vscode/mcp.json)
bkb mcp install windsurf   # Windsurf (.codeium/windsurf/mcp_config.json)
bkb mcp install opencode   # OpenCode CLI / opencode.jsonc

# Or install for all detected editors at once:
bkb mcp install all
```

#### Step 2: Initialize Graph & Open Visual Flight Deck
```bash
# Ingest your codebase and capture pre-migration invariant baseline
bkb init --repo /path/to/your-repo --pack express-to-fastify

# In another terminal window, launch the real-time visual cockpit
bkb cockpit --repo /path/to/your-repo
```

#### Step 3: Prompt Your AI Agent
Paste one of these prompts into your agent's chat interface:

<details open>
<summary><b>Production Team Prompt (Recommended for Full Codebases)</b></summary>

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
</details>

<details>
<summary><b>Quick Try Prompt (Minimal 1-Liner)</b></summary>

> *"Use the BKB MCP server to migrate this repository. Call `bkb_get_migration_status` to see current progress, then run the `advance_migration` loop to claim, transform, and verify each batch until 100% complete."*
</details>

---

### Workflow B: Autonomous Terminal CLI (`bkb run`)

Execute migrations directly from your shell without an interactive editor:

```bash
# 1. Zero-Cost Deterministic Dry Run (Simulates the entire topological loop):
bkb run --repo /path/to/your-repo --pack express-to-fastify --dry-run

# 2. Local Zero-Cost LLM via Ollama (e.g. Qwen2.5-Coder):
bkb run --repo /path/to/your-repo --pack express-to-fastify --provider ollama --model qwen2.5-coder:latest

# 3. OpenCode / DeepSeek (Default: deepseek-v4.1-flash-free):
bkb run --repo /path/to/your-repo --pack cjs-to-esm --provider opencode

# 4. Cloud LLMs (OpenAI GPT-4o / Anthropic Claude):
export OPENAI_API_KEY="sk-..."
bkb run --repo /path/to/your-repo --pack express-to-fastify --provider openai --model gpt-4o
```

#### Rollback Safety Net
If a transformation ever fails unexpectedly, revert your codebase and graph state instantly:
```bash
bkb rollback            # Revert to the latest verified checkpoint
bkb rollback 3          # Revert to specific Step 3
bkb rollback --list     # View all available step snapshots
```

---

## Supported Migration Packs & Polyglot Adapters

Bagwan Kai Bandey includes four production-ready packs spanning **TypeScript/JavaScript** and **Python**:

| Migration Pack | Source $\rightarrow$ Target | Language | Shim Strategy | Invariant Snapshot |
|---|---|---|---|---|
| **`express-to-fastify`** | Express.js $\rightarrow$ Fastify | TypeScript / JS | `in-file-branch` | 100% route signature parity (`dump-routes.mjs`) |
| **`cjs-to-esm`** | CommonJS $\rightarrow$ ES Modules | TypeScript / JS | `runtime-interop` (Node $\ge 22.12$) | Export surface and callable shape preservation (`dump-exports.mjs`) |
| **`jest-to-vitest`** | Jest $\rightarrow$ Vitest | TypeScript / JS | `in-file-branch` | Test runner wrapper + test-count parity (`test-counts.mjs`) |
| **`flask-to-fastapi`** | Flask $\rightarrow$ FastAPI | Python | `in-file-branch` | Dual-framework route canonicalizer (`dump_routes.py`) |

### Core Architectural Capabilities
- **Dual Shim Strategies**:
  - `in-file-branch`: In-file dual-compatibility branches tagged with `@bkb-shim` markers, automatically pruned during the `DE_SHIM` phase once callers have migrated.
  - `runtime-interop`: Emits pure target syntax while preserving CommonJS export shape (`export default` + `export { X as "module.exports" }`) under Node $\ge 22.12$ synchronous `require(esm)`.
- **Polyglot AST Language Adapters**:
  - `TypeScriptAdapter`: Parses TS, TSX, JS, and JSX; resolves ESM `.js` $\rightarrow$ `.ts` mappings, relative `.cjs`/`.mjs` paths, and `tsconfig.json` path aliases.
  - `PythonAdapter`: Tree-sitter WASM parser for Python (`.py`); resolves relative (`..foo`) and dotted (`app.bar`) package imports; prunes virtual environments (`.venv`, `venv`) and caches; clusters circular dependencies with Tarjan SCC.
- **Formal Pack Specification**: Draft-07 JSON Schema (`packs/PACK_SPEC.schema.json`) compiled with Ajv, providing instant schema validation via `bkb pack validate <path>`.

---

## Phased Multi-Sprint Migrations & Team Handoff

Real enterprise migrations span weeks across distributed teams. BKB enables phased migrations with **Git-Native Manifests (`.bkb/manifest.json`)**:

```text
your-repo/
├── .bkb/
│   ├── manifest.json       # Committed directly to Git at each milestone
│   └── checkpoints/        # Local disk checkpoints for instant rollback
```

### Why This Matters:
1. **Pre-Migration Baseline Invariance**:  
   When engineer Alice initializes the migration, BKB records the pure pre-migration route, export, or test baseline into `.bkb/manifest.json`. When engineer Bob clones the repository weeks later (with 40% of modules already shimmed), BKB reuses the committed baseline snapshot rather than re-capturing against a half-migrated codebase.
2. **Instant Graph Reconciliation**:  
   Running `bkb init` on any developer machine or CI container automatically reads `.bkb/manifest.json`, restores all completed `SHIMMED` and `VERIFIED` node states in FalkorDB, and recomputes unblocked leaves in milliseconds.
3. **Native MCP Milestone Commits**:  
   AI agents call `bkb_commit_milestone` to atomically stage modified code and `.bkb/manifest.json`, commit with structured audit notes, and embed the new Git commit SHA into the manifest history.
4. **Flight Deck Status**:  
   ```bash
   bkb status --repo /path/to/your-repo
   ```
   Outputs an instant ASCII flight deck progress bar (`[■■■■░░░░░░░░░░░░░░░░]`), module counts, baseline snapshot health, last team milestone, and unblocked leaves ready for the next sprint.

---

## Live Visual Cockpit (`bkb cockpit`)

Launch the dedicated **Live Sync Flight Deck & Visualizer**:
```bash
bkb cockpit --repo /path/to/your-repo
```

- **Editorial Minimalist Craft**: High-definition Alabaster and warm stone interface inspired by Vercel Geist and Linear, powered by a Cytoscape.js & Dagre hierarchical layout, hairline dividers, and tactile pill controls.
- **Real-Time SSE Synchronization**: Powered by a Server-Sent Events bus. Whenever your CLI (`bkb claim`, `bkb verify`, `bkb run`) or AI agent calls MCP tools, the browser visualizer immediately mirrors the action.
- **Interactive AST & Blast-Radius Inspection**: Click any node in the graph to inspect inward callers, outward dependencies, exported symbols, and reverse multi-hop blast radius.
- **Collapsible openCypher Tray**: Run live graph queries against FalkorDB with built-in presets (`Leaf Claim`, `De-shim Prioritizer`, `Circular Cycles (SCC)`, `PageRank Risk`, `Reverse Blast Radius`).

---

## CLI Command Reference

| Command | Arguments / Flags | Description |
|---|---|---|
| `bkb doctor` | `[--repo <path>]` | Evaluates environment health (Node.js, Docker, FalkorDB ports, Git status). |
| `bkb mcp install` | `[cursor\|claude\|vscode\|windsurf\|opencode\|all]` | 1-Click registers BKB MCP server into your editor or agent configuration. |
| `bkb init` | `[--interactive\|-i] [--repo <path>] [--pack <id>] [--reset]` | Ingests codebase into FalkorDB, calculates Tarjan SCCs, captures baseline snapshots. |
| `bkb status` | `[--repo <path>] [--pack <id>] [--json]` | Displays live migration flight status, progress bar, unblocked leaves, and Git manifest sync. |
| `bkb run` | `[--repo <path>] [--pack <id>] [--provider <p>] [--model <m>] [--dry-run]` | Autonomously executes migration loop (claim $\rightarrow$ checkpoint $\rightarrow$ slice $\rightarrow$ transform $\rightarrow$ verify $\rightarrow$ gate). |
| `bkb cockpit` | `[--port <port>] [--repo <path>] [--pack <id>]` | Launches the live visual migration flight deck with multi-pack header badges & SSE sync. |
| `bkb rollback` | `[step] [--repo <path>] [--pack <id>] [--list]` | Rollback source files and FalkorDB graph state to a previous step (or latest checkpoint). |
| `bkb claim` | `--repo <path> --pack <id>` | Computes transitive callee graph and claims the next unblocked leaf or circular SCC cluster. |
| `bkb slice` | `--repo <path> --pack <id> --module <path> --phase <phase>` | Returns 1-hop contextual slice (target files, callee signatures, caller snippets, guidance). |
| `bkb blast-radius` | `--repo <path> --pack <id> --module <path>` | Evaluates reverse multi-hop dependencies (`[:IMPORTS*1..10]`) before editing. |
| `bkb verify` | `--repo <path> --pack <id> --module <path> [--summary <text>]` | Re-parses AST, checks invariants, runs compiler verification, and commits state in FalkorDB. |
| `bkb audit` | `--repo <path> --pack <id> [--checkpoint]` | Streams cryptographic episode audit log; runs full checkpoint gates (tests + snapshot diffs). |
| `bkb serve` | `[--repo <path>] [--pack <id>]` | Starts the Model Context Protocol (MCP) server over standard I/O (stdio transport). |
| `bkb pack init` | `<pack-id> [--lang <ts\|py\|go>]` | Scaffolds a new schema-validated Migration Pack starter template. |
| `bkb pack validate`| `<path-to-pack>` | Validates Migration Pack structure, Ajv schema, and compiles Tree-sitter AST queries. |
| `bkb adapter init` | `<language>` | Scaffolds a new Language Adapter starter template extending `BaseLanguageAdapter`. |

---

## Updating Bagwan Kai Bandey

Stay up to date with the latest migration packs, AST language adapters, and graph engine improvements:

### If Using `npx` (Default):
Append `@latest` to run the newest version automatically:
```bash
npx bagwan-kai-bandey@latest doctor
```

### If Installed Globally:
```bash
npm install -g bagwan-kai-bandey@latest
bkb doctor
```

### Refresh Editor & Agent MCP Configurations:
After updating BKB, re-run the 1-click MCP installer so your editors point to the newest tool definitions:
```bash
bkb mcp install all
```

### Update FalkorDB Docker Image:
```bash
docker pull falkordb/falkordb:latest
```

---

## Documentation Index

For in-depth architectural details, custom framework extensions, and benchmark results:

| Guide | Description |
|---|---|
| **[Architecture & Universal Laws](docs/architecture.md)** | The 3-Layer engine design, The 5 Universal Laws of Topological Migration, and the FalkorDB openCypher graph schema. |
| **[Phased Migrations & Team Handoff](docs/phased-migrations-and-team-handoff.md)** | The Git-native `.bkb/manifest.json` schema, baseline snapshot invariance, and MCP milestone commits across multi-sprint lifecycles. |
| **[Extensibility: Custom Packs & Adapters](docs/extensibility.md)** | How to build custom Migration Packs (`defineMigrationPack`), custom Language Adapters (`BaseLanguageAdapter`), and `bkb.config.ts`. |
| **[MCP Server & AI Agent Guide](docs/mcp-guide.md)** | Detailed reference for the 11 MCP tools, manual JSON-RPC configs, and optimal agent prompts. |
| **[Benchmarks & Performance](docs/benchmarks.md)** | 150-Module scale evaluation ($< 25\text{ms}$ SLA) and Naive Grep vs. BKB MCP comparison (81% token reduction). |
| **[Developer & Contributor Setup](docs/contributing.md)** | Development environment setup, running tests (`npm test`), and AST validators. |

---

## License
MIT © [saqib40](https://github.com/saqib40)
