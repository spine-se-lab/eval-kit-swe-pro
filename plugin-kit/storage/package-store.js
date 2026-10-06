'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function writeJson(file, value, mode = 0o644) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
}

function packageRoot(home, candidate) {
  return path.join(home, 'package-store', candidate.name, candidate.digest);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listFiles(root, current = root, files = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Installed Package 不允许符号链接：${absolute}`);
    if (entry.isDirectory()) listFiles(root, absolute, files);
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`Installed Package 只允许普通文件：${absolute}`);
  }
  return files;
}

function sealPackage(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error(`Installed Package 只允许普通文件和目录：${root}`);
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) sealPackage(path.join(root, entry));
    // File permissions alone do not prevent imports/build tools creating __pycache__.
    fs.chmodSync(root, 0o555);
  } else fs.chmodSync(root, stat.mode & 0o111 ? 0o555 : 0o444);
}

function removeStaging(root, store) {
  if (path.dirname(root) !== store || !path.basename(root).startsWith('.staging-')) {
    throw new Error(`Refusing to clean a path outside PackageStore staging: ${root}`);
  }
  function writable(current) {
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) return; // Never chmod a link target, including borrowed Source.
    fs.chmodSync(current, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) for (const entry of fs.readdirSync(current)) writable(path.join(current, entry));
  }
  writable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function expectedLock(candidate) {
  return Object.fromEntries(candidate.files
    .map(file => [`skills/${candidate.name}/${file.relative}`, file.sha256])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function verifyPackage(root, candidate, { allowTransactionMarker = false } = {}) {
  try {
    if (!fs.lstatSync(root).isDirectory()) return false;
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'codehelix-plugin.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'delivery-lock.json'), 'utf8'));
    if (manifest.schema !== 'codehelix.skill_package/v1'
        || manifest.plugin.id !== candidate.name
        || manifest.delivery_digest !== `sha256:${candidate.digest}`
        || lock.schema !== 'codehelix.delivery_lock/v1') return false;
    const expectedSkillFiles = expectedLock(candidate);
    for (const [relative, fileDigest] of Object.entries(expectedSkillFiles)) {
      if (lock.files[relative] !== fileDigest) return false;
      const source = candidate.files.find(file => `skills/${candidate.name}/${file.relative}` === relative);
      const installedExecutable = Boolean(fs.statSync(path.join(root, relative)).mode & 0o111);
      if (!source || installedExecutable !== source.executable) return false;
    }
    const actual = listFiles(root)
      .filter(relative => relative !== 'delivery-lock.json'
        && !(allowTransactionMarker && relative === '.codehelix-transaction')).sort();
    const locked = Object.keys(lock.files).sort();
    if (JSON.stringify(actual) !== JSON.stringify(locked)) return false;
    return locked.every(relative => sha256(path.join(root, relative)) === lock.files[relative]);
  } catch {
    return false;
  }
}

function materializeSkill(home, candidate, source) {
  const store = path.join(home, 'package-store');
  const finalRoot = packageRoot(home, candidate);
  fs.mkdirSync(path.dirname(finalRoot), { recursive: true });
  if (fs.existsSync(finalRoot)) {
    if (!verifyPackage(finalRoot, candidate)) throw new Error(`PackageStore 中的同摘要 Package 已损坏：${finalRoot}`);
    sealPackage(finalRoot);
    return { pluginId: candidate.name, deliveryDigest: `sha256:${candidate.digest}`, root: finalRoot, reused: true };
  }
  fs.mkdirSync(store, { recursive: true });
  const staging = source.stagingRoot || fs.mkdtempSync(path.join(store, '.staging-'));
  try {
    if (source.stagingRoot) {
      fs.mkdirSync(staging);
      fs.writeFileSync(path.join(staging, '.codehelix-transaction'), source.transactionId, { flag: 'wx' });
    }
    const skillRoot = path.join(staging, 'skills', candidate.name);
    fs.mkdirSync(skillRoot, { recursive: true });
    for (const file of candidate.files) {
      const destination = path.join(skillRoot, ...file.relative.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file.absolute, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, file.executable ? 0o555 : 0o444);
    }
    writeJson(path.join(staging, 'codehelix-plugin.json'), {
      schema: 'codehelix.skill_package/v1',
      plugin: { id: candidate.name, name: candidate.name, version: source.displayVersion },
      delivery_digest: `sha256:${candidate.digest}`,
      content: { skills: [`skills/${candidate.name}`] },
      source: source.provenance,
    });
    const lockFiles = Object.fromEntries(listFiles(staging)
      .filter(relative => relative !== '.codehelix-transaction').sort().map(relative => [
      relative, sha256(path.join(staging, relative)),
    ]));
    writeJson(path.join(staging, 'delivery-lock.json'), {
      schema: 'codehelix.delivery_lock/v1',
      files: lockFiles,
    });
    fs.chmodSync(path.join(staging, 'codehelix-plugin.json'), 0o444);
    fs.chmodSync(path.join(staging, 'delivery-lock.json'), 0o444);
    if (!verifyPackage(staging, candidate, { allowTransactionMarker: true })) throw new Error('Package materialize 后校验失败');
    fs.rmSync(path.join(staging, '.codehelix-transaction'), { force: true });
    sealPackage(staging);
    // macOS needs write permission on a directory when rename changes its parent.
    // Keep only the private staging root writable, then seal the published root.
    fs.chmodSync(staging, 0o700);
    try {
      fs.renameSync(staging, finalRoot);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !verifyPackage(finalRoot, candidate)) throw error;
    }
    if (!verifyPackage(finalRoot, candidate)) throw new Error('Package materialize 后校验失败');
    sealPackage(finalRoot);
    return { pluginId: candidate.name, deliveryDigest: `sha256:${candidate.digest}`, root: finalRoot, reused: false };
  } finally {
    removeStaging(staging, store);
  }
}

function deliveryCandidate(root) {
  root = fs.realpathSync(root);
  const { validateDeliveryLock, digestTree, walkFiles } = require('../model/plugin.js');
  validateDeliveryLock(root, root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'codehelix-plugin.json'), 'utf8'));
  if (!['codehelix.plugin_package/v1', 'codehelix.native_package/v1'].includes(manifest.schema)
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.plugin?.id || '')) {
    throw new Error('Unsupported or invalid Plugin Delivery manifest');
  }
  if (manifest.execution?.mode === 'native') require('../model/native.js').validateDelivery(root, manifest);
  // npm dependencies are local launcher tooling, not immutable Delivery payload.
  const files = walkFiles(root, root, false, ['node_modules']);
  const modes = Object.fromEntries(files.sort().map(file => [file, Boolean(fs.statSync(path.join(root, file)).mode & 0o111)]));
  const digest = crypto.createHash('sha256').update(digestTree(root, { ignoreNpmDependencies: true })).update(JSON.stringify(modes)).digest('hex');
  return { root, name: manifest.plugin.id, manifest, digest, files, modes };
}

function verifyDeliveryPackage(root, expectedDigest) {
  try {
    if (!fs.lstatSync(root).isDirectory()) return false;
    const candidate = deliveryCandidate(root);
    // Build exclusions may be present in a Source checkout, never in Installed Package.
    if (JSON.stringify(listFiles(root).sort()) !== JSON.stringify([...candidate.files].sort())) return false;
    return candidate.digest === expectedDigest.replace(/^sha256:/, '');
  }
  catch { return false; }
}

function materializeDelivery(home, candidate) {
  const destination = packageRoot(home, candidate);
  const reference = { plugin_id: candidate.name, version: candidate.manifest.plugin.version,
    delivery_digest: `sha256:${candidate.digest}`, root: destination };
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    if (!verifyDeliveryPackage(destination, candidate.digest)) throw new Error(`Installed Package integrity failure: ${destination}`);
    sealPackage(destination);
    return { ...reference, reused: true };
  }
  const staging = fs.mkdtempSync(path.join(home, 'package-store', '.staging-'));
  try {
    for (const file of candidate.files) {
      const target = path.join(staging, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(candidate.root, file), target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, candidate.modes[file] ? 0o555 : 0o444);
    }
    if (!verifyDeliveryPackage(staging, candidate.digest)) throw new Error('Delivery changed while materializing PackageStore');
    sealPackage(staging);
    fs.chmodSync(staging, 0o700);
    try { fs.renameSync(staging, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !verifyDeliveryPackage(destination, candidate.digest)) throw error;
    }
    sealPackage(destination);
    return { ...reference, reused: false };
  } finally { removeStaging(staging, path.join(home, 'package-store')); }
}

module.exports = { packageRoot, materializeSkill, verifyPackage, deliveryCandidate, materializeDelivery, verifyDeliveryPackage,
  listFiles, sealPackage, removeStaging };
