# `MASTER_UI_OVERHAUL.md` — End-to-End Frontend & Cytoscape Graph Overhaul Specification

## 0. Autonomous Agent Execution Mandate
You are tasked with executing a **complete, end-to-end visual and structural UI overhaul** of the **"Bagwan Kai Bandey" (Express-to-Fastify Topological Migration Governor)** frontend.

### Current Problems to Eliminate:
1. **Muddy Low-Contrast Dark Theme:** The current `#111`–`#18181b` dark gray palette with `#27272a` borders looks washed out, flat, and AI-generated.
2. **Illegible & Cramped Cytoscape Graph:** On the left canvas, graph nodes are zoomed too far out in a dark void. When non-active nodes are dimmed, their text becomes completely unreadable. Furthermore, the `Target Atomic Cycle (SCC)` red dashed compound box title collides with child nodes (`services/auditA.ts`, `services/auditB.ts`).
3. **Header Badge Clutter:** The top navbar has 8+ competing colored pills fighting for visual weight.
4. **Blocky Wireframe Sidebar & Modal:** The right-hand `Topological Hops` cards and the final `Codebase Migration Verified` modal overuse raw monospace fonts and harsh terminal boxes instead of looking like a high-craft engineering product.

### Target Aesthetic:
Transform the entire interface into a **High-Definition, Editorial Minimalist White & Alabaster UI** inspired by **Vercel Geist Light, Linear Light Mode, Mobbin, and 21st.dev**—featuring crisp `#FFFFFF` elevated surfaces, warm `#F7F7F5` stone/alabaster backgrounds, `1px` structural hairline dividers, tactile pill controls (`rounded-full`), tabular typography, and razor-sharp Cytoscape node cards.

> **CRITICAL NON-BREAKING INVARIANT:**
> You MUST preserve 100% of existing state logic, SSE/WebSocket event streams, stepper controls (`Stop`, `Pause`, `Step`, `Replay Hops`, `Reset`), tabs (`Topological Hops`, `Code Changes`), node click handlers, and the completion modal (`Codebase Migration Verified`). Only refactor styles, DOM structure/classes, and Cytoscape visual configuration.

---

## Phase 1: Codebase Discovery & Audit (Execute First)

Before editing any file, inspect the workspace to map out:
1. **Frontend Stack & Entrypoints:** Locate the main layout, header component, Cytoscape graph component, right inspector panel, completion modal, and global CSS/Tailwind config.
2. **Purge List:** Locate every hardcoded dark surface class (`bg-zinc-950`, `bg-slate-900`, `bg-neutral-900`, `#09090b`, `#111`, etc.), neon shadow, and low-contrast dark border so not a single orphaned dark panel remains.

---

## Phase 2: Global Design Tokens & Typography (`index.css` / `globals.css`)

Inject these exact CSS custom properties and base resets into the global stylesheet:

