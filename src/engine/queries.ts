/**
 * Layer 1 — Core Cypher queries (plan §5 & §6), validated against falkordb/falkordb:latest.
 *
 * Deviations from plan v3 (found during Milestone 0 validation):
 *  1. `pending_callers_count` counts callers in PENDING, IN_PROGRESS **and SHIMMED**
 *     ("legacy callers"). A SHIMMED caller still exercises its legacy branch, so
 *     de-shimming its callee early breaks the typecheck. With this rule de-shimming
 *     cascades top-down (entry -> leaves). SHIMMED still does NOT block claims.
 *  2. openCypher requires `WITH ... WHERE` before a separate `WITH ... ORDER BY ... LIMIT`.
 *  3. `claimed_phase` is persisted on claimed modules so a failed DE_SHIM verify can
 *     revert to SHIMMED instead of PENDING.
 */

export const BLOCKING_STATUSES = ['PENDING', 'IN_PROGRESS'] as const;
export const LEGACY_CALLER_STATUSES = ['PENDING', 'IN_PROGRESS', 'SHIMMED'] as const;

export const INDEXES = [
  'CREATE INDEX FOR (m:Module) ON (m.path)',
  'CREATE INDEX FOR (m:Module) ON (m.status)',
  'CREATE INDEX FOR (m:Module) ON (m.scc_id)',
  'CREATE INDEX FOR (s:Symbol) ON (s.id)',
  'CREATE INDEX FOR (e:MigrationEpisode) ON (e.step)',
];

/** §5.1 PageRank risk ranking (FalkorDB native). */
export const PAGERANK = `
CALL algo.pageRank('Module', 'IMPORTS') YIELD node, score
SET node.pagerank = score
RETURN node.path AS path, score ORDER BY score DESC`;

/** §5.2 Shortest dependency path (FalkorDB native; must live in WITH/RETURN). */
export const SHORTEST_PATH = `
MATCH (caller:Module {path: $callerPath}), (callee:Module {path: $calleePath})
WITH shortestPath((caller)-[:IMPORTS*1..10]->(callee)) AS p
WHERE p IS NOT NULL
RETURN [n IN nodes(p) | n.path] AS dependencyChain`;

/** All module-level import edges (input to Tarjan). */
export const ALL_IMPORT_EDGES = `
MATCH (m:Module)
OPTIONAL MATCH (m)-[:IMPORTS]->(d:Module)
RETURN m.path AS from, collect(d.path) AS to`;

/** Batch write SCC assignments. */
export const SET_SCCS = `
UNWIND $rows AS row
MATCH (m:Module {path: row.path})
SET m.scc_id = row.sccId, m.scc_size = row.sccSize`;

/**
 * §6.1 Pass A — De-shim priority.
 * Deviation: the zero-pending-callers condition is evaluated over the WHOLE SCC
 * (sum of peers), otherwise a cycle member whose only caller is its peer would
 * trigger a premature de-shim of the cluster.
 */
export const RECLAIM_IN_PROGRESS = `
/* reclaim-active-claim */
MATCH (m:Module {status: 'IN_PROGRESS'})
RETURN m.path AS path, m.scc_id AS sccId, m.claimed_phase AS phase, m.pagerank AS pagerank
ORDER BY m.pagerank DESC, m.path ASC`;

export const CLAIM_DESHIM = `
MATCH (m:Module {status: 'SHIMMED'})
WITH DISTINCT m.scc_id AS sccId
MATCH (peer:Module)
WHERE peer.scc_id = sccId
WITH sccId, collect(peer) AS clusterNodes, sum(peer.pending_callers_count) AS sccPending,
     max(peer.pagerank) AS pr, min(peer.path) AS firstPath
WHERE sccPending = 0
WITH sccId, clusterNodes ORDER BY pr DESC, firstPath ASC LIMIT 1
FOREACH (n IN [x IN clusterNodes WHERE x.status = 'SHIMMED'] | SET n.status = 'IN_PROGRESS', n.claimed_phase = 'DE_SHIM')
RETURN
  'DE_SHIM' AS phase,
  sccId,
  [x IN clusterNodes | x.path] AS allClusterPaths,
  [x IN clusterNodes WHERE x.status = 'IN_PROGRESS' | x.path] AS targetPaths,
  0 AS pendingCallersCount,
  [] AS pendingCallerPaths`;

