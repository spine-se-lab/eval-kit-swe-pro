'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { install } = require('../host/index.js');

function fixture(t, owned = true) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'migration-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const delivery = path.join(root, 'artifact');
  const config = path.join(root, 'config');
  const old = path.join(config, 'skills/example/SKILL.md');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, 'legacy skill');
  fs.mkdirSync(path.join(delivery, 'package/skills/example'), { recursive: true });
  fs.writeFileSync(path.join(delivery, 'package/package.json'), JSON.stringify({ name: '@codehelix/example', version: '1.0.0' }));
  fs.writeFileSync(path.join(delivery, 'package/plugin.js'), 'export default async () => ({})');
  fs.writeFileSync(path.join(delivery, 'package/skills/example/SKILL.md'), 'native skill');
  fs.writeFileSync(path.join(config, 'opencode.jsonc'), '{\n// preserve\n"model":"my-model", "plugin":["third-party"]\n}');
  if (owned) {
    const record = path.join(config, 'codehelix/example/codehelix-install.json');
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ plugin: 'example', coding_agent: 'opencode', managed_files: {
      [old]: crypto.createHash('sha256').update('legacy skill').digest('hex'),
    } }));
  }
  const data = path.join(root, 'project/.chrys/memory/topics/rule.md');
  fs.mkdirSync(path.dirname(data), { recursive: true }); fs.writeFileSync(data, 'user memory');
  return { old, config, data, context: { delivery, target: { config_root: config }, configuration: {},
    manifest: { plugin: { id: 'example' }, content: {} } } };
}

test('owned legacy skills migrate without duplicate registration or deleting memory', t => {
  const f = fixture(t);
  const changes = [];
  install(f.context, changes);
  assert.equal(fs.existsSync(f.old), false);
  assert.equal(fs.readFileSync(f.data, 'utf8'), 'user memory');
  assert.ok(changes.some(item => item.kind === 'legacy_skill'));
  const once = fs.readFileSync(path.join(f.config, 'opencode.jsonc'), 'utf8');
  assert.match(once, /\/\/ preserve/);
  install(f.context, []);
  assert.equal(fs.readFileSync(path.join(f.config, 'opencode.jsonc'), 'utf8'), once);
});

for (const scenario of ['unowned', 'modified']) test(`${scenario} legacy skills block all config writes`, t => {
  const f = fixture(t, scenario !== 'unowned');
  if (scenario === 'modified') fs.writeFileSync(f.old, 'user changed this');
  const before = fs.readFileSync(path.join(f.config, 'opencode.jsonc'), 'utf8');
  const changes = [];
  assert.throws(() => install(f.context, changes), /ownership|changed/);
  assert.deepEqual(changes, []);
  assert.equal(fs.readFileSync(path.join(f.config, 'opencode.jsonc'), 'utf8'), before);
  assert.equal(fs.readFileSync(f.data, 'utf8'), 'user memory');
});
