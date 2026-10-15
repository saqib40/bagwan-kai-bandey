# Developer & Contributor Guide

> Guidelines for developing, testing, and contributing to **Bagwan Kai Bandey (BKB)**.

---

## 1. Prerequisites

- **Node.js**: v20 or newer
- **Docker**: For running FalkorDB
- **Git**: Clean working directory

---

## 2. Quick Setup

```bash
# 1. Clone repository
git clone https://github.com/saqib40/bagwan-kai-bandey.git
cd bagwan-kai-bandey

# 2. Install dependencies
npm install

# 3. Start FalkorDB
docker run -p 6379:6379 -p 3000:3000 -d --name falkordb-bkb-engine falkordb/falkordb:latest

# 4. Optional: Link CLI globally for convenient local testing
npm link
```

---

## 3. Running Tests & Quality Gates

BKB has comprehensive test coverage across language adapters, migration operations, MCP server, checkpoints, and end-to-end dry-run migrations.

```bash
# Run all test suites:
npm test

# Run type checking:
npm run typecheck

# Validate Tree-sitter AST queries against packs:
npm run validate:queries

# Validate openCypher queries against live FalkorDB:
npm run validate:cypher

# Run the 150-module synthetic scale benchmark:
npm run benchmark
```

---

## 4. Launching the Local Flight Deck / Demo Cockpit

```bash
npm run demo
```
Open **`http://localhost:4200`** to view the live dependency topology canvas, real-time code diffs, and step-by-step verification gates.

---

## 5. Repository Structure

```
bagwan-kai-bandey/
├── bin/
│   └── cli.ts                 # CLI entrypoint & commands (bkb doctor, run, claim, slice, verify...)
├── docs/                      # Dedicated technical documentation hub
│   ├── architecture.md        # 3-Layer architecture, 5 universal laws, FalkorDB schema
│   ├── extensibility.md       # Custom packs, language adapters, bkb.config.ts
│   ├── mcp-guide.md           # Model Context Protocol tools & editor integration
│   ├── benchmarks.md          # 150-module benchmark & LLM efficiency analysis
│   └── contributing.md        # Developer setup and test commands
├── packs/
│   └── express-to-fastify.json# Built-in migration pack
├── public/                    # Interactive visual flight deck (HTML/CSS/Vis.js)
├── src/
│   ├── adapters/              # Layer 2: TypeScriptAdapter, BaseLanguageAdapter
│   ├── engine/                # Layer 1: FalkorClient, MigrationOps, Tarjan SCC, Checkpoint
│   ├── mcp/                   # MCP Server implementation
│   ├── runner/                # Autonomous migration runner & LLM providers
│   └── server/                # Demo & visual cockpit server
└── test/                      # Comprehensive test suites
```
