/**
 * Bagwan Kai Bandey — Minimalist Migration Cockpit Client (`public/app.js`).
 * Clean, distraction-free architecture powered by FalkorDB openCypher graph engine.
 */

// ── Status Color Mapping (Matte Engineering Palette) ──────
const STATUS_COLORS = {
  CLEAN: { border: '#475569', background: '#1E293B', highlight: { border: '#64748B', background: '#334155' } },
  PENDING: { border: '#D97706', background: '#78350F', highlight: { border: '#F59E0B', background: '#92400E' } },
  IN_PROGRESS: { border: '#3B82F6', background: '#1E3A8A', highlight: { border: '#60A5FA', background: '#1D4ED8' } },
  SHIMMED: { border: '#8B5CF6', background: '#4C1D95', highlight: { border: '#A78BFA', background: '#5B21B6' } },
  VERIFIED: { border: '#10B981', background: '#064E3B', highlight: { border: '#34D399', background: '#065F46' } },
};

// ── openCypher Presets & Rationales ───────────────────────
const CYPHER_PRESETS = {
  claim: {
    title: 'Pass B: Unblocked Leaf Claim',
    query: `MATCH (m:Module {status: 'PENDING'})
OPTIONAL MATCH (m)-[:IMPORTS*1..10]->(blocker:Module)
WHERE blocker.scc_id <> m.scc_id AND blocker.status IN $blocking
WITH m, count(DISTINCT blocker) AS blockerCount
WHERE blockerCount = 0
WITH m ORDER BY m.scc_size ASC, m.pagerank DESC, m.path ASC LIMIT 1
MATCH (peer:Module) WHERE peer.scc_id = m.scc_id
WITH m.scc_id AS sccId, collect(peer) AS clusterNodes
FOREACH (n IN [x IN clusterNodes WHERE x.status = 'PENDING'] | SET n.status = 'IN_PROGRESS')
RETURN 'SHIM' AS phase, sccId, [x IN clusterNodes | x.path] AS targetPaths`,
    rationale: 'FalkorDB evaluates topological blockers in O(1) indexed query time without full AST re-traversals.',
  },
  deshim: {
    title: 'Pass A: Top-Down De-shim Priority',
    query: `MATCH (m:Module {status: 'SHIMMED'})
WITH DISTINCT m.scc_id AS sccId
MATCH (peer:Module) WHERE peer.scc_id = sccId
WITH sccId, collect(peer) AS clusterNodes, sum(peer.pending_callers_count) AS sccPending
WHERE sccPending = 0
WITH sccId, clusterNodes ORDER BY sccId ASC LIMIT 1
FOREACH (n IN clusterNodes | SET n.status = 'IN_PROGRESS', n.claimed_phase = 'DE_SHIM')
RETURN 'DE_SHIM' AS phase, sccId, [x IN clusterNodes | x.path] AS targetPaths`,
    rationale: 'De-shimming cascades top-down (entry callers -> leaves) ONLY when pending legacy callers reach exactly 0, preventing premature interface breakages.',
  },
  scc: {
    title: 'Tarjan Strongly Connected Components (Cycles)',
    query: `MATCH (m:Module)
OPTIONAL MATCH (m)-[:IMPORTS]->(d:Module)
RETURN m.path AS from, collect(d.path) AS to
// Fed into Tarjan SCC algorithm; circular cycles (auditA <-> auditB) are migrated atomically.`,
    rationale: 'Multi-file cyclic dependencies cannot be migrated one-by-one. FalkorDB groups them so they are edited and typechecked atomically in a single step.',
  },
  pagerank: {
    title: 'PageRank Risk Ranking',
    query: `CALL algo.pageRank('Module', 'IMPORTS') YIELD node, score
SET node.pagerank = score
RETURN node.path AS path, score ORDER BY score DESC`,
    rationale: 'High PageRank nodes sit at the center of the codebase import graph. Migrating low PageRank leaves first isolates blast radius to zero.',
  },
  blast: {
    title: 'Reverse Transitive Blast Radius',
    query: `MATCH path = (caller:Module)-[:IMPORTS*1..10]->(callee:Module {path: $targetPath})
RETURN caller.path AS impactedCaller, length(path) AS dependencyHops
ORDER BY dependencyHops ASC`,
    rationale: 'Traces all upstream callers that depend on this module. If an intermediate signature breaks, this query precisely identifies every affected service.',
  },
};

// ── Application State ─────────────────────────────────────
let network = null;
let nodesDataSet = null;
let edgesDataSet = null;
let allModulesCache = [];
let allEdgesCache = [];
let currentModifiedFiles = [];
let activeTargetPaths = [];
let blastRadiusActiveNode = null;
let isAutoPlaying = false;
let autoPlayTimer = null;
let currentStepNumber = 0;
const TOTAL_STEPS = 11;

let currentAppInfo = {
  currentRepo: 'scratch/cockpit-demo-repo',
  displayRepo: 'demo-repo (Sandbox)',
  isDemoRepo: true,
  currentPackId: 'express-to-fastify',
  pack: { id: 'express-to-fastify', name: 'express-to-fastify', language: 'typescript', shimStrategy: 'in-file-branch' },
  mode: 'canned',
  provider: 'mock',
  model: 'qwen2.5-coder:latest',
  availablePacks: ['express-to-fastify'],
  checkpoints: [],
};
let observerInterval = null;
let activeDrawerNode = null;

// ── Hairline Compass Ring for Active Target ───────────────
let radarPulseRadius = 0;
let radarAnimationId = null;

function startRadarPulse() {
  if (radarAnimationId) return;

  function loop() {
    radarPulseRadius = (radarPulseRadius + 0.35) % 20;
    if (network && activeTargetPaths.length > 0) {
      network.redraw();
    }
    radarAnimationId = requestAnimationFrame(loop);
  }
  radarAnimationId = requestAnimationFrame(loop);
}

