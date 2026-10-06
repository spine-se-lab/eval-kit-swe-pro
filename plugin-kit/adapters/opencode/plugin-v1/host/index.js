'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { readConfig, writeConfig } = require('./config.js');
const { packageRoot } = require('../package.js');
const { planMigration, applyMigration } = require('./migrate.js');
const { rejectSymlinks } = require('../../../../files/config.js');

function specifier(entry) { return Array.isArray(entry) ? entry[0] : entry; }
function packageIdentity(entry) {
  const spec = specifier(entry);
  if (typeof spec !== 'string' || !spec.startsWith('file://')) return null;
  try {
    const target = fileURLToPath(spec);
    const root = fs.statSync(target).isDirectory() ? target : path.dirname(target);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return { name: pkg.name, version: pkg.version, root };
  } catch { return null; }
}

function matching(config, manifest) {
  const name = `@codehelix/${manifest.plugin.id}`;
  return (config.value.plugin || []).filter(entry => packageIdentity(entry)?.name === name
    || specifier(entry) === name || String(specifier(entry)).startsWith(`${name}@`));
}

function inspect(context) {
  const config = readConfig(context.target.config_root);
  const entries = matching(config, context.manifest);
  if (entries.length > 1) throw new Error('Multiple registrations exist for the same native plugin');
  return { registered: entries.length === 1, enabled: entries.length === 1,
    version: entries.length ? packageIdentity(entries[0])?.version || null : null, loaded: null,
    registration_digest: require('node:crypto').createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}

function install(context, changes) {
  const config = readConfig(context.target.config_root);
  const migration = planMigration(context, config);
  const old = matching(config, context.manifest);
  if (old.length > 1) throw new Error('Multiple registrations exist for the same native plugin');
  const entry = [pathToFileURL(path.join(packageRoot(context.delivery), 'plugin.js')).href, context.configuration];
  const plugins = (config.value.plugin || []).filter(item => !old.includes(item));
  plugins.push(entry);
  writeConfig(config, { plugin: plugins, ...(config.value.mcp ? { mcp: migration.mcp } : {}) }, changes);
  applyMigration(migration, changes);
}

function preflight(context) { capture(context); }

function remove(context, changes) {
  const config = readConfig(context.target.config_root);
  const old = matching(config, context.manifest);
  writeConfig(config, { plugin: (config.value.plugin || []).filter(item => !old.includes(item)) }, changes);
}

function secretReference(value) {
  return typeof value === 'string' && /^(?:\$\{[A-Z_][A-Z0-9_]*\}|\{env:[A-Z_][A-Z0-9_]*\})$/.test(value);
}

function assertNoSecrets(value, key = '') {
  if (/token|secret|password|api[_-]?key|authorization/i.test(key) && value !== null && value !== '' && !secretReference(value)) {
    throw new Error('Native rollback snapshot contains a credential; replace it with an environment reference before installation');
  }
  if (typeof value === 'string' && /https?:\/\/[^\s/:@]+:[^\s/@]+@/i.test(value)) throw new Error('Native rollback snapshot contains a credential-bearing URL');
  if (Array.isArray(value)) value.forEach(item => assertNoSecrets(item));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([name, item]) => assertNoSecrets(item, name));
}

