# `plan.md` — Graph Telemetry & Hop-by-Hop Visualizer Integration

## 0. Objective & Architectural Mandate
Integrate an interactive, hierarchical graph visualization engine using **Cytoscape.js (`cytoscape`)** and **Dagre (`cytoscape-dagre`)** to render FalkorDB state, Strongly Connected Components (SCCs), counterfactual simulation branches, and sequential hop-by-hop query traversals.

> **CRITICAL RULE — ZERO UI ASSUMPTIONS:** 
> Do NOT assume the frontend framework, build tool, state manager, styling library, or directory layout. You MUST complete **Phase 1 (Repository & UI Discovery)** and align with the existing codebase before installing packages or writing components.

---

## Phase 1: Repository & UI Discovery (Mandatory First Step)

Before proposing code or modifying files, inspect the workspace and answer the following checklist:

1. **Runtime & Framework Detection:**
   - Check `package.json` (or workspace manifests) to identify the UI stack (e.g., React, Next.js, Vite, Vue, Svelte, Astro, or Vanilla HTML/JS).
   - Check if TypeScript (`.ts`/`.tsx`) or JavaScript (`.js`/`.jsx`) is used.
2. **Styling & Design System Audit:**
   - Identify how styles are authored (Tailwind CSS, CSS Modules, Styled Components, plain CSS, or UI libraries like shadcn/ui, Radix, MUI).
   - Extract the existing color tokens/variables (background surfaces, border colors, primary accents, monospace fonts) so the graph canvas matches the existing UI natively.
3. **Layout & Mount Point Identification:**
   - Locate where main views, panels, sidebars, or modals are mounted.
   - Determine how the graph canvas should coexist with existing panels (e.g., split-pane view, tab view, or full-bleed background canvas with floating HUD overlays).
4. **Data & Transport Layer Audit:**
   - Identify how the frontend currently communicates with the backend or MCP server (REST polling, WebSockets, Server-Sent Events (SSE), tRPC, or IPC).

**Deliverable for Phase 1:** Output a brief summary of the discovered UI stack and confirm the target file paths before proceeding to Phase 2.

---

## Phase 2: Dependency Installation

Install `cytoscape` and `cytoscape-dagre` using the lockfile's package manager (`npm`, `pnpm`, `yarn`, or `bun`) detected in Phase 1:

- **Core Packages:** `cytoscape`, `dagre`, `cytoscape-dagre`
- **Type Definitions (if TypeScript is detected):** `@types/cytoscape`, `@types/dagre`
- *(Fallback: If the existing UI is a zero-build static HTML setup, load the UMD bundles via `<script>` tags).*

---

## Phase 3: Data Contract & State Normalization

Create a transport-agnostic adapter layer that converts raw FalkorDB / MCP payloads into Cytoscape elements and sequential traversal steps. Do not tightly couple Cytoscape to raw database responses.

### 3.1 Graph Element Schema
```typescript
export type NodeStatus = 
  | 'PENDING' 
  | 'IN_PROGRESS' 
  | 'VERIFIED' 
  | 'BLOCKED' 
  | 'LEGACY' 
  | 'TARGET' 
  | 'SCC_CYCLE'
  | 'SIMULATED_BROKEN';

export interface GraphNodePayload {
  id: string;
  label: string;
  status: NodeStatus;
  parentClusterId?: string; // Used for Cytoscape Compound Nodes (SCC cycles / batches)
  metadata?: Record<string, unknown>;
}

export interface GraphEdgePayload {
  id: string;
  source: string;
  target: string;
  relationship: string; // e.g., ':IMPORTS', ':CALLS', ':USES_API'
  isCycleEdge?: boolean;
  state?: 'CLEAN' | 'BROKEN_CONTRACT' | 'VERIFIED';
}

export interface HopStep {
  hopIndex: number;
  nodeId: string;
  viaEdgeId?: string;
  relationship?: string;
  note?: string;
}

export interface TraversalEventPayload {
  toolName: string;
  cypherQuery: string;
  executionMs?: number;
  graphBranch: 'production' | 'shadow_simulation';
  hops: HopStep[];
}