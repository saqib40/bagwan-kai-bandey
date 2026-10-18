import { rmSync, mkdirSync, cpSync, symlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Copies a fixture repo into an isolated scratch directory so tests never
 * mutate the committed fixture (notably its `.bkb/` manifest). The whole tree
 * is copied minus `node_modules` and `.bkb`; `node_modules` is re-linked from
 * the source so scripts and `npm test` baselines still resolve.
 */
export function setupScratchRepo(sourceRepo: string, scratchRepo: string): void {
  rmSync(scratchRepo, { recursive: true, force: true });
  mkdirSync(scratchRepo, { recursive: true });

  cpSync(sourceRepo, scratchRepo, {
    recursive: true,
    filter: (src) => {
      const base = src.split(/[\\/]/).pop();
      return base !== 'node_modules' && base !== '.bkb';
    },
  });

  const sourceModules = resolve(sourceRepo, 'node_modules');
  if (existsSync(sourceModules)) {
    symlinkSync(sourceModules, resolve(scratchRepo, 'node_modules'), 'dir');
  }
}

export function cleanupScratchRepo(scratchRepo: string): void {
  rmSync(scratchRepo, { recursive: true, force: true });
}