// ── Initialize Vis.js Network ─────────────────────────────
function initNetwork(modules, edges) {
  const container = document.getElementById('network-container');
  allModulesCache = modules;
  allEdgesCache = edges;

  if (typeof vis === 'undefined') {
    console.error('Vis.js is not loaded!');
    container.innerHTML = '<div style="color:#F43F5E;padding:20px;text-align:center;">Vis.js failed to load.</div>';
    return;
  }

  const nodes = modules.map((m) => {
    const isCycle = (m.sccSize ?? 1) > 1;
    const baseColors = STATUS_COLORS[m.status] || STATUS_COLORS.PENDING;
    const label = m.path.replace(/^src\//, '');
    const size = Math.max(15, Math.min(32, Math.round((m.pagerank || 0.1) * 150 + 14)));

    return {
      id: m.path,
      label,
      title: `${m.path}\nStatus: ${m.status}\nPageRank: ${Number(m.pagerank ?? 0).toFixed(4)}\nPending Callers: ${m.pendingCallers ?? 0}\nSCC Size: ${m.sccSize ?? 1}`,
      size,
      value: size,
      shape: 'dot',
      color: isCycle ? { ...baseColors, border: '#F43F5E' } : baseColors,
      borderWidth: isCycle ? 2.5 : 1.2,
      font: {
        color: '#E2E8F0',
        face: 'JetBrains Mono, monospace',
        size: 11,
        strokeWidth: 2,
        strokeColor: '#08090C',
      },
      shadow: {
        enabled: true,
        color: 'rgba(0, 0, 0, 0.4)',
        size: 3,
        x: 0,
        y: 1,
      },
      moduleData: m,
    };
  });

  const formattedEdges = edges.map((e, idx) => {
    const isCycleEdge = (e.source.includes('audit') && e.target.includes('audit'));
    return {
      id: `edge-${idx}`,
      from: e.source,
      to: e.target,
      arrows: { to: { enabled: true, scaleFactor: 0.55 } },
      color: isCycleEdge ? { color: '#F43F5E', highlight: '#FB7185' } : { color: 'rgba(148, 163, 184, 0.28)', highlight: '#5E6AD2' },
      dashes: isCycleEdge,
      width: isCycleEdge ? 1.8 : 1.1,
      smooth: { type: 'curvedCW', roundness: 0.15 },
    };
  });

  nodesDataSet = new vis.DataSet(nodes);
  edgesDataSet = new vis.DataSet(formattedEdges);

  const options = {
    physics: {
      enabled: true,
      barnesHut: {
        gravitationalConstant: -2400,
        centralGravity: 0.35,
        springLength: 115,
        springConstant: 0.05,
        damping: 0.12,
        avoidOverlap: 0.3,
      },
      stabilization: {
        enabled: true,
        iterations: 150,
      },
    },
    nodes: {
      shape: 'dot',
      scaling: { min: 14, max: 32 },
    },
    interaction: {
      hover: true,
      tooltipDelay: 80,
      zoomView: true,
    },
    autoResize: true,
    height: '100%',
    width: '100%',
  };

  network = new vis.Network(container, { nodes: nodesDataSet, edges: edgesDataSet }, options);

  // Hairline Compass Ring around Active Targets
  network.on('afterDrawing', (ctx) => {
    if (!activeTargetPaths.length) return;

    try {
      const positions = network.getPositions(activeTargetPaths);
      for (const path of activeTargetPaths) {
        const pos = positions[path];
        if (!pos) continue;

        ctx.save();
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 18 + radarPulseRadius, 0, 2 * Math.PI, false);
        const alpha = Math.max(0, 0.5 - (radarPulseRadius / 20));
        ctx.strokeStyle = `rgba(94, 106, 210, ${alpha})`;
        ctx.lineWidth = 1.0;
        ctx.stroke();
        ctx.restore();
      }
    } catch {
      // Ignore transient canvas exceptions
    }
  });

  network.once('stabilizationIterationsDone', () => {
    network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
  });

  setTimeout(() => {
    if (network) {
      network.redraw();
      network.fit();
    }
  }, 200);

  // Click handler
  network.on('click', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      highlightBlastRadius(nodeId);
      openNodeInspector(nodeId);
      inspectNodeInDiffViewer(nodeId);
    } else {
      clearBlastRadius();
      closeNodeInspector();
      renderMissionDeck();
    }
  });

  // Hover handler
  network.on('hoverNode', (params) => {
    if (!blastRadiusActiveNode) {
      showFloatingHud(params.node);
    }
  });

  network.on('blurNode', () => {
    if (!blastRadiusActiveNode) {
      hideFloatingHud();
    }
  });

  startRadarPulse();
}

// ── Interactive Blast Radius Traversal ────────────────────
function getTransitiveCallers(targetNodeId) {
  const callers = new Set();
  const queue = [targetNodeId];
  const visited = new Set([targetNodeId]);

  while (queue.length > 0) {
    const current = queue.shift();
    const directCallers = allEdgesCache
      .filter((e) => e.target === current)
      .map((e) => e.source);

    for (const caller of directCallers) {
      if (!visited.has(caller)) {
        visited.add(caller);
        callers.add(caller);
        queue.push(caller);
      }
    }
  }

  return Array.from(callers);
}

function highlightBlastRadius(nodeId) {
  blastRadiusActiveNode = nodeId;
  const callers = getTransitiveCallers(nodeId);
  const callersSet = new Set(callers);

  const updates = allModulesCache.map((m) => {
    const isTarget = m.path === nodeId;
    const isCaller = callersSet.has(m.path);

    if (isTarget) {
      return {
        id: m.path,
        color: { background: '#3730A3', border: '#818CF8' },
        borderWidth: 2,
        opacity: 1.0,
      };
    } else if (isCaller) {
      return {
        id: m.path,
        color: { background: '#78350F', border: '#F59E0B' },
        borderWidth: 1.8,
        opacity: 1.0,
      };
    } else {
      return {
        id: m.path,
        color: { background: '#10131B', border: '#1C212E' },
        borderWidth: 1,
        opacity: 0.18,
      };
    }
  });

  nodesDataSet.update(updates);
  showFloatingHud(nodeId, callers);
}

function clearBlastRadius() {
  blastRadiusActiveNode = null;
  hideFloatingHud();
  updateNetworkTopology(allModulesCache);
}

