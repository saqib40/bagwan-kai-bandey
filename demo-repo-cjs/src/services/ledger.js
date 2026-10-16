'use strict';

const { shortHash } = require('../utils/hash');

const entries = [];

function record(actor, action) {
  const entry = {
    id: entries.length + 1,
    actor: String(actor ?? 'anon'),
    action: String(action ?? 'noop'),
    tag: shortHash(action),
  };
  entries.push(entry);
  return entry;
}

function list() {
  return entries.slice();
}

module.exports = { record, list };
