/**
 * Bagwan Kai Bandey (BKB) Checkpoint & Rollback System (`src/runner/rollback.ts`).
 *
 * Saves step-level disk snapshots to `.bkb/checkpoints/step-<N>/` before code modifications,
 * enabling instantaneous zero-risk rollback of both disk state and FalkorDB graph state.
 */

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { MigrationGraphManager } from '../engine/graphManager';
import { loadManifest, saveManifest } from '../engine/manifest';
import { broadcastLiveEvent } from '../engine/telemetry';

export interface CheckpointInfo {
  step: number;
  dir: string;
  timestamp: number;
}

export function getCheckpointsDir(repoPath: string): string {
  return join(resolve(repoPath), '.bkb', 'checkpoints');
}

/**
 * Recursively deletes any file or directory in destDir that does not exist in sourceDir.
 */
function syncDirDeletive(sourceDir: string, destDir: string): void {
  if (!existsSync(destDir)) return;
  const destEntries = readdirSync(destDir, { withFileTypes: true });
  for (const entry of destEntries) {
    const destPath = join(destDir, entry.name);
    const sourcePath = join(sourceDir, entry.name);
    if (!existsSync(sourcePath)) {
      rmSync(destPath, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      syncDirDeletive(sourcePath, destPath);
    }
  }
}

const COMMON_ROOT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json'];

/**
 * Saves a snapshot of source and configuration files before a migration step is applied.
 */
export function saveCheckpoint(repoPath: string, step: number, targetPaths: string[] = []): string {
  const absRepo = resolve(repoPath);
  const cpDir = join(getCheckpointsDir(absRepo), `step-${step}`);
  if (!existsSync(cpDir)) {
    mkdirSync(cpDir, { recursive: true });
  }

  const manifest: { timestamp: number; step: number; trackedPaths: string[] } = {
    timestamp: Date.now(),
    step,
    trackedPaths: [],
  };

  // 1. Snapshot src/ directory
  const srcDir = join(absRepo, 'src');
  if (existsSync(srcDir)) {
    cpSync(srcDir, join(cpDir, 'src'), { recursive: true });
    manifest.trackedPaths.push('src');
  }

  // 2. Snapshot scripts/ directory
  const scriptsDir = join(absRepo, 'scripts');
  if (existsSync(scriptsDir)) {
    cpSync(scriptsDir, join(cpDir, 'scripts'), { recursive: true });
    manifest.trackedPaths.push('scripts');
  }

  // 3. Snapshot root configuration files
  for (const filename of COMMON_ROOT_FILES) {
    const fPath = join(absRepo, filename);
    if (existsSync(fPath)) {
      cpSync(fPath, join(cpDir, filename));
      manifest.trackedPaths.push(filename);
    }
  }

  // 4. Snapshot any explicitly specified targetPaths
  for (const p of targetPaths) {
    const srcFile = join(absRepo, p);
    if (existsSync(srcFile) && !manifest.trackedPaths.includes(p)) {
      const destFile = join(cpDir, p);
      mkdirSync(dirname(destFile), { recursive: true });
      cpSync(srcFile, destFile);
      manifest.trackedPaths.push(p);
    }
  }

  writeFileSync(join(cpDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return cpDir;
}

/**
 * Lists all available checkpoint step numbers in chronological order.
 */
export function listCheckpoints(repoPath: string): number[] {
  const cpDir = getCheckpointsDir(repoPath);
  if (!existsSync(cpDir)) return [];

  try {
    return readdirSync(cpDir)
      .filter((d) => d.startsWith('step-'))
      .map((d) => parseInt(d.replace('step-', ''), 10))
      .filter((n) => !isNaN(n))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * Restores disk files from a checkpoint and re-synchronizes the FalkorDB graph.
 */
export async function rollbackToCheckpoint(
  repoPath: string,
  packId = 'express-to-fastify',
  step?: number,
  graphName?: string,
): Promise<{ ok: boolean; restoredStep: number | null; message: string }> {
  const absRepo = resolve(repoPath);
  const available = listCheckpoints(absRepo);

  if (!available.length) {
    return {
      ok: false,
      restoredStep: null,
      message: 'No BKB checkpoints found in .bkb/checkpoints.',
    };
  }

  const targetStep = step !== undefined ? step : available[available.length - 1]!;
  const cpDir = join(getCheckpointsDir(absRepo), `step-${targetStep}`);

  if (!existsSync(cpDir)) {
    return {
      ok: false,
      restoredStep: null,
      message: `Checkpoint step-${targetStep} does not exist. Available: [${available.join(', ')}]`,
    };
  }

  // 1. Restore src/ with deletive cleanup of extraneous files created after the checkpoint
  const cpSrc = join(cpDir, 'src');
  const repoSrc = join(absRepo, 'src');
  if (existsSync(cpSrc)) {
    cpSync(cpSrc, repoSrc, { recursive: true });
    syncDirDeletive(cpSrc, repoSrc);
  }

  // 2. Restore scripts/ with deletive cleanup
  const cpScripts = join(cpDir, 'scripts');
  const repoScripts = join(absRepo, 'scripts');
  if (existsSync(cpScripts)) {
    cpSync(cpScripts, repoScripts, { recursive: true });
    syncDirDeletive(cpScripts, repoScripts);
  }

  // 3. Restore root configuration files
  for (const filename of COMMON_ROOT_FILES) {
    const cpRootFile = join(cpDir, filename);
    const repoRootFile = join(absRepo, filename);
    if (existsSync(cpRootFile)) {
      cpSync(cpRootFile, repoRootFile);
    }
  }

  // 4. Fallback restore for any other files in checkpoint directory
  const manifestPath = join(cpDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const p of manifest.trackedPaths || []) {
        if (p !== 'src' && p !== 'scripts' && !COMMON_ROOT_FILES.includes(p)) {
          const cpFile = join(cpDir, p);
          const repoFile = join(absRepo, p);
          if (existsSync(cpFile)) {
            mkdirSync(dirname(repoFile), { recursive: true });
            cpSync(cpFile, repoFile);
          }
        }
      }
    } catch {
      // Ignore manifest parse errors
    }
  }

  // Capture the committed manifest before re-ingesting. initMigrationGraph with
  // reset:true rebuilds the manifest from the restored disk state, which would
  // discard the pristine pre-migration baseline and the team's commit history.
  const priorManifest = loadManifest(absRepo, packId);

  // Re-synchronize FalkorDB graph from the restored disk state
  try {
    await MigrationGraphManager.initMigrationGraph({
      repoPath: absRepo,
      packId,
      graphName,
      reset: true,
    });
  } catch (err: any) {
    return {
      ok: true,
      restoredStep: targetStep,
      message: `Disk restored to step-${targetStep}, but graph re-sync failed: ${err.message}`,
    };
  }

  // Restore the preserved baseline/history/epoch/phase onto the rebuilt manifest
  // so rollback is not treated as a fresh migration.
  if (priorManifest) {
    const rebuilt = loadManifest(absRepo, packId);
    if (rebuilt) {
      rebuilt.baseline = priorManifest.baseline;
      rebuilt.history = priorManifest.history;
      rebuilt.migrationEpoch = priorManifest.migrationEpoch;
      rebuilt.phase = priorManifest.phase;
      saveManifest(absRepo, rebuilt);
    }
  }

  broadcastLiveEvent({
    type: 'rollback',
    repoPath: absRepo,
    packId,
    step: targetStep,
  });

  return {
    ok: true,
    restoredStep: targetStep,
    message: `Successfully rolled back codebase and FalkorDB graph to checkpoint step-${targetStep}.`,
  };
}

/**
 * Clears all checkpoints for a repository.
 */
export function clearCheckpoints(repoPath: string): void {
  const cpDir = getCheckpointsDir(repoPath);
  if (existsSync(cpDir)) {
    rmSync(cpDir, { recursive: true, force: true });
  }
}
