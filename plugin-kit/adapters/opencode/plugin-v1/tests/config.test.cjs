'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readConfig, writeConfig } = require('../host/config.js');

test('native configuration preserves comments and unrelated keys, rejects edits since preview', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'opencode-config-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'opencode.jsonc');
  fs.writeFileSync(file, '{\n  // personal preference\n  "model": "example/model",\n  "plugin": ["third-party"],\n}\n');
  const config = readConfig(root);
  const changes = [];
  writeConfig(config, { plugin: [...config.value.plugin, 'file:///package/plugin.js'] }, changes);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\/\/ personal preference/);
  assert.match(text, /"model": "example\/model"/);
  assert.deepEqual(readConfig(root).value.plugin, ['third-party', 'file:///package/plugin.js']);
  assert.equal(changes.length, 1);
  assert.throws(() => writeConfig(config, { plugin: [] }, []), /changed after preflight/);
});

test('malformed configuration and symlink scopes are blocked without writes', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'opencode-config-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'opencode.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => readConfig(root), /Invalid/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(root, 'elsewhere'), file);
  assert.throws(() => readConfig(root), /symlink/);
});
