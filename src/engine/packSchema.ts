/**
 * Layer 1 — Migration Pack JSON-Schema validation (`src/engine/packSchema.ts`).
 *
 * Compiles the authoritative `packs/PACK_SPEC.schema.json` (draft-07) with Ajv
 * and validates pack objects against it. This complements the hand-written
 * `validatePack` structural checks in `packLoader.ts`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';

const SCHEMA_PATH = resolve(import.meta.dirname, '../../packs/PACK_SPEC.schema.json');

let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

/** Renders an Ajv error with a readable instance path and enum hints. */
function formatAjvError(err: ErrorObject): string {
  const path = err.instancePath
    ? err.instancePath.replace(/^\//, '').replace(/\//g, '.')
    : '(root)';
  const params = err.params as Record<string, unknown>;
  const allowed =
    Array.isArray(params?.allowedValues) && params.allowedValues.length
      ? ` [allowed: ${(params.allowedValues as unknown[]).join(', ')}]`
      : '';
  return `${path}: ${err.message}${allowed}`;
}

/**
 * Validates a pack object against `PACK_SPEC.schema.json`.
 * Returns `{ valid: true, errors: [] }` on success.
 */
export function validatePackSchema(pack: unknown): { valid: boolean; errors: string[] } {
  const validate = getValidator();
  const valid = validate(pack) as boolean;
  if (valid) return { valid: true, errors: [] };
  return { valid: false, errors: (validate.errors ?? []).map(formatAjvError) };
}