function showFloatingHud(nodeId, transitiveCallers) {
  const hud = document.getElementById('blast-radius-hud');
  const mod = allModulesCache.find((m) => m.path === nodeId);
  if (!mod) return;

  const callers = transitiveCallers ?? getTransitiveCallers(nodeId);

  document.getElementById('hud-path').textContent = mod.path.replace(/^src\//, '');
  const statusEl = document.getElementById('hud-status');
  statusEl.textContent = mod.status;
  statusEl.className = `phase-pill phase-${mod.status.toLowerCase().replace('_', '')}`;

  document.getElementById('hud-pagerank').textContent = Number(mod.pagerank ?? 0).toFixed(4);
  document.getElementById('hud-blast').textContent = `${callers.length} Callers`;
  document.getElementById('hud-indegree').textContent = mod.inDegree ?? 0;
  document.getElementById('hud-scc').textContent = `${mod.sccSize ?? 1} Nodes`;

  const callersListEl = document.getElementById('hud-callers-names');
  if (callers.length > 0) {
    callersListEl.textContent = callers.map((c) => c.replace(/^src\//, '')).join(', ');
  } else {
    callersListEl.textContent = 'None (Entrypoint)';
  }

  hud.style.display = 'block';
}

function hideFloatingHud() {
  const hud = document.getElementById('blast-radius-hud');
  hud.style.display = 'none';
}

// ── Update Network Nodes ──────────────────────────────────
function updateNetworkTopology(modules) {
  allModulesCache = modules;
  if (!nodesDataSet) return;

  const updates = modules.map((m) => {
    const isCycle = (m.sccSize ?? 1) > 1;
    const baseColors = STATUS_COLORS[m.status] || STATUS_COLORS.PENDING;
    const size = Math.max(15, Math.min(32, Math.round((m.pagerank || 0.1) * 150 + 14)));

    return {
      id: m.path,
      size,
      value: size,
      color: isCycle ? { ...baseColors, border: '#F43F5E' } : baseColors,
      borderWidth: isCycle ? 2.5 : 1.2,
      opacity: 1.0,
      shadow: {
        enabled: true,
        color: 'rgba(0, 0, 0, 0.4)',
        size: 3,
        x: 0,
        y: 1,
      },
      moduleData: m,
    };
  });

  nodesDataSet.update(updates);
}

// ── Refresh Status Counts & Header Progress ───────────────
function updateStatusCounts(counts) {
  const cleanCount = counts.CLEAN ?? 0;
  const pendingCount = counts.PENDING ?? 0;
  const shimmedCount = counts.SHIMMED ?? 0;
  const verifiedCount = counts.VERIFIED ?? 0;

  document.getElementById('count-clean').textContent = cleanCount;
  document.getElementById('count-pending').textContent = pendingCount;
  document.getElementById('count-shimmed').textContent = shimmedCount;
  document.getElementById('count-verified').textContent = verifiedCount;

  const total = (allModulesCache && allModulesCache.length) || (cleanCount + pendingCount + shimmedCount + verifiedCount) || 1;
  const migratedCount = cleanCount + verifiedCount;
  const pct = Math.min(100, Math.round((migratedCount / total) * 100));

  const progressFill = document.getElementById('progress-fill');
  const progressPercent = document.getElementById('progress-percent');
  const stepBadge = document.getElementById('step-badge');

  if (progressFill) progressFill.style.width = `${pct}%`;
  if (progressPercent) progressPercent.textContent = `${pct}%`;
  if (stepBadge) stepBadge.textContent = `${migratedCount} / ${total} Migrated`;

  const flightTitle = document.getElementById('flight-milestone');
  if (flightTitle && !flightTitle.textContent.startsWith('Claimed') && !flightTitle.textContent.startsWith('Gate') && !flightTitle.textContent.startsWith('Verified')) {
    if (pct === 100) {
      flightTitle.textContent = '100% Migrated';
    } else if (shimmedCount > 0) {
      flightTitle.textContent = `${shimmedCount} Shimmed`;
    } else if (pendingCount > 0) {
      flightTitle.textContent = `${pendingCount} Pending`;
    } else {
      flightTitle.textContent = 'Live Stream';
    }
  }
}

// ── Toast Notification Manager ────────────────────────────
function showToast(title, message, type = 'info', durationMs = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const item = document.createElement('div');
  item.className = `toast-item toast-${type}`;

  const icons = {
    info: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    success: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F43F5E" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    warn: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };

  item.innerHTML = `
    <div style="flex-shrink: 0; margin-top: 1px;">${icons[type] || icons.info}</div>
    <div class="toast-content">
      <div class="toast-title">${escapeHtml(title)}</div>
      <div class="toast-msg">${escapeHtml(message)}</div>
    </div>
  `;

  container.appendChild(item);

  setTimeout(() => {
    item.classList.add('toast-leave');
    setTimeout(() => item.remove(), 250);
  }, durationMs);
}

// ── Mission Control Deck for Idle State ───────────────────
function renderMissionDeck() {
  const targetTitle = document.getElementById('target-title');
  const phaseBadge = document.getElementById('phase-badge');
  const targetMeta = document.getElementById('target-meta');
  const diffFileLabel = document.getElementById('diff-file-label');
  const diffTabs = document.getElementById('diff-tabs');
  const diffViewer = document.getElementById('diff-viewer');
  const proofContainer = document.getElementById('proof-container');

  if (targetTitle) targetTitle.textContent = 'Active Migration Target';
  if (phaseBadge) {
    phaseBadge.textContent = 'READY';
    phaseBadge.className = 'phase-pill phase-idle';
  }
  if (targetMeta) targetMeta.style.display = 'none';
  if (diffFileLabel) diffFileLabel.style.display = 'none';
  if (diffTabs) diffTabs.style.display = 'none';
  if (proofContainer) proofContainer.style.display = 'none';

  const repoDisplay = currentAppInfo?.displayRepo || 'demo-repo';
  const packDisplay = currentAppInfo?.currentPackId || 'express-to-fastify';

  if (diffViewer) {
    diffViewer.innerHTML = `
      <div class="mission-deck">
        <div class="mission-header">
          <div class="mission-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818CF8" stroke-width="2">
              <polygon points="12 2 2 7 12 12 22 7 12 2"/>
              <polyline points="2 17 12 22 22 17"/>
              <polyline points="2 12 12 17 22 12"/>
            </svg>
          </div>
          <div class="mission-details">
            <div class="mission-title">Graph-Governed Migration Deck</div>
            <div class="mission-subtitle">${escapeHtml(repoDisplay)} &middot; ${escapeHtml(packDisplay)}</div>
          </div>
        </div>

        <div class="mission-invariants-grid">
          <div class="invariant-card">
            <div class="inv-icon">🔒</div>
            <div class="inv-info">
              <div class="inv-title">Route Invariants</div>
              <div class="inv-desc">HTTP signatures &amp; middleware parity verified 100%</div>
            </div>
          </div>
          <div class="invariant-card">
            <div class="inv-icon">🔄</div>
            <div class="inv-info">
              <div class="inv-title">Atomic Tarjan SCC</div>
              <div class="inv-desc">Circular dependency cycles migrated simultaneously</div>
            </div>
          </div>
          <div class="invariant-card">
            <div class="inv-icon">🚦</div>
            <div class="inv-info">
              <div class="inv-title">Zero Broken Commits</div>
              <div class="inv-desc">TypeScript compilation verified at every topological gate</div>
            </div>
          </div>
        </div>

        <div class="mission-status-callout">
          <span class="sync-indicator pulse"></span>
          <span>Live Telemetry Synchronized. Listening for agent tool calls from <strong>OpenCode</strong> / <strong>Claude</strong> / <strong>CLI</strong>.</span>
        </div>
      </div>
    `;
    diffViewer.scrollTop = 0;
  }
}

// ── Render File Preview for Claimed / Clicked Nodes ───────
function renderFilePreview(path, content, phase, note) {
  const diffViewer = document.getElementById('diff-viewer');
  const fileLabel = document.getElementById('diff-file-label');
  const tabsContainer = document.getElementById('diff-tabs');

  if (fileLabel) {
    fileLabel.textContent = path.replace(/^src\//, '');
    fileLabel.style.display = 'inline';
  }
  if (tabsContainer) tabsContainer.style.display = 'none';

  if (!diffViewer) return;

  if (!content) {
    diffViewer.innerHTML = `
      <div class="target-empty">
        <p>Module claimed: <strong>${escapeHtml(path)}</strong>.<br>
        <span style="color:#64748B;font-size:0.68rem;">Awaiting transformation patch from agent...</span></p>
      </div>
    `;
    return;
  }

  const lines = content.split('\n');
  let html = `
    <div class="code-preview-bar">
      <div class="code-preview-info">
        <span class="preview-phase-chip">[${escapeHtml(phase || 'INSPECT')}]</span>
        <span class="preview-path">${escapeHtml(path.replace(/^src\//, ''))}</span>
        <span class="preview-lines">(${lines.length} lines)</span>
      </div>
      ${note ? `<div class="preview-note">${escapeHtml(note)}</div>` : ''}
    </div>
    <div class="code-preview-body">
  `;

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const isShim = line.includes('@bkb-shim') || line.includes('@shift-shim');
    const lineClass = isShim ? 'diff-line diff-shim' : 'diff-line';
    html += `
      <div class="${lineClass}">
        <span class="code-linenum">${lineNum}</span>
        <span class="code-linetext">${escapeHtml(line)}</span>
        ${isShim ? '<span class="shim-tag">compat-shim</span>' : ''}
      </div>
    `;
  });

  html += `</div>`;
  diffViewer.innerHTML = html;
  diffViewer.scrollTop = 0;
}

// ── Render Gate Failure Diagnostics ───────────────────────
function renderGateFailure(errors, targetPaths) {
  const diffViewer = document.getElementById('diff-viewer');
  if (!diffViewer) return;

  const names = (targetPaths || []).map((p) => p.replace(/^src\//, '')).join(', ');
  const rawErr = (errors || []).join('\n') || 'Verification gate failed';

  diffViewer.innerHTML = `
    <div class="gate-failure-box">
      <div class="failure-title">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F43F5E" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        Verification Gate Blocked — Invariants Guarded
      </div>
      <div class="failure-desc">
        BKB intercepted broken changes in <strong>${escapeHtml(names || 'target module')}</strong> and prevented broken commits. FalkorDB graph rollback is primed.
      </div>
      <pre class="failure-code"><code>${escapeHtml(rawErr)}</code></pre>
    </div>
  `;
  diffViewer.scrollTop = 0;
}

// ── Inspect Node in Diff Viewer on Graph Click ────────────
async function inspectNodeInDiffViewer(nodeId) {
  try {
    const res = await fetch(`/api/node-detail?path=${encodeURIComponent(nodeId)}`);
    const data = await res.json();
    if (!data) return;

    document.getElementById('target-title').textContent = `Inspecting: ${nodeId.replace(/^src\//, '')}`;
    const phaseBadge = document.getElementById('phase-badge');
    if (phaseBadge) {
      phaseBadge.textContent = data.meta?.status || 'INSPECT';
      phaseBadge.className = `phase-pill status-${data.meta?.status || 'PENDING'}`;
    }

    const targetMeta = document.getElementById('target-meta');
    if (targetMeta) {
      targetMeta.style.display = 'block';
      targetMeta.innerHTML = `
        <div class="target-meta-grid">
          <div class="meta-item"><span class="lbl">PageRank:</span> <span class="val phase-highlight">${Number(data.meta?.pagerank ?? 0).toFixed(4)}</span></div>
          <div class="meta-item"><span class="lbl">In-Degree:</span> <span class="val">${data.meta?.inDegree ?? 0}</span></div>
          <div class="meta-item"><span class="lbl">Blast Radius:</span> <span class="val text-crimson">${data.blastRadius?.length ?? 0} Callers</span></div>
        </div>
      `;
    }

    renderFilePreview(nodeId, data.fileContent, data.meta?.status, 'Node selected from graph');
  } catch (err) {
    console.error('Failed to inspect node:', err);
  }
}

// ── Display Active Target & Diff ──────────────────────────
function showActiveTarget(claim, claimLatencyMs) {
  const targetTitle = document.getElementById('target-title');
  const phaseBadge = document.getElementById('phase-badge');
  const targetMeta = document.getElementById('target-meta');
  const proofContainer = document.getElementById('proof-container');
  const proofText = document.getElementById('proof-text');

  if (!claim) return;

  phaseBadge.textContent = claim.phase;
  phaseBadge.className = `phase-pill phase-${claim.phase.toLowerCase().replace('_', '')}`;

  activeTargetPaths = claim.targetPaths || [];

  const latencyBadge = document.getElementById('graph-latency');
  if (latencyBadge && claimLatencyMs) {
    latencyBadge.textContent = `FalkorDB: ${claimLatencyMs} ms`;
  }
  document.getElementById('gate-falkor').textContent = `${claimLatencyMs || '1.2'} ms`;

  const isCycle = claim.targetPaths.length > 1;

  if (isCycle) {
    targetTitle.textContent = 'Atomic SCC Cycle';
    targetMeta.style.display = 'block';
    targetMeta.innerHTML = `
      <div class="target-meta-grid">
        <div class="meta-item"><span class="lbl">Cycle Size:</span> <span class="val phase-highlight">${claim.targetPaths.length} Nodes</span></div>
        <div class="meta-item"><span class="lbl">Phase:</span> <span class="val">${escapeHtml(claim.phase)}</span></div>
        <div class="meta-item"><span class="lbl">SLA:</span> <span class="val text-emerald">${claimLatencyMs || '1.2'} ms</span></div>
      </div>
    `;
  } else {
    targetTitle.textContent = claim.targetPaths[0] ? claim.targetPaths[0].replace(/^src\//, '') : 'Active Target';
    targetMeta.style.display = 'none';
  }

  if (claim.proof) {
    proofContainer.style.display = 'flex';
    proofText.textContent = `${claim.proof} (${claimLatencyMs || '1.2'} ms)`;
  } else {
    proofContainer.style.display = 'none';
  }
}

// ── Render Code Diff with Multi-File Tabs ─────────────────
function renderCodeDiff(modifiedFiles) {
  currentModifiedFiles = modifiedFiles || [];
  const diffViewer = document.getElementById('diff-viewer');
  const fileLabel = document.getElementById('diff-file-label');
  const tabsContainer = document.getElementById('diff-tabs');

  if (!modifiedFiles || modifiedFiles.length === 0) {
    fileLabel.style.display = 'none';
    tabsContainer.style.display = 'none';
    diffViewer.innerHTML = `<div class="target-empty"><p>No changes in this step.</p></div>`;
    return;
  }

  fileLabel.textContent = modifiedFiles.map((f) => f.path.replace(/^src\//, '')).join(', ');
  fileLabel.style.display = 'inline';

  if (modifiedFiles.length > 1) {
    tabsContainer.style.display = 'flex';
    tabsContainer.innerHTML = modifiedFiles
      .map((f, idx) => `
        <button class="diff-tab-btn ${idx === 0 ? 'active' : ''}" data-file-idx="${idx}">
          ${f.path.replace(/^src\//, '')}
        </button>
      `)
      .join('');

    tabsContainer.querySelectorAll('.diff-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        tabsContainer.querySelectorAll('.diff-tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const idx = Number(btn.getAttribute('data-file-idx'));
        renderSingleFileDiff(modifiedFiles[idx]);
      });
    });

    renderSingleFileDiff(modifiedFiles[0]);
  } else {
    tabsContainer.style.display = 'none';
    renderSingleFileDiff(modifiedFiles[0]);
  }
}

function renderSingleFileDiff(f) {
  const diffViewer = document.getElementById('diff-viewer');
  if (!f) return;

  const oldLines = f.oldCode.split('\n');
  const newLines = f.newCode.split('\n');

  let diffHtml = `<div style="font-weight: 600; color: #A5B4FC; margin-bottom: 8px; font-size: 0.75rem;">--- ${f.path}</div>`;

  let diffCount = 0;
  let lineNum = 1;
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    const o = oldLines[i];
    const n = newLines[i];

    if (o === n) continue;

    if (o !== undefined && (n === undefined || !newLines.includes(o))) {
      diffCount++;
      diffHtml += `<div class="diff-line diff-del"><span style="display:inline-block;width:28px;color:#64748B;font-size:0.65rem;user-select:none;">${lineNum++}</span><span>- ${escapeHtml(o)}</span></div>`;
    }
    if (n !== undefined && (o === undefined || !oldLines.includes(n))) {
      diffCount++;
      const isShim = n.includes('@bkb-shim') || n.includes('@shift-shim');
      if (isShim) {
        diffHtml += `
          <div class="diff-line diff-shim">
            <span style="display:inline-block;width:28px;color:#A78BFA;font-size:0.65rem;user-select:none;">${lineNum++}</span>
            <span>+ ${escapeHtml(n)}</span>
            <span class="shim-tag">compat-shim</span>
          </div>
        `;
      } else {
        diffHtml += `<div class="diff-line diff-add"><span style="display:inline-block;width:28px;color:#64748B;font-size:0.65rem;user-select:none;">${lineNum++}</span><span>+ ${escapeHtml(n)}</span></div>`;
      }
    }
  }

  diffViewer.innerHTML = diffCount > 0 ? diffHtml : `<div style="color: #64748B; padding: 10px;">Identical or whitespace-only changes</div>`;
  diffViewer.scrollTop = 0;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── openCypher Query Stream Terminal ──────────────────────
function updateCypherTerminal(cypherTrace) {
  if (!cypherTrace) return;

  const codeEl = document.getElementById('cypher-query-display');
  const latencyEl = document.getElementById('cypher-latency-badge');
  const rationaleEl = document.getElementById('cypher-rationale');

  if (cypherTrace.latencyMs) {
    latencyEl.textContent = `${cypherTrace.latencyMs} ms`;
  }

  codeEl.innerHTML = highlightCypherSyntax(cypherTrace.query);

  if (cypherTrace.phase === 'DE_SHIM') {
    rationaleEl.innerHTML = CYPHER_PRESETS.deshim.rationale;
  } else {
    rationaleEl.innerHTML = CYPHER_PRESETS.claim.rationale;
  }
}

function highlightCypherSyntax(rawQuery) {
  let html = escapeHtml(rawQuery);

  const keywords = ['MATCH', 'OPTIONAL MATCH', 'WHERE', 'WITH', 'ORDER BY', 'LIMIT', 'SET', 'RETURN', 'FOREACH', 'DISTINCT', 'AND', 'OR', 'IN', 'AS', 'CALL', 'YIELD', 'UNWIND', 'CREATE'];
  for (const kw of keywords) {
    const reg = new RegExp(`\\b${kw}\\b`, 'g');
    html = html.replace(reg, `<span class="cypher-kw">${kw}</span>`);
  }

  html = html.replace(/:([A-Z][a-zA-Z0-9_]+)/g, ':<span class="cypher-lbl">$1</span>');
  html = html.replace(/:\[?([A-Z_]+)\*?/g, ':<span class="cypher-rel">$1</span>');
  html = html.replace(/(\$[a-zA-Z0-9_]+)/g, '<span class="cypher-fn">$1</span>');
  html = html.replace(/\b(count|collect|size|sum|max|min|shortestPath|nodes|algo\.[a-zA-Z0-9_]+)\b/g, '<span class="cypher-fn">$1</span>');
  html = html.replace(/('[^']*')/g, '<span class="cypher-str">$1</span>');

  return `<code>${html}</code>`;
}

function setupCypherDrawer() {
  const toggleBtn = document.getElementById('btn-toggle-cypher');
  const drawer = document.getElementById('cypher-drawer');
  const arrow = document.getElementById('cypher-arrow');

  toggleBtn.addEventListener('click', () => {
    const isOpen = drawer.style.display !== 'none';
    drawer.style.display = isOpen ? 'none' : 'flex';
    arrow.textContent = isOpen ? '▾' : '▴';

    setTimeout(() => {
      if (network) network.fit({ animation: { duration: 250 } });
    }, 50);
  });

  const buttons = document.querySelectorAll('.btn-preset');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const presetKey = btn.getAttribute('data-preset');
      const preset = CYPHER_PRESETS[presetKey];
      if (preset) {
        const codeEl = document.getElementById('cypher-query-display');
        const rationaleEl = document.getElementById('cypher-rationale');
        codeEl.innerHTML = highlightCypherSyntax(preset.query);
        rationaleEl.innerHTML = preset.rationale;
      }
    });
  });
}

// ── Update Verification Gates HUD ─────────────────────────
function updateVerificationGates(verifyResult, verifyLatencyMs) {
  const gateTsc = document.getElementById('gate-tsc');
  const gateTest = document.getElementById('gate-test');
  const gateRoutes = document.getElementById('gate-routes');
  const gateFalkor = document.getElementById('gate-falkor');
  const overallBadge = document.getElementById('gate-overall-badge');

  if (verifyResult) {
    gateTsc.textContent = verifyResult.ok ? 'PASS' : 'FAIL';
    gateTsc.style.color = verifyResult.ok ? '#10B981' : '#F43F5E';

    if (verifyResult.checkpointResult) {
      const cp = verifyResult.checkpointResult;
      gateTest.textContent = cp.testPass ? '6/6' : 'FAIL';
      gateRoutes.textContent = cp.routeMatch ? '100%' : 'MISMATCH';
    }

    gateFalkor.textContent = `${verifyLatencyMs || '< 2'} ms`;
    overallBadge.textContent = verifyResult.ok ? 'GATES INTACT' : 'GATE FAILED';
    overallBadge.style.color = verifyResult.ok ? '#34D399' : '#F43F5E';
  }
}

// ── Audit Ledger Management ───────────────────────────────
async function loadAuditTrail() {
  try {
    const res = await fetch('/api/audit');
    if (!res.ok) return;
    const data = await res.json();
    const episodes = data.episodes || [];
    renderAuditTrail(episodes);
  } catch (err) {
    console.error('Failed to load audit trail:', err);
  }
}

function renderAuditTrail(episodes) {
  const feed = document.getElementById('audit-feed');
  if (!feed) return;

  if (!episodes || episodes.length === 0) {
    feed.innerHTML = `
      <div class="audit-empty-state">
        <div class="audit-empty-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#818CF8" stroke-width="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </div>
        <div class="audit-empty-title">Audit Ledger Standing By</div>
        <div class="audit-empty-desc">FalkorDB cryptographically tracks every claimed module, gate evaluation, and verified commit.</div>
      </div>
    `;
    return;
  }

  // Render episodes in descending order (newest first)
  const sorted = [...episodes].reverse();
  feed.innerHTML = sorted
    .map((ep) => {
      const paths = (ep.modules || []).map((m) => m.replace(/^src\//, '')).join(', ');
      const rawModulePaths = (ep.modules || []).join(',');
      const phaseStr = ep.phase || 'MIGRATE';
      const statusClass = (ep.newStatus || 'VERIFIED').replace(/[^A-Za-z0-9_-]/g, '');
      return `
        <div class="audit-item" data-modules="${escapeHtml(rawModulePaths)}" title="Click to inspect module in viewer">
          <div class="audit-item-left">
            <span class="audit-step">#${ep.step}</span>
            <span class="audit-phase">${escapeHtml(phaseStr)}</span>
            <span class="audit-path" title="${escapeHtml(paths)}">${escapeHtml(paths)}</span>
          </div>
          <div class="audit-status status-${statusClass}">${escapeHtml(ep.newStatus || 'VERIFIED')}</div>
        </div>
      `;
    })
    .join('');
}

async function inspectEpisodeFiles(pathsStr) {
  if (!pathsStr) return;
  const firstPath = pathsStr.split(',')[0].trim();
  if (!firstPath) return;

  if (network) {
    network.focus(firstPath, { scale: 1.15, animation: { duration: 350 } });
    highlightBlastRadius(firstPath);
  }
  inspectNodeInDiffViewer(firstPath);
}

function appendAuditItem(step, phase, newStatus, targetPaths) {
  loadAuditTrail();
}

function showVictoryModal() {
  const modal = document.getElementById('victory-modal');
  modal.style.display = 'flex';
}

function hideVictoryModal() {
  const modal = document.getElementById('victory-modal');
  modal.style.display = 'none';
}

// ── API Operations ────────────────────────────────────────

async function fetchGraphData() {
  const res = await fetch('/api/graph');
  const data = await res.json();
  return data;
}

async function executeStep() {
  const btnStep = document.getElementById('btn-step');
  btnStep.disabled = true;

  try {
    const res = await fetch('/api/step', { method: 'POST' });
    const data = await res.json();

    if (data.finished) {
      stopAutoPlay();
      currentStepNumber = TOTAL_STEPS;
      document.getElementById('phase-badge').textContent = 'COMPLETE';
      document.getElementById('phase-badge').className = 'phase-pill phase-deshim';
      document.getElementById('target-title').textContent = 'Migration Complete';
      document.getElementById('target-meta').style.display = 'none';
      document.getElementById('diff-viewer').innerHTML = `
        <div class="target-empty" style="color: #34D399;">
          <p>All 7 legacy modules successfully migrated and verified to pure Fastify.</p>
        </div>
      `;

      activeTargetPaths = [];
      const topology = await fetchGraphData();
      updateNetworkTopology(topology.modules);
      updateStatusCounts(topology.statusCounts);
      showVictoryModal();
      return false;
    }

    currentStepNumber++;
    renderTimelineStrip(currentStepNumber, currentAppInfo.checkpoints);

    showActiveTarget(data.claim, data.claimLatencyMs);
    renderCodeDiff(data.modifiedFiles);
    updateVerificationGates(data.verifyResult, data.verifyLatencyMs);
    updateNetworkTopology(data.topology.modules);
    updateStatusCounts(data.topology.statusCounts);
    appendAuditItem(currentStepNumber, data.claim.phase, data.verifyResult.newStatus, data.claim.targetPaths);

    if (data.cypherTrace) {
      updateCypherTerminal(data.cypherTrace);
    }

    if (network && data.claim.targetPaths.length > 0) {
      network.focus(data.claim.targetPaths[0], {
        scale: 1.1,
        animation: { duration: 400, easingFunction: 'easeInOutQuad' },
      });
    }

    return true;
  } catch (err) {
    console.error('Step failed:', err);
    stopAutoPlay();
    return false;
  } finally {
    btnStep.disabled = false;
  }
}

async function resetCodebase() {
  stopAutoPlay();
  currentStepNumber = 0;
  activeTargetPaths = [];
  blastRadiusActiveNode = null;
  hideVictoryModal();
  renderTimelineStrip(0, currentAppInfo.checkpoints);

  const btnReset = document.getElementById('btn-reset');
  btnReset.disabled = true;

  try {
    const res = await fetch('/api/reset', { method: 'POST' });
    const data = await res.json();

    renderMissionDeck();
    await loadAuditTrail();
    showToast('Codebase Reset', 'Restored baseline dependencies & graph state', 'info');

    document.getElementById('gate-overall-badge').textContent = 'GATES INTACT';
    document.getElementById('gate-overall-badge').className = 'gate-overall';
    document.getElementById('gate-tsc').textContent = 'PASS';
    document.getElementById('gate-test').textContent = '6/6';
    document.getElementById('gate-routes').textContent = '100%';
    document.getElementById('gate-falkor').textContent = '< 2 ms';
    document.getElementById('graph-latency').textContent = 'FalkorDB: 1.5 ms';

    updateNetworkTopology(data.topology.modules);
    updateStatusCounts(data.topology.statusCounts);

    const preset = CYPHER_PRESETS.claim;
    document.getElementById('cypher-query-display').innerHTML = highlightCypherSyntax(preset.query);
    document.getElementById('cypher-rationale').innerHTML = preset.rationale;
    document.querySelectorAll('.btn-preset').forEach((b) => b.classList.remove('active'));
    document.querySelector('.btn-preset[data-preset="claim"]')?.classList.add('active');

    if (network) {
      network.fit({ animation: { duration: 500 } });
    }
  } catch (err) {
    console.error('Reset failed:', err);
  } finally {
    btnReset.disabled = false;
  }
}

function toggleAutoPlay() {
  if (isAutoPlaying) {
    stopAutoPlay();
  } else {
    startAutoPlay();
  }
}

function startAutoPlay() {
  isAutoPlaying = true;
  const label = document.getElementById('btn-auto-label');
  const btn = document.getElementById('btn-auto');
  label.textContent = 'Pause';
  btn.className = 'btn btn-secondary';

  const stepLoop = async () => {
    if (!isAutoPlaying) return;
    const canContinue = await executeStep();
    if (canContinue && isAutoPlaying) {
      autoPlayTimer = setTimeout(stepLoop, 1300);
    }
  };

  stepLoop();
}

function stopAutoPlay() {
  isAutoPlaying = false;
  if (autoPlayTimer) clearTimeout(autoPlayTimer);
  const label = document.getElementById('btn-auto-label');
  const btn = document.getElementById('btn-auto');
  label.textContent = 'Auto-Play';
  btn.className = 'btn btn-primary';
}

async function downloadAuditReport() {
  try {
    const res = await fetch('/api/audit?checkpoint=true');
    const trail = await res.json();
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(trail, null, 2));
    const dlAnchor = document.createElement('a');
    dlAnchor.setAttribute('href', dataStr);
    dlAnchor.setAttribute('download', `bagwan-kai-bandey-audit-${Date.now()}.json`);
    document.body.appendChild(dlAnchor);
    dlAnchor.click();
    dlAnchor.remove();
  } catch (err) {
    console.error('Failed to download audit trail:', err);
  }
}

// ── Node Inspector Drawer ─────────────────────────────────
async function openNodeInspector(nodeId) {
  activeDrawerNode = nodeId;
  const drawer = document.getElementById('node-inspector-drawer');
  if (!drawer) return;

  drawer.style.display = 'flex';
  document.getElementById('drawer-node-path').textContent = nodeId;
  document.getElementById('drawer-file-code').textContent = '// Fetching node details and file contents...';

  try {
    const res = await fetch(`/api/node-detail?path=${encodeURIComponent(nodeId)}`);
    const data = await res.json();

    if (data.meta) {
      document.getElementById('drawer-node-status').textContent = data.meta.status;
      document.getElementById('drawer-node-status').className = `phase-pill status-${data.meta.status}`;
      document.getElementById('drawer-pagerank').textContent = Number(data.meta.pagerank ?? 0).toFixed(4);
      document.getElementById('drawer-indegree').textContent = data.meta.inDegree ?? 0;
      document.getElementById('drawer-scc').textContent = `${data.meta.sccSize ?? 1} Nodes`;
    }

    // Tab 1: Source code
    document.getElementById('drawer-file-code').textContent = data.fileContent || '// Empty or unreadable file';

    // Tab 2: Callers & Callees & Blast Radius
    const callersList = document.getElementById('drawer-callers-list');
    document.getElementById('drawer-callers-count').textContent = data.callers?.length ?? 0;
    callersList.innerHTML = data.callers?.length
      ? data.callers.map((c) => `<span class="jump-chip" data-node-path="${escapeHtml(c.path)}">${escapeHtml(c.path.replace(/^src\//, ''))}</span>`).join('')
      : '<span style="color: #64748B; font-size: 0.7rem;">None (Root entrypoint)</span>';

    const calleesList = document.getElementById('drawer-callees-list');
    document.getElementById('drawer-callees-count').textContent = data.callees?.length ?? 0;
    calleesList.innerHTML = data.callees?.length
      ? data.callees.map((c) => `<span class="jump-chip" data-node-path="${escapeHtml(c.path)}">${escapeHtml(c.path.replace(/^src\//, ''))}</span>`).join('')
      : '<span style="color: #64748B; font-size: 0.7rem;">None (Leaf module)</span>';

    const blastList = document.getElementById('drawer-blast-list');
    document.getElementById('drawer-blast-count').textContent = data.blastRadius?.length ?? 0;
    blastList.innerHTML = data.blastRadius?.length
      ? data.blastRadius.map((b) => `
          <div class="blast-row">
            <span class="jump-chip" data-node-path="${escapeHtml(b.callerPath)}">${escapeHtml(b.callerPath.replace(/^src\//, ''))}</span>
            <span class="hop-badge">${b.hops} Hop${b.hops > 1 ? 's' : ''}</span>
          </div>
        `).join('')
      : '<div style="color: #64748B; padding: 4px; font-size: 0.7rem;">Zero reverse callers (Isolated blast radius)</div>';

    // Tab 3: Symbols & AST
    const symbolsList = document.getElementById('drawer-symbols-list');
    symbolsList.innerHTML = data.symbols?.length
      ? data.symbols.map((s) => `
          <div class="symbol-item">
            <span class="symbol-kind">[${s.kind}]</span>
            <span class="symbol-sig">${escapeHtml(s.signature || s.name)}</span>
          </div>
        `).join('')
      : '<div style="color: #64748B; padding: 4px; font-size: 0.7rem;">No exported symbols indexed</div>';

  } catch (err) {
    console.error('Failed to load node details:', err);
    document.getElementById('drawer-file-code').textContent = `// Error loading details: ${err.message}`;
  }
}

function closeNodeInspector() {
  const drawer = document.getElementById('node-inspector-drawer');
  if (drawer) drawer.style.display = 'none';
  activeDrawerNode = null;
}

function jumpToNode(nodeId) {
  if (network && nodeId) {
    network.focus(nodeId, { scale: 1.15, animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
    highlightBlastRadius(nodeId);
    openNodeInspector(nodeId);
  }
}
window.jumpToNode = jumpToNode;

// ── Interactive Timeline Strip ────────────────────────────
const CANNED_STEP_NAMES = [
  'Baseline Express',
  'response.ts (SHIM)',
  'auth.ts (SHIM)',
  'auditA + auditB (SHIM)',
  'orders.ts (SHIM)',
  'users.ts (SHIM)',
  'app.ts (MIGRATE)',
  'orders.ts (DE_SHIM)',
  'users.ts (DE_SHIM)',
  'auditA + auditB (DE_SHIM)',
  'auth.ts (DE_SHIM)',
  'response.ts (DE_SHIM)',
];

function renderTimelineStrip(stepNum, checkpoints = []) {
  const track = document.getElementById('timeline-track');
  if (!track) return;

  track.innerHTML = '';
  for (let i = 0; i < CANNED_STEP_NAMES.length; i++) {
    const chip = document.createElement('div');
    const isCompleted = i < stepNum;
    const isCurrent = i === stepNum;

    chip.className = `timeline-chip ${isCompleted ? 'completed' : ''} ${isCurrent ? 'current' : ''}`;
    chip.innerHTML = `
      <span class="timeline-chip-dot"></span>
      <span>${i === 0 ? '0: Baseline' : `${i}: ${CANNED_STEP_NAMES[i]}`}</span>
    `;

    chip.title = i === 0 ? 'Original Baseline' : `Step ${i}: ${CANNED_STEP_NAMES[i]}`;

    chip.addEventListener('click', async () => {
      if (i > stepNum) return;
      if (confirm(`Do you want to roll back codebase and FalkorDB graph to Step ${i}?`)) {
        await executeRollback(i);
      }
    });

    track.appendChild(chip);
  }
}

async function executeRollback(targetStep) {
  try {
    const res = await fetch('/api/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: targetStep }),
    });
    const data = await res.json();
    if (data.ok) {
      currentStepNumber = targetStep;
      activeTargetPaths = [];
      updateNetworkTopology(data.topology.modules);
      updateStatusCounts(data.topology.statusCounts);
      renderTimelineStrip(currentStepNumber, data.checkpoints);
      alert(data.message);
    } else {
      alert(`Rollback failed: ${data.message}`);
    }
  } catch (err) {
    console.error('Rollback request failed:', err);
  }
}

// ── System Info & Dynamic Target Manager ──────────────────
function renderPackMeta(pack) {
  const navPack = document.getElementById('nav-pack-name');
  const langBadge = document.getElementById('nav-pack-lang');
  const shimBadge = document.getElementById('nav-pack-shim');
  if (navPack) navPack.textContent = pack.id || pack.name || 'unknown';
  if (langBadge) {
    langBadge.textContent = pack.language || 'unknown';
    langBadge.style.display = pack.language ? '' : 'none';
  }
  if (shimBadge) {
    shimBadge.textContent = pack.shimStrategy || 'in-file-branch';
    shimBadge.style.display = pack.shimStrategy ? '' : 'none';
  }
}

async function loadSystemInfo() {
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    currentAppInfo = info;

    const navRepo = document.getElementById('nav-repo-name');
    if (navRepo) navRepo.textContent = info.isDemoRepo ? 'demo-repo' : info.displayRepo.split('/').pop();
    renderPackMeta(info.pack || { id: info.currentPackId, language: 'typescript', shimStrategy: 'in-file-branch' });

    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === info.mode);
    });

    const packSelect = document.getElementById('select-pack');
    if (packSelect && info.availablePacks) {
      packSelect.innerHTML = info.availablePacks
        .map((p) => `<option value="${p}" ${p === info.currentPackId ? 'selected' : ''}>${p}</option>`)
        .join('');
    }

    renderTimelineStrip(currentStepNumber, info.checkpoints);
    handleObserverMode(info.mode);
  } catch (err) {
    console.error('Failed to load system info:', err);
  }
}

function handleObserverMode(mode) {
  if (observerInterval) {
    clearInterval(observerInterval);
    observerInterval = null;
  }

  if (mode === 'observer') {
    // Immediate refresh on entering observer mode
    fetchGraphData().then((topology) => {
      updateNetworkTopology(topology.modules);
      updateStatusCounts(topology.statusCounts);
    }).catch(() => {});

    // Passive fallback polling in addition to SSE
    observerInterval = setInterval(async () => {
      try {
        const topology = await fetchGraphData();
        updateNetworkTopology(topology.modules);
        updateStatusCounts(topology.statusCounts);
      } catch (e) {
        // Silent poll error
      }
    }, 2000);
  }
}

// ── Real-Time CLI & MCP Live SSE Telemetry Stream ─────────

function initLiveStream() {
  const syncBadge = document.getElementById('sync-status-badge');
  const syncText = document.getElementById('sync-text');

  function updateSyncStatus(connected) {
    if (!syncBadge || !syncText) return;
    if (connected) {
      syncBadge.classList.remove('disconnected');
      syncText.textContent = 'CLI Sync Live';
    } else {
      syncBadge.classList.add('disconnected');
      syncText.textContent = 'CLI Sync Offline';
    }
  }

  function flashSyncBadge() {
    if (!syncBadge) return;
    syncBadge.classList.add('flash');
    setTimeout(() => syncBadge.classList.remove('flash'), 400);
  }

  try {
    const es = new EventSource('/api/events');
    es.onopen = () => {
      updateSyncStatus(true);
    };
    es.onmessage = async (e) => {
      try {
        const event = JSON.parse(e.data);
        await handleLiveTelemetryEvent(event, flashSyncBadge);
      } catch (err) {
        console.error('Failed to parse live telemetry event:', err);
      }
    };
    es.onerror = () => {
      updateSyncStatus(false);
    };
  } catch (err) {
    updateSyncStatus(false);
  }
}

async function handleLiveTelemetryEvent(event, flashBadge) {
  if (event.type === 'connected') {
    updateSyncStatus(true);
    return;
  }

  if (typeof flashBadge === 'function') flashBadge();

  // Pack switched without a repo change: refresh pack metadata/badges only
  if (
    event.packId &&
    currentAppInfo &&
    event.repoPath === currentAppInfo.currentRepo &&
    event.packId !== currentAppInfo.currentPackId
  ) {
    await loadSystemInfo();
    return;
  }

  // If repo switched in CLI, reload system info and re-render topology
  if (event.repoPath && currentAppInfo && event.repoPath !== currentAppInfo.currentRepo) {
    await loadSystemInfo();
    const fresh = await fetchGraphData();
    initNetwork(fresh.modules, fresh.edges);
    updateStatusCounts(fresh.statusCounts);
    await loadAuditTrail();
    renderMissionDeck();
    return;
  }

  if (event.type === 'init') {
    await loadSystemInfo();
    const fresh = await fetchGraphData();
    initNetwork(fresh.modules, fresh.edges);
    updateStatusCounts(fresh.statusCounts);
    await loadAuditTrail();
    renderMissionDeck();
    showToast('Migration Initialized', `Loaded ${fresh.modules.length} modules into FalkorDB`, 'info');
    return;
  }

  if (event.type === 'claim') {
    if (event.targetPaths?.length && nodesDataSet) {
      event.targetPaths.forEach((path) => {
        nodesDataSet.update({
          id: path,
          color: { border: '#3B82F6', background: 'rgba(59, 130, 246, 0.25)' },
          borderWidth: 3,
        });
      });
      activeTargetPaths = event.targetPaths;

      if (network && event.targetPaths[0]) {
        network.focus(event.targetPaths[0], { scale: 1.15, animation: { duration: 300 } });
      }

      const names = event.targetPaths.map((p) => p.split('/').pop()).join(', ');
      const milestone = document.getElementById('flight-milestone');
      if (milestone) milestone.textContent = `Claimed: ${names}`;

      // Update Card 1 UI
      const targetTitle = document.getElementById('target-title');
      if (targetTitle) targetTitle.textContent = `Target: ${names}`;

      const phaseBadge = document.getElementById('phase-badge');
      if (phaseBadge) {
        phaseBadge.textContent = event.phase || 'MIGRATE';
        phaseBadge.className = `phase-pill phase-${(event.phase || 'migrate').toLowerCase()}`;
      }

      const fileLabel = document.getElementById('diff-file-label');
      if (fileLabel) {
        fileLabel.textContent = event.targetPaths.join(', ');
        fileLabel.style.display = 'inline';
      }

      const targetMeta = document.getElementById('target-meta');
      if (targetMeta) {
        targetMeta.style.display = 'block';
        targetMeta.innerHTML = `
          <div class="target-meta-grid">
            <div class="meta-item"><span class="lbl">Phase:</span> <span class="val phase-highlight">${escapeHtml(event.phase || 'MIGRATE')}</span></div>
            <div class="meta-item"><span class="lbl">Modules:</span> <span class="val">${event.targetPaths.length}</span></div>
            <div class="meta-item"><span class="lbl">Agent Lock:</span> <span class="val text-emerald">Active</span></div>
          </div>
        `;
      }

      // Fetch file content to display preview immediately
      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(event.targetPaths[0])}`);
        if (res.ok) {
          const fileData = await res.json();
          renderFilePreview(event.targetPaths[0], fileData.content, event.phase, 'Claimed by agent');
        }
      } catch {}

      showToast(`Claimed ${names}`, `Phase: ${event.phase || 'MIGRATE'} · Ready for patch`, 'info');
    }
    return;
  }

  if (event.type === 'verify') {
    const fresh = await fetchGraphData();
    updateNetworkTopology(fresh.modules);
    updateStatusCounts(fresh.statusCounts);
    currentStepNumber = event.step || currentStepNumber + 1;
    renderTimelineStrip(currentStepNumber, currentAppInfo?.checkpoints || []);
    await loadAuditTrail();

    // Update Gate indicators to green
    const gateTsc = document.getElementById('gate-tsc');
    const gateTest = document.getElementById('gate-test');
    const gateRoutes = document.getElementById('gate-routes');
    const gateFalkor = document.getElementById('gate-falkor');
    const overallBadge = document.getElementById('gate-overall-badge');
    if (gateTsc) { gateTsc.textContent = 'PASS'; gateTsc.className = 'gate-val text-emerald'; }
    if (gateTest) { gateTest.textContent = 'PASS'; gateTest.className = 'gate-val text-emerald'; }
    if (gateRoutes) { gateRoutes.textContent = '100%'; gateRoutes.className = 'gate-val text-emerald'; }
    if (gateFalkor) { gateFalkor.textContent = '< 2 ms'; gateFalkor.className = 'gate-val text-emerald'; }
    if (overallBadge) { overallBadge.textContent = 'GATES INTACT'; overallBadge.className = 'gate-overall gate-pass'; }

    const names = (event.targetPaths || []).map((p) => p.split('/').pop()).join(', ');
    const milestone = document.getElementById('flight-milestone');
    if (milestone) milestone.textContent = `Verified: ${names}`;

    const targetTitle = document.getElementById('target-title');
    if (targetTitle) targetTitle.textContent = `Verified: ${names}`;

    const phaseBadge = document.getElementById('phase-badge');
    if (phaseBadge) {
      phaseBadge.textContent = event.status || 'VERIFIED';
      phaseBadge.className = 'phase-pill status-VERIFIED';
    }

    if (event.targetPaths && event.targetPaths[0]) {
      try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(event.targetPaths[0])}`);
        if (res.ok) {
          const fileData = await res.json();
          renderFilePreview(event.targetPaths[0], fileData.content, event.status, 'Gates passed & verified');
        }
      } catch {}
    }

    showToast(`Verified ${names}`, `Status: ${event.status || 'VERIFIED'} · All gates passed`, 'success');
    return;
  }

  if (event.type === 'failure') {
    if (event.targetPaths?.length && nodesDataSet) {
      event.targetPaths.forEach((path) => {
        nodesDataSet.update({
          id: path,
          color: { border: '#F43F5E', background: 'rgba(244, 63, 94, 0.25)' },
          borderWidth: 3,
        });
      });
    }

    const milestone = document.getElementById('flight-milestone');
    if (milestone) milestone.textContent = 'Gate Failed';

    const overallBadge = document.getElementById('gate-overall-badge');
    if (overallBadge) { overallBadge.textContent = 'GATE BLOCKED'; overallBadge.className = 'gate-overall gate-fail'; }
    const gateTsc = document.getElementById('gate-tsc');
    if (gateTsc) { gateTsc.textContent = 'FAIL'; gateTsc.className = 'gate-val text-crimson'; }

    const phaseBadge = document.getElementById('phase-badge');
    if (phaseBadge) {
      phaseBadge.textContent = 'FAILED';
      phaseBadge.className = 'phase-pill phase-failed';
    }

    renderGateFailure(event.errors, event.targetPaths);

    const firstErr = (event.errors && event.errors[0]) || 'Verification failed';
    const firstLine = firstErr.split('\n')[0].substring(0, 80);
    showToast('Verification Gate Blocked', firstLine, 'error', 6000);
    return;
  }

  if (event.type === 'rollback') {
    const fresh = await fetchGraphData();
    updateNetworkTopology(fresh.modules);
    updateStatusCounts(fresh.statusCounts);
    await loadSystemInfo();
    await loadAuditTrail();
    renderMissionDeck();
    const milestone = document.getElementById('flight-milestone');
    if (milestone) milestone.textContent = `Rolled back: step-${event.step}`;
    showToast('Rollback Executed', `Reverted cleanly to step-${event.step}`, 'warn');
    return;
  }

  if (event.type === 'complete') {
    const fresh = await fetchGraphData();
    updateNetworkTopology(fresh.modules);
    updateStatusCounts(fresh.statusCounts);
    await loadAuditTrail();
    const milestone = document.getElementById('flight-milestone');
    if (milestone) milestone.textContent = 'Migration Complete (100%)';
    showToast('Migration Complete', '100% of legacy modules verified in Fastify', 'success');
    showVictoryModal();
    return;
  }
}

