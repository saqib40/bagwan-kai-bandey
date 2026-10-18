/**
 * Bagwan Kai Bandey — Minimalist Migration Cockpit Client (`public/app.js`).
 * Clean, distraction-free architecture powered by FalkorDB openCypher graph engine.
 */

// ── Status Color Mapping (High-Definition Light Palette) ──
const STATUS_COLORS = {
  CLEAN: { border: '#D4D4D8', background: '#FFFFFF', highlight: { border: '#09090B', background: '#F7F7F5' } },
  PENDING: { border: '#F59E0B', background: '#FFFBEB', highlight: { border: '#B45309', background: '#FEF3C7' } },
  IN_PROGRESS: { border: '#09090B', background: '#09090B', highlight: { border: '#09090B', background: '#18181B' } },
  SHIMMED: { border: '#A855F7', background: '#FAF5FF', highlight: { border: '#7E22CE', background: '#F3E8FF' } },
  VERIFIED: { border: '#10B981', background: '#ECFDF5', highlight: { border: '#047857', background: '#D1FAE5' } },
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

// ── Cytoscape.js & Dagre Graph Engine ─────────────────────
let cy = null;
let currentRankDir = 'TB'; // Top-Down layout per Master UI Overhaul
let currentStatusFilter = 'all';
let activeTraversalTimer = null;
let lastProofHops = [];

function initNetwork(modules, edges) {
  const container = document.getElementById('network-container');
  allModulesCache = modules;
  allEdgesCache = edges;

  if (typeof cytoscape === 'undefined') {
    console.error('Cytoscape.js is not loaded!');
    container.innerHTML = '<div style="color:#F43F5E;padding:20px;text-align:center;">Cytoscape.js failed to load.</div>';
    return;
  }

  // Group SCC cycle members (sccSize > 1) into compound parent clusters
  const sccClusters = new Map();
  for (const m of modules) {
    const sccId = m.sccId ?? 0;
    const sccSize = m.sccSize ?? 1;
    if (sccSize > 1) {
      if (!sccClusters.has(sccId)) {
        sccClusters.set(sccId, []);
      }
      sccClusters.get(sccId).push(m);
    }
  }

  const elements = [];

  // 1. Add Compound Parent Nodes for Circular Tarjan SCC Cycles
  for (const [sccId, members] of sccClusters) {
    elements.push({
      group: 'nodes',
      data: {
        id: `scc-cluster-${sccId}`,
        label: `Tarjan Cycle (SCC #${sccId} · ${members.length} modules)`,
        isCompoundParent: true,
      },
      classes: 'compound-scc-parent',
    });
  }

  // 2. Add Module Nodes
  for (const m of modules) {
    const isCycle = (m.sccSize ?? 1) > 1;
    const label = m.path.replace(/^src\//, '');
    const size = Math.max(28, Math.min(54, Math.round((m.pagerank || 0.1) * 160 + 26)));
    const parentId = isCycle ? `scc-cluster-${m.sccId}` : undefined;

    elements.push({
      group: 'nodes',
      data: {
        id: m.path,
        label,
        status: m.status,
        pagerank: Number(m.pagerank ?? 0),
        pendingCallers: Number(m.pendingCallers ?? 0),
        sccSize: Number(m.sccSize ?? 1),
        sccId: Number(m.sccId ?? 0),
        inDegree: Number(m.inDegree ?? 0),
        size,
        parent: parentId,
        fullPath: m.path,
        moduleData: m,
      },
      classes: `status-${m.status.toLowerCase()}${isCycle ? ' scc-member' : ''}${activeTargetPaths.includes(m.path) ? ' active-target' : ''}`,
    });
  }

  // 3. Add Import & Cycle Edges
  edges.forEach((e, idx) => {
    const isCycleEdge = (e.source.includes('audit') && e.target.includes('audit')) ||
      (modules.find(m => m.path === e.source)?.sccId === modules.find(m => m.path === e.target)?.sccId && (modules.find(m => m.path === e.source)?.sccSize ?? 1) > 1);

    elements.push({
      group: 'edges',
      data: {
        id: `edge-${idx}`,
        source: e.source,
        target: e.target,
        relationship: ':IMPORTS',
        isCycleEdge,
      },
      classes: `edge-imports${isCycleEdge ? ' cycle-edge' : ''}`,
    });
  });

  if (cy) {
    cy.destroy();
  }

  cy = cytoscape({
    container,
    elements,
    boxSelectionEnabled: false,
    autounselectify: false,
    style: [
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
          'transition-duration': '220ms',
        },
      },

      // 2. Pending Node State
      {
        selector: 'node[status="PENDING"], node.pending, node.status-pending',
        style: {
          'background-color': '#FFFFFF',
          'border-color': '#D4D4D8',
          'color': '#09090B',
        },
      },

      // 3. Active / Claimed / Hop-Active Node (Pure Black Pill with Crisp White Text)
      {
        selector: 'node[status="CLAIMED"], node.claimed, node.hop-active, node:selected, node.active-target, node.status-in_progress',
        style: {
          'background-color': '#09090B',
          'border-color': '#09090B',
          'border-width': 2.5,
          'color': '#FFFFFF',
          'z-index': 999,
        },
      },

      // 4. Verified Node State (Rich Emerald Tint)
      {
        selector: 'node[status="VERIFIED"], node.verified, node.status-verified',
        style: {
          'background-color': '#ECFDF5',
          'border-color': '#10B981',
          'border-width': 2,
          'color': '#065F46',
        },
      },

      // 5. Atomic Cycle Member Node (Crisp White with Refined Rose Border)
      {
        selector: 'node[status="CYCLE"], node.cycle, node.scc-member',
        style: {
          'background-color': '#FFFFFF',
          'border-color': '#F43F5E',
          'border-width': 1.5,
          'color': '#881337',
        },
      },

      // 6. SCC Compound Parent Box (Airy Rose Tint with Bottom Label to prevent edge collision)
      {
        selector: ':parent, node.cluster, node.scc-cluster, .compound-scc-parent',
        style: {
          'shape': 'round-rectangle',
          'background-color': '#FFF1F2',
          'background-opacity': 0.45,
          'border-color': '#FDA4AF',
          'border-width': 1.5,
          'border-style': 'dashed',
          'padding': 28,
          'label': 'data(label)',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 8,
          'font-family': 'Inter, sans-serif',
          'font-size': 11,
          'font-weight': 600,
          'color': '#BE123C',
        },
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
          'transition-duration': '220ms',
        },
      },

      // 8. Active Hop Traversal Edge
      {
        selector: 'edge.hop-active, edge.active, edge.hop-active-edge',
        style: {
          'width': 3,
          'line-color': '#09090B',
          'target-arrow-color': '#09090B',
          'line-style': 'dashed',
          'line-dash-pattern': [7, 4],
          'color': '#09090B',
          'font-weight': 700,
          'z-index': 999,
        },
      },

      // 9. SCC Cycle Edge
      {
        selector: 'edge.cycle-edge',
        style: {
          'width': 2.2,
          'line-color': '#F43F5E',
          'target-arrow-color': '#F43F5E',
          'line-style': 'dashed',
        },
      },

      // 10. Dimmed Non-Active Elements (Keep 100% Legible at 0.48 Opacity!)
      {
        selector: '.dimmed',
        style: {
          'opacity': 0.48,
        },
      },
    ],
  });

  runDagreLayout(false);

  // Click handler
  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    if (node.isParent()) return;
    const nodeId = node.id();
    highlightBlastRadius(nodeId);
    openNodeInspector(nodeId);
    inspectNodeInDiffViewer(nodeId);
    parseAndAnimateProof(null, [nodeId], { targetPaths: [nodeId], phase: 'INSPECT' });
  });

  // Background tap handler
  cy.on('tap', (evt) => {
    if (evt.target === cy) {
      clearBlastRadius();
      closeNodeInspector();
      renderMissionDeck();
    }
  });

  // Hover handlers
  cy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    if (node.isParent()) return;
    if (!blastRadiusActiveNode) {
      showFloatingHud(node.id());
    }
  });

  cy.on('mouseout', 'node', () => {
    if (!blastRadiusActiveNode) {
      hideFloatingHud();
    }
  });

  bindCanvasControls();

  // Backward compatibility object
  window.network = {
    fit: () => cy && cy.fit(undefined, 45),
    focus: (nodeId, opts) => {
      if (!cy) return;
      const el = cy.getElementById(nodeId);
      if (el && el.length) {
        cy.animate({ center: { eles: el }, zoom: 1.25 }, { duration: opts?.animation?.duration ?? 350 });
      }
    },
    redraw: () => {},
  };
}

