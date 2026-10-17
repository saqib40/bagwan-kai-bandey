# Model Context Protocol (MCP) & AI Agent Integration Guide

> Connect any modern AI coding assistant (Cursor, Claude Desktop, VS Code, Windsurf) to **Bagwan Kai Bandey** via the Model Context Protocol to execute graph-governed, safe migrations.

---

## 1. Overview

Rather than guessing which files to edit, an AI coding agent connected to BKB queries a graph engine that calculates exact topological callee order, circular dependency batches, and backward-compatible shims.

### The Single-Turn Autonomous Migration Loop (`advance_migration`)
```
┌────────────────────────────────────────────────────────┐
│ 1. advance_migration (No edits)                        │
│    Engine claims leaf batch & returns target files,    │
│    callee signatures, caller snippets, and guidance    │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│ 2. advance_migration (With edits: [{path, content}])   │
│    Engine writes files, executes AST/invariant gates,  │
│    runs tsc --noEmit, rolls back on error, and returns │
│    the next batch in a single turn (0 context bloat)   │
└────────────────────────────────────────────────────────┘
```

---

## 2. The MCP Tools

| Tool | Parameters | Description |
|---|---|---|
| **`advance_migration`** ⭐ *(Recommended)* | `edits?: Array<{path, content}>`<br>`agentSummary?: string` | **Single-turn macro-tool.** With no edits: claims the batch and returns source, signatures, and guidance. With edits: writes files, executes verification gates, rolls back on error, and advances. |
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

When interacting with an AI coding assistant in chat (Cursor Composer, Claude Desktop, VS Code, Windsurf, or OpenCode), copy-paste this prompt to kick off the graph-governed migration:

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

### Granular Tool Fallback
If you need finer control than the single-turn `advance_migration` loop:
- Call `claim_next_leaf` to claim unblocked nodes.
- Call `get_migration_slice` to view 1-hop source code and signatures.
- Call `simulate_blast_radius` to see reverse upstream callers.
- Call `verify_and_commit_node` to validate compilation and commit.
- Call `get_migration_audit_trail` to run checkpoint test suites and route diffs.
- Call `bkb_commit_milestone` to push the Git commit and update `.bkb/manifest.json`.
