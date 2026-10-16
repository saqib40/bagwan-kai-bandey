'use strict';

function labelB() {
  return 'B';
}

// Lazily require cycleA inside the function so the cycle resolves to live
// exports (equivalent to ESM live bindings) instead of a partial snapshot.
function echoA() {
  return require('./cycleA').labelA();
}

module.exports = { labelB, echoA };