// ── Run Dagre Hierarchical Layout ─────────────────────────
function runDagreLayout(animate = true) {
  if (!cy) return;
  const layout = cy.layout({
    name: 'dagre',
    rankDir: currentRankDir || 'TB', // Top-to-Bottom clean flow
    nodeSep: 60,
    rankSep: 78,
    animate: animate,
    animationDuration: 380,
    fit: true,
    padding: 45,
  });
  layout.run();
  setTimeout(() => {
    if (cy) cy.fit(undefined, 45);
  }, 450);
}

// ── Floating Canvas Controls & Filters ────────────────────
let canvasControlsBound = false;
function bindCanvasControls() {
  if (canvasControlsBound) return;
  canvasControlsBound = true;

  document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
    if (cy) cy.zoom({ level: cy.zoom() * 1.25, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  });

  document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
    if (cy) cy.zoom({ level: cy.zoom() * 0.8, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  });

  document.getElementById('btn-zoom-fit')?.addEventListener('click', () => {
    if (cy) cy.fit(undefined, 45);
  });

  document.getElementById('btn-toggle-direction')?.addEventListener('click', () => {
    currentRankDir = currentRankDir === 'BT' ? 'TB' : 'BT';
    runDagreLayout(true);
    showToast('Layout Orientation', `Switched layout to ${currentRankDir === 'BT' ? 'Callee-First (Bottom-Up)' : 'Top-Down'}`);
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const filter = chip.dataset.filter;
      currentStatusFilter = filter;
      applyStatusFilter(filter);
    });
  });

  // Search input
  document.getElementById('input-search-node')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!cy) return;
    if (!q) {
      applyStatusFilter(currentStatusFilter);
      return;
    }
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        if (n.isParent()) return;
        const match = n.id().toLowerCase().includes(q) || (n.data('label') || '').toLowerCase().includes(q);
        if (match) {
          n.removeClass('dimmed');
        } else {
          n.addClass('dimmed');
        }
      });
    });
  });

}

function applyStatusFilter(filter) {
  if (!cy) return;
  cy.batch(() => {
    cy.elements().removeClass('dimmed');
    if (filter === 'all') return;

    if (filter === 'cycles') {
      cy.nodes().forEach((n) => {
        if (n.isParent()) {
          n.removeClass('dimmed');
          return;
        }
        if ((n.data('sccSize') ?? 1) > 1) {
          n.removeClass('dimmed');
        } else {
          n.addClass('dimmed');
        }
      });
      return;
    }

    const targetStatus = filter.toUpperCase();
    cy.nodes().forEach((n) => {
      if (n.isParent()) return;
      if (n.data('status') === targetStatus) {
        n.removeClass('dimmed');
      } else {
        n.addClass('dimmed');
      }
    });
  });
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

// Computes a sequential path from an upstream entrypoint root down to targetId
function getCallerPathToTarget(targetId) {
  const path = [targetId];
  let curr = targetId;
  const visited = new Set([targetId]);

  while (true) {
    const parentEdges = allEdgesCache.filter((e) => e.target === curr && !visited.has(e.source));
    if (!parentEdges.length) break;
    // Prefer parent closer to root entrypoint (lowest inDegree)
    parentEdges.sort((a, b) => {
      const modA = allModulesCache.find((m) => m.path === a.source);
      const modB = allModulesCache.find((m) => m.path === b.source);
      return (modA?.inDegree ?? 99) - (modB?.inDegree ?? 99);
    });
    const parent = parentEdges[0].source;
    visited.add(parent);
    path.unshift(parent);
    curr = parent;
  }
  return path;
}

function highlightBlastRadius(nodeId) {
  blastRadiusActiveNode = nodeId;
  const callers = getTransitiveCallers(nodeId);
  const callersSet = new Set(callers);

  if (!cy) return;

  // Build clean sequential hop path from root down to clicked target module
  const chain = getCallerPathToTarget(nodeId);
  const hops = chain.map((p, i) => {
    const isTarget = i === chain.length - 1;
    let note = 'Caller';
    if (isTarget) {
      note = 'Target Module';
    } else if (i === 0) {
      note = 'Upstream Root';
    } else {
      note = `Caller (Hop ${i})`;
    }
    return {
      hopIndex: i + 1,
      nodeId: p,
      note,
    };
  });
  lastProofHops = hops;

  const mod = allModulesCache.find((m) => m.path === nodeId);
  renderHopPipeline(hops, { targetPaths: [nodeId], phase: mod?.status || 'INSPECT' }, currentStepNumber);

  animateTraversal(hops, {
    onComplete: () => {
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          if (n.isParent()) return;
          const p = n.id();
          if (p === nodeId) {
            n.removeClass('dimmed').addClass('active-target');
          } else if (callersSet.has(p)) {
            n.removeClass('dimmed').addClass('hop-active');
          } else {
            n.addClass('dimmed').removeClass('active-target hop-active');
          }
        });
        cy.edges().forEach((e) => {
          if (callersSet.has(e.source().id()) && (callersSet.has(e.target().id()) || e.target().id() === nodeId)) {
            e.removeClass('dimmed').addClass('hop-active-edge');
          } else {
            e.addClass('dimmed').removeClass('hop-active-edge');
          }
        });
      });
    },
  });

  showFloatingHud(nodeId, callers);
}

