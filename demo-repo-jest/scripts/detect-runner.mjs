/**
 * Shared runner detection for the jest-to-vitest fixture.
 *
 * The migration converts test files in place, so at any moment the suite may be
 * entirely Jest (baseline), entirely Vitest (fully migrated), or briefly mixed.
 * We select the runner by scanning the test tree for a `vitest` import:
 *   - no `vitest` import anywhere → Jest (pre-migration)
 *   - otherwise                   → Vitest (post-migration)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const VITEST_IMPORT = /(?:from\s*|require\(\s*)['"]vitest['"]/;

export function listTestFiles(dir = join(REPO_ROOT, 'test')) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTestFiles(full));
    else if (/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function usesVitest(files) {
  return files.some((file) => VITEST_IMPORT.test(readFileSync(file, 'utf8')));
}

export function selectRunner() {
  const testFiles = listTestFiles();
  if (usesVitest(testFiles)) return { runner: 'vitest', args: ['run'], testFiles };
  return { runner: 'jest', args: ['--ci'], testFiles };
}
