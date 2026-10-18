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

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  rmSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import type { FalkorClient } from './falkorClient';
import * as Q from './queries';

export interface ModuleManifestEntry {
  status: 'PENDING' | 'CLAIMED' | 'SHIMMED' | 'VERIFIED' | 'CLEAN';
  phase?: 'MIGRATE' | 'SHIM' | 'DE_SHIM';
  step?: number;
  sccId?: number | string;
  verifiedCommit?: string;
  lastModified?: string;
  /**
   * The module's pre-migration invariant sets (per invariant id). Persisted so a
   * fresh clone can restore the true baseline instead of re-capturing it against
   * an already half-migrated codebase.
   */
  baselineSets?: Record<string, string[]>;
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
  /** All declared pack snapshots, keyed by snapshot id, as normalized output. */
  snapshots?: Record<string, string>;
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

export interface InitOrUpdateManifestOptions {
  repoPath: string;
  packId: string;
  reset?: boolean;
  baselineSnapshot: {
    snapshotType: string;
    entryCount: number;
    entries: string[];
    command?: string;
    hash?: string;
    snapshots?: Record<string, string>;
    rawOutput?: string;
  };
  modules: Array<{
    path: string;
    status: 'PENDING' | 'CLEAN';
    sccId?: number;
    baselineSets?: Record<string, string[]>;
  }>;
}

export interface RecordStepInput {
  step: number;
  phase: 'MIGRATE' | 'SHIM' | 'DE_SHIM';
  modules: string[];
  status: 'SHIMMED' | 'VERIFIED';
  action: string;
  verifiedBy?: string;
  commitSha?: string;
  invariants?: Record<string, unknown>;
  /** Pack whose manifest should be updated. Omit to fall back to the sole manifest. */
  packId?: string;
}

const MANIFESTS_DIR = 'manifests';
const LEGACY_MANIFEST_FILE = 'manifest.json';

/** Filesystem-safe filename for a pack id. */
function sanitizePackId(packId: string): string {
  return packId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Returns the repository-local manifest path. With a pack id this is the
 * per-pack file `.bkb/manifests/<packId>.json`; without one it is the legacy
 * single-tenant path `.bkb/manifest.json`.
 */
export function getManifestPath(repoPath: string, packId?: string): string {
  const root = resolve(repoPath);
  if (packId) {
    return join(root, '.bkb', MANIFESTS_DIR, `${sanitizePackId(packId)}.json`);
  }
  return join(root, '.bkb', LEGACY_MANIFEST_FILE);
}

function getManifestsDir(repoPath: string): string {
  return join(resolve(repoPath), '.bkb', MANIFESTS_DIR);
}

/** All per-pack manifest files present on disk (empty if none). */
export function listManifestPaths(repoPath: string): string[] {
  const dir = getManifestsDir(repoPath);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function readManifestFile(filePath: string): MigrationManifest | null {
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
 * Loads a migration manifest from disk, or returns null if none exists.
 *
 * Resolution order:
 *  - With a `packId`: the per-pack file, then the legacy file (only if it
 *    belongs to the same pack).
 *  - Without a `packId`: a sole per-pack file, then the legacy file. When
 *    multiple packs are present the result is ambiguous and null is returned,
 *    so callers should pass a packId.
 */
export function loadManifest(repoPath: string, packId?: string): MigrationManifest | null {
  const candidates: string[] = [];
  if (packId) {
    candidates.push(getManifestPath(repoPath, packId));
    candidates.push(getManifestPath(repoPath));
  } else {
    const perPack = listManifestPaths(repoPath);
    if (perPack.length === 1) candidates.push(perPack[0]);
    if (perPack.length !== 1) candidates.push(getManifestPath(repoPath));
  }

  for (const filePath of candidates) {
    const manifest = readManifestFile(filePath);
    if (!manifest) continue;
    if (packId && manifest.packId !== packId) continue;
    return manifest;
  }
  return null;
}

/**
 * Writes the manifest to `<repoPath>/.bkb/manifest.json` atomically: the
 * payload is written to a sibling temp file and then renamed into place, so a
 * crash mid-write can never leave a truncated/corrupt manifest behind.
 */
export function saveManifest(repoPath: string, manifest: MigrationManifest): void {
  const filePath = getManifestPath(repoPath, manifest.packId);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, filePath);
}

const MANIFEST_LOCK_TIMEOUT_MS = 5_000;
const MANIFEST_LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serializes a read-modify-write of `.bkb/manifest.json` across processes using
 * an advisory lock file. Stale locks (older than the staleness window) are
 * reclaimed; if the lock cannot be acquired in time the callback still runs so
 * a crashed peer can never permanently wedge the migration.
 */
export function withManifestLock<T>(repoPath: string, fn: () => T): T {
  const dir = resolve(repoPath, '.bkb');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const lockPath = join(dir, 'manifest.lock');

  const start = Date.now();
  let acquired = false;
  while (Date.now() - start < MANIFEST_LOCK_TIMEOUT_MS) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      acquired = true;
      break;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > MANIFEST_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // Lock vanished between stat and rm; retry.
      }
      sleepSync(25);
    }
  }

  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Best-effort unlock.
      }
    }
  }
}

