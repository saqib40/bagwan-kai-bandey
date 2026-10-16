import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isPathContained, isOriginAllowed, startDemoServer } from '../src/server/demoServer';

describe('Cockpit Security & Origin Containment', () => {
  const root = resolve('/workspace/demo-repo');

  test('isPathContained permits valid nested paths', () => {
    assert.strictEqual(isPathContained(root, 'src/app.ts'), true);
    assert.strictEqual(isPathContained(root, './src/routes/users.ts'), true);
    assert.strictEqual(isPathContained(root, 'package.json'), true);
  });

  test('isPathContained rejects directory traversal and absolute escapes', () => {
    assert.strictEqual(isPathContained(root, '../../etc/passwd'), false);
    assert.strictEqual(isPathContained(root, '/etc/passwd'), false);
    assert.strictEqual(isPathContained(root, '../other-repo/file.ts'), false);
  });

  test('isOriginAllowed blocks external web origins and allows localhost', () => {
    assert.strictEqual(isOriginAllowed(undefined), true);
    assert.strictEqual(isOriginAllowed('http://localhost:4200'), true);
    assert.strictEqual(isOriginAllowed('http://127.0.0.1:4200'), true);
    assert.strictEqual(isOriginAllowed('https://evil.com'), false);
    assert.strictEqual(isOriginAllowed('http://attacker.com:4200'), false);
    assert.strictEqual(isOriginAllowed('invalid-origin'), false);
  });

  test('HTTP requests with untrusted origin or escaping path are blocked', async () => {
    const port = 4289;
    const server = startDemoServer(port);
    await new Promise((r) => setTimeout(r, 100));

    try {
      // 1. Untrusted origin blocked with 403
      const originRes = await fetch(`http://127.0.0.1:${port}/api/info`, {
        headers: { Origin: 'https://malicious-website.com' },
      });
      assert.strictEqual(originRes.status, 403);
      const originJson = await originRes.json() as any;
      assert.strictEqual(originJson.error, 'Forbidden: untrusted origin');

      // 2. Traversal on /api/file blocked with 403
      const fileRes = await fetch(`http://127.0.0.1:${port}/api/file?path=/etc/passwd`);
      assert.strictEqual(fileRes.status, 403);
      const fileJson = await fileRes.json() as any;
      assert.strictEqual(fileJson.error, 'Access denied: path escapes active repository root');

      // 3. Traversal on /api/file with ../ blocked with 403
      const dotRes = await fetch(`http://127.0.0.1:${port}/api/file?path=../../package.json`);
      assert.strictEqual(dotRes.status, 403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
