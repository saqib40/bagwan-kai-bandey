/**
 * Multi-Provider LLM Client for Autonomous Migrations (`src/runner/llmClient.ts`).
 * Supports:
 *  - 'mock': Built-in verified reference transforms for zero-cost dry runs & tests
 *  - 'ollama': Local zero-cost LLM (e.g. qwen2.5-coder, deepseek-coder) via http://localhost:11434
 *  - 'openai': OpenAI chat completions API (gpt-4o, gpt-4o-mini, etc.)
 *  - 'anthropic': Anthropic messages API (claude-3-5-sonnet, etc.)
 */

import { shimMarkerList } from '../adapters/types';

export interface LlmRequest {
  targetPath: string;
  phase: 'MIGRATE' | 'SHIM' | 'DE_SHIM';
  fullSource: string;
  guidance: string;
  calleeSignatures: Array<{
    modulePath: string;
    symbolId: string;
    symbolName: string;
    kind: string;
    signature: string;
  }>;
  callerSnippets: Array<{
    callerPath: string;
    importSnippet: string;
  }>;
  previousErrors?: string[];
}

export interface LlmResponse {
  code: string;
  summary: string;
}

export interface LlmClientOptions {
  provider?: 'mock' | 'ollama' | 'openai' | 'anthropic' | 'custom';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Target language of the migration pack (drives prompt fences). Defaults to 'typescript'. */
  language?: string;
  /** Repository root, used to load fixture-local mock transforms (`.bkb-mocks.json`). */
  repoPath?: string;
}

/** Returns the markdown code-fence aliases accepted for a given language. */
export function fenceAliasesForLanguage(language: string): string[] {
  switch ((language || 'typescript').toLowerCase()) {
    case 'python':
    case 'py':
      return ['python', 'py'];
    case 'javascript':
    case 'js':
      return ['javascript', 'js', 'typescript', 'ts'];
    default:
      return ['typescript', 'ts', 'javascript', 'js'];
  }
}

/** Returns the canonical fence label used when instructing the model. */
export function canonicalFenceForLanguage(language: string): string {
  switch ((language || 'typescript').toLowerCase()) {
    case 'python':
    case 'py':
      return 'python';
    case 'javascript':
    case 'js':
      return 'javascript';
    default:
      return 'typescript';
  }
}

/** Human-readable language label for prompts. */
function displayLanguage(language: string): string {
  switch ((language || 'typescript').toLowerCase()) {
    case 'python':
    case 'py':
      return 'Python';
    case 'javascript':
    case 'js':
      return 'JavaScript';
    default:
      return 'TypeScript';
  }
}

/**
 * Extracts raw source code from an LLM response containing optional markdown code fences.
 * The accepted fence languages are derived from `language` (defaults to TypeScript).
 */
export function extractCodeFromMarkdown(raw: string, language = 'typescript'): string {
  const aliases = fenceAliasesForLanguage(language).join('|');
  const match = raw.match(new RegExp('```(?:' + aliases + ')?\\s*\\n([\\s\\S]*?)```'));
  if (match && match[1]) {
    return match[1].trim() + '\n';
  }
  return raw.trim() + '\n';
}

