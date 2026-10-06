'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { replacement } = require('../marketplace.js');

test('relocated marketplace can only replace a validated single-plugin Delivery', t => {
  const source = path.resolve(__dirname, '../../../../../plugins/memory-curator/delivery/codex-native');
  const previous = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-marketplace-')));
  t.after(() => fs.rmSync(previous, { recursive: true, force: true }));
  fs.cpSync(source, previous, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'codehelix-plugin.json')));
  const listing = `MARKETPLACE  ROOT\ncodehelix-memory-curator  ${previous}\n`;
  assert.equal(replacement({ delivery: source, manifest }, 'No plugin marketplaces in scope.\n'), null);
  assert.deepEqual(replacement({ delivery: source, manifest }, listing), { name:'codehelix-memory-curator', source: previous });
  assert.equal(replacement({ delivery: fs.realpathSync(previous), manifest }, listing), null);
  manifest.plugin.id = 'unrelated';
  fs.writeFileSync(path.join(previous, 'codehelix-plugin.json'), JSON.stringify(manifest));
  assert.throws(() => replacement({ delivery: source, manifest: {plugin:{id:'memory-curator'},execution:{adapter:'codex/native-plugins'}} }, listing), /different package/);
  assert.throws(() => replacement({ delivery: source, manifest }, 'unknown format'), /Unrecognized/);
});
