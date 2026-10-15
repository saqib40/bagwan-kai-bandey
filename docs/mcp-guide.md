# Model Context Protocol (MCP) & AI Agent Integration Guide

> Connect any modern AI coding assistant (Cursor, Claude Desktop, VS Code, Windsurf) to **Bagwan Kai Bandey** via the Model Context Protocol to execute graph-governed, safe migrations.

---

## 1. Overview

Rather than guessing which files to edit, an AI coding agent connected to BKB queries a graph engine that calculates exact topological callee order, circular dependency batches, and backward-compatible shims.

### The 4-Step Autonomous Migration Loop
```
┌────────────────────────────────────────────────────────┐
│ 1. claim_next_leaf                                     │
│    Engine returns next unblocked module(s) and phase   │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│ 2. get_migration_slice                                 │
│    Engine returns target code, callee signatures,      │
│    caller usage snippets, and phase guidance           │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│ 3. Agent modifies code on disk                         │
│    Writes target framework syntax / dual-compat shims  │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│ 4. verify_and_commit_node                              │
│    Engine runs AST check, tsc --noEmit, and updates    │
│    topological degrees in FalkorDB                     │
└────────────────────────────────────────────────────────┘
```

---

## 2. The 6 MCP Tools

| Tool | Parameters | Description |
|---|---|---|
| **`init_migration_graph`** | `repoPath: string`<br>`packId: string`<br>`reset?: boolean` | Ingests the target codebase into FalkorDB, calculates Tarjan SCCs, captures baseline route invariants, and computes PageRank. |
| **`claim_next_leaf`** | `repoPath?: string`<br>`packId?: string` | Evaluates graph state and atomically claims the next unblocked target (Pass A: De-shim candidates; Pass B: Foundational leaves or circular SCC clusters). |
| **`get_migration_slice`** | `modulePaths: string[]`<br>`phase: "SHIM" \| "MIGRATE" \| "DE_SHIM"` | Generates a 1-hop contextual slice containing disk source code, callee symbol signatures, caller call-site snippets, and tailored pack guidance. |
| **`simulate_blast_radius`** | `modulePath: string` | Runs a multi-hop reverse dependency traversal (`[:IMPORTS*1..6]`) to preview all upstream modules affected before making edits. |
| **`verify_and_commit_node`** | `modulePaths: string[]`<br>`agentSummary?: string` | Strict 4-step validation: AST re-parse, invariant equality, `tsc --noEmit` gate, and graph degree recalculation in FalkorDB. |
| **`get_migration_audit_trail`** | `runCheckpointNow?: boolean` | Returns a chronological log of completed migration steps, and optionally executes the full test suite and route snapshot diff. |

---

## 3. 1-Click Editor & Agent Installation

BKB provides a built-in installation command that auto-detects and registers configuration for your favorite editors and AI coding agents:

```bash
# Auto-configure OpenCode CLI / opencode.jsonc:
bkb mcp install opencode

# Auto-configure Cursor (.cursor/mcp.json):
bkb mcp install cursor

# Auto-configure Claude Desktop (claude_desktop_config.json):
bkb mcp install claude

# Auto-configure VS Code (.vscode/mcp.json):
bkb mcp install vscode

# Auto-configure Windsurf (.codeium/windsurf/mcp_config.json):
bkb mcp install windsurf

# Or configure all detected editors and agents at once:
bkb mcp install all
```

---

## 4. Manual Configuration

If you prefer to configure your editor manually:

### For OpenCode (`~/.config/opencode/opencode.jsonc` or `./opencode.json`)
```json
{
  "mcp": {
    "servers": {
      "bkb": {
        "type": "local",
        "command": [
          "npx",
          "-y",
          "tsx",
          "/absolute/path/to/bagwan-kai-bandey/bin/cli.ts",
          "serve",
          "--repo",
          "/absolute/path/to/your-repo",
          "--pack",
          "express-to-fastify"
        ],
        "enabled": true
      }
    }
  }
}
```
*Tip: You can also register directly via the OpenCode CLI:*
```bash
opencode mcp add bkb -- npx -y tsx /absolute/path/to/bagwan-kai-bandey/bin/cli.ts serve
# Verify status:
opencode mcp list
```

### For Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "bkb": {
      "command": "npx",
      "args": [
        "-y",
        "tsx",
        "/absolute/path/to/bagwan-kai-bandey/bin/cli.ts",
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

### For Cursor (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "bkb": {
      "command": "tsx",
      "args": [
        "/absolute/path/to/bagwan-kai-bandey/bin/cli.ts",
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

---

## 5. Recommended Prompt for AI Agents

When interacting with an AI coding assistant in chat, use this prompt to kick off the migration:

> *"Migrate this repository using the Bagwan Kai Bandey (BKB) MCP tools.*
>
> *Follow this exact loop:*
> 1. *Call `claim_next_leaf` to obtain the next unblocked module(s) and target phase (`SHIM`, `MIGRATE`, or `DE_SHIM`).*
> 2. *Call `get_migration_slice` to view the source code, callee signatures, caller snippets, and instructions.*
> 3. *Edit the file(s) on disk to fulfill the phase guidance.*
> 4. *Call `verify_and_commit_node` to validate compilation and commit the step in the graph.*
> 5. *Repeat until `claim_next_leaf` indicates all modules are `VERIFIED`."*
