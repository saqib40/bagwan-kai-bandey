#!/usr/bin/env node
/**
 * Runtime Export-Surface Snapshot for the cjs-to-esm fixture.
 *
 * Dynamically imports the entry module and emits a sorted JSON array describing
 * the public export surface. Works for BOTH the original CommonJS entry and the
 * migrated ES module (Node module detection + `require(esm)`), so the same
 * command verifies every intermediate migration state.
 *
 * For every export it records the value type. Function values are additionally
 * invoked so that namespace-vs-callable shape regressions (e.g. `import()` of a
 * `module.exports = fn` returning `{ default: fn }`) are caught, not just names.
 */

const entryUrl = new URL('../src/index.js', import.meta.url);

const mod = await import(entryUrl.href);

// Prefer an object-style `default` (CommonJS `module.exports = {...}` or an
// `export default {...}`), otherwise fall back to the namespace itself.
let surface = mod.default;
if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) {
  surface = mod;
}

const names = Object.keys(surface)
  .filter((k) => k !== 'default' && k !== '__esModule')
  .sort();

const descriptors = [];
for (const name of names) {
  const value = surface[name];
  const t = typeof value;
  let descriptor = t;
  if (t === 'function') {
    try {
      descriptor = `function:${typeof value()}`;
    } catch (err) {
      descriptor = `function:throws:${err?.constructor?.name ?? 'Error'}`;
    }
  }
  descriptors.push(`${name}=${descriptor}`);
}

process.stdout.write(JSON.stringify(descriptors) + '\n');
