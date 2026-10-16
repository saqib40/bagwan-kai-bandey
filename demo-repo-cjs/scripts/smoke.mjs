#!/usr/bin/env node
/**
 * Checkpoint smoke test for the cjs-to-esm fixture.
 *
 * Imports the entry module (CommonJS or ESM) and asserts the public behaviour of
 * `main()` is unchanged. Used as the pack's `checkpointTestCmd`, so it must pass
 * at every intermediate migration state.
 */

import assert from 'node:assert/strict';

const entryUrl = new URL('../src/index.js', import.meta.url);
const mod = await import(entryUrl.href);
const surface = mod.default && typeof mod.default === 'object' ? mod.default : mod;

assert.equal(typeof surface.main, 'function', 'entry must export main()');
assert.equal(typeof surface.shortHash, 'function', 'entry must export shortHash()');

const out = surface.main();
assert.deepEqual(out, { route: '/ledger', label: 'A>B', tag: surface.shortHash('main') });

process.stdout.write('smoke ok\n');
