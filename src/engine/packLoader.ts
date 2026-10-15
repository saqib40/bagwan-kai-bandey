/**
 * Layer 1 — Migration Pack Loader (`src/engine/packLoader.ts`).
 *
 * Hard Rule: Zero mentions of language or framework specifics.
 *
 * Provides:
 *  - `defineMigrationPack`: Type-safe helper for writing packs in TypeScript/JavaScript.
 *  - `validatePack`: Structural validator for MigrationPack schemas.
 *  - `loadPack` / `loadPackAsync`: Discovers and loads packs from JSON, TS, or JS modules
 *    across user-configurable search directories and environment paths.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MigrationPack } from '../adapters/types';

/**
 * Type-safe helper to define a Migration Pack in TypeScript or JavaScript.
 * Provides autocomplete, inline documentation, and schema type enforcement.
 */
export function defineMigrationPack(pack: MigrationPack): MigrationPack {
  const validation = validatePack(pack);
  if (!validation.valid) {
    throw new Error(`Invalid migration pack "${pack.id ?? 'unknown'}":\n - ${validation.errors.join('\n - ')}`);
  }
  return pack;
}

/**
 * Validates the structure and required properties of a MigrationPack.
 */
export function validatePack(pack: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!pack || typeof pack !== 'object') {
    return { valid: false, errors: ['Migration pack must be a non-null object.'] };
  }

  if (!pack.id || typeof pack.id !== 'string') {
    errors.push('Missing or invalid `id` (must be a non-empty string).');
  }
  if (!pack.language || typeof pack.language !== 'string') {
    errors.push('Missing or invalid `language` (must be a non-empty string).');
  }
  if (!pack.sourceGlobs || !Array.isArray(pack.sourceGlobs.include) || pack.sourceGlobs.include.length === 0) {
    errors.push('Missing or invalid `sourceGlobs.include` (must be a non-empty array of glob strings).');
  }
  if (!pack.packages || !Array.isArray(pack.packages.legacy) || !Array.isArray(pack.packages.target)) {
    errors.push('Missing or invalid `packages` (must contain `legacy: string[]` and `target: string[]`).');
  }
  if (!Array.isArray(pack.detectionRules) || pack.detectionRules.length === 0) {
    errors.push('Missing or invalid `detectionRules` (must be a non-empty array).');
  } else {
    pack.detectionRules.forEach((rule: any, idx: number) => {
      if (!rule.id || !rule.astQuery) {
        errors.push(`Detection rule at index ${idx} is missing required \`id\` or \`astQuery\`.`);
      }
    });
  }
  if (!pack.verification || typeof pack.verification !== 'object') {
    errors.push('Missing `verification` block.');
  } else {
    if (!pack.verification.perStepTypecheckCmd) {
      errors.push('Missing `verification.perStepTypecheckCmd`.');
    }
    if (!pack.verification.checkpointTestCmd) {
      errors.push('Missing `verification.checkpointTestCmd`.');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Resolves candidate file paths for a pack identifier or path.
 */
function getPackCandidates(packIdOrPath: string, searchDirs: string[] = []): string[] {
  const envDirs = process.env.SHIFT_PACK_DIR ? process.env.SHIFT_PACK_DIR.split(':') : [];
  const allDirs = [
    ...searchDirs,
    ...envDirs,
    join(process.cwd(), 'packs'),
    join(process.cwd(), '.shift/packs'),
    resolve(process.cwd(), 'node_modules'),
  ];

  const extensions = ['', '.json', '.ts', '.js', '.mjs'];
  const candidates: string[] = [];

  // Direct path check
  for (const ext of extensions) {
    candidates.push(packIdOrPath.endsWith(ext) && ext !== '' ? packIdOrPath : `${packIdOrPath}${ext}`);
  }

  // Search dirs
  for (const dir of allDirs) {
    for (const ext of extensions) {
      candidates.push(join(dir, ext !== '' ? `${packIdOrPath}${ext}` : packIdOrPath));
      candidates.push(join(dir, packIdOrPath, `index${ext}`));
    }
  }

  return candidates;
}

/**
 * Synchronous pack loader (for JSON packs or direct path).
 */
export function loadPack(packIdOrPath: string, searchDirs: string[] = []): MigrationPack {
  const candidates = getPackCandidates(packIdOrPath, searchDirs);

  let foundPath: string | null = null;
  for (const c of candidates) {
    if (existsSync(c) && !c.endsWith('/')) {
      foundPath = c;
      break;
    }
  }

  if (!foundPath) {
    throw new Error(
      `Migration pack "${packIdOrPath}" not found.\nSearched candidate paths:\n  - ${candidates.slice(0, 8).join('\n  - ')}...`,
    );
  }

  const ext = extname(foundPath);
  if (ext === '.ts' || ext === '.js' || ext === '.mjs') {
    // For TS/JS packs loaded synchronously, try require or throw informative message
    try {
      // Dynamic fallback for CJS/transpiled environments
      const raw = readFileSync(foundPath, 'utf8');
      if (raw.includes('defineMigrationPack') || raw.includes('export default')) {
        // Evaluate with jiti or throw asking for loadPackAsync
        throw new Error(
          `Migration pack "${foundPath}" is a TypeScript/ESM module. Use loadPackAsync() or provide a .json pack.`,
        );
      }
    } catch (e: any) {
      if (e.message.includes('loadPackAsync')) throw e;
    }
  }

  try {
    const raw = readFileSync(foundPath, 'utf8');
    const parsed = JSON.parse(raw) as MigrationPack;
    const validation = validatePack(parsed);
    if (!validation.valid) {
      throw new Error(`Invalid migration pack in "${foundPath}":\n - ${validation.errors.join('\n - ')}`);
    }
    return parsed;
  } catch (err: unknown) {
    throw new Error(`Failed to load pack from "${foundPath}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Asynchronous pack loader supporting both JSON files and dynamically imported
 * TypeScript/ESM packs (`.ts`, `.js`, `.mjs`).
 */
export async function loadPackAsync(packIdOrPath: string, searchDirs: string[] = []): Promise<MigrationPack> {
  const candidates = getPackCandidates(packIdOrPath, searchDirs);

  let foundPath: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) {
      foundPath = c;
      break;
    }
  }

  if (!foundPath) {
    throw new Error(
      `Migration pack "${packIdOrPath}" not found.\nSearched candidate paths:\n  - ${candidates.slice(0, 8).join('\n  - ')}...`,
    );
  }

  const ext = extname(foundPath);
  if (ext === '.json') {
    return loadPack(foundPath, searchDirs);
  }

  try {
    const fileUrl = pathToFileURL(resolve(foundPath)).href;
    const mod = await import(fileUrl);
    const pack = mod.default ?? mod.pack;
    if (!pack) {
      throw new Error(`Pack module at "${foundPath}" does not have a default export or named export \`pack\`.`);
    }
    const validation = validatePack(pack);
    if (!validation.valid) {
      throw new Error(`Invalid migration pack in "${foundPath}":\n - ${validation.errors.join('\n - ')}`);
    }
    return pack as MigrationPack;
  } catch (err: unknown) {
    throw new Error(`Failed to import pack from "${foundPath}": ${err instanceof Error ? err.message : String(err)}`);
  }
}
