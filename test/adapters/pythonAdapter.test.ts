/**
 * Tests for the Python language adapter (Milestone M4).
 *
 * Validates grammar loading, Python import resolution (absolute + relative),
 * universal symbol extraction, and Tarjan SCC cycle detection — all against a
 * self-contained fixture written to a temp directory. No FalkorDB required.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { adapterRegistry } from '../../src/adapters/registry';
import { PythonAdapter } from '../../src/adapters/pythonAdapter';
import { tarjanScc } from '../../src/engine/scc';

const FILES: Record<string, string> = {
  'app/__init__.py': '',
  'app/utils/__init__.py': '',
  'app/utils/response.py': [
    'def ok(data):',
    '    return {"ok": True, "data": data}',
    '',
    'class Envelope:',
    '    @property',
    '    def kind(self):',
    '        return "envelope"',
    '',
    '    def wrap(self, payload):',
    '        return {"payload": payload}',
    '',
  ].join('\n'),
  'app/services/__init__.py': '',
  'app/services/users.py': [
    'from ..utils.response import ok',
    '',
    'def list_users():',
    '    return ok([{"id": 1}])',
    '',
  ].join('\n'),
  'app/services/orders.py': [
    'from app.utils.response import ok',
    '',
    'def list_orders():',
    '    return ok([])',
    '',
  ].join('\n'),
  'app/services/cycle_a.py': [
    'from .cycle_b import label_b',
    '',
    'def label_a():',
    '    return "A" + label_b()',
    '',
  ].join('\n'),
  'app/services/cycle_b.py': [
    'from .cycle_a import label_a',
    '',
    'def label_b():',
    '    return "B"',
    '',
  ].join('\n'),
  'app/main.py': [
    'from app.services.users import list_users',
    'from app.services.orders import list_orders',
    'from .services import cycle_a',
    '',
    'def run():',
    '    return list_users() + list_orders() + [cycle_a.label_a()]',
    '',
  ].join('\n'),
};

let root = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'bkb-py-'));
  for (const [rel, content] of Object.entries(FILES)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('PythonAdapter', () => {
  it('is registered with the adapter registry', () => {
    assert.ok(adapterRegistry.has('python'));
    assert.ok(adapterRegistry.get('python') instanceof PythonAdapter);
  });

  it('compiles Python AST queries', async () => {
    const adapter = adapterRegistry.get('python');
    const errors = await adapter.validateQuery!('(function_definition name: (identifier) @name)');
    assert.deepEqual(errors, []);
  });

  it('parses a Python module without syntax errors', async () => {
    const adapter = adapterRegistry.get('python');
    const parsed = await adapter.parseModule(root, 'app/utils/response.py');
    assert.equal(parsed.hasSyntaxError, false, parsed.syntaxErrors.join('; '));
  });

  it('extracts functions, classes, and decorated methods', async () => {
    const adapter = adapterRegistry.get('python');
    const parsed = await adapter.parseModule(root, 'app/utils/response.py');
    const byName = new Map(parsed.symbols.map((s) => [s.name, s]));
    assert.equal(byName.get('ok')?.kind, 'function');
    assert.equal(byName.get('Envelope')?.kind, 'class');
    assert.equal(byName.get('kind')?.kind, 'function');
    assert.equal(byName.get('wrap')?.kind, 'function');
    assert.match(byName.get('kind')!.signature, /def kind\(self\)/);
  });

  it('resolves relative package imports', async () => {
    const adapter = adapterRegistry.get('python');
    const parsed = await adapter.parseModule(root, 'app/services/users.py');
    assert.deepEqual(parsed.imports, ['app/utils/response.py']);
  });

  it('resolves dotted absolute imports', async () => {
    const adapter = adapterRegistry.get('python');
    const parsed = await adapter.parseModule(root, 'app/services/orders.py');
    assert.deepEqual(parsed.imports, ['app/utils/response.py']);
  });

  it('resolves a mix of absolute, relative, and submodule imports in the entrypoint', async () => {
    const adapter = adapterRegistry.get('python');
    const parsed = await adapter.parseModule(root, 'app/main.py');
    for (const expected of ['app/services/users.py', 'app/services/orders.py', 'app/services/cycle_a.py']) {
      assert.ok(parsed.imports.includes(expected), `expected import edge to ${expected}, got ${parsed.imports.join(', ')}`);
    }
  });

  it('discovers Python sources while pruning caches and virtualenvs', async () => {
    const adapter = adapterRegistry.get('python');
    mkdirSync(join(root, '__pycache__'), { recursive: true });
    writeFileSync(join(root, '__pycache__', 'junk.py'), 'def x():\n    pass\n');
    mkdirSync(join(root, '.venv', 'lib'), { recursive: true });
    writeFileSync(join(root, '.venv', 'lib', 'dep.py'), 'def y():\n    pass\n');
    const files = await adapter.findSourceFiles(root, { include: ['**/*.py'] });
    assert.ok(files.includes('app/main.py'));
    assert.ok(!files.some((f) => f.includes('__pycache__')));
    assert.ok(!files.some((f) => f.includes('.venv')));
  });

  it('detects a circular dependency with Tarjan SCC', async () => {
    const adapter = adapterRegistry.get('python');
    const files = await adapter.findSourceFiles(root, { include: ['**/*.py'] });
    const adjacency = new Map<string, string[]>();
    for (const file of files) {
      const parsed = await adapter.parseModule(root, file);
      adjacency.set(file, parsed.imports);
    }
    const result = tarjanScc(adjacency);
    const cycleId = result.sccOf.get('app/services/cycle_a.py');
    assert.ok(cycleId !== undefined);
    assert.equal(result.sccOf.get('app/services/cycle_b.py'), cycleId);
    assert.equal(result.members.get(cycleId!)!.length, 2);
  });
});
