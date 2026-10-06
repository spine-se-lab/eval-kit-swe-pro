'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readText } = require('../../../files/config.js');

function replacement(context, listing) {
  if (listing.trim() === 'No plugin marketplaces in scope.') return null;
  if (!/^MARKETPLACE\s+ROOT\s*$/m.test(listing)) throw new Error('Unrecognized Codex marketplace list output');
  const name = `codehelix-${context.manifest.plugin.id}`;
  const rows = listing.trim().split('\n').slice(1).map(line => line.trim().split(/\s{2,}/));
  const matches = rows.filter(row => row[0] === name);
  if (matches.length > 1) throw new Error('Ambiguous Codex marketplace registration');
  if (!matches.length) return null;
  const source = matches[0][1];
  if (!source || !path.isAbsolute(source)) throw new Error('Existing marketplace source is not a known local Delivery');
  if (fs.realpathSync(source) === context.delivery) return null;
  // Repoint only our single-plugin, validated local Delivery. Never replace an
  // arbitrary marketplace merely because its display name happens to match.
  const previous = JSON.parse(readText(path.join(source, 'codehelix-plugin.json')));
  if (previous.plugin?.id !== context.manifest.plugin.id || previous.execution?.adapter !== context.manifest.execution.adapter) {
    throw new Error('Existing marketplace belongs to a different package; resolve the conflict in Codex');
  }
  require('../../../model/native.js').validateDelivery(source, previous);
  return { name, source };
}

module.exports = { replacement };