// Built-in verified reference implementations for the Express -> Fastify pack (used by 'mock' provider)
const MOCK_TRANSFORMS: Record<string, LlmResponse> = {
  'src/utils/response.ts:SHIM': {
    code: `import type { FastifyReply } from 'fastify';
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
    summary: 'Dual-compatible response helper shim',
  },
  'src/utils/response.ts:DE_SHIM': {
    code: `import type { FastifyReply } from 'fastify';

export function sendSuccess(reply: FastifyReply, data: unknown, statusCode = 200) {
  return reply.code(statusCode).send({ ok: true, data });
}

export function sendError(reply: FastifyReply, message: string, statusCode = 400) {
  return reply.code(statusCode).send({ ok: false, error: message });
}
`,
    summary: 'De-shimmed response helpers to pure FastifyReply',
  },
  'src/middleware/auth.ts:SHIM': {
    code: `import type { Request, Response, NextFunction } from 'express'; // @bkb-shim
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
    summary: 'Dual-compatible authentication middleware shim',
  },
  'src/middleware/auth.ts:DE_SHIM': {
    code: `import type { FastifyRequest, FastifyReply } from 'fastify';
import { sendError } from '../utils/response';

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['x-api-key'];
  if (apiKey !== 'secret-token') {
    return sendError(reply, 'Unauthorized', 401);
  }
}
`,
    summary: 'De-shimmed authentication middleware to pure Fastify preHandler hook',
  },
  'src/services/auditA.ts:SHIM': {
    code: `import type { Request } from 'express'; // @bkb-shim
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
    summary: 'Dual-compatible auditA request description shim',
  },
  'src/services/auditA.ts:DE_SHIM': {
    code: `import { shortHash } from '../utils/hash';
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
    summary: 'De-shimmed auditA request description',
  },
  'src/services/auditB.ts:SHIM': {
    code: `import type { Request } from 'express'; // @bkb-shim
import { describeRequest, type AuditableRequest } from './auditA';

export function formatAuditLine(parts: string[]): string {
  return parts.join(':');
}

export function auditRequest(req: AuditableRequest): string {
  return \`audit:\${formatAuditLine(describeRequest(req))}\`;
}
`,
    summary: 'Dual-compatible auditB request formatting shim',
  },
  'src/services/auditB.ts:DE_SHIM': {
    code: `import { describeRequest, type AuditableRequest } from './auditA';

export function formatAuditLine(parts: string[]): string {
  return parts.join(':');
}

export function auditRequest(req: AuditableRequest): string {
  return \`audit:\${formatAuditLine(describeRequest(req))}\`;
}
`,
    summary: 'De-shimmed auditB request formatting',
  },
  'src/routes/orders.ts:SHIM': {
    code: `import express from 'express'; // @bkb-shim
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
    summary: 'Dual-compatible orders router shim',
  },
  'src/routes/orders.ts:DE_SHIM': {
    code: `import type { FastifyPluginAsync } from 'fastify';
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
    summary: 'De-shimmed orders router to pure FastifyPluginAsync',
  },
  'src/routes/users.ts:SHIM': {
    code: `import express from 'express'; // @bkb-shim
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
    summary: 'Dual-compatible users router shim',
  },
  'src/routes/users.ts:DE_SHIM': {
    code: `import type { FastifyPluginAsync } from 'fastify';
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
    summary: 'De-shimmed users router to pure FastifyPluginAsync',
  },
  'src/app.ts:MIGRATE': {
    code: `import Fastify from 'fastify';
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
    summary: 'Migrated root application entrypoint to Fastify instance registration',
  },
};

export class LlmClient {
  readonly provider: 'mock' | 'ollama' | 'openai' | 'anthropic' | 'custom';
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly language: string;

  constructor(options: LlmClientOptions = {}) {
    this.provider = options.provider ?? (process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock');
    this.apiKey = options.apiKey ?? (this.provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY);
    this.baseUrl = options.baseUrl;
    this.language = options.language ?? 'typescript';

    if (this.provider === 'openai') {
      this.model = options.model ?? 'gpt-4o';
    } else if (this.provider === 'anthropic') {
      this.model = options.model ?? 'claude-3-5-sonnet-20241022';
    } else if (this.provider === 'ollama') {
      this.model = options.model ?? 'qwen2.5-coder:latest';
      this.baseUrl = this.baseUrl ?? 'http://localhost:11434';
    } else {
      this.model = options.model ?? 'mock-deterministic';
    }
  }

  async generateTransform(request: LlmRequest): Promise<LlmResponse> {
    if (this.provider === 'mock') {
      const key = `${request.targetPath}:${request.phase}`;
      let entry = MOCK_TRANSFORMS[key];
      if (!entry) {
        if (request.phase === 'MIGRATE') {
          entry = MOCK_TRANSFORMS[`${request.targetPath}:DE_SHIM`] ?? MOCK_TRANSFORMS[`${request.targetPath}:SHIM`];
        } else if (request.phase === 'SHIM') {
          entry = MOCK_TRANSFORMS[`${request.targetPath}:MIGRATE`];
        } else if (request.phase === 'DE_SHIM') {
          entry = MOCK_TRANSFORMS[`${request.targetPath}:MIGRATE`];
        }
      }
      if (entry) {
        return entry;
      }
      return {
        code: request.fullSource,
        summary: `Mock fallback: retained original source for ${request.targetPath}`,
      };
    }

    const prompt = this.buildPrompt(request);

    if (this.provider === 'openai') {
      return this.callOpenAi(prompt, request);
    } else if (this.provider === 'anthropic') {
      return this.callAnthropic(prompt, request);
    } else if (this.provider === 'ollama') {
      return this.callOllama(prompt, request);
    }

    throw new Error(`Unsupported LLM provider: ${this.provider}`);
  }

  private buildPrompt(req: LlmRequest): string {
    const fence = canonicalFenceForLanguage(this.language);
    return `You are an expert autonomous codebase migration engineer using Bagwan Kai Bandey (BKB).
Your mission is to migrate the module at "${req.targetPath}" for Phase "${req.phase}".

MIGRATION GUIDANCE:
${req.guidance}

CALLEE EXPORTED SIGNATURES (Downstream dependencies):
${req.calleeSignatures.length ? req.calleeSignatures.map((s) => `${s.modulePath}: ${s.symbolName} (${s.kind}) -> ${s.signature}`).join('\n') : '(None)'}

CALLER SNIPPETS (Upstream callers):
${req.callerSnippets.map((u) => `${u.callerPath}: ${u.importSnippet}`).join('\n') || '(None)'}

CURRENT SOURCE CODE:
\`\`\`${fence}
${req.fullSource}
\`\`\`

${req.previousErrors?.length ? `PREVIOUS COMPILATION / INVARIANT ERRORS (Please fix these):\n${req.previousErrors.join('\n')}\n` : ''}

RULES:
1. Return ONLY valid, compilable ${displayLanguage(this.language)} code inside a single \`\`\`${fence} ... \`\`\` code block.
2. In Phase "SHIM": Maintain backward compatibility for callers that still use the legacy API using ${shimMarkerList()} tags on legacy lines. Both markers are accepted.
3. In Phase "MIGRATE": Replace internal legacy API usages with modern target framework equivalents.
4. In Phase "DE_SHIM": Remove all ${shimMarkerList()} tags and legacy fallback branches entirely.
5. Invariants: Preserve all exported names, public symbols, route paths, parameter names, and HTTP status codes exactly as required by the migration pack's invariants.`;
  }

  private async callOpenAi(prompt: string, req: LlmRequest): Promise<LlmResponse> {
    const url = `${this.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: `You are an autonomous codebase migration engine. Output only ${displayLanguage(this.language)} code.` },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API request failed (${res.status}): ${errText}`);
    }

    const data: any = await res.json();
    const rawCode = data.choices?.[0]?.message?.content ?? req.fullSource;
    return {
      code: extractCodeFromMarkdown(rawCode, this.language),
      summary: `AI migrated ${req.targetPath} via ${this.model}`,
    };
  }

  private async callAnthropic(prompt: string, req: LlmRequest): Promise<LlmResponse> {
    const url = `${this.baseUrl ?? 'https://api.anthropic.com/v1'}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API request failed (${res.status}): ${errText}`);
    }

    const data: any = await res.json();
    const rawCode = data.content?.[0]?.text ?? req.fullSource;
    return {
      code: extractCodeFromMarkdown(rawCode, this.language),
      summary: `AI migrated ${req.targetPath} via ${this.model}`,
    };
  }

  private async callOllama(prompt: string, req: LlmRequest): Promise<LlmResponse> {
    const url = `${this.baseUrl ?? 'http://localhost:11434'}/api/generate`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama request failed (${res.status}): ${errText}`);
    }

    const data: any = await res.json();
    const rawCode = data.response ?? req.fullSource;
    return {
      code: extractCodeFromMarkdown(rawCode, this.language),
      summary: `Local Ollama migrated ${req.targetPath} via ${this.model}`,
    };
  }
}
