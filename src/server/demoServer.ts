/**
 * Shift Migration Cockpit — Backend Server (`src/server/demoServer.ts`).
 *
 * Drives the live Shift migration engine and FalkorDB graph in real time:
 *  - GET /api/graph -> Current nodes, edges, SCC clusters, PageRank, status counts
 *  - POST /api/reset -> Resets scratch demo-repo to original Express and re-inits FalkorDB
 *  - POST /api/step  -> Executes the next topological claim + edit + verify + checkpoint gate
 *  - GET /api/audit  -> Full chronological audit trail of MigrationEpisodes
 *
 * Serves the modern Vis.js dark-mode visualizer from `public/`.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { execSync } from 'node:child_process';
import { ensureFalkorDB } from '../engine/docker';
import { FalkorClient } from '../engine/falkorClient';
import { MigrationGraphManager } from '../engine/graphManager';
import { MigrationOps, type Phase } from '../engine/operations';
import * as Q from '../engine/queries';

const PORT = Number(process.env.PORT ?? 4200);
const WORKSPACE = resolve(import.meta.dirname, '../..');
const SOURCE_REPO = resolve(WORKSPACE, 'demo-repo');
const TARGET_REPO = resolve(WORKSPACE, 'scratch/cockpit-demo-repo');
const GRAPH_NAME = 'shift_cockpit';
const PACK_ID = 'express-to-fastify';

// Pre-defined code states for the 11 migration steps (exact code verified in Milestone 3)
const STEP_CODE_STATES: Record<string, Record<string, string>> = {
  // Step 1: response.ts -> SHIM
  'src/utils/response.ts:SHIM': {
    'src/utils/response.ts': `import type { FastifyReply } from 'fastify';
import type { Response } from 'express'; // @shift-shim

/** Standard success envelope (dual-compatible shim). */
export function sendSuccess(replyOrRes: any, data: unknown, statusCode = 200) {
  if (typeof replyOrRes?.code === 'function') {
    return replyOrRes.code(statusCode).send({ ok: true, data });
  }
  return replyOrRes.status(statusCode).json({ ok: true, data }); // @shift-shim
}

/** Standard error envelope (dual-compatible shim). */
export function sendError(replyOrRes: any, message: string, statusCode = 400) {
  if (typeof replyOrRes?.code === 'function') {
    return replyOrRes.code(statusCode).send({ ok: false, error: message });
  }
  return replyOrRes.status(statusCode).json({ ok: false, error: message }); // @shift-shim
}
`,
  },

  // Step 2: auth.ts -> SHIM
  'src/middleware/auth.ts:SHIM': {
    'src/middleware/auth.ts': `import type { Request, Response, NextFunction } from 'express'; // @shift-shim
import type { FastifyRequest, FastifyReply } from 'fastify';
import { sendError } from '../utils/response';

/** Require auth middleware (dual-compatible rest-parameter shim). */
export async function requireAuth(req: any, replyOrRes: any, ...legacyRest: any[]) {
  const apiKey = req.headers?.['x-api-key'] ?? req.get?.('x-api-key');
  if (apiKey !== 'secret-token') {
    return sendError(replyOrRes, 'Unauthorized', 401);
  }
  const next = legacyRest[0]; // @shift-shim
  if (typeof next === 'function') next(); // @shift-shim
}
`,
  },

  // Step 3: auditA + auditB -> SHIM (Atomic Cycle)
  'src/services/auditA.ts,src/services/auditB.ts:SHIM': {
    'src/services/auditA.ts': `import type { Request } from 'express'; // @shift-shim
import { shortHash } from '../utils/hash';
import { formatAuditLine } from './auditB';

export interface AuditableRequest {
  method?: string;
  headers: Record<string, unknown>;
}

export function describeRequest(req: AuditableRequest): string[] {
  const agent = String(req.headers?.['user-agent'] ?? 'unknown');
  return [req.method ?? 'GET', shortHash(agent)];
}