```css
@import url('[https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap](https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap)');

:root {
  /* Core Surfaces (Editorial Alabaster & Pure White) */
  --bg-canvas: #F7F7F5;              /* Warm architectural stone for Graph Canvas & App Background */
  --bg-surface: #FFFFFF;             /* Pure crisp white for Header, Right Sidebar, Cards, Modals */
  --bg-subtle: #F1F1EF;              /* Recessed pill tracks, table headers, subtle row hovers */
  --bg-elevated: #FAFAFA;            /* Secondary card surface */
  --bg-glass: rgba(255, 255, 255, 0.90); /* Floating HUD docks over graph canvas */

  /* Hairline Borders */
  --border-hairline: #E6E6E3;        /* 1px solid structural layout dividers */
  --border-card: #DCDCD8;            /* Crisp card & node border */
  --border-strong: #09090B;          /* High-contrast obsidian border for active focus */

  /* Typography Colors */
  --text-primary: #09090B;           /* Pitch black for titles, filenames, primary metrics */
  --text-secondary: #52525B;         /* Neutral slate for structural labels (Layer, Role, Status) */
  --text-muted: #8E8E93;             /* Muted metadata & captions */

  /* Semantic Status Tokens (High-Definition on White) */
  --status-verified-bg: #ECFDF5;
  --status-verified-border: #10B981;
  --status-verified-text: #047857;

  --status-claimed-bg: #09090B;      /* Pure Obsidian Black for active/claimed focal contrast */
  --status-claimed-border: #09090B;
  --status-claimed-text: #FFFFFF;

  --status-pending-bg: #FFFBEB;
  --status-pending-border: #F59E0B;
  --status-pending-text: #B45309;

  --status-cycle-bg: #FFF1F2;
  --status-cycle-border: #F43F5E;
  --status-cycle-text: #BE123C;

  /* Tactile Shadows */
  --shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.03);
  --shadow-card: 0 2px 5px -1px rgba(0, 0, 0, 0.05), 0 1px 3px -1px rgba(0, 0, 0, 0.03);
  --shadow-floating: 0 12px 32px -4px rgba(0, 0, 0, 0.08), 0 4px 12px -2px rgba(0, 0, 0, 0.04);
  --shadow-modal: 0 24px 48px -12px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.06);
}

body {
  background-color: var(--bg-canvas);
  color: var(--text-primary);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  -webkit-font-smoothing: antialiased;
  letter-spacing: -0.011em;
}

code, pre, .font-mono {
  font-family: 'JetBrains Mono', monospace;
  font-variant-numeric: tabular-nums;
}
Phase 3: Top Navigation Bar Overhaul
Refactor the top header (height: 56px, bg-[#FFFFFF], border-b border-[#E6E6E3], px-5 flex items-center justify-between):

Left Section (Identity & Clean Breadcrumb):

Brand: Crisp geometric icon + Bagwan Kai Bandey in #09090B (font-semibold text-[15px] tracking-tight).

Repo Breadcrumb: Separate with a subtle / divider: demo-repo / express-to-fastify in #52525B (text-xs font-mono).

Single Consolidated Metadata Pill: Instead of 3 separate noisy badges (FalkorDB, TYPESCRIPT, 10-file-branch), render sleek subtle pills:

bg-[#F1F1EF] text-[#52525B] border border-[#E6E6E3] rounded-md px-2 py-0.5 text-[11px] font-medium for TypeScript • 10-file-branch.

Center Section (High-Craft Progress Module):

Display X / 9 Verified (font-semibold text-xs text-[#09090B] tabular-nums) + percentage (text-[#52525B]).

Render a clean 110px progress bar track (h-2 bg-[#F1F1EF] rounded-full overflow-hidden border border-[#E6E6E3]) with a smooth #10B981 emerald fill.

Render the currently claimed file inside a crisp contrast badge: bg-zinc-100 text-zinc-900 border border-zinc-300 rounded-md px-2 py-0.5 text-[11px] font-mono.

Right Section (Tactile Pill Controls):

Style Stop, Pause, and Reset as refined pill buttons:
rounded-full px-3.5 py-1.5 text-xs font-medium bg-white text-[#09090B] border border-[#DCDCD8] hover:bg-[#F7F7F5] shadow-[var(--shadow-xs)] transition-all.

Style CLI Sync Live as an editorial status pill:
rounded-full px-3 py-1 text-xs font-medium bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0] flex items-center gap-1.5 with a 6px pulsing #10B981 dot.

Phase 4: Cytoscape.js Dependency Graph Overhaul (Left Panel)
Refactor the Cytoscape canvas container and stylesheet so the graph is large, sharp, high-contrast, and 100% readable at all times:

4.1 Architectural Dot-Grid Canvas Surface
Apply this background to the left graph wrapper:

CSS
background-color: #F7F7F5;
background-image: radial-gradient(#D4D4D0 1.25px, transparent 1.25px);
background-size: 20px 20px;
Top Overlay Bar inside Canvas:

Left: Dependency Graph title (text-xs font-semibold uppercase tracking-wider text-[#52525B] bg-white/90 backdrop-blur px-3 py-1.5 rounded-lg border border-[#E6E6E3] shadow-sm).

Right: Click node to inspect details & blast radius + FalkorDB: XX.X ms inside a matching crisp white floating pill (text-xs text-[#52525B] font-mono bg-white/90 backdrop-blur px-3 py-1.5 rounded-lg border border-[#E6E6E3] shadow-sm).
4.2 High-Definition Cytoscape Style Rules
Replace the Cytoscape style array with these exact high-contrast light-mode specifications:
const cytoscapeStyles = [
  // 1. Base Module Node (Crisp White Hardware Chip)
  {
    selector: 'node',
    style: {
      'shape': 'round-rectangle',
      'width': 195,
      'height': 52,
      'background-color': '#FFFFFF',
      'border-width': 1.5,
      'border-color': '#D4D4D8',
      'label': 'data(label)',
      'text-wrap': 'wrap',
      'text-max-width': 175,
      'text-valign': 'center',
      'text-halign': 'center',
      'color': '#09090B',
      'font-family': 'JetBrains Mono, monospace',
      'font-size': 11.5,
      'font-weight': 600,
      'transition-property': 'background-color, border-color, border-width, opacity',
      'transition-duration': '220ms'
    }
  },

  // 2. Pending Node State
  {
    selector: 'node[status="PENDING"], node.pending',
    style: {
      'background-color': '#FFFFFF',
      'border-color': '#D4D4D8',
      'color': '#09090B'
    }
  },

  // 3. Active / Claimed / Hop-Active Node (Pure Black Pill with Crisp White Text)
  {
    selector: 'node[status="CLAIMED"], node.claimed, node.hop-active, node:selected',
    style: {
      'background-color': '#09090B',
      'border-color': '#09090B',
      'border-width': 2.5,
      'color': '#FFFFFF',
      'z-index': 999
    }
  },

  // 4. Verified Node State (Rich Emerald Tint)
  {
    selector: 'node[status="VERIFIED"], node.verified',
    style: {
      'background-color': '#ECFDF5',
      'border-color': '#10B981',
      'border-width': 2,
      'color': '#065F46'
    }
  },

  // 5. Atomic Cycle Member Node (Soft Rose Tint)
  {
    selector: 'node[status="CYCLE"], node.cycle',
    style: {
      'background-color': '#FFF1F2',
      'border-color': '#F43F5E',
      'border-width': 2,
      'color': '#9F1239'
    }
  },

  // 6. SCC Compound Parent Box (Fix Label Overlap!)
  {
    selector: ':parent, node.cluster, node.scc-cluster',
    style: {
      'shape': 'round-rectangle',
      'background-color': 'rgba(244, 63, 94, 0.04)',
      'border-color': '#F43F5E',
      'border-width': 1.5,
      'border-style': 'dashed',
      'padding': 34,
      'label': 'data(label)',
      'text-valign': 'top',
      'text-halign': 'center',
      'text-margin-y': -10,
      'font-family': 'Inter, sans-serif',
      'font-size': 11,
      'font-weight': 600,
      'color': '#E11D48'
    }
  },

  // 7. Base Directed Edges
  {
    selector: 'edge',
    style: {
      'width': 1.75,
      'curve-style': 'bezier',
      'line-color': '#A1A1AA',
      'target-arrow-color': '#A1A1AA',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.9,
      'font-family': 'JetBrains Mono, monospace',
      'font-size': 9.5,
      'color': '#52525B',
      'text-background-opacity': 1,
      'text-background-color': '#F7F7F5',
      'text-background-padding': 3,
      'transition-property': 'line-color, width, opacity',
      'transition-duration': '220ms'
    }
  },

  // 8. Active Hop Traversal Edge
  {
    selector: 'edge.hop-active, edge.active',
    style: {
      'width': 3,
      'line-color': '#09090B',
      'target-arrow-color': '#09090B',
      'line-style': 'dashed',
      'line-dash-pattern': [7, 4],
      'color': '#09090B',
      'font-weight': 700,
      'z-index': 999
    }
  },

  // 9. SCC Cycle Edge
  {
    selector: 'edge.cycle-edge',
    style: {
      'width': 2.2,
      'line-color': '#F43F5E',
      'target-arrow-color': '#F43F5E',
      'line-style': 'dashed'
    }
  },

  // 10. Dimmed Non-Active Elements (Keep 100% Legible at 0.48 Opacity!)
  {
    selector: '.dimmed',
    style: {
      'opacity': 0.48
    }
  }
];
4.3 Layout Sizing & Viewport Fit Fix
In the dagre layout config, set:
rankDir: 'TB', nodeSep: 60, rankSep: 78, padding: 45.

Ensure cy.fit(undefined, 45) is called after layout so the dependency tree fills 75%–85% of the left canvas cleanly and never renders as a tiny shrunken island.

4.4 Floating Bottom Legend & Filter Pill Bar
Replace the dark bottom status bar inside the left panel with an elevated floating pill dock (absolute bottom-4 left-4 right-4 bg-white/95 backdrop-blur-md border border-[#E6E6E3] rounded-full px-4 py-2 shadow-[var(--shadow-floating)] flex items-center justify-between):

Left side: Crisp status dot indicators (Pending, Claimed, Verified, Clean, 2-Node Cycle) in #09090B and #52525B text (text-xs font-medium).

Right side: Clean pill buttons for Controls & Filters and openCypher (bg-[#F7F7F5] hover:bg-[#E6E6E3] text-[#09090B] border border-[#DCDCD8] rounded-full px-3 py-1 text-xs font-medium).

Phase 5: Right Inspector Panel Overhaul (bg-white border-l border-[#E6E6E3])
Redesign the entire right sidebar to match Linear / Mobbin / 21st.dev card precision:

5.1 Active Target Header Bar
Container: p-4 border-b border-[#E6E6E3] bg-white.

Top Row:

Left: Module status label (Target: or Verified:) in #52525B + filename (middleware/auth.ts) in 15px bold #09090B font-mono.

Right Action Group:

Replay Hops button: Clean secondary pill (rounded-full px-3.5 py-1.5 text-xs font-medium bg-[#F1F1EF] text-[#09090B] hover:bg-[#E6E6E3] transition).

Step button: High-contrast Primary Obsidian Pill (rounded-full px-4 py-1.5 text-xs font-semibold bg-[#09090B] text-white hover:bg-zinc-800 shadow-sm transition).

SHIM / MIGRATE / VERIFIED status badge: Semantic pill (rounded-md px-2.5 py-1 text-[11px] font-semibold).

Verification SLA Strip (TypeScript PASS, Unit Tests 8/8, HTTP Routes 100%, Graph SLA 0):

Render inside a sleek recessed strip (mt-3 px-3 py-2 rounded-lg bg-[#F7F7F5] border border-[#E6E6E3] flex items-center justify-between text-[11px]).

Render PASS, 8/8, and 100% in #047857 bold emerald text.

5.2 Segmented Control Tabs (Topological Hops | Code Changes)
Container: mx-4 mt-3 p-1 rounded-lg bg-[#F1F1EF] border border-[#E6E6E3] grid grid-cols-2 gap-1.

Active Tab: bg-white text-[#09090B] font-semibold text-xs py-1.5 rounded-md shadow-[var(--shadow-xs)] text-center.

Inactive Tab: text-[#52525B] hover:text-[#09090B] font-medium text-xs py-1.5 rounded-md text-center.

5.3 Editorial Hop Cards (01, 02, 03...) & Empty State
Onboarding / Empty State (Topological Migration Stepper):

Style as a clean white editorial card (bg-white border border-[#E6E6E3] rounded-xl p-5 shadow-[var(--shadow-card)]).

Feature cards (Leaves First, Atomic Cycles, 100% Gate Verification) use bg-[#F7F7F5] border border-[#E6E6E3] rounded-lg p-3.5 with #09090B bold titles and #52525B descriptions.

Active Hop Step Cards (01 routes/orders.ts, 02 middleware/auth.ts, etc.):

Wrap each card in bg-white border border-[#DCDCD8] rounded-xl p-4 shadow-[var(--shadow-card)] mb-3 transition-all hover:border-zinc-400.

Card Header (pb-2.5 mb-2.5 border-b border-[#E6E6E3] flex items-center justify-between):

Left: Step index pill (01, 02) in bg-[#F1F1EF] text-[#09090B] font-mono text-xs font-semibold px-2 py-0.5 rounded + File path in font-mono text-sm font-bold text-[#09090B].

Right: Role/Action badge (Auth Middleware, SHIM, MIGRATE, SC_SHIM) in a clean semantic pill (bg-amber-50 text-amber-800 border border-amber-200 or bg-zinc-100 text-zinc-700 border border-zinc-200 rounded px-2 py-0.5 text-[11px] font-medium).

Card Metadata Rows (Mobbin-Style Hairline Key-Value List):

Render Layer, Role, and Status as clean horizontal rows (py-1.5 flex items-center justify-between text-xs border-b border-zinc-100 last:border-0):

Left Label (Layer, Role, Status): Normal Sans-Serif (Inter), #52525B, font-medium (remove ugly all-caps monospace).

Right Value (Security Middleware, Root Caller, 0 Outgoing Blockers (Ready)): Crisp #09090B font-medium (with 0 Outgoing Blockers (Ready) highlighted in #B45309 amber or #047857 emerald).

5.4 Code Changes Diff Tab
Ensure the diff viewer inside Code Changes renders on a clean #FFFFFF or #FAFAFA surface with #E6E6E3 borders:

Added lines (+): bg-[#ECFDF5] text-[#065F46] border-l-2 border-[#10B981].

Removed lines (-): bg-[#FFF1F2] text-[#9F1239] border-l-2 border-[#F43F5E].

Phase 6: "Codebase Migration Verified" Completion Modal Overhaul
Redesign the final verification modal overlay (9 / 9 Migrated 100%) into an executive-grade report card:

Backdrop: fixed inset-0 bg-zinc-950/30 backdrop-blur-sm flex items-center justify-center z-50.

Modal Card: bg-white border border-[#DCDCD8] rounded-2xl p-8 max-w-2xl w-full shadow-[var(--shadow-modal)].

Header:

Centered #ECFDF5 circle (w-12 h-12 rounded-full border border-[#A7F3D0] flex items-center justify-center text-[#059669] mx-auto mb-3).

Title: Codebase Migration Verified (text-xl font-bold text-[#09090B] tracking-tight text-center).

Subtitle: 100% Graph-Governed Express-to-Fastify transformation verified. All verification gates intact across 11 intermediate commits. (text-xs text-[#52525B] text-center mt-1 mb-6).

4-Column KPI Grid (9 / 9 Files Migrated, 0 Broken Contracts, 0 Lines Unverified, 1.4 ms Avg FalkorDB SLA):

grid grid-cols-4 gap-3 mb-6

Each KPI card: bg-[#F7F7F5] border border-[#E6E6E3] rounded-xl p-3.5 text-center.

Metric value: text-xl font-bold text-[#09090B] font-mono tabular-nums.

Metric label: text-[11px] font-medium text-[#52525B] mt-0.5.

Architectural Evaluation Table (Bagwan Kai Bandey vs Naive LLM Drop Agent):

Wrap inside border border-[#E6E6E3] rounded-xl overflow-hidden mb-6.

Table Header: bg-[#F7F7F5] border-b border-[#E6E6E3] text-[11px] font-semibold uppercase tracking-wider text-[#52525B] px-4 py-2.5.

Table Rows: border-b border-[#E6E6E3] last:border-0 px-4 py-3 text-xs bg-white.

Metric Column: font-semibold text-[#09090B].

Naive LLM Column: Render inside soft rose badges (inline-block bg-[#FFF1F2] text-[#BE123C] border border-[#FECDD3] rounded-md px-2 py-0.5 font-medium text-[11px]).

Bagwan Kai Bandey (FalkorDB) Column: Render inside crisp emerald badges (inline-block bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0] rounded-md px-2 py-0.5 font-semibold text-[11px]).

Modal Footer CTAs:

Export Audit Trail (JSON): rounded-full px-5 py-2 text-xs font-semibold bg-white text-[#09090B] border border-[#DCDCD8] hover:bg-[#F7F7F5] shadow-sm transition.

View Clean Topology: rounded-full px-5 py-2 text-xs font-semibold bg-[#09090B] text-white hover:bg-zinc-800 shadow-sm transition.

Phase 7: Final Verification & QA Checklist
Before concluding execution, verify every item below:

[ ] The project builds/compiles with zero TypeScript or CSS errors.

[ ] Not a single dark #09090b / #18181b panel remains; the entire app is unified under the High-Definition Alabaster (#F7F7F5) & Crisp White (#FFFFFF) theme.

[ ] Cytoscape graph nodes are sized at 195x52, crisp white with dark #09090B text, and active/claimed nodes invert to solid #09090B black with #FFFFFF white text.

[ ] Dimmed Cytoscape nodes remain readable at 0.48 opacity.

[ ] The Target Atomic Cycle (SCC) compound box label sits cleanly above the dashed border (text-margin-y: -10) with zero node overlap.

[ ] All interactive flows (Step, Replay Hops, Pause, Reset, node inspection, and the final Codebase Migration Verified modal) operate smoothly.