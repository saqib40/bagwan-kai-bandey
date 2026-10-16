'use strict';

const { record, list } = require('../services/ledger');
const { summarize } = require('../services/audit');

const routes = [
  { method: 'GET', path: '/ledger', handler: () => list() },
  { method: 'POST', path: '/ledger', handler: (input) => record('cli', input) },
  { method: 'GET', path: '/audit', handler: () => summarize() },
];

function find(method, path) {
  return routes.find((r) => r.method === method && r.path === path);
}

module.exports = { routes, find };
