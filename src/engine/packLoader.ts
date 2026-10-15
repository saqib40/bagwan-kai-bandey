/**
 * Layer 1 — Migration Pack Loader.
 * Hard Rule: Zero mentions of language or framework specifics.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { MigrationPack } from '../adapters/types';

export function loadPack(packIdOrPath: string, searchDirs: string[] = []): MigrationPack {
  const candidates: string[] = [
    packIdOrPath,
    ...searchDirs.map((dir) => join(dir, packIdOrPath)),
    ...searchDirs.map((dir) => join(dir, `${packIdOrPath}.json`)),
    join(process.cwd(), 'packs', `${packIdOrPath}.json`),
    join(process.cwd(), 'packs', packIdOrPath),
  ];

  let foundPath: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) {
      foundPath = c;
      break;
    }
  }

  if (!foundPath) {
    throw new Error(`Migration pack "${packIdOrPath}" not found. Searched paths: ${candidates.join(', ')}`);
  }

  try {
    const raw = readFileSync(foundPath, 'utf8');
    const parsed = JSON.parse(raw) as MigrationPack;

    if (!parsed.id || !parsed.language || !parsed.detectionRules) {
      throw new Error(`Invalid migration pack structure in "${foundPath}": missing id, language, or detectionRules.`);
    }

    return parsed;
  } catch (err: unknown) {
    throw new Error(`Failed to load pack from "${foundPath}": ${err instanceof Error ? err.message : String(err)}`);
  }
}
