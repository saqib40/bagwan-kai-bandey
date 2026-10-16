'use strict';

/** Joins parts with a colon, tolerating non-array input. */
function formatLine(parts) {
  return (Array.isArray(parts) ? parts : [String(parts ?? '')]).join(':');
}

module.exports = { formatLine };
