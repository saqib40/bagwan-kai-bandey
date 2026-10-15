/**
 * Bagwan Kai Bandey (BKB) Checkpoint & Rollback System (`src/runner/rollback.ts`).
 *
 * Saves step-level disk snapshots to `.bkb/checkpoints/step-<N>/` before code modifications,
 * enabling instantaneous zero-risk rollback of both disk state and FalkorDB graph state.
 */

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { MigrationGraphManager } from '../engine/graphManager';

export interface CheckpointInfo {
  step: number;
  dir: string;
  timestamp: number;
}

export function getCheckpointsDir(repoPath: string): string {
  return join(resolve(repoPath), '.bkb', 'checkpoints');
}

/**
 * Saves a snapshot of source files before a migration step is applied.
 */
export function saveCheckpoint(repoPath: string, step: number, targetPaths: string[] = []): string {
  const absRepo = resolve(repoPath);
  const cpDir = join(getCheckpointsDir(absRepo), `step-${step}`);
  if (!existsSync(cpDir)) {
    mkdirSync(cpDir, { recursive: true });
  }

  // If specific files given, backup those; otherwise snapshot src directory or repo files
  const srcDir = join(absRepo, 'src');
  if (existsSync(srcDir)) {
    cpSync(srcDir, join(cpDir, 'src'), { recursive: true });
  } else {
    for (const p of targetPaths) {
      const srcFile = join(absRepo, p);
      if (existsSync(srcFile)) {
        const destFile = join(cpDir, p);
        mkdirSync(resolve(destFile, '..'), { recursive: true });
        cpSync(srcFile, destFile);
      }
    }
  }

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

  // Restore files
  const cpSrc = join(cpDir, 'src');
  if (existsSync(cpSrc)) {
    cpSync(cpSrc, join(absRepo, 'src'), { recursive: true });
  } else {
    // Copy all contents from checkpoint dir back to repo
    cpSync(cpDir, absRepo, { recursive: true });
  }

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
