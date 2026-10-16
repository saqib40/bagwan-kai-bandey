import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { broadcastLiveEvent, type LiveEvent } from '../src/engine/telemetry';

describe('BKB Live Telemetry & Event Synchronization', () => {
  test('broadcastLiveEvent does not throw or hang when server is offline', () => {
    // Port 4299 has no listening server
    process.env.BKB_COCKPIT_PORT = '4299';
    assert.doesNotThrow(() => {
      broadcastLiveEvent({
        type: 'claim',
        repoPath: '/tmp/non-existent',
        targetPaths: ['src/index.ts'],
        phase: 'MIGRATE',
      });
    });
  });

  test('broadcastLiveEvent transmits payload to listening server', async () => {
    const testPort = 4288;
    process.env.BKB_COCKPIT_PORT = String(testPort);

    let receivedPayload: LiveEvent | null = null;
    const testServer = createServer((req, res) => {
      if (req.url === '/api/broadcast' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          receivedPayload = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => testServer.listen(testPort, '127.0.0.1', () => resolve()));

    try {
      broadcastLiveEvent({
        type: 'verify',
        repoPath: '/Users/test/repo',
        packId: 'express-to-fastify',
        targetPaths: ['src/app.ts'],
        status: 'VERIFIED',
        step: 5,
      });

      // Wait a short tick for loopback fetch to finish
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(receivedPayload !== null, 'Server should have received broadcast payload');
      const payload = receivedPayload as LiveEvent;
      assert.strictEqual(payload.type, 'verify');
      assert.strictEqual(payload.repoPath, '/Users/test/repo');
      assert.strictEqual(payload.status, 'VERIFIED');
      assert.strictEqual(payload.step, 5);
    } finally {
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
      delete process.env.BKB_COCKPIT_PORT;
    }
  });
});
