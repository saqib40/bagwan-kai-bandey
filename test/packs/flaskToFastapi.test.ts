/**
 * Tests for the `flask-to-fastapi` migration pack and `demo-repo-flask` fixture (M5).
 *
 * Pack-conformance and AST-detection checks run without Python or FalkorDB.
 * The full autonomous migration loop is appended in M5.3 and is gated on a host
 * Python toolchain with Flask/FastAPI/pytest installed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPack, validatePack } from '../../src/engine/packLoader';
import { validatePackQueries } from '../../src/engine/packSemantics';
import { adapterRegistry } from '../../src/adapters/registry';
import { getShimStrategy } from '../../src/adapters/types';

const PACK_PATH = resolve(import.meta.dirname, '../../packs/flask-to-fastapi.json');
const FIXTURE = resolve(import.meta.dirname, '../../demo-repo-flask');

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
