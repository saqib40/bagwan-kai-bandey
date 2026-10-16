#!/usr/bin/env node
/**
 * Runner-agnostic checkpoint test command.
 *
 * Runs Jest before the migration and Vitest afterwards, so the same command is
 * valid at every intermediate migration state. Exits non-zero if the suite fails.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, selectRunner } from './detect-runner.mjs';

const { runner, args } = selectRunner();
const bin = join(REPO_ROOT, 'node_modules', '.bin', runner);
const result = spawnSync(bin, args, {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: { ...process.env, CI: 'true' },
});

process.exit(result.status ?? 1);