function capture(context) {
  const config = readConfig(context.target.config_root);
  const migration = planMigration(context, config);
  const own = matching(config, context.manifest);
  if (own.length > 1) throw new Error('Multiple registrations exist for the same native plugin');
  const entries = (config.value.plugin || []).flatMap((entry, index) => own.includes(entry) ? [{ index, entry: structuredClone(entry) }] : []);
  const mcp = Object.fromEntries(Object.entries(config.value.mcp || {}).filter(([key]) => !Object.hasOwn(migration.mcp, key)));
  assertNoSecrets(entries);
  assertNoSecrets(mcp);
  const files = migration.files.map(item => {
    const bytes = fs.readFileSync(item.file);
    if (/^\s*[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z_]*\s*=\s*["']?[^\s$"']/m.test(bytes.toString('utf8'))) {
      throw new Error('Legacy Skill contains a credential assignment; cannot persist a rollback snapshot');
    }
    return { path: item.file, digest: item.digest, mode: fs.statSync(item.file).mode & 0o777, bytes: bytes.toString('base64') };
  });
  return { schema: 'codehelix.native_host_snapshot/v1', adapter: 'opencode/plugin-v1', persistable: true,
    plugin_id: context.manifest.plugin.id, config_root: context.target.config_root, config_file: config.file,
    plugin_field_present: Object.hasOwn(config.value, 'plugin'), entries, mcp, files };
}

function legacyFileAllowed(context, file) {
  const configRoot = context.target.config_root;
  const roots = [path.join(configRoot, 'skills')];
  if (path.basename(configRoot) === 'opencode' && path.basename(path.dirname(configRoot)) === '.config') {
    const home = path.dirname(path.dirname(configRoot));
    roots.push(path.join(home, '.claude/skills'), path.join(home, '.agents/skills'));
  }
  const skills = fs.readdirSync(path.join(context.delivery, 'package/skills'));
  return roots.some(root => skills.some(skill => {
    const relative = path.relative(path.join(root, skill), file);
    return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
  }));
}

function restore(context, snapshot, changes = []) {
  if (snapshot?.schema !== 'codehelix.native_host_snapshot/v1' || snapshot.adapter !== 'opencode/plugin-v1'
      || snapshot.plugin_id !== context.manifest.plugin.id || snapshot.config_root !== context.target.config_root || snapshot.persistable !== true) {
    throw new Error('Native recovery snapshot does not match this OpenCode plugin target');
  }
  assertNoSecrets(snapshot.entries);
  assertNoSecrets(snapshot.mcp);
  const config = readConfig(context.target.config_root);
  if (config.file !== snapshot.config_file) throw new Error('OpenCode configuration scope changed before rollback');
  const knownSpecifiers = new Set(snapshot.entries.map(item => specifier(item.entry)));
  knownSpecifiers.add(pathToFileURL(path.join(packageRoot(context.delivery), 'plugin.js')).href);
  const own = matching(config, context.manifest);
  const plugins = (config.value.plugin || []).filter(entry => !own.includes(entry) && !knownSpecifiers.has(specifier(entry)));
  for (const saved of [...snapshot.entries].sort((a, b) => a.index - b.index)) plugins.splice(Math.min(saved.index, plugins.length), 0, saved.entry);
  const mcp = { ...(config.value.mcp || {}) };
  for (const [key, value] of Object.entries(snapshot.mcp)) {
    if (Object.hasOwn(mcp, key) && !isDeepStrictEqual(mcp[key], value)) throw new Error(`Legacy MCP changed during installation; refusing rollback: ${key}`);
    mcp[key] = value;
  }
  // Verify every exact legacy target before restoring any bytes. Never overwrite
  // a user's new file just because the previous installer owned that pathname.
  for (const item of snapshot.files) {
    if (!legacyFileAllowed(context, item.path)) throw new Error('Native recovery snapshot contains an unrelated legacy path');
    rejectSymlinks(item.path);
    const bytes = Buffer.from(item.bytes, 'base64');
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.digest) throw new Error('Native recovery file digest mismatch');
    if (fs.existsSync(item.path) && crypto.createHash('sha256').update(fs.readFileSync(item.path)).digest('hex') !== item.digest) {
      throw new Error(`Legacy Skill changed during installation; refusing rollback: ${item.path}`);
    }
  }
  writeConfig(config, { plugin: !snapshot.plugin_field_present && !plugins.length ? undefined : plugins,
    ...(Object.keys(snapshot.mcp).length ? { mcp } : {}) }, changes);
  for (const item of snapshot.files) {
    if (fs.existsSync(item.path)) continue;
    fs.mkdirSync(path.dirname(item.path), { recursive: true });
    fs.writeFileSync(item.path, Buffer.from(item.bytes, 'base64'), { mode: item.mode, flag: 'wx' });
    changes.push({ kind: 'legacy_skill', path: item.path, action: 'rollback-restored' });
  }
  const after = readConfig(context.target.config_root);
  const restored = (after.value.plugin || []).filter(entry => matching(after, context.manifest).includes(entry)
    || knownSpecifiers.has(specifier(entry)));
  if (!isDeepStrictEqual(restored, snapshot.entries.map(item => item.entry))
      || Object.entries(snapshot.mcp).some(([key, value]) => !isDeepStrictEqual(after.value.mcp?.[key], value))) {
    throw new Error('OpenCode native rollback verification failed');
  }
  return inspect(context);
}

module.exports = { inspect, install, remove, preflight, capture, restore };