/** §6.1 Pass B — Unblocked leaf / atomic SCC claim. */
export const CLAIM_LEAF = `
MATCH (m:Module {status: 'PENDING'})
OPTIONAL MATCH (m)-[:IMPORTS*1..10]->(blocker:Module)
WHERE blocker.scc_id <> m.scc_id
  AND blocker.status IN $blocking
WITH m, count(DISTINCT blocker) AS blockerCount
WHERE blockerCount = 0
WITH m ORDER BY m.scc_size ASC, m.pagerank DESC, m.path ASC LIMIT 1
MATCH (peer:Module)
WHERE peer.scc_id = m.scc_id
WITH m.scc_id AS sccId, collect(peer) AS clusterNodes
FOREACH (n IN [x IN clusterNodes WHERE x.status = 'PENDING'] | SET n.status = 'IN_PROGRESS')
WITH sccId, clusterNodes
UNWIND clusterNodes AS node
OPTIONAL MATCH (caller:Module)-[:IMPORTS]->(node)
WHERE caller.scc_id <> sccId AND caller.status IN $legacyCallers
WITH sccId, clusterNodes, collect(DISTINCT node.path) AS allClusterPaths, collect(DISTINCT caller.path) AS pendingCallerPaths
RETURN
  CASE WHEN size(pendingCallerPaths) > 0 THEN 'SHIM' ELSE 'MIGRATE' END AS phase,
  sccId,
  allClusterPaths,
  [x IN clusterNodes WHERE x.status = 'IN_PROGRESS' | x.path] AS targetPaths,
  size(pendingCallerPaths) AS pendingCallersCount,
  pendingCallerPaths`;

/** Persist the phase a set of modules was claimed under. */
export const SET_CLAIMED_PHASE = `
UNWIND $paths AS p
MATCH (m:Module {path: p})
SET m.claimed_phase = $phase`;

/** §6.2 Step 1 — replace outgoing edges of a re-parsed module. */
export const REPLACE_OUTGOING = `
MATCH (m:Module {path: $modulePath})
SET m.current_sets = $currentSetsJson, m.shim_line_count = $shimLineCount
WITH m
OPTIONAL MATCH (m)-[rImp:IMPORTS]->(:Module) DELETE rImp
WITH m
OPTIONAL MATCH (m)-[rApi:USES_API]->(:ExternalAPI) DELETE rApi
WITH m
OPTIONAL MATCH (m)-[:DECLARES]->(sym:Symbol) DETACH DELETE sym`;

/** §6.2 Step 4 — global degree & unblock recalculation. */
export const RECOMPUTE_DEGREES = `
MATCH (target:Module)
OPTIONAL MATCH (caller:Module)-[:IMPORTS]->(target)
WITH target,
     count(DISTINCT caller) AS totalInDegree,
     sum(CASE WHEN caller.scc_id <> target.scc_id AND caller.status IN $legacyCallers THEN 1 ELSE 0 END) AS pendingCallers
SET target.in_degree = totalInDegree,
    target.pending_callers_count = pendingCallers`;

/** Pending-caller count for a specific SCC (Step 3 gate). */
export const SCC_PENDING_CALLERS = `
MATCH (node:Module)
WHERE node.scc_id = $sccId
OPTIONAL MATCH (caller:Module)-[:IMPORTS]->(node)
WHERE caller.scc_id <> $sccId AND caller.status IN $legacyCallers
RETURN count(DISTINCT caller) AS pendingCallers, collect(DISTINCT caller.path) AS callerPaths`;

/** §8.4 Multi-hop blast radius. */
export const BLAST_RADIUS = `
MATCH (m:Module {path: $modulePath})
MATCH p = (m)<-[:IMPORTS*1..6]-(caller:Module)
WITH m, caller, min(length(p)) AS hops
RETURN caller.path AS path, caller.status AS status, hops, caller.pagerank AS pagerank, m.pagerank AS targetPagerank
ORDER BY hops ASC, path ASC`;

export const STATUS_COUNTS = `
MATCH (m:Module)
RETURN m.status AS status, count(m) AS n`;
