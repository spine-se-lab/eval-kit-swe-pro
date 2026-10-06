'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parse, modify, applyEdits } = require('jsonc-parser');
const { readText, writeText } = require('../../../../files/config.js');

function readConfig(root) {
  // Keep the host's normal config. Refuse ambiguous parallel files instead of
  // writing an override which silently loses unrelated registrations.
  const existing = ['opencode.json', 'opencode.jsonc'].map(name => path.join(root, name)).filter(file => fs.existsSync(file));
  if (existing.length > 1) throw new Error('Both opencode.json and opencode.jsonc exist; consolidate the intended plugin scope first');
  const file = existing[0] || path.join(root, 'opencode.json');
  const text = readText(file);
  const errors = [];
  const value = parse(text || '{}', errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid OpenCode configuration: ${file}`);
  if (value.plugin !== undefined && !Array.isArray(value.plugin)) throw new Error('OpenCode plugin must be an array');
  return { file, text, value };
}

function writeConfig(config, values, changes) {
  let text = config.text || '{}\n';
  for (const [key, value] of Object.entries(values)) {
    text = applyEdits(text, modify(text, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  writeText(config.file, text, config.text, changes);
}

module.exports = { readConfig, writeConfig };
