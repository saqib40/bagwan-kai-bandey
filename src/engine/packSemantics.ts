/**
 * Layer 1 — Migration Pack semantic validation (`src/engine/packSemantics.ts`).
 *
 * Complements the JSON-Schema checks with rules that are awkward to express
 * declaratively:
 *  - checkpoint-scope invariants are rejected (global checks belong in snapshots)
 *  - duplicate detection-rule / invariant / snapshot ids
 *  - grammar-specific AST query compilation (only when an adapter is registered)
 */

import type { MigrationPack } from '../adapters/types';
import type { AdapterRegistry } from '../adapters/registry';

export interface SemanticValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function findDuplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    else seen.add(id);
  }
  return [...dupes];
}

/**
 * Synchronous semantic validation. Safe to call during pack loading.
 */
export function validatePackSemantics(pack: MigrationPack | any): SemanticValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!pack || typeof pack !== 'object') {
    return { valid: false, errors: ['Migration pack must be a non-null object.'], warnings };
  }

  for (const inv of pack.invariants ?? []) {
    if (inv?.scope && inv.scope !== 'per-step') {
      errors.push(
        `Invariant "${inv.id ?? '<unknown>'}" uses scope "${inv.scope}", which is not enforced by the engine. ` +
          `Move global checks to \`verification.snapshots\` and keep only \`per-step\` invariants.`,
      );
    }
  }

  const ruleDupes = findDuplicates((pack.detectionRules ?? []).map((r: any) => r?.id).filter(Boolean));
  if (ruleDupes.length) errors.push(`Duplicate detectionRule id(s): ${ruleDupes.join(', ')}.`);

  const invDupes = findDuplicates((pack.invariants ?? []).map((i: any) => i?.id).filter(Boolean));
  if (invDupes.length) errors.push(`Duplicate invariant id(s): ${invDupes.join(', ')}.`);

  const snapshots = pack.verification?.snapshots ?? [];
  if (Array.isArray(snapshots)) {
    const snapDupes = findDuplicates(snapshots.map((s: any) => s?.id).filter(Boolean));
    if (snapDupes.length) errors.push(`Duplicate snapshot id(s): ${snapDupes.join(', ')}.`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

export interface QueryValidationResult extends SemanticValidationResult {
  /** True when AST validation was skipped (no adapter / adapter lacks support). */
  skipped: boolean;
}

/**
 * Compiles every AST query in the pack with the registered adapter for the
 * pack's language. If no adapter is registered (or it does not support query
 * validation) validation is skipped with a warning rather than failing.
 */
export async function validatePackQueries(
  pack: MigrationPack,
  registry: AdapterRegistry,
): Promise<QueryValidationResult> {
  if (!registry.has(pack.language)) {
    return {
      valid: true,
      errors: [],
      warnings: [`Skipped AST query validation: no "${pack.language}" adapter registered.`],
      skipped: true,
    };
  }

  const adapter = registry.get(pack.language);
  if (typeof adapter.validateQuery !== 'function') {
    return {
      valid: true,
      errors: [],
      warnings: [`Skipped AST query validation: adapter "${pack.language}" does not support it.`],
      skipped: true,
    };
  }

  const errors: string[] = [];
  for (const rule of pack.detectionRules ?? []) {
    const result = await adapter.validateQuery(rule.astQuery);
    for (const err of result) errors.push(`Detection rule "${rule.id}": ${err}`);
  }
  for (const inv of pack.invariants ?? []) {
    const result = await adapter.validateQuery(inv.astExtractor);
    for (const err of result) errors.push(`Invariant "${inv.id}": ${err}`);
  }

  return { valid: errors.length === 0, errors, warnings: [], skipped: false };
}
