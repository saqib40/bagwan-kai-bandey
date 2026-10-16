#!/usr/bin/env node
/**
 * Bagwan Kai Bandey (BKB) Binary Launcher (`bin/bkb.js`).
 *
 * Runs `bin/cli.ts` via tsx so that TypeScript execution, ESM module
 * resolution, and stdio pipes are completely transparent across all Node versions.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliTs = join(__dirname, 'cli.ts');
const localTsx = join(__dirname, '../node_modules/.bin/tsx');

let tsxEntry = '';
try {
  const tsxPkgUrl = import.meta.resolve('tsx/package.json');
  const tsxPkgPath = fileURLToPath(tsxPkgUrl);
  tsxEntry = join(dirname(tsxPkgPath), 'dist/cli.mjs');
} catch {}

let cmd = process.execPath;
let args = [];

if (tsxEntry && existsSync(tsxEntry)) {
  cmd = process.execPath;
  args = [tsxEntry, cliTs, ...process.argv.slice(2)];
} else if (existsSync(localTsx)) {
  cmd = localTsx;
  args = [cliTs, ...process.argv.slice(2)];
} else {
  // Fallback to npx if invoked in an external environment
  cmd = 'npx';
  args = ['-y', 'tsx', cliTs, ...process.argv.slice(2)];
}

const child = spawn(cmd, args, {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
