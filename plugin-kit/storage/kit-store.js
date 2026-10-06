'use strict';

// Keep a self-contained installer after the borrowed repository is gone. Kit
// code and its dependency are executable artifacts, not merely a ready marker.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { digestTree, walkFiles } = require('../model/plugin.js');
const { listFiles, sealPackage, removeStaging } = require('./package-store.js');

const SCHEMA = 'codehelix.retained_kit/v1';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const serialized = value => `${JSON.stringify(value, null, 2)}\n`;
const payloadDigest = files => hash(JSON.stringify({ schema: SCHEMA, files }));

function snapshot(kit, dependency) {
  const files = {};
  for (const [prefix, root] of [['plugin-kit', kit], ['node_modules/jsonc-parser', dependency]]) {
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error(`Invalid Kit source: ${root}`);
    for (const relative of walkFiles(root).filter(file => !file.split('/').includes('.pytest_cache')).sort()) {
      const source = path.join(root, relative);
      files[`${prefix}/${relative}`] = { sha256: hash(fs.readFileSync(source)), executable: Boolean(fs.statSync(source).mode & 0o111) };
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

function verify(root, expectedDigest) {
  try {
    if (!/^[a-f0-9]{64}$/.test(expectedDigest) || fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory()) return false;
    const readyText = fs.readFileSync(path.join(root, 'ready.json'), 'utf8');
    const ready = JSON.parse(readyText);
    if (ready.digest !== expectedDigest) return false;
    const actual = listFiles(root).sort();
    if (ready.schema === SCHEMA) {
      const lockText = fs.readFileSync(path.join(root, 'kit-lock.json'), 'utf8');
      const lock = JSON.parse(lockText);
      if (lock.schema !== SCHEMA || !lock.files || typeof lock.files !== 'object' || Array.isArray(lock.files)) return false;
      const files = snapshot(path.join(root, 'plugin-kit'), path.join(root, 'node_modules/jsonc-parser'));
      if (JSON.stringify(actual) !== JSON.stringify([...Object.keys(files), 'ready.json', 'kit-lock.json'].sort())) return false;
      if (JSON.stringify(lock.files) !== JSON.stringify(files) || payloadDigest(files) !== expectedDigest) return false;
      return readyText === serialized({ schema: SCHEMA, digest: expectedDigest })
        && lockText === serialized({ schema: SCHEMA, files });
    }
    // Pre-lock retained Kits used hash(JSON({kit: digestTree, dependency:
    // digestTree})) as the directory name. Verify that identity, not the marker.
    if (JSON.stringify(ready) !== JSON.stringify({ digest: expectedDigest })) return false;
    if (actual.some(file => file !== 'ready.json' && !file.startsWith('plugin-kit/') && !file.startsWith('node_modules/jsonc-parser/'))) return false;
    // digestTree historically excludes these files; they must not bypass an
    // integrity check when inspecting a retained executable artifact.
    if (actual.some(file => file.split('/').some(part => part === '__pycache__' || part === '.DS_Store' || part.endsWith('.pyc')))) return false;
    return hash(JSON.stringify({ kit: digestTree(path.join(root, 'plugin-kit')),
      dependency: digestTree(path.join(root, 'node_modules/jsonc-parser')) })) === expectedDigest;
  } catch { return false; }
}

function verifyRetainedKit(root) { return verify(root, path.basename(root)); }

function retainKit(home) {
  const kit = path.resolve(__dirname, '..');
  const dependency = path.dirname(require.resolve('jsonc-parser/package.json'));
  const files = snapshot(kit, dependency);
  const digest = payloadDigest(files);
  const family = path.join(home, 'package-store/codehelix-installer');
  const destination = path.join(family, digest);
  const legacyDigest = hash(JSON.stringify({ kit: digestTree(kit), dependency: digestTree(dependency) }));
  const legacy = path.join(family, legacyDigest);
  for (const existing of [destination, legacy]) {
    if (!fs.existsSync(existing)) continue;
    if (!verifyRetainedKit(existing)) throw new Error(`Retained Kit integrity failure: ${existing}`);
    sealPackage(existing);
    return existing;
  }
  fs.mkdirSync(family, { recursive: true });
  const staging = fs.mkdtempSync(path.join(family, '.staging-'));
  try {
    for (const [relative, entry] of Object.entries(files)) {
      const source = relative.startsWith('plugin-kit/') ? path.join(kit, relative.slice('plugin-kit/'.length))
        : path.join(dependency, relative.slice('node_modules/jsonc-parser/'.length));
      const target = path.join(staging, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, entry.executable ? 0o555 : 0o444);
    }
    fs.writeFileSync(path.join(staging, 'kit-lock.json'), serialized({ schema: SCHEMA, files }), { mode: 0o444 });
    fs.writeFileSync(path.join(staging, 'ready.json'), serialized({ schema: SCHEMA, digest }), { mode: 0o444 });
    if (!verify(staging, digest)) throw new Error('Kit source changed while retaining installer');
    sealPackage(staging);
    fs.chmodSync(staging, 0o700); // macOS needs a writable root for this rename.
    try { fs.renameSync(staging, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !verifyRetainedKit(destination)) throw error;
    }
    sealPackage(destination);
    return destination;
  } finally { removeStaging(staging, family); }
}

module.exports = { retainKit, verifyRetainedKit };
