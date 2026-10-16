/**
 * Layer 1 — Global Verification Snapshots (`src/engine/snapshots.ts`).
 *
 * Hard Rule: Zero mentions of language or framework specifics.
 *
 * Resolves the snapshots a pack declares (falling back to the deprecated
 * `routeSnapshotCmd`) and normalizes snapshot command output for comparison.
 */

import type { MigrationPack, SnapshotKind, VerificationSnapshot } from '../adapters/types';

export const SNAPSHOT_KINDS: readonly SnapshotKind[] = ['set', 'count', 'exact'] as const;

/**
 * Returns the global snapshots declared by a pack. Backward compatible: when
 * `verification.snapshots` is absent, a legacy `routeSnapshotCmd` is exposed as
 * a single `route-surface` set-snapshot.
 */
export function getPackSnapshots(pack: MigrationPack): VerificationSnapshot[] {
  const declared = pack.verification?.snapshots;
  if (declared && declared.length > 0) return declared;

  const legacy = pack.verification?.routeSnapshotCmd;
  if (legacy) {
    return [{ id: 'route-surface', command: legacy, kind: 'set' }];
  }
  return [];
}

/**
 * Normalizes raw snapshot command output to a stable, comparable string.
 * - `set`:   parses a JSON array, sorts it, and re-serializes (empty array on failure).
 * - `count`: parses JSON (number or structured counts) and re-serializes.
 * - `exact`: returns the trimmed raw string unchanged.
 */
export function normalizeSnapshotOutput(kind: SnapshotKind, raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (kind === 'exact') return trimmed;

  try {
    const parsed = JSON.parse(trimmed);
    if (kind === 'set') {
      return JSON.stringify(Array.isArray(parsed) ? [...parsed].sort() : []);
    }
    return JSON.stringify(parsed);
  } catch {
    return kind === 'set' ? '[]' : trimmed;
  }
}
