/**
 * Layer 1 — Bagwan Kai Bandey (BKB) Configuration System (`src/engine/config.ts`).
 *
 * Allows projects to define a `bkb.config.ts`, `bkb.config.js`, or `bkb.config.json`
 * (or legacy `shift.config.*`) in the repository root to automatically inject:
 *  - Custom Language Adapters (Layer 2)
 *  - Custom Migration Pack directories (Layer 3)
 *  - Default settings (repo path, pack ID, FalkorDB connection opts)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LanguageAdapter } from '../adapters/types';
import { adapterRegistry } from '../adapters/registry';

export interface BkbConfig {
  /**
   * Custom LanguageAdapter instances or relative file paths to adapter modules.
   */
  adapters?: Array<LanguageAdapter | string>;

  /**
   * Additional directories to search when resolving migration packs.
   */
  packDirs?: string[];

  /**
   * Default repository path (relative or absolute).
   */
  defaultRepo?: string;

  /**
   * Default migration pack identifier.
   */
  defaultPack?: string;

  /**
   * FalkorDB connection configuration overrides.
   */
  falkor?: {
    host?: string;
    port?: number;
    graphName?: string;
  };
}

export type ShiftConfig = BkbConfig;

/**
 * Type-safe configuration helper for `bkb.config.ts` or `shift.config.ts`.
 */
export function defineConfig(config: BkbConfig): BkbConfig {
  return config;
}

/**
 * Discovers and applies `bkb.config.(ts|js|mjs|json)` or `shift.config.*` from the given root directory.
 */
export async function loadConfig(repoRoot = process.cwd()): Promise<BkbConfig | null> {
  const candidateNames = [
    'bkb.config.ts',
    'bkb.config.js',
    'bkb.config.mjs',
    'bkb.config.json',
    '.bkbrc.json',
    'shift.config.ts',
    'shift.config.js',
    'shift.config.mjs',
    'shift.config.json',
    '.shiftrc.json',
  ];

  let configPath: string | null = null;
  for (const name of candidateNames) {
    const candidate = resolve(repoRoot, name);
    if (existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }

  if (!configPath) return null;

  let config: ShiftConfig;

  if (configPath.endsWith('.json')) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      config = JSON.parse(raw) as ShiftConfig;
    } catch (err) {
      throw new Error(`Failed to parse config at "${configPath}": ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    try {
      const url = pathToFileURL(configPath).href;
      const mod = await import(url);
      config = mod.default ?? mod.config ?? mod;
    } catch (err) {
      throw new Error(`Failed to load config at "${configPath}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Register any custom adapters declared in config
  if (config.adapters && Array.isArray(config.adapters)) {
    for (const item of config.adapters) {
      if (typeof item === 'string') {
        const absPath = resolve(repoRoot, item);
        await adapterRegistry.registerFromPath(absPath);
      } else if (typeof item === 'object' && item && 'language' in item) {
        adapterRegistry.register(item);
      }
    }
  }

  return config;
}
