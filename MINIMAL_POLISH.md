# `MINIMAL_POLISH.md` — True Minimalism, De-Cluttering & Micro-Layout Polish

## 0. Objective
The light theme is in place, but the UI currently suffers from **button bloat, text wrapping, clipped scrollbars, and redundant labels**[cite: 5]. True minimalism (Linear / Vercel Geist / Raycast) requires **reducing visual elements, consolidating controls, and perfecting spatial alignment**.

> **NON-BREAKING RULE:** Preserve all state hooks, Cytoscape graph interactions, stepper logic, and modals. Strictly refine DOM structure, layout density, button hierarchy, and Cytoscape node/cluster aesthetics.

---

## Phase 1: Consolidate Controls & Fix the Top Header (`52px` Height)

Right now, the top bar and right sidebar have too many competing buttons (`Stop`, `Pause`, `Reset`, `Replay Hops`, `+ Step`) and redundant badges (`Claimed: response.ts` appears in both the header and the sidebar)[cite: 5].

1. **Left Breadcrumb Cleanup:**
   - Keep ONLY: `[Icon] Bagwan Kai Bandey` `/` `express-to-fastify` and a single subtle text badge `TypeScript` (`text-xs text-zinc-400 font-medium`).
   - **Remove** the `demo-repo` box and the `typescript • 10-file-branch` pill box[cite: 5]—plain typographic hierarchy is cleaner than boxing every word.
2. **Center Progress Indicator (Remove Duplicate Target Pill):**
   - **Delete** the `Claimed: ...` / `Verified: ...` grey box from the top header[cite: 5] (it is already shown in the right sidebar header and causes layout jitter when long filenames like `auditA.ts, services/auditA.ts` are claimed[cite: 5]).
   - Keep only a sleek, minimal progress indicator: `2 of 9 verified` (`text-xs font-medium text-zinc-600 tabular-nums`) + a slim `80px` progress bar (`h-1.5 bg-zinc-200 rounded-full` with `#10B981` fill) + `22%` (`text-xs text-zinc-400 tabular-nums`).
3. **Right Header Controls (De-Emphasize Secondary Actions):**
   - `Stop` MUST NOT be a solid black primary pill[cite: 5]—solid black is reserved strictly for `+ Step` in the inspector!
   - Render `Pause`, `Stop`, and `Reset` as whisper-quiet **ghost/icon-first controls** (`h-7 px-2.5 rounded-md text-xs font-medium text-zinc-600 hover:text-zinc-950 hover:bg-zinc-100 transition flex items-center gap-1.5 border border-transparent hover:border-zinc-200`).
   - Keep `CLI Sync` as a minimal dot + label (`text-xs text-emerald-700 font-medium flex items-center gap-1.5 px-2`) without a heavy border.

---

## Phase 2: Fix Right Inspector Header, Button Wrapping & SLA Scrollbar

In the right sidebar (`width: 420px` to `440px`, `bg-white border-l border-[#E6E6E3]`):

### 2.1 Fix Multi-Filename Header Cramping & `Replay Hops` Text Wrapping
Currently, `Replay Hops` wraps onto two lines (`Replay \n Hops`) and long target names (`auditA.ts, services/auditA.ts, auditB.ts`) crush the layout[cite: 5].
- **Use a Clean 2-Row Header Structure (`p-4 border-b border-[#E6E6E3]`):**
  - **Row 1 (Status + Action Buttons):**
    - Left: Small semantic eyebrow label (`TARGET MODULE` or `VERIFIED MODULE` in `text-[10px] font-semibold uppercase tracking-wider text-zinc-400`) + compact status pill (`SHIM`, `MIGRATE`, `VERIFIED` in `text-[10px] font-semibold px-2 py-0.5 rounded bg-zinc-100 text-zinc-700`).
    - Right: Action Button Group (`flex items-center gap-2 shrink-0`):
      - **`Replay` Button:** Shorten label from `"Replay Hops"` to **`"Replay"`** (with a small replay/rotate icon) and add `whitespace-nowrap` (`h-8 px-3 rounded-lg text-xs font-medium bg-zinc-100 text-zinc-700 hover:bg-zinc-200 flex items-center gap-1.5 whitespace-nowrap shrink-0`).
      - **`Step` Button (The ONLY Solid Black Primary CTA on Screen):** `h-8 px-4 rounded-lg text-xs font-semibold bg-[#09090B] text-white hover:bg-zinc-800 shadow-sm flex items-center gap-1.5 whitespace-nowrap shrink-0`.
  - **Row 2 (Filename Title):**
    - Render the target filename (`utils/response.ts` or `services/auditA.ts ⇄ services/auditB.ts`) on its own dedicated line below Row 1 with `font-mono text-sm font-semibold text-[#09090B] truncate` (`title={fullTargetName}`) so it **never** wraps into multiple lines or pushes buttons off-screen!