function clearBlastRadius() {
  blastRadiusActiveNode = null;
  if (activeTraversalTimer) {
    clearTimeout(activeTraversalTimer);
    activeTraversalTimer = null;
  }
  hideFloatingHud();
  if (cy) {
    cy.batch(() => {
      cy.elements().removeClass('dimmed hop-active hop-active-edge');
    });
  }
}

// ── Hop-by-Hop Sequential Traversal Animator ──────────────
function animateTraversal(hops, options = {}) {
  if (!cy || !hops || !hops.length) return;
  if (activeTraversalTimer) {
    clearTimeout(activeTraversalTimer);
    activeTraversalTimer = null;
  }

  // Dim all elements first
  cy.batch(() => {
    cy.elements().removeClass('dimmed hop-active hop-active-edge active-target');
    cy.elements().addClass('dimmed');
  });

  const stepMs = options.stepMs ?? 450;
  let idx = 0;

  function step() {
    if (idx >= hops.length) {
      document.querySelectorAll('#hop-pipeline .hop-card').forEach((c) => c.classList.remove('hop-pulse-active'));
      if (options.onComplete) options.onComplete();
      return;
    }

    const currentHop = hops[idx];
    const nodeEl = cy.getElementById(currentHop.nodeId);

    // Synchronize glowing pulse on upper panel hop card
    const hopCards = document.querySelectorAll('#hop-pipeline .hop-card');
    hopCards.forEach((c, cIdx) => {
      if (cIdx === idx) {
        c.classList.add('hop-pulse-active');
      } else {
        c.classList.remove('hop-pulse-active');
      }
    });

    cy.batch(() => {
      if (nodeEl && nodeEl.length) {
        nodeEl.removeClass('dimmed').addClass('hop-active');
      }

      if (currentHop.viaEdgeId) {
        const edgeEl = cy.getElementById(currentHop.viaEdgeId);
        if (edgeEl && edgeEl.length) {
          edgeEl.removeClass('dimmed').addClass('hop-active-edge');
        }
      } else if (idx > 0) {
        const prevHop = hops[idx - 1];
        const edgeEl = cy.edges(`[source = "${prevHop.nodeId}"][target = "${currentHop.nodeId}"]`)
          .union(cy.edges(`[source = "${currentHop.nodeId}"][target = "${prevHop.nodeId}"]`));
        if (edgeEl && edgeEl.length) {
          edgeEl.removeClass('dimmed').addClass('hop-active-edge');
        }
      }
    });

    const proofTextEl = document.getElementById('proof-text');
    const proofContainer = document.getElementById('proof-container');
    if (proofTextEl && proofContainer) {
      proofContainer.style.display = 'flex';
      proofTextEl.innerHTML = `<span style="color:#F59E0B;font-weight:600;">Hop ${idx + 1}/${hops.length}:</span> ${currentHop.nodeId.replace(/^src\//, '')} ${currentHop.note ? `<span style="color:#94A3B8;">(${currentHop.note})</span>` : ''}`;
    }

    idx++;
    activeTraversalTimer = setTimeout(step, stepMs);
  }

  step();
}

