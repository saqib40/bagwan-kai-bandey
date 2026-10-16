'use strict';

const { labelB } = require('./cycleB');

function labelA() {
  return 'A>' + labelB();
}

module.exports = { labelA };