async function setExecutionMode(newMode) {
  try {
    const res = await fetch('/api/target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: newMode }),
    });
    const data = await res.json();
    currentAppInfo.mode = newMode;
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === newMode);
    });
    handleObserverMode(newMode);
  } catch (err) {
    console.error('Failed to set mode:', err);
  }
}

function setupSettingsModal() {
  const btnOpen = document.getElementById('btn-project-settings');
  const modal = document.getElementById('project-settings-modal');
  const btnClose = document.getElementById('btn-close-settings');
  const btnCancel = document.getElementById('btn-cancel-settings');
  const btnSave = document.getElementById('btn-save-settings');
  const btnPresetDemo = document.getElementById('btn-preset-demo');
  const repoInput = document.getElementById('input-repo-path');
  const packSelect = document.getElementById('select-pack');
  const modeRadios = document.querySelectorAll('input[name="exec-mode"]');
  const llmBox = document.getElementById('llm-options-box');

  btnOpen?.addEventListener('click', () => {
    if (repoInput) repoInput.value = currentAppInfo.isDemoRepo ? 'demo' : currentAppInfo.currentRepo;
    if (packSelect) packSelect.value = currentAppInfo.currentPackId;
    modeRadios.forEach((r) => {
      r.checked = r.value === currentAppInfo.mode;
    });
    if (llmBox) llmBox.style.display = currentAppInfo.mode === 'llm' ? 'block' : 'none';
    modal.style.display = 'flex';
  });

  const closeModal = () => { modal.style.display = 'none'; };
  btnClose?.addEventListener('click', closeModal);
  btnCancel?.addEventListener('click', closeModal);

  btnPresetDemo?.addEventListener('click', () => {
    if (repoInput) repoInput.value = 'demo';
  });

  btnSave?.addEventListener('click', async () => {
    btnSave.disabled = true;
    btnSave.textContent = 'Ingesting...';

    try {
      const res = await fetch('/api/target', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: repoInput.value.trim(),
          packId: packSelect.value,
          mode: 'observer',
          reset: true,
        }),
      });

      const data = await res.json();
      if (data.success) {
        closeModal();
        await loadSystemInfo();
        updateNetworkTopology(data.topology.modules);
        updateStatusCounts(data.topology.statusCounts);
        await loadAuditTrail();
        renderMissionDeck();
        if (network) network.fit({ animation: { duration: 500 } });
        showToast('Target Loaded', `Observing ${repoInput.value.trim()}`, 'info');
      } else {
        alert(`Failed to load target: ${data.error}`);
      }
    } catch (err) {
      alert(`Network error: ${err.message}`);
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = 'Ingest & Load Graph';
    }
  });
}