export function auditTag(req: AuditableRequest): string {
  return formatAuditLine(describeRequest(req));
}
`,
    'src/services/auditB.ts': `import type { Request } from 'express'; // @shift-shim
import { describeRequest, type AuditableRequest } from './auditA';

export function formatAuditLine(parts: string[]): string {
  return parts.join(':');
}

export function auditRequest(req: AuditableRequest): string {
  return \`audit:\${formatAuditLine(describeRequest(req))}\`;
}
`,
  },

  // Step 4: orders.ts -> SHIM
  'src/routes/orders.ts:SHIM': {
    'src/routes/orders.ts': `import express from 'express'; // @shift-shim
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { auditRequest } from '../services/auditB';

interface Order {
  id: number;
  userId: number;
  total: number;
}

const orders: Order[] = [
  { id: 100, userId: 1, total: 42.5 },
  { id: 101, userId: 2, total: 13.37 },
];

export const ordersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    return sendSuccess(reply, { items: orders, audit: auditRequest(request) });
  });
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const order = orders.find((o) => o.id === Number(request.params.id));
    if (!order) return sendError(reply, 'Order not found', 404);
    return sendSuccess(reply, order);
  });
};

const router = express.Router(); // @shift-shim
router.get('/', requireAuth, (req, res) => { // @shift-shim
  return sendSuccess(res, { items: orders, audit: auditRequest(req) }); // @shift-shim
}); // @shift-shim
router.get('/:id', requireAuth, (req, res) => { // @shift-shim
  const order = orders.find((o) => o.id === Number(req.params.id)); // @shift-shim
  if (!order) return sendError(res, 'Order not found', 404); // @shift-shim
  return sendSuccess(res, order); // @shift-shim
}); // @shift-shim

export const ordersRouter = router; // @shift-shim
`,
  },

  // Step 5: users.ts -> SHIM
  'src/routes/users.ts:SHIM': {
    'src/routes/users.ts': `import express from 'express'; // @shift-shim
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { auditRequest } from '../services/auditB';

interface User {
  id: number;
  name: string;
}

const users: User[] = [
  { id: 1, name: 'Ada Lovelace' },
  { id: 2, name: 'Alan Turing' },
];

export const usersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    return sendSuccess(reply, { items: users, audit: auditRequest(request) });
  });
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = users.find((u) => u.id === Number(request.params.id));
    if (!user) return sendError(reply, 'User not found', 404);
    return sendSuccess(reply, user);
  });
  fastify.post<{ Body: { name?: string } }>('/', { preHandler: requireAuth }, async (request, reply) => {
    const name = request.body?.name;
    if (!name) return sendError(reply, 'name is required', 400);
    const user: User = { id: users.length + 1, name };
    users.push(user);
    return sendSuccess(reply, user, 201);
  });
};

const router = express.Router(); // @shift-shim
router.get('/', requireAuth, (req, res) => { // @shift-shim
  return sendSuccess(res, { items: users, audit: auditRequest(req) }); // @shift-shim
}); // @shift-shim
router.get('/:id', requireAuth, (req, res) => { // @shift-shim
  const user = users.find((u) => u.id === Number(req.params.id)); // @shift-shim
  if (!user) return sendError(res, 'User not found', 404); // @shift-shim
  return sendSuccess(res, user); // @shift-shim
}); // @shift-shim
router.post('/', requireAuth, (req, res) => { // @shift-shim
  const name = typeof req.body?.name === 'string' ? req.body.name : ''; // @shift-shim
  if (!name) return sendError(res, 'name is required', 400); // @shift-shim
  const user: User = { id: users.length + 1, name }; // @shift-shim
  users.push(user); // @shift-shim
  return sendSuccess(res, user, 201); // @shift-shim
}); // @shift-shim

export const usersRouter = router; // @shift-shim
`,
  },

  // Step 6: app.ts -> MIGRATE
  'src/app.ts:MIGRATE': {
    'src/app.ts': `import Fastify from 'fastify';
import { usersRoutes } from './routes/users';
import { ordersRoutes } from './routes/orders';

/** App factory: builds the Fastify app without binding a port. */
export function createApp() {
  const app = Fastify();
  app.register(usersRoutes, { prefix: '/users' });
  app.register(ordersRoutes, { prefix: '/orders' });
  return app;
}

/** Boots the app on the given port. Owned here so server.ts stays framework-agnostic. */
export async function startServer(port: number) {
  const app = createApp();
  await app.listen({ port });
  return app;
}
`,
  },

  // Step 7: orders.ts -> DE_SHIM
  'src/routes/orders.ts:DE_SHIM': {
    'src/routes/orders.ts': `import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { auditRequest } from '../services/auditB';

interface Order {
  id: number;
  userId: number;
  total: number;
}

const orders: Order[] = [
  { id: 100, userId: 1, total: 42.5 },
  { id: 101, userId: 2, total: 13.37 },
];

export const ordersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    return sendSuccess(reply, { items: orders, audit: auditRequest(request) });
  });
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const order = orders.find((o) => o.id === Number(request.params.id));
    if (!order) return sendError(reply, 'Order not found', 404);
    return sendSuccess(reply, order);
  });
};
`,
  },

  // Step 8: users.ts -> DE_SHIM
  'src/routes/users.ts:DE_SHIM': {
    'src/routes/users.ts': `import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/auth';
import { sendSuccess, sendError } from '../utils/response';
import { auditRequest } from '../services/auditB';

interface User {
  id: number;
  name: string;
}

const users: User[] = [
  { id: 1, name: 'Ada Lovelace' },
  { id: 2, name: 'Alan Turing' },
];

export const usersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    return sendSuccess(reply, { items: users, audit: auditRequest(request) });
  });
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = users.find((u) => u.id === Number(request.params.id));
    if (!user) return sendError(reply, 'User not found', 404);
    return sendSuccess(reply, user);
  });
  fastify.post<{ Body: { name?: string } }>('/', { preHandler: requireAuth }, async (request, reply) => {
    const name = request.body?.name;
    if (!name) return sendError(reply, 'name is required', 400);
    const user: User = { id: users.length + 1, name };
    users.push(user);
    return sendSuccess(reply, user, 201);
  });
};
`,
  },

  // Step 9: auditA + auditB -> DE_SHIM
  'src/services/auditA.ts,src/services/auditB.ts:DE_SHIM': {
    'src/services/auditA.ts': `import { shortHash } from '../utils/hash';
import { formatAuditLine } from './auditB';

export interface AuditableRequest {
  method?: string;
  headers: Record<string, unknown>;
}

export function describeRequest(req: AuditableRequest): string[] {
  const agent = String(req.headers?.['user-agent'] ?? 'unknown');
  return [req.method ?? 'GET', shortHash(agent)];
}

export function auditTag(req: AuditableRequest): string {
  return formatAuditLine(describeRequest(req));
}
`,
    'src/services/auditB.ts': `import { describeRequest, type AuditableRequest } from './auditA';

export function formatAuditLine(parts: string[]): string {
  return parts.join(':');
}

export function auditRequest(req: AuditableRequest): string {
  return \`audit:\${formatAuditLine(describeRequest(req))}\`;
}
`,
  },

  // Step 10: auth.ts -> DE_SHIM
  'src/middleware/auth.ts:DE_SHIM': {
    'src/middleware/auth.ts': `import type { FastifyRequest, FastifyReply } from 'fastify';
import { sendError } from '../utils/response';

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['x-api-key'];
  if (apiKey !== 'secret-token') {
    return sendError(reply, 'Unauthorized', 401);
  }
}
`,
  },

  // Step 11: response.ts -> DE_SHIM
  'src/utils/response.ts:DE_SHIM': {
    'src/utils/response.ts': `import type { FastifyReply } from 'fastify';

export function sendSuccess(reply: FastifyReply, data: unknown, statusCode = 200) {
  return reply.code(statusCode).send({ ok: true, data });
}

export function sendError(reply: FastifyReply, message: string, statusCode = 400) {
  return reply.code(statusCode).send({ ok: false, error: message });
}
`,
  },
};

