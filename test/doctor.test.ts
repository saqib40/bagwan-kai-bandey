import test from 'node:test';
import assert from 'node:assert/strict';
import { runDiagnostics, formatDoctorReport } from '../src/cli/doctor';

test('bkb doctor: evaluates node, docker, git, and pack checks', async () => {
  const report = await runDiagnostics();

  assert.ok(report.checks.length >= 6);

  const nodeCheck = report.checks.find((c) => c.title === 'Node.js Runtime');
  assert.ok(nodeCheck);
  assert.equal(nodeCheck.ok, true);

  const gitCheck = report.checks.find((c) => c.title === 'Git Workspace');
  assert.ok(gitCheck);
  assert.equal(gitCheck.ok, true);

  const packsCheck = report.checks.find((c) => c.title === 'Available Migration Packs');
  assert.ok(packsCheck);
  assert.equal(packsCheck.ok, true);
  assert.ok(packsCheck.message.includes('express-to-fastify'));

  const formatted = formatDoctorReport(report);
  assert.ok(formatted.includes('Bagwan Kai Bandey (BKB) Environment Diagnostics'));
  assert.ok(formatted.includes('Node.js Runtime'));
});
