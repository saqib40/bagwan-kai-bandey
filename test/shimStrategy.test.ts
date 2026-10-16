/**
 * Unit tests for the pack-declared shim strategy (Milestone M2.1).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getShimStrategy,
  DEFAULT_SHIM_STRATEGY,
  RUNTIME_INTEROP_MARKER,
} from '../src/adapters/types';
import { shimRuleForStrategy } from '../src/runner/llmClient';
import { validatePackSchema } from '../src/engine/packSchema';

function minimalPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p',
    name: 'Pack',
    language: 'typescript',
    sourceGlobs: { include: ['src/**/*.js'] },
    packages: { legacy: [], target: [] },
    detectionRules: [{ id: 'r', description: 'r', astQuery: '(identifier)' }],
    agentGuidance: {},
    invariants: [],
    verification: { perStepTypecheckCmd: 'true', checkpointTestCmd: 'true' },
    ...overrides,
  };
}

describe('getShimStrategy', () => {
  it('defaults to in-file-branch', () => {
    assert.equal(getShimStrategy({}), DEFAULT_SHIM_STRATEGY);
    assert.equal(getShimStrategy({}), 'in-file-branch');
  });

  it('returns an explicit strategy', () => {
    assert.equal(getShimStrategy({ shimStrategy: 'runtime-interop' }), 'runtime-interop');
  });
});

describe('shimStrategy schema', () => {
  it('accepts both enum values', () => {
    assert.equal(validatePackSchema(minimalPack({ shimStrategy: 'in-file-branch' })).valid, true);
    assert.equal(validatePackSchema(minimalPack({ shimStrategy: 'runtime-interop' })).valid, true);
  });

  it('rejects unknown strategies with an allowed-values hint', () => {
    const result = validatePackSchema(minimalPack({ shimStrategy: 'dual-syntax' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('shimStrategy') && e.includes('in-file-branch')));
  });
});

describe('shimRuleForStrategy', () => {
  it('describes dual-branch shimming for in-file-branch', () => {
    const rule = shimRuleForStrategy('in-file-branch');
    assert.match(rule, /@bkb-shim/);
    assert.doesNotMatch(rule, /esm-runtime-interop/);
  });

  it('describes export-shape preservation for runtime-interop', () => {
    const rule = shimRuleForStrategy('runtime-interop');
    assert.ok(rule.includes(RUNTIME_INTEROP_MARKER));
    assert.match(rule, /export default X/);
    assert.match(rule, /top-level await/);
  });
});
