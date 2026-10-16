'use strict';

const { list } = require('./ledger');
const { formatLine } = require('../utils/format');

function summarize() {
  return list().map((e) => formatLine([e.actor, e.action]));
}

module.exports = { summarize };
