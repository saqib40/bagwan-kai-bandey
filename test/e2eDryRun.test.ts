/**
 * Milestone 3: End-to-End Autonomous Migration Dry Run (`test/e2eDryRun.test.ts`).
 *
 * Exercises the complete Shift engine via MCP client tool calls:
 *  1. response.ts & auth.ts transition PENDING -> SHIMMED -> VERIFIED
 *  2. auditA & auditB migrate atomically as a Tarjan SCC
 *  3. tsc --noEmit passes on EVERY intermediate step
 *  4. npm test + dump-routes.mjs match 100% at checkpoint & completion
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createShiftMcpServer } from '../src/mcp/server';

const WORKSPACE = resolve(import.meta.dirname, '..');
const SOURCE_REPO = resolve(WORKSPACE, 'demo-repo');
const TARGET_REPO = resolve(WORKSPACE, 'scratch/e2e-demo-repo');
const TEST_GRAPH = 'shift_e2e_dryrun';
const PACK_ID = 'express-to-fastify';

test('End-to-End Autonomous Migration: demo-repo completely migrated via BKB MCP', async () => {
  // ── Setup Scratch Target Repo ──
  rmSync(TARGET_REPO, { recursive: true, force: true });
  mkdirSync(TARGET_REPO, { recursive: true });

  cpSync(resolve(SOURCE_REPO, 'src'), resolve(TARGET_REPO, 'src'), { recursive: true });
  cpSync(resolve(SOURCE_REPO, 'scripts'), resolve(TARGET_REPO, 'scripts'), { recursive: true });
  cpSync(resolve(SOURCE_REPO, 'test'), resolve(TARGET_REPO, 'test'), { recursive: true });
  cpSync(resolve(SOURCE_REPO, 'package.json'), resolve(TARGET_REPO, 'package.json'));
  cpSync(resolve(SOURCE_REPO, 'tsconfig.json'), resolve(TARGET_REPO, 'tsconfig.json'));
  symlinkSync(resolve(SOURCE_REPO, 'node_modules'), resolve(TARGET_REPO, 'node_modules'), 'junction');

  // Verify baseline test & routes in scratch target
  const baseRoutesOut = execSync('node scripts/dump-routes.mjs', { cwd: TARGET_REPO, encoding: 'utf8' }).trim();
  const baselineRoutes = JSON.parse(baseRoutesOut);
  assert.equal(baselineRoutes.length, 5);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createShiftMcpServer({
    defaultRepoPath: TARGET_REPO,
    defaultPackId: PACK_ID,
    graphName: TEST_GRAPH,
  });

  await server.connect(serverTransport);
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);

  try {
    // ── Tool 1: init_migration_graph ──
    const initRes = await client.callTool({
      name: 'init_migration_graph',
      arguments: { repoPath: TARGET_REPO, packId: PACK_ID, reset: true },
    });
    assert.equal(initRes.isError ?? false, false);
    const initData = JSON.parse((initRes.content as any)[0].text);
    assert.equal(initData.summary.totalModules, 9);
    assert.equal(initData.summary.cleanModules, 2);
    assert.equal(initData.summary.pendingModules, 7);

    // ── Step 1: Claim & Shim utils/response.ts ──
    const claim1 = JSON.parse(((await client.callTool({ name: 'claim_next_leaf', arguments: {} })).content as any)[0].text);
    assert.equal(claim1.claimed, true);
    assert.equal(claim1.phase, 'SHIM');
    assert.deepEqual(claim1.targetPaths, ['src/utils/response.ts']);
    assert.equal(claim1.pendingCallersCount, 3);

    // Get slice
    const slice1 = JSON.parse(((await client.callTool({
      name: 'get_migration_slice',
      arguments: { modulePaths: claim1.targetPaths, phase: 'SHIM' },
    })).content as any)[0].text);
    assert.ok(slice1.guidance.includes('// @shift-shim'));

    // Write dual-signature shim for response.ts
    writeFileSync(
      resolve(TARGET_REPO, 'src/utils/response.ts'),
      `import type { FastifyReply } from 'fastify';
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
    );

    const v1 = JSON.parse(((await client.callTool({
      name: 'verify_and_commit_node',
      arguments: { modulePaths: ['src/utils/response.ts'], agentSummary: 'Dual-compatible response helper shim' },
    })).content as any)[0].text);
    assert.equal(v1.ok, true);
    assert.equal(v1.newStatus, 'SHIMMED');

    // ── Step 2: Claim & Shim middleware/auth.ts ──
    const claim2 = JSON.parse(((await client.callTool({ name: 'claim_next_leaf', arguments: {} })).content as any)[0].text);
    assert.equal(claim2.claimed, true);
    assert.equal(claim2.phase, 'SHIM');
    assert.deepEqual(claim2.targetPaths, ['src/middleware/auth.ts']);
    assert.equal(claim2.pendingCallersCount, 2);

    writeFileSync(
      resolve(TARGET_REPO, 'src/middleware/auth.ts'),
      `import type { Request, Response, NextFunction } from 'express'; // @shift-shim
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
    );

    const v2 = JSON.parse(((await client.callTool({
      name: 'verify_and_commit_node',
      arguments: { modulePaths: ['src/middleware/auth.ts'], agentSummary: 'Dual-compatible auth middleware shim' },
    })).content as any)[0].text);
    assert.equal(v2.ok, true);
    assert.equal(v2.newStatus, 'SHIMMED');

    // ── Step 3: Claim & Shim services/auditA.ts + auditB.ts (Atomic Tarjan SCC Cycle) ──
    const claim3 = JSON.parse(((await client.callTool({ name: 'claim_next_leaf', arguments: {} })).content as any)[0].text);
    assert.equal(claim3.claimed, true);
    assert.equal(claim3.targetPaths.length, 2);
    assert.ok(claim3.targetPaths.includes('src/services/auditA.ts'));
    assert.ok(claim3.targetPaths.includes('src/services/auditB.ts'));

    writeFileSync(
      resolve(TARGET_REPO, 'src/services/auditA.ts'),
      `import type { Request } from 'express'; // @shift-shim
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
    );

    writeFileSync(
      resolve(TARGET_REPO, 'src/services/auditB.ts'),
      `import type { Request } from 'express'; // @shift-shim
import { describeRequest, type AuditableRequest } from './auditA';

export function formatAuditLine(parts: string[]): string {
  return parts.join(':');
}

export function auditRequest(req: AuditableRequest): string {
  return \`audit:\${formatAuditLine(describeRequest(req))}\`;
}
`,
    );

    const v3 = JSON.parse(((await client.callTool({
      name: 'verify_and_commit_node',
      arguments: {
        modulePaths: ['src/services/auditA.ts', 'src/services/auditB.ts'],
        agentSummary: 'Atomic migration of audit cycle',
      },
    })).content as any)[0].text);
    assert.equal(v3.ok, true);
    assert.equal(v3.newStatus, 'SHIMMED');
    assert.equal(v3.checkpointTriggered, true);
    assert.equal(v3.checkpointResult?.tscPass, true);
    assert.equal(v3.checkpointResult?.testPass, true);
    assert.equal(v3.checkpointResult?.routeMatch, true);

    // ── Step 4: Claim & Shim routes/orders.ts ──
    const claim4 = JSON.parse(((await client.callTool({ name: 'claim_next_leaf', arguments: {} })).content as any)[0].text);
    assert.equal(claim4.claimed, true);
    assert.deepEqual(claim4.targetPaths, ['src/routes/orders.ts']);

    writeFileSync(
      resolve(TARGET_REPO, 'src/routes/orders.ts'),
      `import express from 'express'; // @shift-shim
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
    );

    const v4 = JSON.parse(((await client.callTool({
      name: 'verify_and_commit_node',
      arguments: { modulePaths: ['src/routes/orders.ts'], agentSummary: 'Dual-compatible orders router shim' },
    })).content as any)[0].text);
    assert.equal(v4.ok, true);
    assert.equal(v4.newStatus, 'SHIMMED');

    // ── Step 5: Claim & Shim routes/users.ts ──
    const claim5 = JSON.parse(((await client.callTool({ name: 'claim_next_leaf', arguments: {} })).content as any)[0].text);
    assert.equal(claim5.claimed, true);
    assert.deepEqual(claim5.targetPaths, ['src/routes/users.ts']);

    writeFileSync(
      resolve(TARGET_REPO, 'src/routes/users.ts'),
      `import express from 'express'; // @shift-shim
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
    );

    const v5 = JSON.parse(((await client.callTool({
      name: 'verify_and_commit_node',
      arguments: { modulePaths: ['src/routes/users.ts'], agentSummary: 'Dual-compatible users router shim' },
    })).content as any)[0].text);
    assert.equal(v5.ok, true);
    assert.equal(v5.newStatus, 'SHIMMED');

    // ── Step 6: Claim & Migrate app.ts (Root Caller) ──
    const claim6 = JSON.parse(((await client.callTool({ name: 'claim_next_leaf', arguments: {} })).content as any)[0].text);
    assert.equal(claim6.claimed, true);
    assert.equal(claim6.phase, 'MIGRATE');
    assert.deepEqual(claim6.targetPaths, ['src/app.ts']);
    assert.equal(claim6.pendingCallersCount, 0);

    writeFileSync(
      resolve(TARGET_REPO, 'src/app.ts'),
      `import Fastify from 'fastify';
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
    );

    const v6 = JSON.parse(((await client.callTool({
      name: 'verify_and_commit_node',
      arguments: { modulePaths: ['src/app.ts'], agentSummary: 'Migrate app.ts to Fastify instance registration' },
    })).content as any)[0].text);
    assert.equal(v6.ok, true);
    assert.equal(v6.newStatus, 'VERIFIED');

    // ── Step 7: Top-Down De-Shim Cascade (Pass A Priority) ──

    // 7a: De-shim routes/orders.ts
    const dClaim1 = JSON.parse(((await client.callTool({ name: 'claim_next_leaf', arguments: {} })).content as any)[0].text);
    assert.equal(dClaim1.claimed, true);
    assert.equal(dClaim1.phase, 'DE_SHIM');
    assert.deepEqual(dClaim1.targetPaths, ['src/routes/orders.ts']);

    writeFileSync(
      resolve(TARGET_REPO, 'src/routes/orders.ts'),
      `import type { FastifyPluginAsync } from 'fastify';
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
    );

    const dv1 = JSON.parse(((await client.callTool({
      name: 'verify_and_commit_node',
      arguments: { modulePaths: ['src/routes/orders.ts'], agentSummary: 'De-shim orders routes' },
    })).content as any)[0].text);
    assert.equal(dv1.ok, true);
    assert.equal(dv1.newStatus, 'VERIFIED');
    assert.equal(dv1.checkpointTriggered, true);

    // 7b: De-shim routes/users.ts
    const dClaim2 = JSON.parse(((await client.callTool({ name: 'claim_next_leaf', arguments: {} })).content as any)[0].text);
    assert.equal(dClaim2.claimed, true);
    assert.equal(dClaim2.phase, 'DE_SHIM');
    assert.deepEqual(dClaim2.targetPaths, ['src/routes/users.ts']);

    writeFileSync(
      resolve(TARGET_REPO, 'src/routes/users.ts'),
      `import type { FastifyPluginAsync } from 'fastify';
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
    );

    const dv2 = JSON.parse(((await client.callTool({
      name: 'verify_and_commit_node',
      arguments: { modulePaths: ['src/routes/users.ts'], agentSummary: 'De-shim users routes' },
    })).content as any)[0].text);
    assert.equal(dv2.ok, true);
    assert.equal(dv2.newStatus, 'VERIFIED');

    // 7c: De-shim services/auditA.ts & auditB.ts
    const dClaim3 = JSON.parse(((await client.callTool({ name: 'claim_next_leaf', arguments: {} })).content as any)[0].text);
    assert.equal(dClaim3.claimed, true);
    assert.equal(dClaim3.phase, 'DE_SHIM');

    writeFileSync(
      resolve(TARGET_REPO, 'src/services/auditA.ts'),
      `import { shortHash } from '../utils/hash';
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
    );

    writeFileSync(
      resolve(TARGET_REPO, 'src/services/auditB.ts'),
      `import { describeRequest, type AuditableRequest } from './auditA';

export function formatAuditLine(parts: string[]): string {
  return parts.join(':');
}

export function auditRequest(req: AuditableRequest): string {
  return \`audit:\${formatAuditLine(describeRequest(req))}\`;
}
`,
    );

    const dv3 = JSON.parse(((await client.callTool({
      name: 'verify_and_commit_node',
      arguments: { modulePaths: dClaim3.targetPaths, agentSummary: 'De-shim audit cycle' },
    })).content as any)[0].text);
    assert.equal(dv3.ok, true);
    assert.equal(dv3.newStatus, 'VERIFIED');

    // 7d: De-shim middleware/auth.ts
    const dClaim4 = JSON.parse(((await client.callTool({ name: 'claim_next_leaf', arguments: {} })).content as any)[0].text);
    assert.equal(dClaim4.claimed, true);
    assert.equal(dClaim4.phase, 'DE_SHIM');
    assert.deepEqual(dClaim4.targetPaths, ['src/middleware/auth.ts']);

    writeFileSync(
      resolve(TARGET_REPO, 'src/middleware/auth.ts'),
      `import type { FastifyRequest, FastifyReply } from 'fastify';
import { sendError } from '../utils/response';

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['x-api-key'];
  if (apiKey !== 'secret-token') {
    return sendError(reply, 'Unauthorized', 401);
  }
}
`,
    );

    const dv4 = JSON.parse(((await client.callTool({
      name: 'verify_and_commit_node',
      arguments: { modulePaths: ['src/middleware/auth.ts'], agentSummary: 'De-shim auth middleware' },
    })).content as any)[0].text);
    assert.equal(dv4.ok, true);
    assert.equal(dv4.newStatus, 'VERIFIED');

    // 7e: De-shim utils/response.ts
    const dClaim5 = JSON.parse(((await client.callTool({ name: 'claim_next_leaf', arguments: {} })).content as any)[0].text);
    assert.equal(dClaim5.claimed, true);
    assert.equal(dClaim5.phase, 'DE_SHIM');
    assert.deepEqual(dClaim5.targetPaths, ['src/utils/response.ts']);

    writeFileSync(
      resolve(TARGET_REPO, 'src/utils/response.ts'),
      `import type { FastifyReply } from 'fastify';

export function sendSuccess(reply: FastifyReply, data: unknown, statusCode = 200) {
  return reply.code(statusCode).send({ ok: true, data });
}

export function sendError(reply: FastifyReply, message: string, statusCode = 400) {
  return reply.code(statusCode).send({ ok: false, error: message });
}
`,
    );

    const dv5 = JSON.parse(((await client.callTool({
      name: 'verify_and_commit_node',
      arguments: { modulePaths: ['src/utils/response.ts'], agentSummary: 'De-shim response helper' },
    })).content as any)[0].text);
    assert.equal(dv5.ok, true);
    assert.equal(dv5.newStatus, 'VERIFIED');

    // ── Step 8: Verify Complete (No more claims) ──
    const finalClaim = JSON.parse(((await client.callTool({ name: 'claim_next_leaf', arguments: {} })).content as any)[0].text);
    assert.equal(finalClaim.claimed, false);

    // ── Step 9: Final Audit Trail & Checkpoint Gate ──
    const finalAudit = JSON.parse(((await client.callTool({
      name: 'get_migration_audit_trail',
      arguments: { runCheckpointNow: true },
    })).content as any)[0].text);

    assert.equal(finalAudit.totalEpisodes >= 11, true);
    assert.equal(finalAudit.checkpoint.tscPass, true);
    assert.equal(finalAudit.checkpoint.testPass, true);
    assert.equal(finalAudit.checkpoint.routeMatch, true);
    assert.equal(finalAudit.checkpoint.shimCount, 0);
    assert.equal(finalAudit.checkpoint.pendingCount, 0);
    assert.equal(finalAudit.checkpoint.shimmedCount, 0);

    // Verify dump-routes matches baseline 100%
    const currentRoutesOut = execSync('node scripts/dump-routes.mjs', { cwd: TARGET_REPO, encoding: 'utf8' }).trim();
    assert.equal(currentRoutesOut, baseRoutesOut);

    // Verify all tests pass in migrated app
    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;
    const testOut = execSync('npm test', { cwd: TARGET_REPO, encoding: 'utf8', env: cleanEnv });
    assert.ok(testOut.includes('pass 6'));
    assert.ok(testOut.includes('fail 0'));
  } finally {
    await client.close();
    await server.close();
    rmSync(TARGET_REPO, { recursive: true, force: true });
  }
});