/**
 * Creates or updates a manifest for an initialized migration.
 * Preserves existing history and verified module states if a manifest already exists.
 */
export function initOrUpdateManifest(options: InitOrUpdateManifestOptions): MigrationManifest {
  return withManifestLock(options.repoPath, () => initOrUpdateManifestUnlocked(options));
}

function initOrUpdateManifestUnlocked(options: InitOrUpdateManifestOptions): MigrationManifest {
  const existing = loadManifest(options.repoPath, options.packId);

  if (!options.reset && existing && existing.packId === options.packId) {
    // Preserve baseline and completed module states from existing manifest
    const mergedModules: Record<string, ModuleManifestEntry> = { ...existing.modules };

    for (const mod of options.modules) {
      if (!mergedModules[mod.path]) {
        mergedModules[mod.path] = {
          status: mod.status,
          sccId: mod.sccId,
          baselineSets: mod.baselineSets,
        };
      } else if (!mergedModules[mod.path].baselineSets && mod.baselineSets) {
        // Backfill legacy manifests that predate baseline-set persistence.
        mergedModules[mod.path] = {
          ...mergedModules[mod.path],
          baselineSets: mod.baselineSets,
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
      baselineSets: mod.baselineSets,
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
      snapshots: options.baselineSnapshot.snapshots,
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
  record: RecordStepInput,
): MigrationManifest | null {
  return withManifestLock(repoPath, () => recordStepInManifestUnlocked(repoPath, record));
}

function recordStepInManifestUnlocked(
  repoPath: string,
  record: RecordStepInput,
): MigrationManifest | null {
  const manifest = loadManifest(repoPath, record.packId);
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

  // Keep the top-level phase in lockstep with the most recent verified step so
  // status reporting reflects the active phase (SHIM / MIGRATE / DE_SHIM)
  // instead of being frozen at the value written during initialization.
  manifest.phase = record.phase;

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
): Promise<{ reconciledNodes: number; restoredBaselineSets: number }> {
  const statusRows: Array<{ path: string; status: string; phase: string }> = [];
  const baselineRows: Array<{ path: string; baselineSets: string }> = [];

  for (const [modPath, entry] of Object.entries(manifest.modules)) {
    if (entry.status === 'SHIMMED' || entry.status === 'VERIFIED') {
      statusRows.push({
        path: modPath,
        status: entry.status,
        phase: entry.phase ?? (entry.status === 'SHIMMED' ? 'SHIM' : 'MIGRATE'),
      });
    }
    // Restore the true pre-migration invariant baseline for every module that
    // recorded one, so per-step invariant checks on a fresh clone compare
    // against the original baseline rather than the half-migrated disk state.
    if (entry.baselineSets) {
      baselineRows.push({ path: modPath, baselineSets: JSON.stringify(entry.baselineSets) });
    }
  }

  // Batched writes (one round-trip each) instead of one query per module.
  if (statusRows.length) {
    await client.query(
      `UNWIND $rows AS row
       MATCH (m:Module {path: row.path})
       SET m.status = row.status, m.claimed_phase = row.phase`,
      { rows: statusRows },
    );
  }
  if (baselineRows.length) {
    await client.query(
      `UNWIND $rows AS row
       MATCH (m:Module {path: row.path})
       SET m.baseline_sets = row.baselineSets`,
      { rows: baselineRows },
    );
  }

  const reconciledNodes = statusRows.length;
  const restoredBaselineSets = baselineRows.length;

  // Recompute global in_degree and pending_callers_count after reconciliation
  await client.query(Q.RECOMPUTE_DEGREES, {
    legacyCallers: [...Q.LEGACY_CALLER_STATUSES],
  });

  return { reconciledNodes, restoredBaselineSets };
}