### 2.2 Eliminate the Horizontal Scrollbar on the Verification SLA Bar
Currently, `TypeScript PASS • Unit Tests 6/6 • HTTP Routes 100% • Graph SLA...` overflows horizontally and renders an ugly browser scrollbar[cite: 5].
- **Fix:** Replace the overflowing flex strip with a **non-scrolling, compact 4-pill row** (`px-4 py-2 bg-[#FAFAFA] border-b border-[#E6E6E3] grid grid-cols-4 gap-1 text-[11px] overflow-hidden`):
  - Column 1: `TS` **`PASS`** (emerald dot/text)
  - Column 2: `Tests` **`6/6`**
  - Column 3: `Routes` **`100%`**
  - Column 4: `SLA` **`1.5ms`**
- Never allow `overflow-x: auto` or scrollbars on telemetry bars.

---

## Phase 3: Ultra-Minimalist Hop Cards (Eliminate Boxy Table Bloat)

In the `Topological Hops` tab, the current cards (`01 middleware/auth.ts`, `02 utils/response.ts`) look too tall and boxy because each card renders a 3-row table (`Layer`, `Role`, `Status`)[cite: 5].

Refactor each Hop Card into a **sleek, compact Linear-style row card** (`rounded-xl border border-[#E6E6E3] bg-white p-3.5 mb-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.02)] hover:border-zinc-300 transition-all`):

1. **Top Line (`flex items-center justify-between gap-2`):**
   - Left: Step badge (`01` in `font-mono text-[11px] text-zinc-400 font-medium`) + Filename (`middleware/auth.ts` in `font-mono text-[13px] font-semibold text-zinc-900`).
   - Right: Single clean pill (`SHIM` in `bg-amber-50 text-amber-700 border border-amber-200/80 text-[10px] font-semibold px-2 py-0.5 rounded` OR `Verified` in `bg-emerald-50 text-emerald-700 border border-emerald-200/80 text-[10px] font-semibold px-2 py-0.5 rounded`).
2. **Bottom Line (Single-Line Metadata Breadcrumb instead of a 3-Row Table!):**
   - Replace the 3 separate `Layer` / `Role` / `Status` table rows[cite: 5] with a **single, quiet subtitle row** (`mt-2 pt-2 border-t border-zinc-100 flex items-center justify-between text-xs text-zinc-500`):
     - Left: `{layer} • {role}` (e.g., `Security Middleware • Root Caller` in `text-zinc-500`).
     - Right: `{status}` (e.g., `0 Blockers` in `text-emerald-600 font-medium` or `Verified` in `text-zinc-500`).
   - *Result:* Card height drops by 45%, visual noise disappears, and 4–5 hops fit comfortably on screen without scrolling!

---

## Phase 4: Clean Up the Onboarding Empty State (`Topological Migration Stepper`)

When no hops are active (at `0:00` in the video), the right panel shows a centered icon and 3 boxed cards (`1 Leaves First`, `2 Atomic Cycles`, `3 100% Gate Verification`)[cite: 5].
- Make this much quieter and more editorial:
  - Left-align the heading (`Topological Migration Stepper`, `text-sm font-semibold text-zinc-900`) and description (`text-xs text-zinc-500 leading-relaxed`).
  - Instead of 3 heavy gray-bordered boxes, render items `1`, `2`, and `3` as a clean vertical list separated by `1px` hairlines (`divide-y divide-zinc-100`) with subtle numbered circles (`w-5 h-5 rounded-full bg-zinc-100 text-zinc-600 text-[11px] font-mono flex items-center justify-center shrink-0`).

---

