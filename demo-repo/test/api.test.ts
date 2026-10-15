/**
 * Integration tests that stay valid across every migration state:
 * they boot createApp() on an ephemeral port (Express or Fastify) and use fetch.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';

const KEY = { 'x-api-key': 'secret-token' };
let baseUrl = '';
let close: () => Promise<void> = async () => {};

before(async () => {
  const app: any = await createApp();
  if (typeof app.inject === 'function') {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    close = () => app.close();
  } else {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
  }
});

after(() => close());

async function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

test('GET /users lists users with audit tag', async () => {
  const { status, body } = await call('GET', '/users', { headers: KEY });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.data.items.length >= 2);
  assert.match(body.data.audit, /^audit:GET:/);
});

test('GET /users/:id returns a user, 404 when missing', async () => {
  const hit = await call('GET', '/users/1', { headers: KEY });
  assert.equal(hit.status, 200);
  assert.equal(hit.body.data.name, 'Ada Lovelace');
  const miss = await call('GET', '/users/999', { headers: KEY });
  assert.equal(miss.status, 404);
  assert.deepEqual(miss.body, { ok: false, error: 'User not found' });
});

test('POST /users creates a user', async () => {
  const { status, body } = await call('POST', '/users', { headers: KEY, body: { name: 'Grace Hopper' } });
  assert.equal(status, 201);
  assert.equal(body.data.name, 'Grace Hopper');
});

test('GET /orders lists orders with audit tag', async () => {
  const { status, body } = await call('GET', '/orders', { headers: KEY });
  assert.equal(status, 200);
  assert.equal(body.data.items.length, 2);
  assert.match(body.data.audit, /^audit:GET:/);
});

test('GET /orders/:id returns an order', async () => {
  const { status, body } = await call('GET', '/orders/100', { headers: KEY });
  assert.equal(status, 200);
  assert.equal(body.data.total, 42.5);
});

test('rejects requests without API key (401)', async () => {
  for (const path of ['/users', '/orders', '/users/1']) {
    const { status, body } = await call('GET', path);
    assert.equal(status, 401);
    assert.deepEqual(body, { ok: false, error: 'Unauthorized' });
  }
});
