/**
 * Extensibility & Plugin Tests (`test/extensibility.test.ts`).
 *
 * Verifies developer ergonomics for:
 *  - Layer 2: BaseLanguageAdapter inheritance and dynamic adapter registration.
 *  - Layer 3: defineMigrationPack, validatePack, and loadPackAsync.
 *  - Config: shift.config loading and injection.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import {
  BaseLanguageAdapter,
  adapterRegistry,
  AdapterRegistry,
  defineMigrationPack,
  validatePack,
  loadPack,
  loadPackAsync,
  type MigrationPack,
  type ParsedModule,
  defineConfig,
  loadConfig,
} from '../src/index';

describe('Layer 2 Extensibility: Language Adapters', () => {
  class CustomPythonAdapter extends BaseLanguageAdapter {
    readonly language = 'python';

    async parseModule(
      repoRoot: string,
      relativePath: string,
      sourceCode?: string,
      pack?: MigrationPack,
    ): Promise<ParsedModule> {
      const code = sourceCode ?? (await this.readSource(repoRoot, relativePath));
      // Basic regex extraction for testing
      const importMatches = [...code.matchAll(/import\s+([a-zA-Z0-9_]+)/g)].map((m) => m[1]);
      const symbol = this.createSymbol(relativePath, 'test_func', 'function', 'def test_func():');

      return this.createParsedModule({
        path: relativePath,
        fullSource: code,
        imports: importMatches,
        symbols: [symbol],
      });
    }
  }

  test('BaseLanguageAdapter provides functional discovery and creation helpers', async () => {
    const adapter = new CustomPythonAdapter();
    assert.equal(adapter.language, 'python');

    const parsed = await adapter.parseModule('/tmp', 'test.py', 'import math\n# @shift-shim\nimport os');
    assert.equal(parsed.path, 'test.py');
    assert.deepEqual(parsed.imports, ['math', 'os']);
    assert.equal(parsed.shimLineCount, 1);
    assert.equal(parsed.symbols.length, 1);
    assert.equal(parsed.symbols[0].id, 'test.py#test_func');
  });

  test('AdapterRegistry allows runtime registration and discovery', () => {
    const registry = new AdapterRegistry();
    assert.equal(registry.has('typescript'), true);
    assert.equal(registry.has('python'), false);

    registry.register(new CustomPythonAdapter());
    assert.equal(registry.has('python'), true);
    assert.equal(registry.get('python').language, 'python');
    assert.ok(registry.list().includes('python'));
  });

  test('AdapterRegistry throws actionable error for unregistered language', () => {
    const registry = new AdapterRegistry();
    assert.throws(
      () => registry.get('rust'),
      /No language adapter registered for "rust"/,
    );
  });
});

describe('Layer 3 Extensibility: Migration Packs', () => {
  const validPackObj: MigrationPack = {
    id: 'test-pack',
    name: 'Test Migration Pack',
    language: 'typescript',
    sourceGlobs: {
      include: ['src/**/*.ts'],
      exclude: ['**/dist/**'],
    },
    packages: {
      legacy: ['express'],
      target: ['fastify'],
    },
    detectionRules: [
      {
        id: 'test-rule',
        description: 'Test rule query',
        astQuery: '(call_expression)',
      },
    ],
    agentGuidance: {
      MIGRATE: 'Migrate to target framework.',
    },
    invariants: [],
    verification: {
      perStepTypecheckCmd: 'npm run typecheck',
      checkpointTestCmd: 'npm test',
      routeSnapshotCmd: 'node scripts/dump-routes.mjs',
    },
  };

  test('validatePack verifies sound packs and catches schema violations', () => {
    const validResult = validatePack(validPackObj);
    assert.equal(validResult.valid, true);
    assert.equal(validResult.errors.length, 0);

    const invalidResult = validatePack({ id: 'broken' });
    assert.equal(invalidResult.valid, false);
    assert.ok(invalidResult.errors.some((e) => e.includes('language')));
    assert.ok(invalidResult.errors.some((e) => e.includes('sourceGlobs')));
    assert.ok(invalidResult.errors.some((e) => e.includes('detectionRules')));
  });

  test('defineMigrationPack enforces schema validity at definition time', () => {
    const pack = defineMigrationPack(validPackObj);
    assert.equal(pack.id, 'test-pack');

    assert.throws(() => {
      defineMigrationPack({ id: 'broken' } as any);
    }, /Invalid migration pack/);
  });

  test('loadPack resolves built-in express-to-fastify pack', () => {
    const pack = loadPack('express-to-fastify');
    assert.equal(pack.id, 'express-to-fastify');
    assert.equal(pack.language, 'typescript');
    assert.ok(pack.detectionRules.length > 0);
  });

  test('loadPackAsync loads programmatic TS/JS migration packs', async () => {
    const scratchDir = resolve(process.cwd(), 'scratch/ext-test');
    if (!existsSync(scratchDir)) mkdirSync(scratchDir, { recursive: true });
    const tsPackFile = join(scratchDir, 'sample-pack.ts');

    const fileContent = `
      export default {
        id: 'programmatic-pack',
        name: 'Programmatic Pack',
        language: 'typescript',
        sourceGlobs: { include: ['src/**/*.ts'] },
        packages: { legacy: ['a'], target: ['b'] },
        detectionRules: [{ id: 'r1', description: 'test', astQuery: '(id)' }],
        agentGuidance: { MIGRATE: 'test' },
        invariants: [],
        verification: {
          perStepTypecheckCmd: 'true',
          checkpointTestCmd: 'true',
          routeSnapshotCmd: 'true',
        },
      };
    `;
    writeFileSync(tsPackFile, fileContent);

    try {
      const loaded = await loadPackAsync(tsPackFile);
      assert.equal(loaded.id, 'programmatic-pack');
      assert.equal(loaded.language, 'typescript');
    } finally {
      if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe('Shift Configuration System', () => {
  test('defineConfig returns typed configuration object', () => {
    const config = defineConfig({
      packDirs: ['./custom-packs'],
      defaultPack: 'express-to-fastify',
    });
    assert.equal(config.defaultPack, 'express-to-fastify');
    assert.deepEqual(config.packDirs, ['./custom-packs']);
  });

  test('loadConfig gracefully handles non-existent config', async () => {
    const cfg = await loadConfig('/tmp');
    assert.equal(cfg, null);
  });
});
