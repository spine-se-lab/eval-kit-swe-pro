'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const adapter = require('../adapter.js');

test('OpenCode skills-v1 declares its filesystem capability and resolves both scopes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-skills-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const userHome = path.join(root, 'user');
  fs.mkdirSync(project);
  fs.mkdirSync(userHome);
  assert.equal(adapter.contract.capability, 'skill-directory-v1');
  assert.equal(adapter.targetRoot('project', { projectRoot: project }), path.join(fs.realpathSync(project), '.opencode/skills'));
  assert.equal(adapter.targetRoot('global', { env: {}, userHome }), path.join(fs.realpathSync(userHome), '.config/opencode/skills'));
  assert.equal(adapter.detect({ env: { PATH: '' }, userHome }), false);
  assert.equal(adapter.detect({ env: { PATH: '', OPENCODE_CONFIG_DIR: path.join(root, 'opencode') }, userHome }), true);
  assert.throws(() => adapter.targetRoot('unknown', { projectRoot: project }), /Scope/);
});
