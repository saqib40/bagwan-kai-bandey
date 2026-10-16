/**
 * Bagwan Kai Bandey (BKB) Migration Cockpit — Backend Server (`src/server/demoServer.ts`).
 *
 * Drives the live BKB migration engine and FalkorDB graph in real time:
 *  - GET /api/info        -> Current repo, pack, mode, available packs, checkpoints
 *  - GET /api/graph       -> Current nodes, edges, SCC clusters, PageRank, status counts
 *  - POST /api/target     -> Dynamically switch target repo, pack, mode, or LLM provider
 *  - POST /api/reset      -> Resets target repo (demo or custom) and re-inits FalkorDB
 *  - POST /api/step       -> Executes next topological step (canned, LLM, or observer)
 *  - GET /api/file        -> Fetches raw file contents on disk for inspection
 *  - GET /api/node-detail -> Detailed callers, callees, symbols, and blast radius for a node
 *  - GET /api/audit       -> Full chronological audit trail of MigrationEpisodes
 *  - GET /api/checkpoints -> Available step snapshots in .bkb/checkpoints/
 *  - POST /api/rollback   -> Instant 1-click disk and graph rollback to a previous checkpoint
 *
 * Serves the modern Vis.js visualizer from `public/`.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, symlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname, basename, relative, isAbsolute } from 'node:path';
import { ensureFalkorDB } from '../engine/docker';
import { FalkorClient } from '../engine/falkorClient';
import { MigrationGraphManager, getGraphNameForRepo as getEngineGraphName } from '../engine/graphManager';
import { MigrationOps, type Phase } from '../engine/operations';
import { LlmClient } from '../runner/llmClient';
import { saveCheckpoint, listCheckpoints, rollbackToCheckpoint } from '../runner/rollback';
import * as Q from '../engine/queries';

export function isPathContained(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(rootDir, targetPath);
  const rel = relative(resolvedRoot, resolvedTarget);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export function isOriginAllowed(origin?: string): boolean {
  if (!origin) return true; // Direct non-browser calls (curl, cli, node fetch)
  try {
    const parsed = new URL(origin);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

const PORT = Number(process.env.PORT ?? 4200);
const WORKSPACE = resolve(import.meta.dirname, '../..');
const SOURCE_REPO = resolve(WORKSPACE, 'demo-repo');
const DEFAULT_TARGET_REPO = resolve(WORKSPACE, 'scratch/cockpit-demo-repo');
const DEFAULT_PACK_ID = 'express-to-fastify';

export function getGraphNameForRepo(repoPath: string): string {
  if (repoPath === DEFAULT_TARGET_REPO) {
    return process.env.BKB_GRAPH ?? 'bkb_cockpit';
  }
  return getEngineGraphName(repoPath);
}

// ── Dynamic Server State ─────────────────────────────────
let activeRepo = DEFAULT_TARGET_REPO;
let activePackId = DEFAULT_PACK_ID;
let activeMode: 'canned' | 'llm' | 'observer' = 'canned';
let activeProvider: 'mock' | 'ollama' | 'openai' | 'anthropic' = 'mock';
let activeModel = 'qwen2.5-coder:latest';

// ── Real-Time SSE Event Bus ──────────────────────────────
const sseClients = new Set<ServerResponse>();

export function broadcastSse(data: Record<string, unknown>): void {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Pre-defined code states for the 11 migration steps (exact code verified in Milestone 3)
const STEP_CODE_STATES: Record<string, Record<string, string>> = {
  // Step 1: response.ts -> SHIM
  'src/utils/response.ts:SHIM': {
    'src/utils/response.ts': `import type { FastifyReply } from 'fastify';
import type { Response } from 'express'; // @bkb-shim

/** Standard success envelope (dual-compatible shim). */
export function sendSuccess(replyOrRes: any, data: unknown, statusCode = 200) {
  if (typeof replyOrRes?.code === 'function') {
    return replyOrRes.code(statusCode).send({ ok: true, data });
  }
  return replyOrRes.status(statusCode).json({ ok: true, data }); // @bkb-shim
}

/** Standard error envelope (dual-compatible shim). */
export function sendError(replyOrRes: any, message: string, statusCode = 400) {
  if (typeof replyOrRes?.code === 'function') {
    return replyOrRes.code(statusCode).send({ ok: false, error: message });
  }
  return replyOrRes.status(statusCode).json({ ok: false, error: message }); // @bkb-shim
}
`,
  },

  // Step 2: auth.ts -> SHIM
  'src/middleware/auth.ts:SHIM': {
    'src/middleware/auth.ts': `import type { Request, Response, NextFunction } from 'express'; // @bkb-shim
