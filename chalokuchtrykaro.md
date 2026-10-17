# `ui-refactor.md` — De-Neonizing & Elevating UI to Editorial Minimalist Craft

## 0. Core Objective
Transform the existing frontend from an AI-generated "neon/cyberpunk" aesthetic into a **human-crafted, editorial minimalist interface** inspired by **21st.dev, Linear, Mobbin, and Vercel Geist**. 

> **CRITICAL MANDATE — ZERO DESTRUCTIVE ASSUMPTIONS:**
> Do NOT break existing state hooks, event listeners, canvas mounts (e.g., Cytoscape.js), or data flows. You MUST complete **Phase 1 (Codebase Audit)** first so all visual refactoring is applied cleanly using the project's existing framework and styling setup.

---

## Phase 1: Codebase & Style Audit (Mandatory First Step)

Before editing any file, inspect the workspace and identify:
1. **Styling Engine:** Check whether styling is driven by Tailwind CSS, CSS variables (`index.css`/`globals.css`), CSS Modules, or inline styles.
2. **Theme Polarity:** Check if the app is currently Dark Mode, Light Mode, or supports both. (Apply the corresponding palette from Phase 3).
3. **"Vibe-Coded" Anti-Patterns to Locate & Purge:**
   - Search for and list all occurrences of heavy neon drop-shadows (`shadow-teal-500`, `shadow-[0_0_25px_...]`, glowing text shadows).
   - Search for saturated multi-color gradients (`bg-gradient-to-r from-teal-500 to-sky-500`, `border-cyan-400`).
   - Search for sci-fi jargon or decorative clutter (`// SYSTEM READY`, pulsing radar rings, excessive uppercase neon badges, emojis in button labels).

---

## Phase 2: The 5 Visual Pillars (What to Replace Neon With)

### Pillar 1: 98% Monochrome Neutrality, 2% Precision Accent
- **Eliminate global neon:** Never color entire button backgrounds, panel borders, or headers with bright cyan, teal, magenta, or lime.
- **Neutral Dominance:** 98% of the viewport must consist of neutral grayscale surfaces (off-white/alabaster in light mode; deep carbon/obsidian in dark mode).
- **Restrained Semantic Color:** Use color **strictly** as small `6px` status dots, subtle `1px` active node strokes, or muted pill text—never as glowing fills.

### Pillar 2: Structural Hairline Tables Over Floating Boxes
- Instead of stacking multiple floating cards with thick borders and gaps, organize sidebars and metadata into **clean, edge-to-edge hairline rows** (`1px solid` dividers between key-value pairs):
  - **Left-aligned muted label** (`Creator`, `Status`, `Latency`, `Out-Degree`)
  - **Right-aligned high-contrast value** (`tabular-nums`, crisp weight)

### Pillar 3: Tactile Pill Controls & Localized Micro-Shimmer
- **Primary CTAs & Toggles:** Use crisp `rounded-full` (pill) geometry or tight `rounded-lg` (`8px`) containers.
  - *In Dark Mode:* Deep neutral surface (`#0a0a0c`) with a `1px` subtle border (`rgba(255,255,255,0.14)`) and a localized, whisper-quiet border shimmer on hover—never a full neon fill.
  - *In Light Mode:* Solid near-black pill (`#0f0f11`) with crisp white text (`#ffffff`), or subtle warm gray (`#f4f4f5`) for secondary actions[cite: 2].
- **Segmented Controls:** Group view switchers (e.g., `Code | Preview` or `Graph | Diff`) inside a single recessed pill track with an elevated active thumb.

### Pillar 4: Subtle Dot-Matrix Canvas & Layered Depth
- **Canvas Background:** Use a barely perceptible architectural dot grid (`1px` dots spaced `20px–24px` apart at `4%–6%` opacity) rather than heavy sci-fi grid lines.
- **Modals & Floating Panels:** Use clean surface elevation (`1px` hairline border + soft ambient shadow `0 20px 40px -15px rgba(0,0,0,0.35)`) without colored glow[cite: 2, 3].

### Pillar 5: Editorial & Tabular Typography
- **Primary UI Font:** `Inter`, `Geist`, or `-apple-system` with tight tracking on headings (`letter-spacing: -0.02em`, `font-weight: 600`).
- **Code & Metrics Font:** `Geist Mono` or `JetBrains Mono`, strictly scoped to code diffs, file paths, Cypher queries, and numeric counters (`font-variant-numeric: tabular-nums`).
- **Copywriting Cleanup:** Rewrite robotic "cyberpunk" labels into calm, human product language (e.g., change `"SHIFT // NEURAL TELEMETRY HUD"` to `"Shift"` with a muted subtitle `"Dependency & Migration Graph"`).

---

## Phase 3: Exact Design Tokens to Apply

Inject or map these exact tokens into the project's stylesheet or Tailwind configuration:

### Option A: Carbon Dark Palette (21st.dev / Linear Style)[cite: 3]
```css
:root {
  --bg-canvas: #09090b;           /* Deep matte zinc */
  --bg-surface: #111113;          /* Primary panel surface */
  --bg-elevated: #18181b;         /* Hover / active card surface */
  --bg-glass: rgba(17, 17, 19, 0.82);

  --border-subtle: rgba(255, 255, 255, 0.07);
  --border-default: rgba(255, 255, 255, 0.12);
  --border-hover: rgba(255, 255, 255, 0.24);

  --text-primary: #fafafa;
  --text-secondary: #a1a1aa;
  --text-muted: #52525b;

  /* Restrained Semantic Accents (No Neon) */
  --status-verified: #10b981;     /* Muted Emerald */
  --status-pending: #f59e0b;      /* Warm Amber */
  --status-danger: #f43f5e;       /* Soft Rose */
  --status-active-hop: #e4e4e7;   /* Crisp White/Silver for active paths, or soft Indigo #818cf8 */
}