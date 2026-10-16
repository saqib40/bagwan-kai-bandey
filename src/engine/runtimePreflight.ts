/**
 * Layer 1 — Runtime preflight checks (`src/engine/runtimePreflight.ts`).
 *
 * `runtime-interop` packs depend on Node's synchronous `require(esm)` support,
 * which is unflagged from Node 22.12.0. This module gates those packs with an
 * actionable error before any graph mutation occurs.
 */

import { getShimStrategy, type MigrationPack, type ShimStrategy } from '../adapters/types';

export const RUNTIME_INTEROP_MIN_NODE = '22.12.0';

/** Parses a `vMAJOR.MINOR.PATCH` (or bare) version string into numeric parts. */
export function parseNodeVersion(version: string): [number, number, number] {
  const clean = version.trim().replace(/^v/, '');
  const [major = '0', minor = '0', patch = '0'] = clean.split('.');
  return [parseInt(major, 10) || 0, parseInt(minor, 10) || 0, parseInt(patch, 10) || 0];
}

/** Compares two dotted versions; returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = parseNodeVersion(a);
  const pb = parseNodeVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** True when the given Node version supports synchronous `require(esm)`. */
export function isRuntimeInteropSupported(nodeVersion: string = process.versions.node): boolean {
  return compareVersions(nodeVersion, RUNTIME_INTEROP_MIN_NODE) >= 0;
}

export interface RuntimePreflightResult {
  ok: boolean;
  strategy: ShimStrategy;
  nodeVersion: string;
  /** Minimum required Node version when relevant. */
  required?: string;
  message: string;
}

/**
 * Evaluates whether the running Node version satisfies the pack's shim strategy.
 */
export function checkRuntimePreflight(
  pack: Pick<MigrationPack, 'shimStrategy'>,
  nodeVersion: string = process.versions.node,
): RuntimePreflightResult {
  const strategy = getShimStrategy(pack);

  if (strategy !== 'runtime-interop') {
    return {
      ok: true,
      strategy,
      nodeVersion,
      message: `shimStrategy "${strategy}" has no runtime version requirement.`,
    };
  }

  const ok = isRuntimeInteropSupported(nodeVersion);
  return {
    ok,
    strategy,
    nodeVersion,
    required: RUNTIME_INTEROP_MIN_NODE,
    message: ok
      ? `Node ${nodeVersion} supports synchronous require(esm).`
      : `Pack uses shimStrategy "runtime-interop" which requires Node >= ${RUNTIME_INTEROP_MIN_NODE} ` +
        `for synchronous require(esm), but this process is running Node ${nodeVersion}. ` +
        `Upgrade Node (e.g. \`nvm install 22.12\`) or use an \`in-file-branch\` pack.`,
  };
}

/**
 * Throws when the pack's runtime prerequisites are unmet.
 */
export function assertRuntimeInteropSupport(
  pack: Pick<MigrationPack, 'shimStrategy'>,
  nodeVersion: string = process.versions.node,
): RuntimePreflightResult {
  const result = checkRuntimePreflight(pack, nodeVersion);
  if (!result.ok) throw new Error(result.message);
  return result;
}