import type { FastifyRequest, FastifyReply } from 'fastify';
import { sendError } from '../utils/response';

/** Require auth middleware (dual-compatible rest-parameter shim). */
export async function requireAuth(req: any, replyOrRes: any, ...legacyRest: any[]) {
  const apiKey = req.headers?.['x-api-key'] ?? req.get?.('x-api-key');
  if (apiKey !== 'secret-token') {
    return sendError(replyOrRes, 'Unauthorized', 401);
  }
  const next = legacyRest[0]; // @bkb-shim
  if (typeof next === 'function') next(); // @bkb-shim
}
`,
  },

  // Step 3: auditA + auditB -> SHIM (Atomic Cycle)
  'src/services/auditA.ts,src/services/auditB.ts:SHIM': {
    'src/services/auditA.ts': `import type { Request } from 'express'; // @bkb-shim
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
    'src/services/auditB.ts': `import type { Request } from 'express'; // @bkb-shim
import { describeRequest, type AuditableRequest } from './auditA';

export function formatAuditLine(parts: string[]): string {
  return parts.join(':');
}

export function auditRequest(req: AuditableRequest): string {
  const [method, hash] = describeRequest(req);
  return formatAuditLine([method, hash]);
}
`,
  },

  // Step 4: orders.ts -> SHIM
  'src/routes/orders.ts:SHIM': {
    'src/routes/orders.ts': `import express from 'express'; // @bkb-shim
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

const router = express.Router(); // @bkb-shim
router.get('/', requireAuth, (req, res) => { // @bkb-shim
  return sendSuccess(res, { items: orders, audit: auditRequest(req) }); // @bkb-shim
}); // @bkb-shim
router.get('/:id', requireAuth, (req, res) => { // @bkb-shim
  const order = orders.find((o) => o.id === Number(req.params.id)); // @bkb-shim
  if (!order) return sendError(res, 'Order not found', 404); // @bkb-shim
  return sendSuccess(res, order); // @bkb-shim
}); // @bkb-shim

export const ordersRouter = router; // @bkb-shim
`,
  },

  // Step 5: users.ts -> SHIM
  'src/routes/users.ts:SHIM': {
    'src/routes/users.ts': `import express from 'express'; // @bkb-shim
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

const router = express.Router(); // @bkb-shim
router.get('/', requireAuth, (req, res) => { // @bkb-shim
  return sendSuccess(res, { items: users, audit: auditRequest(req) }); // @bkb-shim
}); // @bkb-shim
router.get('/:id', requireAuth, (req, res) => { // @bkb-shim
  const user = users.find((u) => u.id === Number(req.params.id)); // @bkb-shim
  if (!user) return sendError(res, 'User not found', 404); // @bkb-shim
  return sendSuccess(res, user); // @bkb-shim
}); // @bkb-shim
router.post('/', requireAuth, (req, res) => { // @bkb-shim
  const name = typeof req.body?.name === 'string' ? req.body.name : ''; // @bkb-shim
  if (!name) return sendError(res, 'name is required', 400); // @bkb-shim
  const user: User = { id: users.length + 1, name }; // @bkb-shim
  users.push(user); // @bkb-shim
  return sendSuccess(res, user, 201); // @bkb-shim
}); // @bkb-shim

export const usersRouter = router; // @bkb-shim
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
  const [method, hash] = describeRequest(req);
  return formatAuditLine([method, hash]);
}
`,
  },

  // Step 10: auth.ts -> DE_SHIM
  'src/middleware/auth.ts:DE_SHIM': {
    'src/middleware/auth.ts': `import type { FastifyRequest, FastifyReply } from 'fastify';
import { sendError } from '../utils/response';

/** Require auth preHandler (pure Fastify). */
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
  const expectedGraph = getGraphNameForRepo(activeRepo);
  if (!dbClient || dbClient.graphName !== expectedGraph) {
    if (dbClient) {
      await dbClient.close().catch(() => {});
    }
    await ensureFalkorDB();
    dbClient = await FalkorClient.connect({ graphName: expectedGraph });
  }
  return dbClient;
}

async function getOps(): Promise<MigrationOps> {
  if (!currentOps) {
    const client = await getClient();
    const mgr = await MigrationGraphManager.create(activeRepo, activePackId, {
      graphName: getGraphNameForRepo(activeRepo),
      client,
    });
    currentOps = new MigrationOps(mgr.db, mgr.pack, mgr.repoPath);
  }
  return currentOps;
}

async function resetDemoState() {
  console.error('[cockpit] Resetting scratch target repo...');
  rmSync(DEFAULT_TARGET_REPO, { recursive: true, force: true });
  mkdirSync(DEFAULT_TARGET_REPO, { recursive: true });

  cpSync(resolve(SOURCE_REPO, 'src'), resolve(DEFAULT_TARGET_REPO, 'src'), { recursive: true });
  cpSync(resolve(SOURCE_REPO, 'scripts'), resolve(DEFAULT_TARGET_REPO, 'scripts'), { recursive: true });
  cpSync(resolve(SOURCE_REPO, 'test'), resolve(DEFAULT_TARGET_REPO, 'test'), { recursive: true });
  cpSync(resolve(SOURCE_REPO, 'package.json'), resolve(DEFAULT_TARGET_REPO, 'package.json'));
  cpSync(resolve(SOURCE_REPO, 'tsconfig.json'), resolve(DEFAULT_TARGET_REPO, 'tsconfig.json'));
  symlinkSync(resolve(SOURCE_REPO, 'node_modules'), resolve(DEFAULT_TARGET_REPO, 'node_modules'), 'junction');

  activeRepo = DEFAULT_TARGET_REPO;
  activePackId = DEFAULT_PACK_ID;

  const client = await getClient();
  await MigrationGraphManager.initMigrationGraph({
    repoPath: DEFAULT_TARGET_REPO,
    packId: DEFAULT_PACK_ID,
    graphName: getGraphNameForRepo(DEFAULT_TARGET_REPO),
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
    currentRepo: activeRepo,
    displayRepo: activeRepo === DEFAULT_TARGET_REPO ? 'demo-repo (Sandbox)' : activeRepo,
    isDemoRepo: activeRepo === DEFAULT_TARGET_REPO,
    currentPackId: activePackId,
    mode: activeMode,
    provider: activeProvider,
    model: activeModel,
  };
}

// ── HTTP Helpers ─────────────────────────────────────────

function sendJson(res: ServerResponse, data: unknown, status = 200) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const origin = (res as any).__origin;
  if (origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  res.writeHead(status, headers);
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

function parseJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

export function startDemoServer(port = PORT) {
  const publicDir = resolve(WORKSPACE, 'public');

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    (res as any).__origin = origin;

    // Reject untrusted cross-origin requests from external websites
    if (origin && !isOriginAllowed(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: untrusted origin' }));
      return;
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      const preflightHeaders: Record<string, string> = {};
      if (origin && isOriginAllowed(origin)) {
        preflightHeaders['Access-Control-Allow-Origin'] = origin;
        preflightHeaders['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        preflightHeaders['Access-Control-Allow-Headers'] = 'Content-Type';
      }
      res.writeHead(204, preflightHeaders);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ── Real-Time Synchronization Endpoints ──

    // SSE Stream for connected browser tabs
    if (pathname === '/api/events' && req.method === 'GET') {
      const sseHeaders: Record<string, string> = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      };
      if (origin && isOriginAllowed(origin)) {
        sseHeaders['Access-Control-Allow-Origin'] = origin;
      }
      res.writeHead(200, sseHeaders);
      res.write(
        `data: ${JSON.stringify({
          type: 'connected',
          activeRepo,
          activePackId,
          graphName: getGraphNameForRepo(activeRepo),
        })}\n\n`,
      );
      sseClients.add(res);

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // Ingest event broadcast from CLI or MCP Server process
    if (pathname === '/api/broadcast' && req.method === 'POST') {
      try {
        const event = (await parseJsonBody(req)) as Record<string, any>;
        if (event.repoPath && resolve(event.repoPath) !== activeRepo) {
          activeRepo = resolve(event.repoPath);
          if (event.packId) activePackId = event.packId;
          if (dbClient) {
            await dbClient.close().catch(() => {});
            dbClient = null;
          }
          currentOps = null;
        }

        broadcastSse(event);
        sendJson(res, { ok: true, clientCount: sseClients.size });
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    // 1. System Info & Configuration Status
    if (pathname === '/api/info' && req.method === 'GET') {
      try {
        const packsDir = resolve(WORKSPACE, 'packs');
        const availablePacks = existsSync(packsDir)
          ? readdirSync(packsDir)
              .filter((f) => f.endsWith('.json') || f.endsWith('.ts'))
              .map((f) => f.replace(/\.(json|ts)$/, ''))
          : ['express-to-fastify'];

        if (!availablePacks.includes('express-to-fastify')) {
          availablePacks.unshift('express-to-fastify');
        }

        const checkpoints = listCheckpoints(activeRepo);

        sendJson(res, {
          currentRepo: activeRepo,
          displayRepo: activeRepo === DEFAULT_TARGET_REPO ? 'demo-repo (Sandbox)' : activeRepo,
          isDemoRepo: activeRepo === DEFAULT_TARGET_REPO,
          graphName: getGraphNameForRepo(activeRepo),
          currentPackId: activePackId,
          mode: activeMode,
          provider: activeProvider,
          model: activeModel,
          availablePacks,
          checkpoints,
          sseClientsCount: sseClients.size,
        });
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    // 2. Graph Topology & Live Stats
    if (pathname === '/api/graph' && req.method === 'GET') {
      try {
        const topology = await getGraphTopology();
        sendJson(res, topology);
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    // 3. Dynamic Target Repository & Mode Switching
    if (pathname === '/api/target' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        if (body.repoPath !== undefined) {
          let targetPath = activeRepo;
          if (body.repoPath === 'demo' || body.repoPath === '' || body.repoPath === './demo-repo') {
            targetPath = DEFAULT_TARGET_REPO;
          } else {
            targetPath = resolve(WORKSPACE, body.repoPath);
          }
          if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
            sendJson(res, { error: `Invalid repository path: ${body.repoPath}` }, 400);
            return;
          }
          activeRepo = targetPath;
        }
        if (body.packId) activePackId = body.packId;
        if (body.mode) activeMode = body.mode;
        if (body.provider) activeProvider = body.provider;
        if (body.model) activeModel = body.model;

        currentOps = null;
        const client = await getClient();

        if (body.reset || !existsSync(activeRepo)) {
          if (activeRepo === DEFAULT_TARGET_REPO) {
            await resetDemoState();
          } else {
            await MigrationGraphManager.initMigrationGraph({
              repoPath: activeRepo,
              packId: activePackId,
              graphName: getGraphNameForRepo(activeRepo),
              client,
              reset: true,
            });
          }
        }

        const topology = await getGraphTopology();
        sendJson(res, {
          success: true,
          currentRepo: activeRepo,
          displayRepo: activeRepo === DEFAULT_TARGET_REPO ? 'demo-repo (Sandbox)' : activeRepo,
          isDemoRepo: activeRepo === DEFAULT_TARGET_REPO,
          currentPackId: activePackId,
          mode: activeMode,
          provider: activeProvider,
          model: activeModel,
          topology,
        });
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    // 4. Codebase & Graph Reset
    if (pathname === '/api/reset' && req.method === 'POST') {
      try {
        if (activeRepo === DEFAULT_TARGET_REPO) {
          await resetDemoState();
        } else {
          const client = await getClient();
          await MigrationGraphManager.initMigrationGraph({
            repoPath: activeRepo,
            packId: activePackId,
            graphName: getGraphNameForRepo(activeRepo),
            client,
            reset: true,
          });
          currentOps = null;
        }

        const topology = await getGraphTopology();
        sendJson(res, { success: true, topology });
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    // 5. Query Unblocked Target (Claim Dry-Run)
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

    // 6. Step Forward Migration Execution
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

        // Determine step key
        const sortedTargets = [...claim.targetPaths].sort().join(',');
        const stepKey = `${sortedTargets}:${claim.phase}`;
        let replacements: Record<string, string> | undefined;

        // Mode A: Canned step diff (if in canned mode and stepKey exists)
        if (activeMode === 'canned' && activeRepo === DEFAULT_TARGET_REPO) {
          replacements = STEP_CODE_STATES[stepKey];
        }

        // Mode B: Live LLM Transform via LlmClient
        if (!replacements) {
          const llmClient = new LlmClient({
            provider: activeProvider === 'mock' && activeRepo !== DEFAULT_TARGET_REPO ? 'ollama' : activeProvider,
            model: activeModel,
          });

          const slice = await ops.getMigrationSlice(claim.targetPaths, claim.phase);
          replacements = {};

          // Snapshot checkpoint before modifying disk
          const client = await getClient();
          const epRows = await client.roQuery<any>(`MATCH (e:MigrationEpisode) RETURN count(e) AS n`);
          const epStep = Number(epRows[0]?.n ?? 0) + 1;
          saveCheckpoint(activeRepo, epStep, claim.targetPaths);

          for (const targetPath of claim.targetPaths) {
            const abs = resolve(activeRepo, targetPath);
            const oldCode = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
            const transform = await llmClient.generateTransform({
              targetPath,
              phase: claim.phase,
              fullSource: oldCode,
              guidance: slice.guidance,
              calleeSignatures: slice.calleeSignatures,
              callerSnippets: slice.callerSnippets,
            });
            replacements[targetPath] = transform.code;
          }
        }

        // Apply file writes to disk
        const modifiedFiles: Array<{ path: string; oldCode: string; newCode: string }> = [];
        for (const [relPath, newContent] of Object.entries(replacements)) {
          const abs = resolve(activeRepo, relPath);
          let oldCode = '';
          try {
            oldCode = readFileSync(abs, 'utf8');
          } catch {
            oldCode = '';
          }
          writeFileSync(abs, newContent);
          modifiedFiles.push({ path: relPath, oldCode, newCode: newContent });
        }

        // Run real verification & node commit in FalkorDB
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

    // 7. Disk File Content Viewer
    if (pathname === '/api/file' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) {
        sendJson(res, { error: 'Missing path query parameter' }, 400);
        return;
      }
      if (!isPathContained(activeRepo, filePath)) {
        sendJson(res, { error: 'Access denied: path escapes active repository root' }, 403);
        return;
      }
      try {
        const absPath = resolve(activeRepo, filePath);
        if (!existsSync(absPath)) {
          sendJson(res, { error: `File not found: ${filePath}` }, 404);
          return;
        }
        const content = readFileSync(absPath, 'utf8');
        sendJson(res, {
          path: filePath,
          content,
          linesCount: content.split('\n').length,
        });
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    // 8. Detailed Node Inspector (Callers, Callees, Symbols, Blast Radius)
    if (pathname === '/api/node-detail' && req.method === 'GET') {
      const nodePath = url.searchParams.get('path');
      if (!nodePath) {
        sendJson(res, { error: 'Missing path query parameter' }, 400);
        return;
      }
      try {
        const client = await getClient();
        const ops = await getOps();

        // Node metadata
        const nodeRows = await client.roQuery<any>(`
          MATCH (m:Module {path: $path})
          RETURN m.path AS path, m.status AS status, m.scc_id AS sccId, m.scc_size AS sccSize,
                 m.pagerank AS pagerank, m.pending_callers_count AS pendingCallers,
                 m.in_degree AS inDegree, m.shim_line_count AS shimLines
        `, { path: nodePath });

        const nodeMeta = nodeRows[0] ?? null;

        // Direct Callees
        const callees = await client.roQuery<any>(`
          MATCH (m:Module {path: $path})-[:IMPORTS]->(callee:Module)
          RETURN callee.path AS path, callee.status AS status
        `, { path: nodePath });

        // Direct Callers
        const callers = await client.roQuery<any>(`
          MATCH (caller:Module)-[:IMPORTS]->(m:Module {path: $path})
          RETURN caller.path AS path, caller.status AS status
        `, { path: nodePath });

        // Symbols declared
        const symbols = await client.roQuery<any>(`
          MATCH (m:Module {path: $path})-[:DECLARES]->(s:Symbol)
          RETURN s.name AS name, s.kind AS kind, s.signature AS signature
        `, { path: nodePath });

        // Multi-hop blast radius
        const blast = await ops.simulateBlastRadius(nodePath).catch(() => []);

        // File content from disk (guarded by repository containment)
        let fileContent = '';
        try {
          if (isPathContained(activeRepo, nodePath)) {
            const absPath = resolve(activeRepo, nodePath);
            if (existsSync(absPath)) {
              fileContent = readFileSync(absPath, 'utf8');
            }
          }
        } catch {
          fileContent = '';
        }

        sendJson(res, {
          meta: nodeMeta,
          callees,
          callers,
          symbols,
          blastRadius: blast,
          fileContent,
        });
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    // 9. Checkpoints List & Rollback
    if (pathname === '/api/checkpoints' && req.method === 'GET') {
      try {
        const checkpoints = listCheckpoints(activeRepo);
        sendJson(res, { checkpoints });
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/rollback' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const result = await rollbackToCheckpoint(activeRepo, activePackId, body.step, getGraphNameForRepo(activeRepo));
        currentOps = null;
        const topology = await getGraphTopology();
        sendJson(res, {
          ...result,
          topology,
          checkpoints: listCheckpoints(activeRepo),
        });
      } catch (err: any) {
        sendJson(res, { error: err.message }, 500);
      }
      return;
    }

    // 10. Audit Trail & Checkpoint Verification Gate
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

  server.listen(port, '127.0.0.1', async () => {
    console.error(`\n======================================================`);
    console.error(`  BAGWAN KAI BANDEY MIGRATION COCKPIT IS LIVE ON HTTP`);
    console.error(`  URL: http://localhost:${port}`);
    console.error(`======================================================\n`);

    // Ensure initial demo state exists
    if (!existsSync(DEFAULT_TARGET_REPO)) {
      await resetDemoState();
    }
  });

  return server;
}

// Direct execution CLI runner
if (process.argv[1]?.includes('demoServer')) {
  startDemoServer();
}
