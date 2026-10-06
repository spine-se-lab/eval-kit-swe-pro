'use strict';

const fs = require('node:fs');
const path = require('node:path');
const model = require('../model/plugin.js');
const native = require('../model/native.js');
const { getAdapter } = require('../adapters/registry.js');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyTree(source, destination) {
  // Enumerate first, so symlinks and non-contained source trees fail before copying.
  const files = model.walkFiles(source);
  for (const relative of files) {
    const dest = path.join(destination, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(source, relative), dest);
  }
}

function buildNative(pluginRoot) {
  const descriptor = model.loadDescriptor(pluginRoot);
  const targets = descriptor.targets.map(relative => model.loadTarget(pluginRoot, relative))
    .filter(target => target.execution?.mode === 'native');
  if (!targets.length) return;
  const content = native.validateContent(pluginRoot, descriptor);
  const sourceDigest = model.digestTree(path.join(pluginRoot, 'source'));
  for (const target of targets) {
    const adapter = getAdapter(target.execution.adapter);
    const manifest = native.compiledManifest(descriptor, target);
    const destination = path.join(pluginRoot, 'delivery', target.profile);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const staged = fs.mkdtempSync(path.join(path.dirname(destination), '.native-build-'));
    try {
      adapter.buildPackage({ delivery: staged, manifest, writeJson, copyContent(root) {
        copyTree(model.safeChild(pluginRoot, content.skills, 'skills'), path.join(root, 'skills'));
        const servers = (content.mcp || []).map(server => structuredClone(server));
        if (servers.length) {
          for (const server of servers) {
            fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
            server.wheel = require('./runtimes/python-package.js').buildPythonPackage(
              model.safeChild(pluginRoot, server.runtime.source, 'runtime'), path.join(root, 'runtime', server.name), copyTree);
          }
          fs.copyFileSync(path.join(__dirname, 'runtimes/python-launch.cjs'), path.join(root, 'runtime/launch.cjs'));
          fs.copyFileSync(path.join(__dirname, '../process/environment.js'), path.join(root, 'runtime/environment.cjs'));
          writeJson(path.join(root, 'runtime/servers.json'), servers);
        }
        return servers;
      } });
      if (content.legacy_opencode) {
        const legacyFile = model.safeChild(pluginRoot, content.legacy_opencode, 'legacy_opencode');
        writeJson(path.join(staged, 'legacy-opencode.json'), JSON.parse(fs.readFileSync(legacyFile, 'utf8')));
      }
      writeJson(path.join(staged, 'codehelix-plugin.json'), manifest);
      writeJson(path.join(staged, 'source-lock.json'), {
        schema: 'codehelix.source_lock/v1', source_tree_sha256: sourceDigest,
        adapter: adapter.id,
        adapter_tree_sha256: model.digestTree(path.join(__dirname, '..', 'adapters', adapter.id)),
        builder_tree_sha256: model.digestTree(__dirname),
        kit_tree_sha256: model.digestTree(path.join(__dirname, '..')),
      });
      writeJson(path.join(staged, 'delivery-lock.json'), {
        schema: 'codehelix.delivery_lock/v1', files: Object.fromEntries(model.walkFiles(staged).sort().map(f => [f, model.sha256(path.join(staged, f))])),
      });
      native.validateDelivery(staged, manifest);
      if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error('Delivery cannot be a symlink');
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(staged, destination);
    } finally {
      fs.rmSync(staged, { recursive: true, force: true });
    }
  }
}

module.exports = { buildNative };
