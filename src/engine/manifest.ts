/**
 * Git-Native Migration Manifest Manager (`src/engine/manifest.ts`).
 *
 * Implements persistent, distributed team handoff as specified in:
 * docs/phased-migrations-and-team-handoff.md
 *
 * Provides:
 *  - Schema definition for `.bkb/manifest.json`
 *  - Load / Save / Reconcile methods
 *  - Preservation of original baseline snapshots across clones / sessions
 *  - Synchronization of FalkorDB node states from committed Git manifests
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { FalkorClient } from './falkorClient';
import * as Q from './queries';

export interface ModuleManifestEntry {
  status: 'PENDING' | 'CLAIMED' | 'SHIMMED' | 'VERIFIED' | 'CLEAN';
  phase?: 'MIGRATE' | 'SHIM' | 'DE_SHIM';
  step?: number;
  sccId?: number | string;
  verifiedCommit?: string;
  lastModified?: string;
  invariants?: {
    compilerErrors?: number;
    matchedRoutes?: number;
    legacyUsageShimmed?: boolean;
    [key: string]: unknown;
  };
}

export interface BaselineManifestEntry {
  snapshotType: string;
  hash?: string;
  command?: string;
  entryCount: number;
  entries: string[];
  rawOutput?: string;
}

export interface ManifestHistoryEntry {
  step: number;
  phase: 'MIGRATE' | 'SHIM' | 'DE_SHIM' | 'INIT';
  modules: string[];
  action: string;
  verifiedBy?: string;
  commitSha?: string;
  timestamp: string;
}

export interface MigrationManifest {
  $schema?: string;
  version: string;
  packId: string;
  migrationEpoch: string;
  phase: 'MIGRATE' | 'SHIM' | 'DE_SHIM';
  baseline: BaselineManifestEntry;
  modules: Record<string, ModuleManifestEntry>;
  history: ManifestHistoryEntry[];
}

/**
 * Returns the path to the repository-local `.bkb/manifest.json`.
 */
export function getManifestPath(repoPath: string): string {
  return join(resolve(repoPath), '.bkb', 'manifest.json');
}

/**
 * Loads the `.bkb/manifest.json` from disk, or returns null if it does not exist.
 */
export function loadManifest(repoPath: string): MigrationManifest | null {
  const filePath = getManifestPath(repoPath);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.packId && parsed.modules) {
      return parsed as MigrationManifest;
    }
    return null;
  } catch (err) {
    console.error(`[bkb] Warning: Failed to parse manifest at "${filePath}":`, err);
    return null;
  }
}

/**
 * Writes the manifest to `<repoPath>/.bkb/manifest.json`, ensuring parent directories exist.
 */
export function saveManifest(repoPath: string, manifest: MigrationManifest): void {
  const filePath = getManifestPath(repoPath);
  const dir = resolve(repoPath, '.bkb');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * Creates or updates a manifest for an initialized migration.
 * Preserves existing history and verified module states if a manifest already exists.
 */
export function initOrUpdateManifest(options: {
  repoPath: string;
  packId: string;
  reset?: boolean;
  baselineSnapshot: {
    snapshotType: string;
    entryCount: number;
    entries: string[];
    command?: string;
    hash?: string;
    rawOutput?: string;
  };
  modules: Array<{ path: string; status: 'PENDING' | 'CLEAN'; sccId?: number }>;
}): MigrationManifest {
  const existing = loadManifest(options.repoPath);

  if (!options.reset && existing && existing.packId === options.packId) {
    // Preserve baseline and completed module states from existing manifest
    const mergedModules: Record<string, ModuleManifestEntry> = { ...existing.modules };

    for (const mod of options.modules) {
      if (!mergedModules[mod.path]) {
        mergedModules[mod.path] = {
          status: mod.status,
          sccId: mod.sccId,
        };
      }
    }

    const updated: MigrationManifest = {
      ...existing,
      modules: mergedModules,
    };
    saveManifest(options.repoPath, updated);
    return updated;
  }

  const initialModules: Record<string, ModuleManifestEntry> = {};
  for (const mod of options.modules) {
    initialModules[mod.path] = {
      status: mod.status,
      sccId: mod.sccId,
    };
  }

  const newManifest: MigrationManifest = {
    $schema: 'https://bkb.dev/manifest.schema.json',
    version: '1.0.0',
    packId: options.packId,
    migrationEpoch: new Date().toISOString(),
    phase: 'SHIM',
    baseline: {
      snapshotType: options.baselineSnapshot.snapshotType,
      entryCount: options.baselineSnapshot.entryCount,
      entries: options.baselineSnapshot.entries,
      command: options.baselineSnapshot.command,
      hash: options.baselineSnapshot.hash,
      rawOutput: options.baselineSnapshot.rawOutput,
    },
    modules: initialModules,
    history: [
      {
        step: 0,
        phase: 'INIT',
        modules: options.modules.map((m) => m.path),
        action: `Initialized migration graph for pack "${options.packId}" with ${options.baselineSnapshot.entryCount} baseline entries`,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  saveManifest(options.repoPath, newManifest);
  return newManifest;
}

/**
 * Records a verified step in `.bkb/manifest.json`.
 */
export function recordStepInManifest(
  repoPath: string,
  record: {
    step: number;
    phase: 'MIGRATE' | 'SHIM' | 'DE_SHIM';
    modules: string[];
    status: 'SHIMMED' | 'VERIFIED';
    action: string;
    verifiedBy?: string;
    commitSha?: string;
    invariants?: Record<string, unknown>;
  },
): MigrationManifest | null {
  const manifest = loadManifest(repoPath);
  if (!manifest) return null;

  const now = new Date().toISOString();

  for (const modPath of record.modules) {
    manifest.modules[modPath] = {
      ...(manifest.modules[modPath] ?? {}),
      status: record.status,
      phase: record.phase,
      step: record.step,
      lastModified: now,
      verifiedCommit: record.commitSha ?? manifest.modules[modPath]?.verifiedCommit,
      invariants: record.invariants ?? manifest.modules[modPath]?.invariants,
    };
  }

  manifest.history.push({
    step: record.step,
    phase: record.phase,
    modules: record.modules,
    action: record.action,
    verifiedBy: record.verifiedBy ?? 'BKB Invariant Engine',
    commitSha: record.commitSha,
    timestamp: now,
  });

  saveManifest(repoPath, manifest);
  return manifest;
}

/**
 * Reconciles the FalkorDB graph state with the committed `.bkb/manifest.json`.
 * Ensures nodes that were previously verified and committed to Git retain their state.
 */
export async function reconcileGraphWithManifest(
  client: FalkorClient,
  manifest: MigrationManifest,
): Promise<{ reconciledNodes: number }> {
  let reconciledNodes = 0;

  for (const [modPath, entry] of Object.entries(manifest.modules)) {
    if (entry.status === 'SHIMMED' || entry.status === 'VERIFIED') {
      await client.query(
        `MATCH (m:Module {path: $path})
         SET m.status = $status,
             m.claimed_phase = $phase
         RETURN count(m) AS cnt`,
        {
          path: modPath,
          status: entry.status,
          phase: entry.phase ?? (entry.status === 'SHIMMED' ? 'SHIM' : 'MIGRATE'),
        },
      );
      reconciledNodes++;
    }
  }

  // Recompute global in_degree and pending_callers_count after reconciliation
  await client.query(Q.RECOMPUTE_DEGREES, {
    legacyCallers: [...Q.LEGACY_CALLER_STATUSES],
  });

  return { reconciledNodes };
}
