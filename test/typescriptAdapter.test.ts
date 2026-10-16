import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { TypeScriptAdapter } from '../src/adapters/typescriptAdapter';
import type { MigrationPack } from '../src/adapters/types';

const repoRoot = resolve(import.meta.dirname, '../demo-repo');
const pack: MigrationPack = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../packs/express-to-fastify.json'), 'utf8'),
);

test('TypeScriptAdapter scans files in demo-repo', async () => {
  const adapter = new TypeScriptAdapter();
  await adapter.init();
  const files = await adapter.findSourceFiles(repoRoot, pack.sourceGlobs);
  assert.ok(files.length >= 8);
  assert.ok(files.includes('src/utils/response.ts'));
  assert.ok(files.includes('src/app.ts'));
  assert.ok(files.includes('src/services/auditA.ts'));
});

test('TypeScriptAdapter parses src/utils/response.ts', async () => {
  const adapter = new TypeScriptAdapter();
  await adapter.init();
  const parsed = await adapter.parseModule(repoRoot, 'src/utils/response.ts', undefined, pack);

  assert.equal(parsed.hasSyntaxError, false);
  assert.equal(parsed.path, 'src/utils/response.ts');
  assert.deepEqual(parsed.imports, []);
  assert.ok(parsed.symbols.length >= 2);
  const names = parsed.symbols.map((s) => s.name);
  assert.ok(names.includes('sendSuccess'));
  assert.ok(names.includes('sendError'));

  // Should have express legacy detections
  assert.ok(parsed.apiUsages.length > 0);
  assert.ok(parsed.apiUsages.some((u) => u.ruleId === 'express-res-methods'));
});

test('TypeScriptAdapter extracts mutual imports for audit cycle', async () => {
  const adapter = new TypeScriptAdapter();
  await adapter.init();
  const a = await adapter.parseModule(repoRoot, 'src/services/auditA.ts', undefined, pack);
  const b = await adapter.parseModule(repoRoot, 'src/services/auditB.ts', undefined, pack);

  assert.ok(a.imports.includes('src/services/auditB.ts'));
  assert.ok(a.imports.includes('src/utils/hash.ts'));
  assert.ok(b.imports.includes('src/services/auditA.ts'));
});

test('TypeScriptAdapter extracts route invariants from routes/users.ts', async () => {
  const adapter = new TypeScriptAdapter();
  await adapter.init();
  const parsed = await adapter.parseModule(repoRoot, 'src/routes/users.ts', undefined, pack);

  const routes = parsed.invariantSets['module-route-surface-preserved'];
  assert.deepEqual(routes, ['GET /', 'GET /:id', 'POST /']);
});

test('TypeScriptAdapter resolves app.ts imports to routes', async () => {
  const adapter = new TypeScriptAdapter();
  await adapter.init();
  const parsed = await adapter.parseModule(repoRoot, 'src/app.ts', undefined, pack);

  assert.ok(parsed.imports.includes('src/routes/users.ts'));
  assert.ok(parsed.imports.includes('src/routes/orders.ts'));
});

test('TypeScriptAdapter resolves ESM .js imports to existing .ts files', async () => {
  const adapter = new TypeScriptAdapter();
  await adapter.init();
  // Simulate an ESM source file importing a relative module with .js extension
  const source = `import { sendSuccess } from "./response.js";\nimport { hashPassword } from "./hash.js";`;
  const parsed = await adapter.parseModule(repoRoot, 'src/utils/testModule.ts', source, pack);

  assert.ok(parsed.imports.includes('src/utils/response.ts'));
  assert.ok(parsed.imports.includes('src/utils/hash.ts'));
});

test('TypeScriptAdapter resolves relative .cjs and .mjs imports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bkb-cjs-esm-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/legacy.cjs'), 'module.exports = { value: 1 };\n');
    writeFileSync(join(dir, 'src/modern.mjs'), 'export const value = 2;\n');

    const adapter = new TypeScriptAdapter();
    await adapter.init();
    const source = `import legacy from "./legacy.cjs";\nimport { value } from "./modern.mjs";`;
    const parsed = await adapter.parseModule(dir, 'src/main.ts', source, pack);

    assert.ok(parsed.imports.includes('src/legacy.cjs'));
    assert.ok(parsed.imports.includes('src/modern.mjs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TypeScriptAdapter resolves path aliases and baseUrl from tsconfig.json', async () => {
  const adapter = new TypeScriptAdapter();
  await adapter.init();
  const realStarterRepo = resolve(import.meta.dirname, '../scratch/test-repos/typescript-express-starter/templates/default');
  const parsed = await adapter.parseModule(realStarterRepo, 'src/server.ts', undefined, pack);

  assert.ok(parsed.imports.includes('src/app.ts'));
  assert.ok(parsed.imports.includes('src/routes/auth.route.ts'));
  assert.ok(parsed.imports.includes('src/routes/users.route.ts'));
  assert.ok(parsed.imports.includes('src/utils/logger.ts'));
});

