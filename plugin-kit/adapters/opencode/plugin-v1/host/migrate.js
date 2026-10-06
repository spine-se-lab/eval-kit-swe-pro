'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { rejectSymlinks, readText } = require('../../../../files/config.js');
const { walkFiles } = require('../../../../model/plugin.js');

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function planMigration(context, config) {
  const root = context.target.config_root;
  const id = context.manifest.plugin.id;
  const recordPath = path.join(root, 'codehelix', id, 'codehelix-install.json');
  const recordText = readText(recordPath);
  const record = recordText ? JSON.parse(recordText) : null;
  if (record && (record.plugin !== id || record.coding_agent !== 'opencode')) throw new Error('Legacy installation record has a different owner');
  const legacyFile = path.join(context.delivery, 'legacy-opencode.json');
  const legacy = fs.existsSync(legacyFile) ? JSON.parse(fs.readFileSync(legacyFile, 'utf8')) : { skills: {} };
  const names = fs.readdirSync(path.join(context.delivery, 'package/skills'));
  const skillRoots = [{ path: path.join(root, 'skills'), legacyOwned: true }];
  if (path.basename(root) === 'opencode' && path.basename(path.dirname(root)) === '.config') {
    const home = path.dirname(path.dirname(root));
    skillRoots.push({ path: path.join(home, '.claude/skills'), legacyOwned: true },
      { path: path.join(home, '.agents/skills'), legacyOwned: false });
  }
  const files = [];
  const directories = [];
  for (const skills of skillRoots) for (const name of names) {
    const directory = path.join(skills.path, name);
    rejectSymlinks(directory);
    if (!fs.existsSync(directory)) continue;
    if (!record) throw new Error(`Legacy Skill ownership is unknown: ${directory}`);
    if (!fs.statSync(directory).isDirectory()) throw new Error(`Conflicting Skill path: ${directory}`);
    for (const relative of walkFiles(directory)) {
      const file = path.join(directory, relative);
      const current = hash(file);
      const expected = record?.managed_files?.[file]
        || (record && !record.managed_files && skills.legacyOwned ? legacy.skills[`${name}/${relative}`] : null);
      if (!expected || expected !== current) throw new Error(`Legacy Skill ownership is unknown or contents changed: ${file}`);
      files.push({ file, digest: current });
    }
    directories.push(directory);
  }
  const mcp = { ...(config.value.mcp || {}) };
  if (legacy.mcp && Object.hasOwn(mcp, legacy.mcp.name)) {
    const value = mcp[legacy.mcp.name];
    const command = path.join(root, 'codehelix', id, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', legacy.mcp.console_script + (process.platform === 'win32' ? '.exe' : ''));
    const expectedWorkspace = record?.workbench_workspace || '';
    const env = value.environment || {};
    if (!record || value.type !== 'local' || !isDeepStrictEqual(value.command, [command]) || value.enabled !== true
        || (env[legacy.mcp.workspace_env] || '') !== expectedWorkspace
        || Object.keys(value).some(k => !['type', 'command', 'enabled', 'environment'].includes(k))
        || Object.keys(env).some(k => ![legacy.mcp.workspace_env, 'CODEHELIX_GUIDANCE_EVENTS'].includes(k))) {
      throw new Error(`Legacy MCP ownership is unknown or configuration changed: ${legacy.mcp.name}`);
    }
    delete mcp[legacy.mcp.name];
  }
  // A directly configured server with the new native name would also shadow the
  // packaged binding. Its presence is not authority to remove user settings.
  for (const server of context.manifest.content.mcp || []) {
    if (Object.hasOwn(mcp, server.name)) throw new Error(`MCP name conflicts with user configuration: ${server.name}`);
  }
  return { files, directories, mcp, recordPath, recordText };
}

function applyMigration(plan, changes) {
  if (readText(plan.recordPath) !== plan.recordText) throw new Error('Legacy ownership record changed after preflight');
  for (const item of plan.files) {
    rejectSymlinks(item.file);
    if (hash(item.file) !== item.digest) throw new Error(`Legacy file changed after preflight: ${item.file}`);
  }
  for (const { file } of plan.files) {
    fs.unlinkSync(file);
    changes.push({ kind: 'legacy_skill', path: file, action: 'removed' });
  }
  for (const directory of plan.directories) {
    // Only remove empty directories; never recursively erase an unlisted file.
    const children = [];
    function visit(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) visit(path.join(dir, entry.name));
      children.push(dir);
    }
    visit(directory);
    for (const dir of children) {
      try { fs.rmdirSync(dir); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
    }
  }
}

module.exports = { planMigration, applyMigration };
