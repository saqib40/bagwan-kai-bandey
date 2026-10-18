/**
 * Repository-local execution environment (`src/engine/execEnv.ts`).
 *
 * Pack-defined commands (baseline snapshots, checkpoint gates) are executed
 * with the repo as cwd, but repo-local binaries are not on PATH by default.
 * `buildRepoExecEnv` prepends the conventional tool directories so commands
 * resolve the repository's own `.venv` interpreter and `node_modules/.bin`
 * CLIs rather than a globally installed lookalike.
 */

import { existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';

/**
 * Returns a copy of `baseEnv` with the repository's local binary directories
 * prepended to `PATH` (venv first, then `node_modules/.bin`). Missing
 * directories are ignored; when neither exists the copy is returned unchanged.
 */
export function buildRepoExecEnv(baseEnv: NodeJS.ProcessEnv, repoPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  const venvBin = resolve(repoPath, process.platform === 'win32' ? '.venv/Scripts' : '.venv/bin');
  const nodeBin = resolve(repoPath, 'node_modules/.bin');
  const extraPaths = [venvBin, nodeBin].filter((p) => existsSync(p));

  if (extraPaths.length > 0) {
    env.PATH = extraPaths.join(delimiter) + (env.PATH ? delimiter + env.PATH : '');
  }

  return env;
}
