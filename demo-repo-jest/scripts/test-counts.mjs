#!/usr/bin/env node
/**
 * Test-count snapshot command (kind: "count").
 *
 * Runs whichever runner is currently active, parses the result summary from
 * BOTH Jest and Vitest output, and prints `{ "suites": N, "tests": M }` to
 * stdout. The engine captures this at init (Jest) and compares it at each
 * checkpoint (Vitest) to prove no test cases were dropped during migration.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, selectRunner } from './detect-runner.mjs';

const ANSI = /\u001b\[[0-9;]*m/g;

const { runner, args } = selectRunner();
const bin = join(REPO_ROOT, 'node_modules', '.bin', runner);
const result = spawnSync(bin, args, { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, CI: 'true' } });

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(ANSI, '');

function pick(pattern) {
  const match = output.match(pattern);
  return match ? Number(match[1]) : 0;
}

const counts =
  runner === 'jest'
    ? {
        suites: pick(/Test Suites:.*?(\d+)\s+passed/),
        tests: pick(/Tests:.*?(\d+)\s+passed/),
      }
    : {
        suites: pick(/Test Files\s+(\d+)\s+passed/),
        tests: pick(/Tests\s+(\d+)\s+passed/),
      };

process.stdout.write(JSON.stringify(counts) + '\n');
if (result.status !== 0) process.exit(result.status ?? 1);
