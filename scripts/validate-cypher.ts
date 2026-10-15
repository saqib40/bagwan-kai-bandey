/**
 * Milestone 0: validate every Cypher query from plan §5/§6 against a live
 * falkordb/falkordb:latest container using a fixture mirroring demo-repo.
 *
 * Also replays the full claim loop twice:
 *   (a) engine policy  — SHIMMED callers count as legacy callers (expected: safe top-down de-shim)
 *   (b) plan v3 policy — only PENDING/IN_PROGRESS count (shows premature de-shim hazard)
 */
import { FalkorClient } from '../src/engine/falkorClient';
import { tarjanScc } from '../src/engine/scc';
import * as Q from '../src/engine/queries';

const EDGES: Record<string, string[]> = {
  'src/server.ts': ['src/app.ts'],
  'src/app.ts': ['src/routes/users.ts', 'src/routes/orders.ts'],
  'src/routes/users.ts': ['src/middleware/auth.ts', 'src/utils/response.ts', 'src/services/auditB.ts'],
  'src/routes/orders.ts': ['src/middleware/auth.ts', 'src/utils/response.ts', 'src/services/auditB.ts'],
  'src/middleware/auth.ts': ['src/utils/response.ts'],
  'src/services/auditA.ts': ['src/utils/hash.ts', 'src/services/auditB.ts'],
  'src/services/auditB.ts': ['src/services/auditA.ts'],
  'src/utils/response.ts': [],
  'src/utils/hash.ts': [],
};
const CLEAN = new Set(['src/server.ts', 'src/utils/hash.ts']);

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`  ${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures++;
}
const short = (p: string) => p.replace(/^src\//, '').replace(/\.ts$/, '');

async function seed(db: FalkorClient) {
  await db.reset();
  for (const ix of Q.INDEXES) await db.ensureIndex(ix);
  const scc = tarjanScc(new Map(Object.entries(EDGES)));
  await db.query(
    `UNWIND $rows AS r CREATE (:Module {path: r.path, status: r.status, scc_id: r.sccId, scc_size: r.sccSize,
       in_degree: 0, pending_callers_count: 0, pagerank: 0.0, shim_line_count: 0})`,
    {
      rows: Object.keys(EDGES).map((path) => ({
        path,
        status: CLEAN.has(path) ? 'CLEAN' : 'PENDING',
        sccId: scc.sccOf.get(path)!,
        sccSize: scc.members.get(scc.sccOf.get(path)!)!.length,
      })),
    },
  );
  await db.query(
    `UNWIND $edges AS e MATCH (a:Module {path: e.from}), (b:Module {path: e.to}) MERGE (a)-[:IMPORTS]->(b)`,
    { edges: Object.entries(EDGES).flatMap(([from, tos]) => tos.map((to) => ({ from, to }))) },
  );
  return scc;
}

async function claimLoop(db: FalkorClient, legacyCallers: readonly string[]) {
  const params = { blocking: [...Q.BLOCKING_STATUSES], legacyCallers: [...legacyCallers] };
  await db.query(Q.RECOMPUTE_DEGREES, params);
  const log: string[] = [];
  for (let step = 1; step <= 30; step++) {
    let rows = await db.query<any>(Q.CLAIM_DESHIM);
    if (!rows.length) rows = await db.query<any>(Q.CLAIM_LEAF, params);
    if (!rows.length) break;
    const c = rows[0];
    const newStatus = c.phase === 'SHIM' ? 'SHIMMED' : 'VERIFIED';
    log.push(`${step}. ${c.phase.padEnd(7)} ${c.targetPaths.map(short).join('+')} (callers=${c.pendingCallersCount}) -> ${newStatus}`);
    await db.query(`UNWIND $paths AS p MATCH (m:Module {path: p}) SET m.status = $s`, { paths: c.targetPaths, s: newStatus });
    await db.query(Q.RECOMPUTE_DEGREES, params);
  }
  const counts = await db.query<any>(Q.STATUS_COUNTS);
  return { log, counts: Object.fromEntries(counts.map((r) => [r.status, r.n])) };
}

const db = await FalkorClient.connect({ graphName: 'shift_m0_validate' });
try {
  console.log('\n[seed] fixture graph');
  const scc = await seed(db);
  const auditScc = scc.sccOf.get('src/services/auditA.ts');
  check(auditScc === scc.sccOf.get('src/services/auditB.ts'), 'Tarjan: auditA/auditB share an SCC');
  check(scc.members.get(auditScc!)!.length === 2, 'Tarjan: audit SCC size == 2');

  console.log('\n[§5.1] algo.pageRank');
  const pr = await db.query<any>(Q.PAGERANK);
  console.log('   ', pr.map((r) => `${short(r.path)}=${Number(r.score).toFixed(3)}`).join(', '));
  check(pr.length === 9, 'pageRank returned all 9 modules');
  const rank = (p: string) => pr.findIndex((r) => r.path === p);
  check(rank('src/utils/response.ts') < rank('src/middleware/auth.ts'), 'response ranks above auth');
  check(rank('src/utils/response.ts') < rank('src/app.ts'), 'response ranks above app (imported-most first)');

  console.log('\n[§5.2] shortestPath');
  const sp = await db.query<any>(Q.SHORTEST_PATH, { callerPath: 'src/server.ts', calleePath: 'src/utils/hash.ts' });
  console.log('   ', sp[0]?.dependencyChain?.map(short).join(' -> '));
  check(sp[0]?.dependencyChain?.length === 6, 'server -> ... -> hash chain has 6 nodes');

  console.log('\n[§6.2 step 4] recompute degrees');
  await db.query(Q.RECOMPUTE_DEGREES, { legacyCallers: [...Q.LEGACY_CALLER_STATUSES] });
  const resp = (await db.query<any>(`MATCH (m:Module {path:'src/utils/response.ts'}) RETURN m.in_degree AS d, m.pending_callers_count AS p`))[0];
  check(resp.d === 3 && resp.p === 3, `response in_degree=3 pending_callers=3 (got ${resp.d}/${resp.p})`);
  const auditA = (await db.query<any>(`MATCH (m:Module {path:'src/services/auditA.ts'}) RETURN m.in_degree AS d, m.pending_callers_count AS p`))[0];
  check(auditA.d === 1 && auditA.p === 0, `auditA: intra-SCC caller not counted as pending (got ${auditA.d}/${auditA.p})`);

  console.log('\n[§6.1] Pass A (no SHIMMED yet) / Pass B first claim');
  check((await db.query(Q.CLAIM_DESHIM)).length === 0, 'Pass A returns 0 rows initially');
  const first = (await db.query<any>(Q.CLAIM_LEAF, { blocking: [...Q.BLOCKING_STATUSES], legacyCallers: [...Q.LEGACY_CALLER_STATUSES] }))[0];
  console.log('   ', JSON.stringify(first));
  check(first?.phase === 'SHIM' && first.targetPaths[0] === 'src/utils/response.ts', 'first claim = response.ts, phase SHIM');
  check(first?.pendingCallersCount === 3, 'first claim pendingCallersCount = 3');

  console.log('\n[§6.2 step 1] edge replacement on a scratch module');
  await db.query(`CREATE (:Module {path:'tmp/x'})-[:IMPORTS]->(:Module {path:'tmp/y'})`);
  await db.query(`MATCH (m:Module {path:'tmp/x'}) CREATE (m)-[:DECLARES]->(:Symbol {id:'tmp/x#f'}), (m)-[:USES_API {line: 1, snippet: 's', is_shimmed: false}]->(:ExternalAPI {id:'rule'})`);
  await db.query(Q.REPLACE_OUTGOING, { modulePath: 'tmp/x', currentSetsJson: '{}', shimLineCount: 0 });
  const left = (await db.query<any>(`MATCH (m:Module {path:'tmp/x'}) OPTIONAL MATCH (m)-[r]->() OPTIONAL MATCH (s:Symbol {id:'tmp/x#f'}) RETURN count(DISTINCT r) AS r, count(DISTINCT s) AS s`))[0];
  check(left.r === 0 && left.s === 0, 'Step 1 removed IMPORTS/USES_API edges and DECLARES symbols');

  console.log('\n[§6.1 loop] engine policy (SHIMMED callers count as legacy)');
  await seed(db);
  await db.query(Q.PAGERANK);
  const engine = await claimLoop(db, Q.LEGACY_CALLER_STATUSES);
  engine.log.forEach((l) => console.log('   ', l));
  check(engine.counts.VERIFIED === 7 && !engine.counts.SHIMMED && !engine.counts.PENDING, `all 7 legacy modules VERIFIED (${JSON.stringify(engine.counts)})`);
  const order = engine.log.map((l) => l.split(/\s+/).slice(1, 3).join(' '));
  check(order.some((o) => o === 'SHIM services/auditA+services/auditB'), 'audit SCC claimed atomically');
  const deshimAudit = order.findIndex((o) => o === 'DE_SHIM services/auditA+services/auditB');
  check(deshimAudit > order.findIndex((o) => o === 'DE_SHIM routes/users'), 'audit SCC de-shimmed only after its callers (SCC-level check)');
  const deshimResp = order.findIndex((o) => o === 'DE_SHIM utils/response');
  const deshimUsers = order.findIndex((o) => o === 'DE_SHIM routes/users');
  check(deshimResp > deshimUsers && deshimUsers >= 0, 'response de-shimmed only after routes de-shimmed (top-down)');

  console.log('\n[§6.1 loop] plan v3 policy (only PENDING/IN_PROGRESS count) — hazard demo');
  await seed(db);
  await db.query(Q.PAGERANK);
  const plan = await claimLoop(db, Q.BLOCKING_STATUSES);
  plan.log.forEach((l) => console.log('   ', l));
  const p = plan.log.map((l) => l.split(/\s+/).slice(1, 3).join(' '));
  const early = p.findIndex((o) => o === 'DE_SHIM utils/response') < p.findIndex((o) => o === 'DE_SHIM routes/users');
  console.log(`    -> plan v3 de-shims response BEFORE routes: ${early} (tsc fails in that state, proven in scratch)`);
} finally {
  await db.reset();
  await db.close();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CYPHER CHECKS PASSED');
process.exit(failures ? 1 : 0);
