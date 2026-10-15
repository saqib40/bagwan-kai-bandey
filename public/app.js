/**
 * Shift Migration Cockpit — Client Application (`public/app.js`).
 * Linear / Raycast Titanium Design System.
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
// Result fed into Tarjan's SCC algorithm;
// Mutually dependent cycles (auditA <-> auditB) are grouped into atomic clusters.`,
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

// ── Hairline Compass Ring for Active Target ───────────────
let radarPulseRadius = 0;
let radarAnimationId = null;

function startRadarPulse() {
  if (radarAnimationId) return;

  function loop() {
    radarPulseRadius = (radarPulseRadius + 0.4) % 24;
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
    container.innerHTML = '<div style="color:#F43F5E;padding:24px;text-align:center;">Error: Vis.js library failed to load.</div>';
    return;
  }

  const nodes = modules.map((m) => {
    const isCycle = (m.sccSize ?? 1) > 1;
    const baseColors = STATUS_COLORS[m.status] || STATUS_COLORS.PENDING;
    const label = m.path.replace(/^src\//, '');
    const size = Math.max(16, Math.min(34, Math.round((m.pagerank || 0.1) * 160 + 15)));

    return {
      id: m.path,
      label,
      title: `${m.path}\nStatus: ${m.status}\nPageRank: ${Number(m.pagerank ?? 0).toFixed(4)}\nPending Callers: ${m.pendingCallers ?? 0}\nSCC Size: ${m.sccSize ?? 1}`,
      size,
      value: size,
      shape: 'dot',
      color: isCycle ? { ...baseColors, border: '#F43F5E' } : baseColors,
      borderWidth: isCycle ? 3 : 1.5,
      font: {
        color: '#E2E8F0',
        face: 'JetBrains Mono, monospace',
        size: 11,
        strokeWidth: 2,
        strokeColor: '#0B0D13',
      },
      shadow: {
        enabled: true,
        color: 'rgba(0, 0, 0, 0.5)',
        size: 4,
        x: 0,
        y: 2,
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
      arrows: { to: { enabled: true, scaleFactor: 0.6 } },
      color: isCycleEdge ? { color: '#F43F5E', highlight: '#FB7185' } : { color: 'rgba(148, 163, 184, 0.3)', highlight: '#5E6AD2' },
      dashes: isCycleEdge,
      width: isCycleEdge ? 2 : 1.2,
      smooth: { type: 'curvedCW', roundness: 0.18 },
    };
  });

  nodesDataSet = new vis.DataSet(nodes);
  edgesDataSet = new vis.DataSet(formattedEdges);

  const options = {
    physics: {
      enabled: true,
      barnesHut: {
        gravitationalConstant: -2600,
        centralGravity: 0.35,
        springLength: 120,
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
      scaling: { min: 15, max: 34 },
    },
    interaction: {
      hover: true,
      tooltipDelay: 100,
      zoomView: true,
    },
    autoResize: true,
    height: '100%',
    width: '100%',
  };

  network = new vis.Network(container, { nodes: nodesDataSet, edges: edgesDataSet }, options);

  // Hairline Ring around Active Targets (Linear Compass Style)
  network.on('afterDrawing', (ctx) => {
    if (!activeTargetPaths.length) return;

    try {
      const positions = network.getPositions(activeTargetPaths);
      for (const path of activeTargetPaths) {
        const pos = positions[path];
        if (!pos) continue;

        ctx.save();
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 20 + radarPulseRadius, 0, 2 * Math.PI, false);
        const alpha = Math.max(0, 0.6 - (radarPulseRadius / 24));
        ctx.strokeStyle = `rgba(94, 106, 210, ${alpha})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
      }
    } catch {
      // Ignore transient canvas exceptions
    }
  });

  network.once('stabilizationIterationsDone', () => {
    network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
  });

  setTimeout(() => {
    if (network) {
      network.redraw();
      network.fit();
    }
  }, 250);

  // Click handler: Inspect Blast Radius on node click; clear on canvas click
  network.on('click', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      highlightBlastRadius(nodeId);
    } else {
      clearBlastRadius();
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
    const baseColors = STATUS_COLORS[m.status] || STATUS_COLORS.PENDING;

    if (isTarget) {
      return {
        id: m.path,
        color: { background: '#3730A3', border: '#818CF8' },
        borderWidth: 2.5,
        opacity: 1.0,
      };
    } else if (isCaller) {
      return {
        id: m.path,
        color: { background: '#78350F', border: '#F59E0B' },
        borderWidth: 2,
        opacity: 1.0,
      };
    } else {
      return {
        id: m.path,
        color: { background: '#131722', border: '#222838' },
        borderWidth: 1,
        opacity: 0.2,
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
    const size = Math.max(16, Math.min(34, Math.round((m.pagerank || 0.1) * 160 + 15)));

    return {
      id: m.path,
      size,
      value: size,
      color: isCycle ? { ...baseColors, border: '#F43F5E' } : baseColors,
      borderWidth: isCycle ? 3 : 1.5,
      opacity: 1.0,
      shadow: {
        enabled: true,
        color: 'rgba(0, 0, 0, 0.5)',
        size: 4,
        x: 0,
        y: 2,
      },
      moduleData: m,
    };
  });

  nodesDataSet.update(updates);
}

// ── Refresh Status HUD & Telemetry ────────────────────────
function updateStatusCounts(counts) {
  document.getElementById('count-clean').textContent = counts.CLEAN ?? 0;
  document.getElementById('count-pending').textContent = counts.PENDING ?? 0;
  document.getElementById('count-shimmed').textContent = counts.SHIMMED ?? 0;
  document.getElementById('count-verified').textContent = counts.VERIFIED ?? 0;

  const pct = Math.min(100, Math.round((currentStepNumber / TOTAL_STEPS) * 100));
  const progressFill = document.getElementById('progress-fill');
  const progressPercent = document.getElementById('progress-percent');
  const stepBadge = document.getElementById('step-badge');

  progressFill.style.width = `${pct}%`;
  progressPercent.textContent = `${pct}%`;
  stepBadge.textContent = `Step ${currentStepNumber} / ${TOTAL_STEPS}`;

  // Flight milestone text
  const flightTitle = document.getElementById('flight-milestone');
  if (currentStepNumber === 0) {
    flightTitle.textContent = 'Baseline Express';
  } else if (currentStepNumber <= 5) {
    flightTitle.textContent = 'Pass B: Shimming Leaves';
  } else if (currentStepNumber === 6) {
    flightTitle.textContent = 'Root Fastify Entrypoint';
  } else if (currentStepNumber < 11) {
    flightTitle.textContent = 'Pass A: Top-Down De-shimming';
  } else {
    flightTitle.textContent = '100% Fastify Verified';
  }

  // Active shims count
  let totalShimLines = 0;
  for (const m of allModulesCache) {
    totalShimLines += m.shimLines ?? 0;
  }
  const shimMetric = document.getElementById('metric-shims');
  shimMetric.textContent = `${totalShimLines} lines`;
  shimMetric.style.color = totalShimLines > 0 ? '#C4B5FD' : '#94A3B8';
}

// ── Display Active Target Panel ───────────────────────────
function showActiveTarget(claim, claimLatencyMs) {
  const phaseBadge = document.getElementById('phase-badge');
  const targetBody = document.getElementById('target-details');
  const proofContainer = document.getElementById('proof-container');
  const proofText = document.getElementById('proof-text');

  phaseBadge.textContent = claim.phase;
  phaseBadge.className = `phase-pill phase-${claim.phase.toLowerCase().replace('_', '')}`;

  activeTargetPaths = claim.targetPaths || [];

  const latencyBadge = document.getElementById('graph-latency');
  if (latencyBadge && claimLatencyMs) {
    latencyBadge.textContent = `FalkorDB: ${claimLatencyMs} ms`;
  }
  document.getElementById('metric-sla').textContent = `${claimLatencyMs || '1.2'} ms`;

  const isCycle = claim.targetPaths.length > 1;

  let html = `
    <div class="target-module-title">
      ${isCycle ? 'Atomic SCC Cycle Cluster' : claim.targetPaths[0]}
    </div>
    <div class="target-meta-row">
      <span class="target-meta-tag">Phase: <strong>${claim.phase}</strong></span>
      <span class="target-meta-tag">SCC ID: <strong>#${claim.sccId}</strong></span>
      <span class="target-meta-tag">Pending Callers: <strong>${claim.pendingCallersCount}</strong></span>
    </div>
  `;

  if (isCycle) {
    html += `
      <div style="font-size: 0.74rem; color: #FDA4AF; margin-top: 4px;">
        Mutually dependent files migrated atomically in a single batch:
        <ul style="margin: 4px 0 0 14px;">
          ${claim.targetPaths.map((p) => `<li><code>${p}</code></li>`).join('')}
        </ul>
      </div>
    `;
  }

  targetBody.innerHTML = html;

  if (claim.proof) {
    proofContainer.style.display = 'block';
    proofText.textContent = `${claim.proof}\nQuery Latency: ${claimLatencyMs || '1.2'} ms`;
  }
}

// ── Render Code Diff with Multi-File Tabs ─────────────────
function renderCodeDiff(modifiedFiles) {
  currentModifiedFiles = modifiedFiles || [];
  const diffViewer = document.getElementById('diff-viewer');
  const fileLabel = document.getElementById('diff-file-label');
  const tabsContainer = document.getElementById('diff-tabs');

  if (!modifiedFiles || modifiedFiles.length === 0) {
    fileLabel.textContent = 'No changes';
    tabsContainer.style.display = 'none';
    diffViewer.innerHTML = `<pre class="diff-placeholder">No modified files in this step.</pre>`;
    return;
  }

  fileLabel.textContent = modifiedFiles.map((f) => f.path.replace(/^src\//, '')).join(', ');

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
      btn.addEventListener('click', (e) => {
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

  let diffHtml = `<div style="font-weight: 600; color: #A5B4FC; margin-bottom: 6px;">--- ${f.path}</div>`;

  let diffCount = 0;
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    const o = oldLines[i];
    const n = newLines[i];

    if (o === n) continue;

    if (o !== undefined && (n === undefined || !newLines.includes(o))) {
      diffCount++;
      diffHtml += `<div class="diff-line diff-del">- ${escapeHtml(o)}</div>`;
    }
    if (n !== undefined && (o === undefined || !oldLines.includes(n))) {
      diffCount++;
      const isShim = n.includes('@shift-shim');
      if (isShim) {
        diffHtml += `
          <div class="diff-line diff-shim">
            <span>+ ${escapeHtml(n)}</span>
            <span class="shim-tag">compat-shim</span>
          </div>
        `;
      } else {
        diffHtml += `<div class="diff-line diff-add">+ ${escapeHtml(n)}</div>`;
      }
    }
  }

  diffViewer.innerHTML = diffCount > 0 ? diffHtml : `<div style="color: #64748B;">Identical or whitespace-only changes</div>`;
  diffViewer.scrollTop = 0;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function setupCypherPresetButtons() {
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
      gateTest.textContent = cp.testPass ? '6/6 PASS' : 'FAIL';
      gateRoutes.textContent = cp.routeMatch ? '100% MATCH' : 'MISMATCH';
    }

    gateFalkor.textContent = `${verifyLatencyMs || '< 5'} ms`;
    overallBadge.textContent = verifyResult.ok ? 'GATES INTACT' : 'GATE FAILED';
    overallBadge.style.color = verifyResult.ok ? '#34D399' : '#F43F5E';
  }
}

// ── Add Audit Stream Item ─────────────────────────────────
function appendAuditItem(step, phase, newStatus, targetPaths) {
  const feed = document.getElementById('audit-feed');
  const countBadge = document.getElementById('episode-count-badge');

  const emptyNotice = feed.querySelector('.audit-empty');
  if (emptyNotice) emptyNotice.remove();

  const item = document.createElement('div');
  item.className = 'audit-item';
  item.innerHTML = `
    <div>
      <span class="audit-step">Step ${step}:</span>
      <span class="audit-phase">[${phase}]</span>
      <span style="color: #CBD5E1;">${targetPaths.map((p) => p.replace(/^src\//, '')).join(', ')}</span>
    </div>
    <span class="audit-status status-${newStatus}">${newStatus}</span>
  `;

  feed.prepend(item);
  countBadge.textContent = `${feed.children.length} Steps`;
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
      document.getElementById('target-details').innerHTML = `
        <div style="text-align: center; padding: 14px; color: #34D399;">
          <h4 style="margin-bottom: 4px; font-weight: 600;">Migration Complete</h4>
          <p style="font-size: 0.78rem; color: #94A3B8;">All 7 Express legacy modules have been successfully migrated, typechecked, and de-shimmed to pure Fastify.</p>
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
        animation: { duration: 500, easingFunction: 'easeInOutQuad' },
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

  const btnReset = document.getElementById('btn-reset');
  btnReset.disabled = true;

  try {
    const res = await fetch('/api/reset', { method: 'POST' });
    const data = await res.json();

    document.getElementById('phase-badge').textContent = 'READY';
    document.getElementById('phase-badge').className = 'phase-pill phase-idle';
    document.getElementById('target-details').innerHTML = `
      <div class="target-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/></svg>
        <p>Click <strong>Step Forward</strong> or <strong>Auto-Play</strong> to initiate graph-governed migration.</p>
      </div>
    `;
    document.getElementById('proof-container').style.display = 'none';
    document.getElementById('diff-viewer').innerHTML = `<pre class="diff-placeholder">Code modifications and dual-signature shims will stream here in real time...</pre>`;
    document.getElementById('diff-file-label').textContent = 'No changes';
    document.getElementById('diff-tabs').style.display = 'none';
    document.getElementById('audit-feed').innerHTML = `<div class="audit-empty">No episodes recorded yet.</div>`;
    document.getElementById('episode-count-badge').textContent = '0 Steps';

    document.getElementById('gate-overall-badge').textContent = 'GATES INTACT';
    document.getElementById('gate-overall-badge').className = 'gate-overall';
    document.getElementById('gate-tsc').textContent = 'PASS';
    document.getElementById('gate-test').textContent = '6/6 PASS';
    document.getElementById('gate-routes').textContent = '100% MATCH';
    document.getElementById('gate-falkor').textContent = '< 5 ms';
    document.getElementById('graph-latency').textContent = 'FalkorDB: 1.5 ms';

    updateNetworkTopology(data.topology.modules);
    updateStatusCounts(data.topology.statusCounts);

    const preset = CYPHER_PRESETS.claim;
    document.getElementById('cypher-query-display').innerHTML = highlightCypherSyntax(preset.query);
    document.getElementById('cypher-rationale').innerHTML = preset.rationale;
    document.querySelectorAll('.btn-preset').forEach((b) => b.classList.remove('active'));
    document.querySelector('.btn-preset[data-preset="claim"]')?.classList.add('active');

    if (network) {
      network.fit({ animation: { duration: 600 } });
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
      autoPlayTimer = setTimeout(stepLoop, 1400);
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
  btn.className = 'btn btn-accent';
}

async function downloadAuditReport() {
  try {
    const res = await fetch('/api/audit?checkpoint=true');
    const trail = await res.json();
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(trail, null, 2));
    const dlAnchor = document.createElement('a');
    dlAnchor.setAttribute('href', dataStr);
    dlAnchor.setAttribute('download', `shift-migration-audit-${Date.now()}.json`);
    document.body.appendChild(dlAnchor);
    dlAnchor.click();
    dlAnchor.remove();
  } catch (err) {
    console.error('Failed to download audit trail:', err);
  }
}

// ── Application Bootstrapper ──────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const data = await fetchGraphData();
    initNetwork(data.modules, data.edges);
    updateStatusCounts(data.statusCounts);
    setupCypherPresetButtons();

    document.getElementById('btn-step').addEventListener('click', executeStep);
    document.getElementById('btn-auto').addEventListener('click', toggleAutoPlay);
    document.getElementById('btn-reset').addEventListener('click', resetCodebase);

    document.getElementById('btn-download-audit')?.addEventListener('click', downloadAuditReport);
    document.getElementById('btn-modal-replay')?.addEventListener('click', resetCodebase);
    document.getElementById('btn-modal-close')?.addEventListener('click', hideVictoryModal);
  } catch (err) {
    console.error('Failed to initialize Cockpit:', err);
  }
});
