/**
 * Unit tests for runtime-interop Node preflight gating (Milestone M2.2).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_INTEROP_MIN_NODE,
  parseNodeVersion,
  compareVersions,
  isRuntimeInteropSupported,
  checkRuntimePreflight,
  assertRuntimeInteropSupport,
} from '../src/engine/runtimePreflight';
import type { ShimStrategy } from '../src/adapters/types';

function pack(shimStrategy?: ShimStrategy) {
  return { shimStrategy };
}

describe('parseNodeVersion / compareVersions', () => {
  it('parses v-prefixed and bare versions', () => {
    assert.deepEqual(parseNodeVersion('v22.12.0'), [22, 12, 0]);
    assert.deepEqual(parseNodeVersion('20.9.1'), [20, 9, 1]);
  });

  it('orders versions numerically, not lexically', () => {
    assert.equal(compareVersions('22.9.0', '22.12.0'), -1);
    assert.equal(compareVersions('22.12.0', '22.12.0'), 0);
    assert.equal(compareVersions('23.0.0', '22.12.0'), 1);
    assert.equal(compareVersions('22.12.1', '22.12.0'), 1);
  });
});

describe('isRuntimeInteropSupported', () => {
  it(`treats ${RUNTIME_INTEROP_MIN_NODE} as the boundary`, () => {
    assert.equal(isRuntimeInteropSupported('22.11.9'), false);
    assert.equal(isRuntimeInteropSupported('22.12.0'), true);
    assert.equal(isRuntimeInteropSupported('v24.1.0'), true);
  });
});

describe('checkRuntimePreflight', () => {
  it('passes for non-interop strategies regardless of Node version', () => {
    const result = checkRuntimePreflight(pack('in-file-branch'), '18.0.0');
    assert.equal(result.ok, true);
    assert.equal(result.required, undefined);
  });

  it('passes for runtime-interop on a supported Node', () => {
    const result = checkRuntimePreflight(pack('runtime-interop'), '22.12.0');
    assert.equal(result.ok, true);
    assert.equal(result.required, RUNTIME_INTEROP_MIN_NODE);
  });

  it('fails for runtime-interop on an old Node with an actionable message', () => {
    const result = checkRuntimePreflight(pack('runtime-interop'), '20.10.0');
    assert.equal(result.ok, false);
    assert.match(result.message, /Node >= 22\.12\.0/);
    assert.match(result.message, /require\(esm\)/);
  });
});

describe('assertRuntimeInteropSupport', () => {
  it('throws on unmet interop prerequisites', () => {
    assert.throws(
      () => assertRuntimeInteropSupport(pack('runtime-interop'), '20.10.0'),
      /require\(esm\)/,
    );
  });

  it('returns the result when satisfied', () => {
    const result = assertRuntimeInteropSupport(pack('runtime-interop'), '23.1.0');
    assert.equal(result.ok, true);
  });
});
