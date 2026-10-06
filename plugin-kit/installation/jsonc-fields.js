'use strict';

// A shared host configuration is owned by fields, never by the surrounding file.
const fs = require('node:fs');
const path = require('node:path');
const jsonc = require('jsonc-parser');
const { atomicWrite } = require('./state-store.js');

function validatePaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.some(parts => !Array.isArray(parts) || !parts.length
    || parts.some(part => typeof part !== 'string' || !part || ['__proto__', 'constructor', 'prototype'].includes(part)))) {
    throw new Error('json_paths must contain non-empty property paths');
  }
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    if (paths[i].slice(0, Math.min(paths[i].length, paths[j].length)).every((part, k) => part === paths[j][k])) {
      throw new Error('json_paths must not overlap');
    }
  }
  return paths;
}

function parse(text) {
  const errors = [];
  const tree = jsonc.parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || tree?.type !== 'object') throw new Error('Invalid shared JSONC configuration');
  const check = node => {
    if (node.type === 'object') {
      const keys = node.children.map(child => child.children[0].value);
      if (new Set(keys).size !== keys.length) throw new Error('Ambiguous duplicate JSONC property');
    }
    (node.children || []).forEach(check);
  };
  check(tree);
  return tree;
}

function read(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Shared configuration must be a regular file: ${file}`);
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function assertObjectParents(tree, parts) {
  for (let length = 1; length < parts.length; length++) {
    const parent = jsonc.findNodeAtLocation(tree, parts.slice(0, length));
    if (parent && parent.type !== 'object') throw new Error('JSONC property parent must be an object');
  }
}

function snapshot(file, paths) {
  validatePaths(paths);
  const text = read(file), tree = parse(text ?? '{}');
  const values = paths.map(parts => {
    assertObjectParents(tree, parts);
    const node = jsonc.findNodeAtLocation(tree, parts);
    return { path: parts, present: Boolean(node), ...(node ? { value: canonical(jsonc.getNodeValue(node)) } : {}) };
  });
  return { type: 'jsonc', values };
}

function restore(file, saved) {
  validatePaths(saved.values.map(item => item.path));
  const existing = read(file);
  if (existing === null && saved.values.every(item => !item.present)) return;
  let text = existing ?? '{}\n';
  parse(text);
  for (const item of saved.values) {
    const tree = parse(text);
    assertObjectParents(tree, item.path);
    if (!item.present && !jsonc.findNodeAtLocation(tree, item.path)) continue;
    const edits = jsonc.modify(text, item.path, item.present ? item.value : undefined,
      { formattingOptions: { insertSpaces: true, tabSize: 2 } });
    text = jsonc.applyEdits(text, edits);
  }
  parse(text);
  if (text !== existing) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, text);
  }
}

module.exports = { validatePaths, snapshot, restore };