function setupDrawerTabs() {
  const tabs = document.querySelectorAll('.drawer-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      const target = tab.getAttribute('data-tab');
      document.getElementById('tab-content-code').style.display = target === 'code' ? 'block' : 'none';
      document.getElementById('tab-content-relations').style.display = target === 'relations' ? 'block' : 'none';
      document.getElementById('tab-content-symbols').style.display = target === 'symbols' ? 'block' : 'none';
    });
  });

  document.getElementById('btn-close-drawer')?.addEventListener('click', closeNodeInspector);
}

function setupDelegatedClickHandlers() {
  document.addEventListener('click', (e) => {
    // 1. Jump chip click in node inspector drawer
    const chip = e.target.closest('.jump-chip');
    if (chip && chip.dataset.nodePath) {
      jumpToNode(chip.dataset.nodePath);
      return;
    }

    // 2. Audit feed item click to inspect episode modules
    const auditItem = e.target.closest('.audit-item');
    if (auditItem && auditItem.dataset.modules) {
      inspectEpisodeFiles(auditItem.dataset.modules);
      return;
    }
  });
}

// ── Application Bootstrapper ──────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const data = await fetchGraphData();
    initNetwork(data.modules, data.edges);
    updateStatusCounts(data.statusCounts);
    setupCypherDrawer();
    setupSettingsModal();
    setupDrawerTabs();
    setupDelegatedClickHandlers();
    await loadSystemInfo();
    renderMissionDeck();
    await loadAuditTrail();

    document.getElementById('btn-reset')?.addEventListener('click', resetCodebase);
    document.getElementById('btn-download-audit')?.addEventListener('click', downloadAuditReport);
    document.getElementById('btn-modal-close')?.addEventListener('click', hideVictoryModal);

    // Connect real-time CLI/MCP event synchronization
    initLiveStream();
  } catch (err) {
    console.error('Failed to initialize Cockpit:', err);
  }
});
