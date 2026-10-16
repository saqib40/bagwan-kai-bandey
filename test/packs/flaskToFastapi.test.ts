/**
 * Tests for the `flask-to-fastapi` migration pack and `demo-repo-flask` fixture (M5).
 *
 * Pack-conformance and AST-detection checks run without Python or FalkorDB.
 * The full autonomous migration loop is appended in M5.3 and is gated on a host
 * Python toolchain with Flask/FastAPI/pytest installed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPack, validatePack } from '../../src/engine/packLoader';
import { validatePackQueries } from '../../src/engine/packSemantics';
import { adapterRegistry } from '../../src/adapters/registry';
import { getShimStrategy } from '../../src/adapters/types';
import { runAutonomousMigration } from '../../src/runner/autonomousRunner';
import { checkPortReachable } from '../../src/cli/doctor';

const PACK_PATH = resolve(import.meta.dirname, '../../packs/flask-to-fastapi.json');
const FIXTURE = resolve(import.meta.dirname, '../../demo-repo-flask');
const WORKSPACE = resolve(import.meta.dirname, '../..');
const VENV_PYTHON = join(FIXTURE, '.venv', 'bin', 'python3');

const SAMPLE = `from flask import Flask, request, jsonify, abort

app = Flask(__name__)

@app.route("/users", methods=["GET"])
def list_users():
    return jsonify([])

@app.post("/users/")
def create_user():
    name = request.args.get("name")
    if not name:
        abort(400)
    return jsonify({"name": name}), 201
`;

describe('flask-to-fastapi pack', () => {
  it('loads and passes structural + semantic + schema validation', () => {
    const pack = loadPack(PACK_PATH);
    assert.equal(pack.id, 'flask-to-fastapi');
    assert.equal(pack.language, 'python');
    assert.equal(validatePack(pack).valid, true, validatePack(pack).errors.join('\n'));
  });

  it('declares the in-file-branch shim strategy', () => {
    const pack = loadPack(PACK_PATH);
    assert.equal(getShimStrategy(pack), 'in-file-branch');
  });

  it('compiles every detection query under the Python adapter', async () => {
    const pack = loadPack(PACK_PATH);
    const result = await validatePackQueries(pack, adapterRegistry);
    assert.equal(result.skipped, false);
    assert.equal(result.valid, true, result.errors.join('\n'));
  });

  it('declares a route-surface set snapshot', () => {
    const pack = loadPack(PACK_PATH);
    const snap = pack.verification.snapshots?.find((s) => s.id === 'route-surface');
    assert.ok(snap);
    assert.equal(snap?.kind, 'set');
    assert.equal(snap?.command, 'python3 scripts/dump_routes.py');
  });

  it('detects Flask usage on a sample module', async () => {
    const pack = loadPack(PACK_PATH);
    const adapter = adapterRegistry.get('python');
    await adapter.init();
    const root = mkdtempSync(join(tmpdir(), 'bkb-flask-'));
    try {
      mkdirSync(join(root, 'app'), { recursive: true });
      writeFileSync(join(root, 'app/main.py'), SAMPLE);
      const parsed = await adapter.parseModule(root, 'app/main.py', undefined, pack);
      assert.equal(parsed.hasSyntaxError, false, parsed.syntaxErrors.join('; '));
      const ruleIds = new Set(parsed.apiUsages.map((u) => u.ruleId));
      assert.ok(ruleIds.has('flask-app'), 'flask-app should match');
      assert.ok(ruleIds.has('flask-route'), 'flask-route should match');
      assert.ok(ruleIds.has('flask-request-global'), 'flask-request-global should match');
      assert.ok(ruleIds.has('flask-helpers'), 'flask-helpers should match');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('flask-to-fastapi autonomous migration (requires FalkorDB + Python toolchain)', () => {
  it('migrates demo-repo-flask from Flask to FastAPI with an unchanged route surface', async (t) => {
    if (!existsSync(VENV_PYTHON)) {
      t.skip('demo-repo-flask/.venv is missing; run `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`');
      return;
    }
    if (!(await checkPortReachable(6379))) {
      t.skip('FalkorDB is not reachable on :6379');
      return;
    }

    const target = resolve(WORKSPACE, 'scratch/flask-e2e');
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const entry of ['routes', 'services', 'utils', 'tests', 'scripts']) {
      cpSync(join(FIXTURE, entry), join(target, entry), { recursive: true });
    }
    for (const file of ['app.py', 'requirements.txt', 'mypy.ini', '.bkb-mocks.json']) {
      cpSync(join(FIXTURE, file), join(target, file));
    }

    const venvBin = join(FIXTURE, '.venv', 'bin');
    const originalPath = process.env.PATH ?? '';
    process.env.PATH = `${venvBin}:${originalPath}`;

    const baseline = execSync('python3 scripts/dump_routes.py', { cwd: target, encoding: 'utf8' }).trim();

    try {
      const res = await runAutonomousMigration({
        repoPath: target,
        packId: 'flask-to-fastapi',
        provider: 'mock',
        graphName: 'bkb_flask_e2e_test',
        reset: true,
        maxSteps: 80,
      });

      assert.equal(res.ok, true, res.error ?? 'migration should succeed');
      assert.equal(res.checkpointPassed, true);
      assert.equal(res.routeParity, true);
      assert.ok(res.migratedModules >= 2);

      // 1. Flask constructs are gone from the migrated application modules.
      for (const rel of ['app.py', 'utils/response.py']) {
        const code = readFileSync(join(target, rel), 'utf8');
        assert.doesNotMatch(code, /from flask|import flask/, `${rel} still imports flask`);
        assert.doesNotMatch(code, /jsonify|@bkb-shim/, `${rel} still uses Flask helpers or shim markers`);
      }

      // 2. Canonicalized route surface is unchanged.
      const migrated = execSync('python3 scripts/dump_routes.py', { cwd: target, encoding: 'utf8' }).trim();
      assert.equal(migrated, baseline);
      assert.deepEqual(JSON.parse(migrated), [
        'GET /health',
        'GET /orders',
        'GET /products',
        'GET /products/{product_id}',
        'POST /orders',
      ]);

      // 3. The pytest suite passes against the migrated FastAPI app.
      const pytestOut = execSync('python3 -m pytest -q', { cwd: target, encoding: 'utf8' });
      assert.match(pytestOut, /7 passed/);
    } finally {
      process.env.PATH = originalPath;
      rmSync(target, { recursive: true, force: true });
    }
  });
});