// ── Human-Readable Module Metadata ────────────────────────
function getHumanModuleInfo(path) {
  const short = (path || '').replace(/^src\//, '');
  if (short === 'server.ts') {
    return {
      role: 'Root Server',
      summary: 'Entrypoint: binds the HTTP listener and loads application routes.',
      layer: 'Root Entrypoint',
    };
  }
  if (short === 'app.ts') {
    return {
      role: 'App Router',
      summary: 'Central router: dispatches incoming requests to orders and users handlers.',
      layer: 'Router Layer',
    };
  }
  if (short.includes('orders.ts')) {
    return {
      role: 'Orders Service',
      summary: 'Handles order checkout; calls Auth middleware on every request.',
      layer: 'Route Handler',
    };
  }
  if (short.includes('users.ts')) {
    return {
      role: 'Users Service',
      summary: 'Manages user accounts; requires authentication token verification.',
      layer: 'Route Handler',
    };
  }
  if (short.includes('auth.ts')) {
    return {
      role: 'Auth Middleware',
      summary: 'Validates API keys and formats error envelopes via response helper.',
      layer: 'Security Middleware',
    };
  }
  if (short.includes('auditA.ts')) {
    return {
      role: 'Audit Service A',
      summary: 'Circular loop with auditB.ts. Formats request telemetry headers.',
      layer: 'Service Layer (Cycle)',
    };
  }
  if (short.includes('auditB.ts')) {
    return {
      role: 'Audit Service B',
      summary: 'Circular loop with auditA.ts. Computes telemetry request hashes.',
      layer: 'Service Layer (Cycle)',
    };
  }
  if (short.includes('response.ts')) {
    return {
      role: 'Response Formatter',
      summary: 'Foundation helper for JSON responses and errors. Zero outgoing dependencies!',
      layer: 'Foundation Leaf',
    };
  }
  if (short.includes('hash.ts')) {
    return {
      role: 'Hash Utility',
      summary: 'Cryptographic hashing helper for tokens and identifiers.',
      layer: 'Foundation Leaf',
    };
  }
  return {
    role: 'Module',
    summary: `Source module at ${short}.`,
    layer: 'Codebase Module',
  };
}

// ── Plain-English Step Narrative Generator ─────────────────
function getStepStory(claim, stepNum) {
  if (!claim || !claim.targetPaths || !claim.targetPaths.length) return null;
  const paths = claim.targetPaths.map((p) => p.replace(/^src\//, ''));
  const phase = claim.phase || 'SHIM';
  const isCycle = paths.length > 1;

  if (phase === 'INSPECT') {
    const info = getHumanModuleInfo(paths[0]);
    return {
      title: `Inspecting: ${info.role} (${paths[0]})`,
      why: info.summary,
      what: `Architectural Layer: ${info.layer}. Click 'Step' or 'Auto Play' above to run the verified migration pipeline.`,
      guarantee: `Topological guard: FalkorDB ensures this module is only migrated when safe.`,
    };
  }

  if (phase === 'SHIM') {
    if (isCycle) {
      return {
        title: `Step ${stepNum}: Circular Loop (${paths.join(' ↔ ')})`,
        why: `These ${paths.length} files depend on each other in a mutual cycle. Migrating them separately would break the compiler. We transform both simultaneously in this atomic step.`,
        what: `Added dual-signature Fastify support while preserving internal circular Express imports.`,
        guarantee: `Zero broken imports: circular references stay intact throughout migration.`,
      };
    }
    if (paths[0].includes('response')) {
      return {
        title: `Step ${stepNum}: Foundation Response Leaf`,
        why: `This module has zero dependencies. Migrating foundation leaves first ensures no underlying code breaks when callers above are migrated.`,
        what: `Converted JSON response helpers to Fastify with dual-signature Express fallback bridges.`,
        guarantee: `Express callers (auth, routes) continue functioning without any modifications.`,
      };
    }
    if (paths[0].includes('auth')) {
      return {
        title: `Step ${stepNum}: Authentication Middleware`,
        why: `Auth is called by route handlers (orders, users). Shimmed before routes so incoming Fastify and legacy Express requests can both be authenticated.`,
        what: `Updated requireAuth() to accept FastifyRequest / FastifyReply alongside Express req / res.`,
        guarantee: `Upstream route callers can now accept both frameworks safely.`,
      };
    }
    return {
      title: `Step ${stepNum}: Route Handler (${paths[0]})`,
      why: `Underlying middleware is prepared. We now add the Fastify route handler while preserving legacy Express routing.`,
      what: `Converted route handler signatures to Fastify plugin format with compat-shim fallback.`,
      guarantee: `All HTTP routes maintain 100% parameter and header parity.`,
    };
  } else if (phase === 'DE_SHIM') {
    return {
      title: `Step ${stepNum}: Clean Up Legacy Shims (${paths.join(', ')})`,
      why: `All callers above this module have been verified on Fastify. Temporary backward-compatibility bridges are no longer needed.`,
      what: `Removed @bkb-shim fallback branches and Express types. Pure Fastify code remains.`,
      guarantee: `Codebase simplified to native Fastify with zero runtime regressions.`,
    };
  } else {
    return {
      title: `Step ${stepNum}: Main Application Server Cutover`,
      why: `All underlying routes and services are dual-compatible. It is now safe to switch the root HTTP server from Express to native Fastify.`,
      what: `Switched HTTP listener in app.ts to fastify.listen().`,
      guarantee: `All 6 API routes continue passing integration tests.`,
    };
  }
}

// ── Render Vertical Hop Pipeline ──────────────────────────
function renderHopPipeline(hops, claim, stepNum) {
  const container = document.getElementById('hop-pipeline');
  const storyCard = document.getElementById('step-story-card');
  if (!container) return;

  if (!hops || !hops.length) {
    container.innerHTML = `
      <div class="journey-empty-state-editorial">
        <div class="empty-state-header">
          <div class="empty-state-title">Topological Migration Stepper</div>
          <div class="empty-state-desc">
            Click <strong>Step</strong> above or tap any module on the graph to watch the sequential caller-to-target dependency traversal in real time.
          </div>
        </div>
        <div class="editorial-principles-list">
          <div class="editorial-principle-item">
            <span class="principle-number">1</span>
            <div class="principle-content">
              <strong>Leaves First:</strong> Modules with 0 outgoing dependencies are migrated first so upstream callers never break.
            </div>
          </div>
          <div class="editorial-principle-item">
            <span class="principle-number">2</span>
            <div class="principle-content">
              <strong>Atomic Cycles:</strong> Circular dependencies (auditA ↔ auditB) are migrated together to prevent compile errors.
            </div>
          </div>
          <div class="editorial-principle-item">
            <span class="principle-number">3</span>
            <div class="principle-content">
              <strong>100% Gate Verification:</strong> TypeScript compiler &amp; 6/6 route tests run before and after every step.
            </div>
          </div>
        </div>
      </div>
    `;
    if (storyCard) storyCard.style.display = 'none';
    return;
  }

  const targetPath = (claim?.targetPaths && claim.targetPaths[0]) || hops[hops.length - 1].nodeId;
  const isTarget = (id) => claim?.targetPaths?.includes(id) || id === targetPath;

  let html = '';
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
    const isTargetHop = isTarget(h.nodeId);
    const info = getHumanModuleInfo(h.nodeId);
    const short = h.nodeId.replace(/^src\//, '');
    const numStr = (i + 1).toString().padStart(2, '0');

    let badgeClass = 'hop-pill-caller';
    let badgeText = 'Caller';
    if (isTargetHop) {
      badgeClass = 'hop-pill-target';
      badgeText = claim?.phase || 'Target';
    } else if (h.note?.toLowerCase().includes('root')) {
      badgeClass = 'hop-pill-root';
      badgeText = 'Root';
    } else {
      badgeClass = 'hop-pill-caller';
      badgeText = 'Caller';
    }

    const mod = allModulesCache.find((m) => m.path === h.nodeId);
    const layerText = info.layer || 'Module';
    const roleText = h.note || info.role || 'Dependency';
    const isVerified = mod?.status === 'VERIFIED';
    const statusText = isVerified
      ? 'Verified'
      : (isTargetHop
          ? (mod?.status === 'PENDING' ? '0 Blockers' : (mod?.status || 'Active Target'))
          : (mod?.status || 'Active'));
    const statusClass = isVerified
      ? 'text-status-verified'
      : (isTargetHop ? 'text-status-target' : '');

    html += `
      <div class="hop-node-row ${isTargetHop ? 'target-row' : ''}">
        <div class="hop-card ${isTargetHop ? 'active-target-hop' : ''}" data-node-id="${escapeHtml(h.nodeId)}" title="Click to locate on graph">
          <div class="hop-card-top">
            <div class="hop-card-identity">
              <span class="hop-index-pill">${numStr}</span>
              <span class="hop-card-path" title="${escapeHtml(short)}">${escapeHtml(short)}</span>
            </div>
            <span class="hop-card-pill ${badgeClass}">${escapeHtml(badgeText)}</span>
          </div>
          <div class="hop-card-bottom">
            <span class="hop-card-meta">${escapeHtml(layerText)} • ${escapeHtml(roleText)}</span>
            <span class="hop-card-status ${statusClass}">${escapeHtml(statusText)}</span>
          </div>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;

  container.querySelectorAll('.hop-card').forEach((card) => {
    card.addEventListener('click', () => {
      const nodeId = card.getAttribute('data-node-id');
      if (nodeId && network) {
        network.focus(nodeId, { scale: 1.2, animation: { duration: 350 } });
        highlightBlastRadius(nodeId);
      }
    });
  });

  if (storyCard) {
    storyCard.style.display = 'none';
  }
}

// ── Proof Traversal Parser & Animator ─────────────────────
function parseAndAnimateProof(proofStr, targetPaths, claimObj) {
  if (!proofStr && (!targetPaths || !targetPaths.length)) return;

  const match = proofStr && proofStr.match(/Dependency proof:\s*([^\r\n]+)/);
  if (match) {
    const parts = match[1].split('→').map((s) => s.trim());
    const hops = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const found = allModulesCache.find((m) => {
        const shortM = m.path.replace(/^src\//, '').replace(/\.[^/.]+$/, '');
        return shortM === p || m.path.includes(p) || p.includes(shortM);
      });
      if (found) {
        hops.push({
          hopIndex: i + 1,
          nodeId: found.path,
          note: i === parts.length - 1 ? 'Target Module' : (i === 0 ? 'Upstream Root' : 'Caller'),
        });
      }
    }
    if (hops.length > 0) {
      if (targetPaths) {
        targetPaths.forEach((tp) => {
          if (!hops.some((h) => h.nodeId === tp)) {
            hops.push({
              hopIndex: hops.length + 1,
              nodeId: tp,
              note: targetPaths.length > 1 ? 'Atomic Cycle Target' : 'Target Module',
            });
          }
        });
      }
      lastProofHops = hops;
      renderHopPipeline(hops, claimObj || { targetPaths }, currentStepNumber);
      animateTraversal(hops);
      return;
    }
  }

  // Fallback: if no linear proof chain or for Tarjan SCC cycles / de-shim
  if (targetPaths && targetPaths.length > 0) {
    const target = targetPaths[0];
    const chain = getCallerPathToTarget(target);
    const hops = chain.map((nodeId, i) => {
      const isTargetNode = targetPaths.includes(nodeId) || i === chain.length - 1;
      let note = 'Caller';
      if (isTargetNode) {
        note = targetPaths.length > 1 ? 'Atomic Cycle Target' : 'Target Module';
      } else if (i === 0) {
        note = 'Upstream Root';
      }
      return {
        hopIndex: i + 1,
        nodeId,
        note,
      };
    });
    targetPaths.forEach((tp) => {
      if (!hops.some((h) => h.nodeId === tp)) {
        hops.push({
          hopIndex: hops.length + 1,
          nodeId: tp,
          note: 'Atomic Cycle Target',
        });
      }
    });

    lastProofHops = hops;
    renderHopPipeline(hops, claimObj || { targetPaths }, currentStepNumber);
    animateTraversal(hops);
  }
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
  if (!cy) return;

  cy.batch(() => {
    for (const m of modules) {
      const node = cy.getElementById(m.path);
      if (node && node.length) {
        node.data('status', m.status);
        node.data('pagerank', Number(m.pagerank ?? 0));
        node.data('pendingCallers', Number(m.pendingCallers ?? 0));
        node.classes(`status-${m.status.toLowerCase()}${(m.sccSize ?? 1) > 1 ? ' scc-member' : ''}${activeTargetPaths.includes(m.path) ? ' active-target' : ''}`);
      }
    }
  });
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
  if (stepBadge) stepBadge.textContent = `${migratedCount} of ${total} verified`;

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
  // Disabled: toast update notifications removed per user request
  return;
}

// ── Mission Control Deck for Idle State ───────────────────
function renderMissionDeck() {
  const targetTitle = document.getElementById('target-title');
  const targetEyebrow = document.getElementById('target-eyebrow');
  const phaseBadge = document.getElementById('phase-badge');
  const diffFileLabel = document.getElementById('diff-file-label');
  const diffTabs = document.getElementById('diff-tabs');
  const diffViewer = document.getElementById('diff-viewer');
  const proofContainer = document.getElementById('proof-container');

  if (targetEyebrow) {
    targetEyebrow.textContent = 'MIGRATION PIPELINE';
  }
  if (targetTitle) {
    targetTitle.textContent = 'Topological Migration Stepper';
    targetTitle.title = 'Topological Migration Stepper';
  }
  if (phaseBadge) {
    phaseBadge.textContent = 'READY';
    phaseBadge.className = 'phase-pill phase-idle';
  }
  if (diffFileLabel) diffFileLabel.style.display = 'none';
  if (diffTabs) diffTabs.style.display = 'none';
  if (proofContainer) proofContainer.style.display = 'none';

  const storyCard = document.getElementById('step-story-card');
  if (storyCard) storyCard.style.display = 'none';

  renderHopPipeline([], null, 0);

  if (diffViewer) {
    diffViewer.innerHTML = `
      <div class="target-empty">
        <p>Ready to migrate. Click <strong>Step</strong> above to view live code transformations.</p>
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

    const targetEyebrow = document.getElementById('target-eyebrow');
    if (targetEyebrow) targetEyebrow.textContent = 'INSPECTING';
    const cleanId = nodeId.replace(/^src\//, '');
    const titleEl = document.getElementById('target-title');
    if (titleEl) {
      titleEl.textContent = cleanId;
      titleEl.title = cleanId;
    }
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
  const targetEyebrow = document.getElementById('target-eyebrow');
  const phaseBadge = document.getElementById('phase-badge');
  const diffFileLabel = document.getElementById('diff-file-label');
  const proofContainer = document.getElementById('proof-container');
  const proofText = document.getElementById('proof-text');

  if (!claim) return;

  if (phaseBadge) {
    phaseBadge.textContent = claim.phase;
    phaseBadge.className = `phase-pill phase-${claim.phase.toLowerCase().replace('_', '')}`;
  }

  activeTargetPaths = claim.targetPaths || [];

  const isCycle = claim.targetPaths.length > 1;
  const paths = claim.targetPaths.map((p) => p.replace(/^src\//, ''));
  const firstPath = claim.targetPaths[0] || '';
  const human = getHumanModuleInfo(firstPath);

  if (targetEyebrow) {
    targetEyebrow.textContent = isCycle ? 'ATOMIC CYCLE' : 'TARGET MODULE';
  }

  if (targetTitle) {
    const fullTargetText = paths.join(' ↔ ');
    targetTitle.textContent = fullTargetText;
    targetTitle.title = fullTargetText;
  }

  if (diffFileLabel) {
    diffFileLabel.style.display = 'none';
  }

  const latencyBadge = document.getElementById('graph-latency');
  if (latencyBadge && claimLatencyMs) {
    latencyBadge.textContent = `FalkorDB: ${claimLatencyMs} ms`;
  }
  const falkorGate = document.getElementById('gate-falkor');
  if (falkorGate) falkorGate.textContent = `${claimLatencyMs || '< 2'} ms`;

  if (claim.proof && proofText && proofContainer) {
    proofContainer.style.display = 'flex';
    const lines = claim.proof.split('\n').filter(Boolean);
    const depLine = lines.find((l) => l.includes('Dependency proof:') || l.includes('Target module(s):') || l.includes('pending_callers_count')) || lines[0] || 'Topological claim verified';
    proofText.textContent = `${depLine} (${claimLatencyMs || '1.2'} ms)`;
  } else if (proofContainer) {
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

// ── Longest Common Subsequence Diff Engine ─────────────────
function computeLCSDiff(oldLines, newLines) {
  const m = oldLines.length;
  const n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (oldLines[i] === newLines[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  let i = m;
  let j = n;
  const diff = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({ type: 'same', oldNum: i, newNum: j, text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'add', oldNum: null, newNum: j, text: newLines[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      diff.unshift({ type: 'del', oldNum: i, newNum: null, text: oldLines[i - 1] });
      i--;
    }
  }

  return diff;
}

function filterDiffHunks(diff, contextRadius = 3) {
  const changedIndices = new Set();
  diff.forEach((entry, idx) => {
    if (entry.type !== 'same') {
      for (let k = Math.max(0, idx - contextRadius); k <= Math.min(diff.length - 1, idx + contextRadius); k++) {
        changedIndices.add(k);
      }
    }
  });

  if (changedIndices.size === 0) return [];

  const result = [];
  let inHunk = false;

  for (let i = 0; i < diff.length; i++) {
    if (changedIndices.has(i)) {
      if (!inHunk) {
        inHunk = true;
        const entry = diff[i];
        result.push({
          type: 'hunk',
          text: `@@ -${entry.oldNum || 1} +${entry.newNum || 1} @@`,
        });
      }
      result.push(diff[i]);
    } else {
      inHunk = false;
    }
  }

  return result;
}

function renderSingleFileDiff(f) {
  const diffViewer = document.getElementById('diff-viewer');
  if (!diffViewer || !f) return;

  const oldLines = (f.oldCode || '').split('\n');
  const newLines = (f.newCode || '').split('\n');
  const shortPath = (f.path || '').replace(/^src\//, '');

  const rawDiff = computeLCSDiff(oldLines, newLines);
  const hunks = filterDiffHunks(rawDiff, 3);

  const addsCount = rawDiff.filter((r) => r.type === 'add').length;
  const delsCount = rawDiff.filter((r) => r.type === 'del').length;

  if (addsCount === 0 && delsCount === 0) {
    diffViewer.innerHTML = `
      <div class="diff-card-wrapper">
        <div class="diff-file-card-header">
          <div class="diff-file-meta">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="diff-file-name">${escapeHtml(shortPath)}</span>
          </div>
          <span style="color: #64748B; font-size: 0.68rem;">Identical / No AST Changes</span>
        </div>
      </div>
    `;
    return;
  }

  let rowsHtml = '';
  for (const item of hunks) {
    if (item.type === 'hunk') {
      rowsHtml += `
        <div class="diff-row diff-row-hunk">
          <span>${escapeHtml(item.text)}</span>
        </div>
      `;
      continue;
    }

    const oldGutter = item.oldNum !== null ? item.oldNum : '';
    const newGutter = item.newNum !== null ? item.newNum : '';
    const isAdd = item.type === 'add';
    const isDel = item.type === 'del';
    const isShim = isAdd && (item.text.includes('@bkb-shim') || item.text.includes('@shift-shim'));

    let rowClass = 'diff-row diff-row-same';
    let sign = ' ';
    if (isDel) {
      rowClass = 'diff-row diff-row-del';
      sign = '-';
    } else if (isShim) {
      rowClass = 'diff-row diff-row-shim';
      sign = '+';
    } else if (isAdd) {
      rowClass = 'diff-row diff-row-add';
      sign = '+';
    }

    rowsHtml += `
      <div class="${rowClass}">
        <span class="diff-gutter-old">${oldGutter}</span>
        <span class="diff-gutter-new">${newGutter}</span>
        <span class="diff-sign">${sign}</span>
        <span class="diff-text">${escapeHtml(item.text)}${isShim ? '<span class="shim-tag">compat-shim</span>' : ''}</span>
      </div>
    `;
  }

  diffViewer.innerHTML = `
    <div class="diff-card-wrapper">
      <div class="diff-file-card-header">
        <div class="diff-file-meta">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          <span class="diff-file-name">${escapeHtml(shortPath)}</span>
        </div>
        <div class="diff-stats-pills">
          <span class="diff-stat-add">+${addsCount}</span>
          <span class="diff-stat-del">-${delsCount}</span>
        </div>
      </div>
      <div class="diff-table">
        ${rowsHtml}
      </div>
    </div>
  `;
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

// ── Standby Flight Deck Overlay Helpers ────────────────────
function dismissStandby() {
  document.body.classList.remove('standby-phase');
  const dock = document.getElementById('standby-dock') || document.getElementById('standby-overlay');
  if (dock) {
    dock.classList.add('dismissed');
    dock.style.display = 'none';
  }
  const legDock = document.querySelector('.graph-floating-dock');
  if (legDock) legDock.classList.remove('dock-hidden');
  if (window.cy) {
    setTimeout(() => {
      try {
        window.cy.resize();
        window.cy.fit(undefined, 40);
      } catch {}
    }, 150);
  }
}

function showStandby() {
  const dock = document.getElementById('standby-dock') || document.getElementById('standby-overlay');
  if (dock) {
    dock.style.display = 'flex';
    dock.classList.remove('dismissed');
  }
}

function checkStandbyState(modules) {
  // Always dismiss standby dock when graph is loaded, keeping sidebar and full cockpit visible
  dismissStandby();
}

function setupStandbyDeck() {
  const btnCopy = document.getElementById('btn-copy-prompt');
  const copyText = document.getElementById('btn-copy-text');
  const promptIconCopy = document.getElementById('prompt-icon-copy');
  const promptIconCheck = document.getElementById('prompt-icon-check');
  const promptText = document.getElementById('agent-prompt-text');
  const btnDismiss = document.getElementById('btn-dismiss-standby');
  const btnShow = document.getElementById('btn-show-standby');
  const btnCopyCmd = document.getElementById('btn-copy-dock-cmd');
  const cmdRun = document.getElementById('cmd-run-code');
  const chipIcon = document.getElementById('dock-chip-icon');
  const chipCheck = document.getElementById('dock-chip-check');

  btnCopy?.addEventListener('click', async () => {
    if (!promptText) return;
    const textToCopy = promptText.textContent.trim();
    try {
      await navigator.clipboard.writeText(textToCopy);
      btnCopy.classList.add('copied');
      if (promptIconCopy) promptIconCopy.style.display = 'none';
      if (promptIconCheck) promptIconCheck.style.display = 'inline-block';
      setTimeout(() => {
        btnCopy.classList.remove('copied');
        if (promptIconCopy) promptIconCopy.style.display = 'inline-block';
        if (promptIconCheck) promptIconCheck.style.display = 'none';
      }, 1800);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(promptText);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });

  btnCopyCmd?.addEventListener('click', async () => {
    const textToCopy = cmdRun ? cmdRun.textContent.trim() : 'bkb run';
    try {
      await navigator.clipboard.writeText(textToCopy);
      btnCopyCmd.classList.add('copied');
      if (chipIcon) chipIcon.style.display = 'none';
      if (chipCheck) chipCheck.style.display = 'inline-block';
      setTimeout(() => {
        btnCopyCmd.classList.remove('copied');
        if (chipIcon) chipIcon.style.display = 'inline-block';
        if (chipCheck) chipCheck.style.display = 'none';
      }, 1800);
    } catch {
      // fallback
    }
  });

  btnDismiss?.addEventListener('click', dismissStandby);
  btnShow?.addEventListener('click', showStandby);
}

function setupControlsDrawer() {
  const toggleBtn = document.getElementById('btn-toggle-controls');
  const drawer = document.getElementById('controls-drawer');
  const arrow = document.getElementById('controls-arrow');

  if (!toggleBtn || !drawer) return;

  toggleBtn.addEventListener('click', () => {
    const isOpen = drawer.style.display !== 'none';
    drawer.style.display = isOpen ? 'none' : 'block';
    if (arrow) arrow.textContent = isOpen ? '▾' : '▴';

    setTimeout(() => {
      if (cy) cy.resize();
    }, 50);
  });
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
  const stepInd = document.getElementById('roadmap-step-indicator');
  if (!feed) return;

  if (stepInd) {
    stepInd.textContent = `Step ${currentStepNumber} of ${TOTAL_STEPS}`;
  }

  if (!episodes || episodes.length === 0) {
    feed.innerHTML = `
      <div class="roadmap-empty-state">
        <div class="roadmap-empty-icon">✓</div>
        <div class="roadmap-empty-title">All Invariants Guarded</div>
        <div class="roadmap-empty-desc">Click Step above to advance through the 11-stage verified migration roadmap.</div>
      </div>
    `;
    return;
  }

  // Render episodes in descending order (newest first)
  const sorted = [...episodes].reverse();
  feed.innerHTML = sorted
    .map((ep) => {
      const paths = (ep.modules || []).map((m) => m.replace(/^src\//, '')).join(' + ');
      const rawModulePaths = (ep.modules || []).join(',');
      const phaseStr = ep.phase || 'MIGRATE';
      const statusClass = (ep.newStatus || 'VERIFIED').replace(/[^A-Za-z0-9_-]/g, '');
      return `
        <div class="roadmap-item" data-modules="${escapeHtml(rawModulePaths)}" title="Click to inspect module on graph">
          <div style="display:flex;align-items:center;gap:6px;overflow:hidden;">
            <span class="roadmap-step">#${ep.step}</span>
            <span class="roadmap-phase">${escapeHtml(phaseStr)}</span>
            <span class="roadmap-path" title="${escapeHtml(paths)}">${escapeHtml(paths)}</span>
          </div>
          <div class="audit-status status-${statusClass}">✓ ${escapeHtml(ep.newStatus || 'VERIFIED')}</div>
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
  const btnStepCard = document.getElementById('btn-step-card');
  if (btnStep) btnStep.disabled = true;
  if (btnStepCard) btnStepCard.disabled = true;

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

    if (data.claim) {
      parseAndAnimateProof(data.claim.proof, data.claim.targetPaths, data.claim);
    }

    return true;
  } catch (err) {
    console.error('Step failed:', err);
    stopAutoPlay();
    return false;
  } finally {
    if (btnStep) btnStep.disabled = false;
    if (btnStepCard) btnStepCard.disabled = false;
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

// ── Node Inspector Drawer & Panel 2 Dossier ───────────────
async function openNodeInspector(nodeId) {
  activeDrawerNode = nodeId;

  // Populate Panel 2 Dossier
  const dossier = document.getElementById('node-dossier');
  const roadmap = document.getElementById('migration-roadmap-view');
  if (dossier && roadmap) {
    dossier.style.display = 'flex';
    roadmap.style.display = 'none';

    const info = getHumanModuleInfo(nodeId);
    const mod = allModulesCache.find((m) => m.path === nodeId);

    const layerEl = document.getElementById('dossier-layer');
    if (layerEl) layerEl.textContent = info.layer;

    const fileEl = document.getElementById('dossier-file');
    if (fileEl) fileEl.textContent = nodeId.replace(/^src\//, '');

    const statusEl = document.getElementById('dossier-status-text');
    if (statusEl) statusEl.textContent = mod?.status || 'PENDING';

    const loopAlert = document.getElementById('dossier-loop-alert');
    const loopText = document.getElementById('dossier-loop-text');
    if (loopAlert && loopText) {
      if ((mod?.sccSize ?? 1) > 1) {
        loopAlert.style.display = 'flex';
        loopText.textContent = `2-File Circular Loop: Mutually imports peer module. Migrated simultaneously at Step 3 to prevent broken references.`;
      } else {
        loopAlert.style.display = 'none';
      }
    }

    const callers = getTransitiveCallers(nodeId);
    const countEl = document.getElementById('dossier-callers-count');
    if (countEl) countEl.textContent = `${callers.length} File${callers.length !== 1 ? 's' : ''}`;

    const chipsEl = document.getElementById('dossier-callers-chips');
    if (chipsEl) {
      if (callers.length > 0) {
        chipsEl.innerHTML = callers.map((c) => `<span class="jump-chip" data-node-path="${escapeHtml(c)}">${escapeHtml(c.replace(/^src\//, ''))}</span>`).join('');
      } else {
        chipsEl.innerHTML = '<span style="color:#64748B;font-size:0.68rem;">None (Zero callers affected)</span>';
      }
    }
  }

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
  const dossier = document.getElementById('node-dossier');
  const roadmap = document.getElementById('migration-roadmap-view');
  if (dossier) dossier.style.display = 'none';
  if (roadmap) roadmap.style.display = 'flex';
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
  const navSlash = document.getElementById('nav-pack-slash');
  const navPack = document.getElementById('nav-pack-name');
  const langBadge = document.getElementById('nav-pack-lang');
  const shimBadge = document.getElementById('nav-pack-shim');

  if (pack && pack.id) {
    if (navSlash) navSlash.style.display = 'inline';
    if (navPack) {
      navPack.textContent = pack.id;
      navPack.style.display = 'inline';
    }
    if (langBadge && pack.language) {
      const formattedLang = pack.language.charAt(0).toUpperCase() + pack.language.slice(1);
      langBadge.textContent = formattedLang;
      langBadge.style.display = 'inline-flex';
    }
    if (shimBadge && pack.shimStrategy) {
      shimBadge.textContent = pack.shimStrategy;
      shimBadge.style.display = 'none';
    }

    // Update Standby CLI commands with actual active pack
    const cmdRun = document.getElementById('cmd-run-code');
    if (cmdRun) {
      cmdRun.textContent = `bkb run --pack ${pack.id}`;
    }
  } else {
    if (navSlash) navSlash.style.display = 'none';
    if (navPack) navPack.style.display = 'none';
    if (langBadge) langBadge.style.display = 'none';
  }
}

async function loadSystemInfo() {
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    currentAppInfo = info;

    const navRepo = document.getElementById('nav-repo-name');
    if (navRepo && info.displayRepo) {
      const repoClean = info.isDemoRepo ? 'demo-repo' : (info.displayRepo.split('/').filter(Boolean).pop() || 'codebase');
      navRepo.textContent = repoClean;
      navRepo.style.display = 'inline';
    }
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

  // Any active telemetry event from CLI or AI agent automatically awakens the flight deck
  if (event.type === 'claim' || event.type === 'verify' || event.type === 'step' || event.type === 'complete') {
    dismissStandby();
  } else if (event.type === 'reset') {
    showStandby();
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
    if (event.targetPaths?.length) {
      activeTargetPaths = event.targetPaths;
      if (cy) {
        cy.batch(() => {
          cy.nodes().removeClass('active-target');
          event.targetPaths.forEach((path) => {
            const node = cy.getElementById(path);
            if (node && node.length) {
              node.addClass('active-target');
            }
          });
        });
      }

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

      // Update Topological Hops immediately for active claim
      const claimObj = {
        targetPaths: event.targetPaths,
        phase: event.phase || 'MIGRATE',
        proof: event.proof,
      };
      parseAndAnimateProof(event.proof, event.targetPaths, claimObj);

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
    const diffFileLabel = document.getElementById('diff-file-label');
    if (diffFileLabel) diffFileLabel.style.display = 'none';

    const phaseBadge = document.getElementById('phase-badge');
    if (phaseBadge) {
      phaseBadge.textContent = event.status || 'VERIFIED';
      phaseBadge.className = 'phase-pill status-VERIFIED';
    }

    // Refresh next unblocked claim in Topological Hops
    await loadInitialTopologicalState();

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
    if (event.targetPaths?.length && cy) {
      cy.batch(() => {
        event.targetPaths.forEach((path) => {
          const node = cy.getElementById(path);
          if (node && node.length) {
            node.addClass('node-failed');
          }
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
  const modal = document.getElementById('project-settings-modal');
  if (!modal) return;
  const btnOpen = document.getElementById('btn-project-settings');
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

function setupViewSwitchTabs() {
  const btnHops = document.getElementById('tab-btn-hops');
  const btnDiff = document.getElementById('tab-btn-diff');
  const journeyView = document.getElementById('journey-view');
  const diffView = document.getElementById('diff-view');
  const btnCloseDossier = document.getElementById('btn-close-dossier');
  const btnDossierTrace = document.getElementById('btn-dossier-trace');

  if (btnHops && btnDiff && journeyView && diffView) {
    btnHops.addEventListener('click', () => {
      btnHops.classList.add('active');
      btnDiff.classList.remove('active');
      journeyView.style.display = 'flex';
      diffView.style.display = 'none';
    });

    btnDiff.addEventListener('click', () => {
      btnDiff.classList.add('active');
      btnHops.classList.remove('active');
      journeyView.style.display = 'none';
      diffView.style.display = 'flex';
    });
  }

  if (btnCloseDossier) {
    btnCloseDossier.addEventListener('click', () => {
      closeNodeInspector();
      clearBlastRadius();
    });
  }

  if (btnDossierTrace) {
    btnDossierTrace.addEventListener('click', () => {
      if (activeDrawerNode) {
        if (btnHops && btnDiff && journeyView && diffView) {
          btnHops.classList.add('active');
          btnDiff.classList.remove('active');
          journeyView.style.display = 'flex';
          diffView.style.display = 'none';
        }
        parseAndAnimateProof(null, [activeDrawerNode], { targetPaths: [activeDrawerNode], phase: 'INSPECT' });
      }
    });
  }
}

function setupDelegatedClickHandlers() {
  document.addEventListener('click', (e) => {
    // 1. Jump chip click in node inspector drawer
    const chip = e.target.closest('.jump-chip');
    if (chip && chip.dataset.nodePath) {
      jumpToNode(chip.dataset.nodePath);
      return;
    }

    // 2. Audit / Roadmap feed item click to inspect episode modules
    const auditItem = e.target.closest('.roadmap-item, .audit-item');
    if (auditItem && auditItem.dataset.modules) {
      inspectEpisodeFiles(auditItem.dataset.modules);
      return;
    }
  });
}

async function loadInitialTopologicalState() {
  try {
    const res = await fetch('/api/claim', { method: 'POST' });
    const data = await res.json();
    if (data && data.claim && data.claim.targetPaths?.length) {
      showActiveTarget(data.claim, data.queryLatencyMs);
      parseAndAnimateProof(data.claim.proof, data.claim.targetPaths, data.claim);
    } else {
      renderMissionDeck();
    }
  } catch (err) {
    console.error('Failed to load initial claim:', err);
    renderMissionDeck();
  }
}

// ── Application Bootstrapper ──────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const data = await fetchGraphData();
    initNetwork(data.modules, data.edges);
    updateStatusCounts(data.statusCounts);
    setupControlsDrawer();
    setupCypherDrawer();
    setupSettingsModal();
    setupDrawerTabs();
    setupViewSwitchTabs();
    setupDelegatedClickHandlers();
    setupStandbyDeck();
    await loadSystemInfo();
    checkStandbyState(data.modules);
    await loadInitialTopologicalState();
    await loadAuditTrail();

    document.getElementById('btn-step')?.addEventListener('click', executeStep);
    document.getElementById('btn-download-audit')?.addEventListener('click', downloadAuditReport);
    document.getElementById('btn-modal-close')?.addEventListener('click', hideVictoryModal);

    // Connect real-time CLI/MCP event synchronization
    initLiveStream();
  } catch (err) {
    console.error('Failed to initialize Cockpit:', err);
  }
});