## Phase 5: De-Clutter the Cytoscape Canvas HUD & Fix the Pink SCC Box

### 5.1 Remove Floating Top Pill Clutter on the Graph Canvas
Currently, the top of the graph has two floating white boxes: `DEPENDENCY GRAPH` on the left, and `Click node to inspect details & blast radius | FalkorDB: 1.5 ms` on the right[cite: 5].
- **Delete** the instructional text `"Click node to inspect details & blast radius"`[cite: 5] completely—it looks like tutorial clutter.
- Merge the top-left overlay into a single ultra-clean floating badge (`top-3 left-3 bg-white/85 backdrop-blur border border-zinc-200/80 rounded-lg px-2.5 py-1 text-[11px] font-medium text-zinc-500 flex items-center gap-2 shadow-sm`):
  `Dependency Graph` `•` `<span class="font-mono text-zinc-700">1.5 ms</span>`

### 5.2 Slim Down the Bottom Floating Dock
Currently, the bottom dock stretches across the entire canvas with bulky text (`Pending (7) • Claimed (1) • Verified (0) • Clean (2) • 2-Node Cycle`)[cite: 5].
- Make it a **compact, centered floating dock** (`bottom-4 left-1/2 -translate-x-1/2 w-auto max-w-[92%] bg-white/90 backdrop-blur-md border border-zinc-200/90 rounded-full px-3.5 py-1.5 shadow-lg flex items-center gap-4 text-[11px] whitespace-nowrap`):
  - Legend items: Use compact counts without parentheses (`● 7 Pending`, `● 1 Active`, `● 2 Verified`, `◌ 1 Cycle`).
  - Vertical divider: `h-3.5 w-[1px] bg-zinc-200`.
  - Action triggers (`Filters`, `Cypher`): Render as clean subtle pills (`px-2.5 py-0.5 rounded-full text-zinc-600 hover:text-zinc-950 hover:bg-zinc-100 font-medium transition`).

### 5.3 Fix the Heavy Pink `2-Node Cycle` Compound Box in Cytoscape
In the video, the `Target Atomic Cycle (SCC)` compound box around `services/auditA.ts` and `services/auditB.ts` has a heavy pink background (`rgba(244,63,94,0.18)`) and its label touches the top border/arrow[cite: 5].
- Update the `:parent` / `node.cluster` style in Cytoscape:
  - `'background-color': '#FFF1F2'` with `'background-opacity': 0.45` (soft, airy rose tint instead of muddy pink).
  - `'border-color': '#FDA4AF'`, `'border-width': 1.5`, `'border-style': 'dashed'`.
  - `'padding': 28`.
  - `'text-valign': 'bottom'`, `'text-halign': 'center'`, `'text-margin-y': 8` — **Move the cluster label (`Atomic Cycle (SCC)`) to the BOTTOM of the dashed box (`text-valign: 'bottom'`, `text-margin-y: 8`)!** Putting the label below the box completely prevents it from ever colliding with the incoming top dependency arrows from `routes/orders.ts` and `routes/users.ts`[cite: 5]!
- Update child cycle nodes (`services/auditA.ts`, `services/auditB.ts`):
  - Keep their fill crisp white (`#FFFFFF`) with a refined rose border (`#F43F5E`, `1.5px`) and dark `#881337` text so they look sharp rather than washed out in pink[cite: 5].

---

## Phase 6: Final QA & Polish Verification
- [ ] `Replay` button text never wraps onto two lines (`whitespace-nowrap`)[cite: 5].
- [ ] Long multi-file target names (`auditA.ts, services/auditA.ts...`) truncate cleanly on their own line without crushing header buttons[cite: 5].
- [ ] Zero horizontal scrollbars appear inside the Right Inspector SLA strip[cite: 5].
- [ ] `+ Step` is the only solid black primary CTA button on screen; header `Stop`/`Pause`/`Reset` are subtle secondary ghost/outline buttons[cite: 5].
- [ ] Hop cards use the compact 2-line layout (Filename + badge on top, `{layer} • {role}` + `{status}` on bottom) instead of a 3-row table[cite: 5].
- [ ] The Cytoscape `Atomic Cycle (SCC)` label is positioned cleanly at the bottom of the compound box (`text-valign: 'bottom'`) so it never overlaps incoming top edges[cite: 5].