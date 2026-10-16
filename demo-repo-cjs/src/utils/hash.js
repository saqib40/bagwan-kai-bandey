'use strict';

/** Deterministic, dependency-free short hash used across the fixture. */
function shortHash(input) {
  const text = String(input ?? '');
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

module.exports = { shortHash };