// ── State Management ─────────────────────────────────────

let dbClient: FalkorClient | null = null;
let currentOps: MigrationOps | null = null;

async function getClient(): Promise<FalkorClient> {
  if (!dbClient) {
    await ensureFalkorDB();
    dbClient = await FalkorClient.connect({ graphName: GRAPH_NAME });
  }
  return dbClient;
}

async function getOps(): Promise<MigrationOps> {
  if (!currentOps) {
    const client = await getClient();
    const mgr = await MigrationGraphManager.create(TARGET_REPO, PACK_ID, {
      graphName: GRAPH_NAME,
      client,
    });
    currentOps = new MigrationOps(mgr.db, mgr.pack, mgr.repoPath);
  }
  return currentOps;
}

async function resetDemoState() {
  console.error('[cockpit] Resetting scratch target repo...');
  rmSync(TARGET_REPO, { recursive: true, force: true });
  mkdirSync(TARGET_REPO, { recursive: true });

  cpSync(resolve(SOURCE_REPO, 'src'), resolve(TARGET_REPO, 'src'), { recursive: true });
  cpSync(resolve(SOURCE_REPO, 'scripts'), resolve(TARGET_REPO, 'scripts'), { recursive: true });
  cpSync(resolve(SOURCE_REPO, 'test'), resolve(TARGET_REPO, 'test'), { recursive: true });
  cpSync(resolve(SOURCE_REPO, 'package.json'), resolve(TARGET_REPO, 'package.json'));
  cpSync(resolve(SOURCE_REPO, 'tsconfig.json'), resolve(TARGET_REPO, 'tsconfig.json'));
  symlinkSync(resolve(SOURCE_REPO, 'node_modules'), resolve(TARGET_REPO, 'node_modules'), 'junction');

  const client = await getClient();
  await MigrationGraphManager.initMigrationGraph({
    repoPath: TARGET_REPO,
    packId: PACK_ID,
    graphName: GRAPH_NAME,
    client,
    reset: true,
  });

  currentOps = null;
  console.error('[cockpit] Demo state reset to original Express baseline.');
}

