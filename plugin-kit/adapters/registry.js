'use strict';

const adapters = [
  require('./codex/native-plugins/adapter.js'),
  require('./opencode/plugin-v1/adapter.js'),
];
require('./resolve.js').validateRegistry(adapters);

function getAdapter(id) {
  const matches = adapters.filter(adapter => adapter.id === id);
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous adapter: ${id}`);
  return matches[0];
}

module.exports = { adapters, getAdapter };
