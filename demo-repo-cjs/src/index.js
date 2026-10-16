'use strict';

const { shortHash } = require('./utils/hash');
const { formatLine } = require('./utils/format');
const { record, list } = require('./services/ledger');
const { summarize } = require('./services/audit');
const { labelA } = require('./services/cycleA');
const { labelB, echoA } = require('./services/cycleB');
const { find } = require('./routes/api');

function main() {
  const route = find('GET', '/ledger');
  return { route: route ? route.path : null, label: labelA(), tag: shortHash('main') };
}

module.exports = { main, shortHash, formatLine, record, list, summarize, labelA, labelB, echoA, find };