async function getGraphTopology() {
  const client = await getClient();

  // Query modules
  const modules = await client.roQuery<any>(`
    MATCH (m:Module)
    RETURN m.path AS path, m.status AS status, m.scc_id AS sccId, m.scc_size AS sccSize,
           m.pagerank AS pagerank, m.pending_callers_count AS pendingCallers,
           m.in_degree AS inDegree, m.shim_line_count AS shimLines
    ORDER BY m.path ASC
  `);

  // Query import edges
  const edges = await client.roQuery<any>(`
    MATCH (a:Module)-[r:IMPORTS]->(b:Module)
    RETURN a.path AS source, b.path AS target
  `);

  // Query status counts
  const counts = await client.roQuery<any>(Q.STATUS_COUNTS);
  const countMap: Record<string, number> = {};
  for (const c of counts) {
    countMap[c.status] = Number(c.n);
  }

  // Query episodes count
  const epRows = await client.roQuery<any>(`MATCH (e:MigrationEpisode) RETURN count(e) AS n`);
  const episodeCount = Number(epRows[0]?.n ?? 0);

  return {
    modules,
    edges,
    statusCounts: countMap,
    episodeCount,
  };
}

// ── HTTP Request Router ──────────────────────────────────

function sendJson(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function sendFile(res: ServerResponse, filePath: string, contentType: string) {
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

export function startDemoServer(port = PORT) {
  const publicDir = resolve(WORKSPACE, 'public');

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ── API Endpoints ──

    if (pathname === '/api/graph' && req.method === 'GET') {
      try {
        const topology = await getGraphTopology();
        sendJson(res, topology);
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/reset' && req.method === 'POST') {
      try {
        await resetDemoState();
        const topology = await getGraphTopology();
        sendJson(res, { success: true, topology });
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/claim' && req.method === 'POST') {
      try {
        const ops = await getOps();
        const t0 = performance.now();
        const claim = await ops.claimNextLeaf();
        const queryLatencyMs = Number((performance.now() - t0).toFixed(2));
        sendJson(res, { claim, queryLatencyMs });
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/step' && req.method === 'POST') {
      try {
        const ops = await getOps();
        const t0 = performance.now();
        const claim = await ops.claimNextLeaf();
        const claimLatencyMs = Number((performance.now() - t0).toFixed(2));

        if (!claim) {
          const audit = await ops.getAuditTrail(true);
          sendJson(res, {
            finished: true,
            message: 'All modules are clean or verified! Migration complete.',
            checkpoint: audit.checkpoint,
          });
          return;
        }

        // Determine step key for pre-verified code diff
        const sortedTargets = [...claim.targetPaths].sort().join(',');
        const stepKey = `${sortedTargets}:${claim.phase}`;
        const replacements = STEP_CODE_STATES[stepKey];

        if (!replacements) {
          sendJson(res, { error: `No canned code state found for step key: ${stepKey}` }, 400);
          return;
        }

        // Apply file writes
        const modifiedFiles: Array<{ path: string; oldCode: string; newCode: string }> = [];
        for (const [relPath, newContent] of Object.entries(replacements)) {
          const abs = resolve(TARGET_REPO, relPath);
          let oldCode = '';
          try {
            oldCode = readFileSync(abs, 'utf8');
          } catch {
            oldCode = '';
          }
          writeFileSync(abs, newContent);
          modifiedFiles.push({ path: relPath, oldCode, newCode: newContent });
        }

        // Run real verify_and_commit_node on the engine
        const verifyStart = performance.now();
        const summary = `${claim.phase} applied to ${claim.targetPaths.join(', ')}`;
        const verifyResult = await ops.verifyAndCommitNode(claim.targetPaths, summary);
        const verifyLatencyMs = Number((performance.now() - verifyStart).toFixed(2));

        // Get updated graph topology
        const topology = await getGraphTopology();
        const claimCypher = (claim.phase === 'DE_SHIM' ? Q.CLAIM_DESHIM : Q.CLAIM_LEAF).trim();

        sendJson(res, {
          finished: false,
          claim,
          claimLatencyMs,
          verifyResult,
          verifyLatencyMs,
          modifiedFiles,
          topology,
          cypherTrace: {
            name: claim.phase === 'DE_SHIM' ? 'Pass A: De-shim Candidate Scan' : 'Pass B: Unblocked Leaf Claim',
            query: claimCypher,
            latencyMs: claimLatencyMs,
          },
        });
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/audit' && req.method === 'GET') {
      try {
        const ops = await getOps();
        const runCheckpoint = url.searchParams.get('checkpoint') === 'true';
        const trail = await ops.getAuditTrail(runCheckpoint);
        sendJson(res, trail);
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    // ── Static Files from public/ ──
    let localPath = resolve(publicDir, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!existsSync(localPath)) {
      localPath = resolve(publicDir, 'index.html');
    }

    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };

    const ext = extname(localPath);
    sendFile(res, localPath, mimeTypes[ext] ?? 'text/plain');
  });

  server.listen(port, async () => {
    console.error(`\n======================================================`);
    console.error(`  SHIFT MIGRATION COCKPIT IS LIVE ON HTTP`);
    console.error(`  URL: http://localhost:${port}`);
    console.error(`======================================================\n`);

    // Ensure initial demo state exists
    if (!existsSync(TARGET_REPO)) {
      await resetDemoState();
    }
  });

  return server;
}

// Direct execution CLI runner
if (process.argv[1]?.includes('demoServer')) {
  startDemoServer();
}
