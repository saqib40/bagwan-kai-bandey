# Bagwan Kai Bandey: Graph-Governed Codebase Migration Engine

[![npm version](https://img.shields.io/npm/v/bagwan-kai-bandey.svg?color=cb3837)](https://www.npmjs.com/package/bagwan-kai-bandey)
[![Powered by FalkorDB](https://img.shields.io/badge/Powered%20by-FalkorDB-purple.svg)](https://www.falkordb.com/)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-blue.svg)](https://modelcontextprotocol.io/)
[![Tests: 38/38 Passing](https://img.shields.io/badge/Tests-38%2F38%20Pass-brightgreen.svg)]()
[![Typecheck: Clean](https://img.shields.io/badge/Typecheck-tsc%20green-success.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Universal laws, pluggable packs.** Bagwan Kai Bandey (BKB) is an autonomous, graph-governed migration engine powered by **FalkorDB** that computes callee-first execution order, collapses circular dependencies into atomic batches via Tarjan's SCC algorithm, enforces dual-signature shims with automatic de-shimming, and verifies edge-level invariants—keeping `tsc` green at every single step, test suites green at every checkpoint, and route surfaces 100% identical.

---

## Why Bagwan Kai Bandey?

Standard AI coding agents attempting framework migrations (e.g., Express $\rightarrow$ Fastify) fail predictably:
1. **Topological Inversion:** They migrate root entrypoints first, breaking all downstream callers.
2. **Circular Dependency Deadlock:** When modules import each other ($A \leftrightarrow B$), file-by-file edits leave the codebase uncompilable in intermediate states.
3. **Premature De-Shimming:** Removing backward compatibility wrappers before all upstream callers have migrated causes cascading type failures.
4. **Token Exhaustion:** Crawling whole repositories with grep consumes tens of thousands of wasted tokens.

**Bagwan Kai Bandey eliminates these failure modes** by governing migrations with an active FalkorDB knowledge graph. It computes mathematically provable callee-first order, groups cycles into atomic batches, and enforces Strangler Fig shims until all callers are safely migrated.

---

## ⚡ Quickstart

### Option 1: Zero-Install via `npx` (Recommended)
No installation or cloning required. Run instantly across macOS, Linux, and WSL:
```bash
# 1. Check environment health (Node, Docker, FalkorDB, Git)
npx bagwan-kai-bandey doctor

# 2. 1-Click register MCP tools in your favorite editor/agent
npx bagwan-kai-bandey mcp install opencode   # or: cursor, claude, vscode, windsurf

# 3. Ingest your codebase into FalkorDB
npx bagwan-kai-bandey init --repo /path/to/your-repo --pack express-to-fastify
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
Ingest your repository, compute circular dependencies, and snapshot route invariants:
```bash
bkb init --repo /path/to/your-repo --pack express-to-fastify
# or via npx:
npx bagwan-kai-bandey init --repo /path/to/your-repo --pack express-to-fastify
```

---

## 🚀 Migration Modes

### Mode A: Autonomous AI Agent via MCP (Recommended)
BKB turns Cursor, Claude Desktop, VS Code, Windsurf, or OpenCode into a graph-governed migration engineer.

**1-Click Editor & Agent Installation:**
```bash
# Auto-configure your favorite editor or coding agent:
bkb mcp install opencode   # OpenCode CLI / opencode.jsonc
bkb mcp install cursor     # Cursor (.cursor/mcp.json)
bkb mcp install claude     # Claude Desktop (claude_desktop_config.json)
bkb mcp install vscode     # VS Code (.vscode/mcp.json)
bkb mcp install windsurf   # Windsurf (.codeium/windsurf/mcp_config.json)
bkb mcp install all        # All detected editors & agents
```

**Instruct Your Agent in Chat:**
> *"Migrate this repository using BKB MCP tools. Call `claim_next_leaf` to get the next target, inspect context with `get_migration_slice`, update code on disk, and call `verify_and_commit_node`. Repeat until all modules reach `VERIFIED`."*

---

### Mode B: Terminal Autonomous Runner (`bkb run`)
Run the migration autonomously right from your command line without external editor GUIs:

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

## 🖥️ Live Visual Cockpit (`http://localhost:4200`)

Launch the real-time visual flight deck to watch the codebase migrate live:
```bash
npm run demo
```
- **Live Dependency Topology:** Vis.js canvas showing PageRank-scaled glowing nodes and Tarjan circular cycles.
- **Controls:** Click **"Step Forward"** to execute one topological step, or **"Auto-Play ▶"** to watch the entire codebase migrate with real-time code diffs, FalkorDB sub-millisecond query latency, and green verification gates (`tsc`, integration tests, route parity).
- **FalkorDB Browser:** Inspect raw openCypher graph state live at `http://localhost:3000`.

---

## 📖 Complete Documentation Index

For in-depth architectural details, custom framework extensions, and benchmark results, explore the dedicated documentation guides:

| Guide | Description |
|---|---|
| 📐 **[Architecture & Universal Laws](docs/architecture.md)** | The 3-Layer engine design, The 5 Universal Laws of Topological Migration, and the FalkorDB openCypher graph schema. |
| 🔌 **[Extensibility: Custom Packs & Adapters](docs/extensibility.md)** | How to build custom Migration Packs (`defineMigrationPack`), custom Language Adapters (`BaseLanguageAdapter`), and `bkb.config.ts`. |
| 🤖 **[MCP Server & AI Agent Guide](docs/mcp-guide.md)** | Detailed reference for the 6 MCP tools, manual JSON-RPC configs, and optimal agent prompts. |
| 📊 **[Benchmarks & Performance](docs/benchmarks.md)** | 150-Module scale evaluation ($< 25\text{ms}$ SLA) and Naive Grep vs. BKB MCP comparison (81% token reduction). |
| 🛠️ **[Developer & Contributor Setup](docs/contributing.md)** | Development environment setup, running tests (`npm test`), and AST validators. |

---

## ⌨️ CLI Command Reference

| Command | Arguments / Flags | Description |
|---|---|---|
| `bkb doctor` | `[--repo <path>]` | Evaluates environment health (Node.js, Docker, FalkorDB ports, Git status). |
| `bkb mcp install` | `[cursor\|claude\|vscode\|windsurf\|opencode\|all]` | 1-Click registers BKB MCP server into your editor or agent configuration. |
| `bkb init` | `[--interactive\|-i] [--repo <path>] [--pack <id>] [--reset] [--adapter <path>]` | Ingests codebase into FalkorDB, calculates Tarjan SCCs, captures baseline route snapshot. |
| `bkb run` / `bkb auto`| `[--repo <path>] [--pack <id>] [--provider <p>] [--model <m>] [--dry-run]` | Autonomously executes migration loop (claim $\rightarrow$ checkpoint $\rightarrow$ slice $\rightarrow$ transform $\rightarrow$ verify $\rightarrow$ gate). |
| `bkb rollback` | `[step] [--repo <path>] [--pack <id>] [--list]` | Rollback source files and FalkorDB graph state to a previous step (or latest checkpoint). |
| `bkb claim` | `--repo <path> --pack <id>` | Computes transitive callee graph and claims the next unblocked leaf or circular SCC cluster. |
| `bkb slice` | `--repo <path> --pack <id> --module <path> --phase <phase>` | Returns 1-hop contextual slice (target files, callee signatures, caller snippets, guidance). |
| `bkb blast-radius` | `--repo <path> --pack <id> --module <path>` | Evaluates reverse multi-hop dependencies (`[:IMPORTS*1..6]`) before editing. |
| `bkb verify` | `--repo <path> --pack <id> --module <path> [--summary <text>]` | Re-parses AST, checks invariants, runs `tsc --noEmit`, and commits state in FalkorDB. |
| `bkb audit` | `--repo <path> --pack <id> [--checkpoint]` | Streams cryptographic episode audit log; runs full checkpoint gates (tests + route diffs). |
| `bkb serve` | `[--repo <path>] [--pack <id>]` | Starts the BKB Model Context Protocol (MCP) server over standard I/O (stdio). |
| `bkb pack init` | `<pack-id> [--lang <language>]` | Scaffolds a new validated Migration Pack starter template. |
| `bkb pack validate`| `<path-to-pack>` | Validates Migration Pack structure, AST queries, and verification commands. |
| `bkb adapter init` | `<language>` | Scaffolds a new Language Adapter starter template extending `BaseLanguageAdapter`. |

---

## License
MIT
