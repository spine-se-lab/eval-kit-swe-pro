'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeChild } = require('../model/plugin.js');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function exists(file) { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

// Record the symlink itself; never traverse a target the installer does not own.
function snapshot(file, contents = false, jsonPaths = null) {
  if (jsonPaths) return require('./jsonc-fields.js').snapshot(file, jsonPaths);
  if (!exists(file)) return { type: 'missing' };
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return { type: 'symlink', link: fs.readlinkSync(file) };
  if (stat.isFile()) {
    const bytes = fs.readFileSync(file);
    return { type: 'file', mode: stat.mode & 0o777, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      ...(contents ? { bytes: bytes.toString('base64') } : {}) };
  }
  if (!stat.isDirectory()) throw new Error(`Unsupported activation filesystem object: ${file}`);
  return { type: 'directory', entries: Object.fromEntries(fs.readdirSync(file).sort().map(name => [name, snapshot(path.join(file, name), contents)])) };
}

function observation(saved) {
  if (saved.type === 'file') { const { bytes, ...value } = saved; return value; }
  if (saved.type === 'directory') return { ...saved, entries: Object.fromEntries(Object.entries(saved.entries).map(([name, value]) => [name, observation(value)])) };
  return saved;
}

function same(left, right) { return digest(observation(left)) === digest(observation(right)); }

function restore(file, saved) {
  if (saved.type === 'jsonc') return require('./jsonc-fields.js').restore(file, saved);
  if (saved.type === 'file' && typeof saved.bytes !== 'string') {
    throw new Error(`Recovery needs host reconciliation; original sensitive configuration was not persisted: ${file}`);
  }
  if (exists(file)) fs.rmSync(file, { recursive: true, force: true });
  if (saved.type === 'missing') return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (saved.type === 'symlink') fs.symlinkSync(saved.link, file, process.platform === 'win32' ? 'junction' : undefined);
  else if (saved.type === 'file') fs.writeFileSync(file, Buffer.from(saved.bytes, 'base64'), { mode: saved.mode });
  else {
    fs.mkdirSync(file);
    for (const [name, item] of Object.entries(saved.entries)) restore(safeChild(file, name, 'Backup entry'), item);
  }
}

function assertSafeParent(file) {
  for (let current = path.dirname(file); ; current = path.dirname(current)) {
    if (exists(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Activation parent is a symlink: ${current}`);
    if (path.dirname(current) === current) break;
  }
}

function targets(manifest, target, skills, delivery) {
  const extra = manifest.managed_install?.target_paths_file;
  const contributed = extra ? JSON.parse(fs.readFileSync(safeChild(delivery, extra, 'Activation manifest'), 'utf8')) : [];
  if (!Array.isArray(contributed)) throw new Error('Activation manifest must contain an array of exact target paths');
  const declared = [...(manifest.managed_install?.target_paths || []), ...contributed].map(item => {
    if (!['config', 'target'].includes(item.root)) throw new Error('target_paths.root must be config or target');
    if (item.json_paths) require('./jsonc-fields.js').validatePaths(item.json_paths);
    return { path: safeChild(item.root === 'config' ? target.config_root : target.root, item.path, 'Activation path'), kind: item.kind || 'file', method: 'custom',
      ...(item.json_paths ? { json_paths: item.json_paths } : {}) };
  });
  if (manifest.execution?.mode === 'native') {
    if (target.agent_system === 'opencode') {
      for (const name of ['opencode.json', 'opencode.jsonc']) declared.push({ path: path.join(target.config_root, name), kind: 'native_plugin', method: 'config' });
    } else if (target.agent_system === 'codex') {
      for (const name of ['config.toml', `codehelix/${manifest.plugin.id}.json`]) declared.push({ path: path.join(target.config_root, name), kind: 'native_plugin', method: 'native' });
    }
  }
  const all = [...skills.map(item => ({ ...item, kind: 'skill' })), ...declared];
  const unique = [...new Map(all.map(item => [item.path, item])).values()];
  for (const item of unique) assertSafeParent(item.path);
  return unique.filter(item => !unique.some(parent => parent !== item && item.path.startsWith(`${parent.path}${path.sep}`)));
}

function contentMatches(destination, source) {
  const stripMode = value => value.type === 'file' ? { type: value.type, sha256: value.sha256 }
    : value.type === 'directory' ? { type: value.type, entries: Object.fromEntries(Object.entries(value.entries).map(([k, v]) => [k, stripMode(v)])) } : value;
  return digest(stripMode(snapshot(destination))) === digest(stripMode(snapshot(source)));
}

function projectSkill(skill) {
  assertSafeParent(skill.path);
  if (exists(skill.path)) {
    if (skill.method === 'symlink' && fs.lstatSync(skill.path).isSymbolicLink()
        && path.resolve(path.dirname(skill.path), fs.readlinkSync(skill.path)) === skill.source) return;
    fs.rmSync(skill.path, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(skill.path), { recursive: true });
  if (skill.method === 'symlink') fs.symlinkSync(skill.source, skill.path, process.platform === 'win32' ? 'junction' : 'dir');
  else {
    fs.cpSync(skill.source, skill.path, { recursive: true, dereference: false });
    // Copy is an independent editable projection, not a second immutable Store.
    const makeWritable = file => {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return;
      fs.chmodSync(file, stat.isDirectory() || stat.mode & 0o111 ? 0o755 : 0o644);
      if (stat.isDirectory()) for (const name of fs.readdirSync(file)) makeWritable(path.join(file, name));
    };
    makeWritable(skill.path);
  }
}

module.exports = { digest, exists, snapshot, observation, same, restore, assertSafeParent, targets, contentMatches, projectSkill };
