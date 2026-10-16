/**
 * Layer 3 — Migration Pack scaffolding (`src/cli/packScaffold.ts`).
 *
 * Produces a conforming starter pack for `bkb pack init`. Kept in its own module
 * so the generated template can be schema-validated in tests.
 */

import type { MigrationPack } from '../adapters/types';

export const PACK_SCHEMA_URL =
  'https://raw.githubusercontent.com/saqib40/bagwan-kai-bandey/main/packs/PACK_SPEC.schema.json';

export function buildPackTemplate(packId: string, lang: string): MigrationPack {
  const extension = lang === 'python' ? 'py' : lang === 'go' ? 'go' : 'ts';
  const callNode = lang === 'python' ? 'call' : 'call_expression';
  return {
    $schema: PACK_SCHEMA_URL,
    id: packId,
    name: `${packId} Migration Pack`,
    language: lang,
    sourceGlobs: {
      include: [`**/*.${extension}`],
      exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
    },
    packages: {
      legacy: ['legacy-package'],
      target: ['target-package'],
    },
    detectionRules: [
      {
        id: 'legacy-api-call',
        description: 'Detects usage of legacy package APIs',
        astQuery: `(${callNode} function: (identifier) @api)`,
      },
    ],
    agentGuidance: {
      SHIM: 'Implement dual-compatibility adapters for legacy callers.',
      MIGRATE: 'Migrate internal module logic to modern framework semantics.',
      DE_SHIM: 'Remove legacy shims and convert to pure target framework calls.',
    },
    invariants: [
      {
        id: 'call-surface-preserved',
        scope: 'per-step',
        type: 'extracted-set-equality',
        description: 'Every internal API call surface in this file must match the captured baseline.',
        astExtractor: `(${callNode} function: (identifier) @fn)`,
      },
    ],
    verification: {
      perStepTypecheckCmd: lang === 'python' ? 'mypy .' : 'npm run typecheck',
      checkpointTestCmd: lang === 'python' ? 'pytest' : 'npm test',
      snapshots: [
        {
          id: 'route-surface',
          command: lang === 'python' ? 'python3 scripts/dump_routes.py' : 'node scripts/dump-routes.mjs',
          kind: 'set',
        },
      ],
    },
  };
}
