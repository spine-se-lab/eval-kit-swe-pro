'use strict';

const fs = require('node:fs');
const path = require('node:path');

function packageRoot(delivery) { return path.join(delivery, 'package'); }

function buildPackage({ delivery, manifest, copyContent, writeJson }) {
  const root = packageRoot(delivery);
  const servers = copyContent(root);
  writeJson(path.join(root, 'package.json'), {
    name: `@codehelix/${manifest.plugin.id}`, version: manifest.plugin.version,
    description: manifest.plugin.description.en, type: 'module', exports: './plugin.js',
    files: ['plugin.js', 'binding.json', 'skills', 'runtime'],
  });
  writeJson(path.join(root, 'binding.json'), { servers: servers.map(s => s.name) });
  fs.copyFileSync(path.join(__dirname, 'runtime/plugin.js'), path.join(root, 'plugin.js'));
}

function validatePackage(delivery, manifest) {
  const root = packageRoot(delivery);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== `@codehelix/${manifest.plugin.id}` || pkg.version !== manifest.plugin.version
      || pkg.type !== 'module' || pkg.exports !== './plugin.js') throw new Error('Invalid OpenCode package');
  for (const file of ['plugin.js', 'binding.json', 'skills']) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing OpenCode package file: ${file}`);
  }
  const binding = JSON.parse(fs.readFileSync(path.join(root, 'binding.json'), 'utf8'));
  if (!require('node:util').isDeepStrictEqual(binding.servers, (manifest.content.mcp || []).map(s => s.name))) throw new Error('Invalid OpenCode MCP binding');
}

module.exports = { buildPackage, validatePackage, packageRoot };
