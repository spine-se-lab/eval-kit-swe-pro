'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { resolveSkillAdapter, listSkillAdapters } = require('../adapters/skill-registry.js');
const adapters = listSkillAdapters();
const byId = new Map(adapters.map(adapter => [adapter.id, adapter]));

function normalizeAgent(value) {
  const agent = String(value || '').trim().toLowerCase();
  const normalized = agent === 'open-code' ? 'opencode' : agent;
  if (!byId.has(normalized)) throw new Error(`暂不支持 Skill activation Agent：${value}`);
  return normalized;
}

function detectedAgents(options = {}) {
  return adapters.filter(adapter => adapter.detect(options)).map(adapter => adapter.id);
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copyMatches(targetPath, managedFiles, executableFiles) {
  if (!managedFiles || typeof managedFiles !== 'object' || !Array.isArray(executableFiles)) return false;
  const expectedExecutable = new Set(executableFiles);
  const seen = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return false;
      if (entry.isDirectory()) {
        if (walk(absolute) === false) return false;
      } else {
        const relative = path.relative(targetPath, absolute).split(path.sep).join('/');
        seen.push(relative);
        if (managedFiles[relative] !== hash(absolute)) return false;
        if (Boolean(fs.statSync(absolute).mode & 0o111) !== expectedExecutable.has(relative)) return false;
      }
    }
    return true;
  }
  return walk(targetPath) && seen.length === Object.keys(managedFiles).length;
}

function inspectTarget(target, expectedPackageSkill, previousActivation, requestedMethod, samePackage) {
  try {
    const stat = fs.lstatSync(target.path);
    if (stat.isSymbolicLink()) {
      const actual = path.resolve(path.dirname(target.path), fs.readlinkSync(target.path));
      if (actual === expectedPackageSkill && requestedMethod === 'symlink') {
        return { action: 'noop', kind: 'symlink', actual };
      }
      if (actual === expectedPackageSkill) {
        return { action: 'blocked', reason: '既有 managed activation 的方式与本次请求不同；当前版本不自动迁移', actual };
      }
      if (previousActivation?.path === target.path && previousActivation.method === 'symlink') {
        return { action: 'blocked', reason: '当前版本尚不支持 managed Skill update；请保留现场并使用后续 update 命令', actual };
      }
      return { action: 'blocked', reason: '目标存在未受管理的 symlink', actual };
    }
    if (stat.isDirectory() && previousActivation?.path === target.path && previousActivation.method === 'copy') {
      if (samePackage && requestedMethod === 'copy'
          && copyMatches(target.path, previousActivation.managed_files, previousActivation.executable_files)) {
        return { action: 'noop', kind: 'copy' };
      }
      return { action: 'blocked', reason: requestedMethod === 'copy'
        ? '既有 managed copy 已发生变化或 Package 不同；当前版本尚不支持 update'
        : '既有 managed activation 的方式与本次请求不同；当前版本不自动迁移' };
    }
    return { action: 'blocked', reason: '目标存在未受管理的文件或目录' };
  } catch (error) {
    if (error.code === 'ENOENT') return { action: 'create' };
    throw error;
  }
}

function resolveSkillTargets(agents, scope, skill, expectedPackageSkill, options = {}, previousState, method) {
  if (!['project', 'global'].includes(scope)) throw new Error('Scope 必须是 project 或 global');
  if (!Array.isArray(agents) || !agents.length) throw new Error('至少选择一个 Agent');
  const unique = [...new Set(agents.map(normalizeAgent))];
  const expectedPackageRoot = path.dirname(path.dirname(expectedPackageSkill));
  const samePackage = previousState?.current_package?.root === expectedPackageRoot;
  return unique.map(agent => {
    const root = resolveSkillAdapter(agent).targetRoot(scope, options);
    const target = { agent, scope, root, path: path.join(root, skill) };
    const previous = previousState?.activations?.find(item => item.agent === agent && item.scope === scope);
    return { ...target, observation: inspectTarget(target, expectedPackageSkill, previous, method, samePackage) };
  });
}

function probeSymlink(target) {
  let ancestor = target.root;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const probeRoot = fs.mkdtempSync(path.join(ancestor, '.codehelix-symlink-probe-'));
  try {
    const source = path.join(probeRoot, 'source');
    const link = path.join(probeRoot, 'link');
    fs.mkdirSync(source);
    fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
    return fs.lstatSync(link).isSymbolicLink();
  } catch (error) {
    throw new Error(`目标文件系统不支持 Skill symlink：${target.root}（${error.message}）`);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

function activateTarget(target, packageSkill, method, { temporaryPath, transactionId } = {}) {
  fs.mkdirSync(target.root, { recursive: true });
  if (target.observation.action === 'noop') {
    return { ...target, method: target.observation.kind, changed: false };
  }
  if (target.observation.action !== 'create') throw new Error(`当前版本不自动覆盖既有目标：${target.path}`);
  if (method === 'symlink') {
    const temporary = temporaryPath
      || path.join(target.root, `.${path.basename(target.path)}.codehelix-${process.pid}-${Date.now()}`);
    try {
      fs.symlinkSync(packageSkill, temporary, process.platform === 'win32' ? 'junction' : 'dir');
      fs.renameSync(temporary, target.path);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  } else if (method === 'copy') {
    const temporary = temporaryPath
      || fs.mkdtempSync(path.join(target.root, `.${path.basename(target.path)}.codehelix-`));
    try {
      if (temporaryPath) fs.mkdirSync(temporary);
      if (transactionId) fs.writeFileSync(path.join(temporary, '.codehelix-transaction'), transactionId, { flag: 'wx' });
      fs.cpSync(packageSkill, temporary, { recursive: true, errorOnExist: true, force: false });
      if (transactionId) fs.rmSync(path.join(temporary, '.codehelix-transaction'));
      fs.renameSync(temporary, target.path);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  } else throw new Error('Activation method 必须是 symlink 或 copy');
  return { ...target, method, changed: true };
}

function rollbackActivation(activation) {
  if (activation.changed) fs.rmSync(activation.path, { recursive: true, force: true });
}

module.exports = {
  normalizeAgent, detectedAgents, resolveSkillTargets, probeSymlink, activateTarget, rollbackActivation,
};
