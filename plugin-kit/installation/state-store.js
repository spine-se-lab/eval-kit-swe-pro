'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function statePath(home, pluginId) {
  return path.join(home, 'state', `${pluginId}.json`);
}

function durableWrite(file, contents, { mode = 0o600, exclusive = false } = {}) {
  const descriptor = fs.openSync(file, exclusive ? 'wx' : 'w', mode);
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicWrite(file, contents) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let renamed = false;
  try {
    durableWrite(temporary, contents, { exclusive: true });
    fs.renameSync(temporary, file);
    renamed = true;
  } finally {
    // Once rename commits the new state, cleanup errors must not tell callers
    // to roll back activation files against an already-committed record.
    try { fs.rmSync(temporary, { force: true }); }
    catch (error) { if (!renamed) throw error; }
  }
}

function readPluginState(home, pluginId) {
  try { return JSON.parse(fs.readFileSync(statePath(home, pluginId), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') {
      const legacy = path.join(home, 'plugins', 'state', `${pluginId}.json`);
      if (fs.existsSync(legacy)) return JSON.parse(fs.readFileSync(legacy, 'utf8'));
      return null;
    }
    throw new Error(`无法读取 PluginState：${error.message}`);
  }
}

function beginTransaction(home, plan) {
  const root = path.join(home, 'state', '.transactions');
  fs.mkdirSync(root, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(root, `${id}.json`);
  const packageStagingRoot = path.join(home, 'package-store', `.staging-${id}`);
  durableWrite(file, `${JSON.stringify({
    schema: 'codehelix.install_transaction/v1', id, status: 'pending', plan_digest: plan.planDigest,
    plugin_id: plan.skill, created_at: new Date().toISOString(),
    package_skill_root: plan.package.skill_root,
    package_staging_root: packageStagingRoot,
    managed_files: Object.fromEntries(plan._internals.candidate.files.map(file => [file.relative, file.sha256])),
    executable_files: plan._internals.candidate.files.filter(file => file.executable).map(file => file.relative),
    activations: plan.targets.map(target => ({
      path: target.path, agent: target.agent, scope: target.scope, method: plan.method,
      status: target.observation.action === 'noop' ? 'existing' : 'planned',
      changed: target.observation.action === 'noop' ? false : null,
    })),
  }, null, 2)}\n`, { exclusive: true });
  return { id, file, packageStagingRoot };
}

function updateActivation(transaction, activationPath, update) {
  const journal = JSON.parse(fs.readFileSync(transaction.file, 'utf8'));
  const item = journal.activations.find(candidate => candidate.path === activationPath);
  if (!item) throw new Error(`Transaction journal 缺少 activation intent：${activationPath}`);
  Object.assign(item, update);
  atomicWrite(transaction.file, `${JSON.stringify(journal, null, 2)}\n`);
}

function markActivationApplying(transaction, target) {
  const temporaryPath = path.join(target.root, `.${path.basename(target.path)}.codehelix-${transaction.id}`);
  updateActivation(transaction, target.path, { status: 'applying', temporary_path: temporaryPath });
  return temporaryPath;
}

function recordActivation(transaction, activation) {
  updateActivation(transaction, activation.path, { status: 'complete', changed: activation.changed });
}

function commitPluginState(home, pluginId, state) {
  const file = statePath(home, pluginId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

function finishTransaction(transaction) {
  fs.rmSync(transaction.file, { force: true });
}

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function activationMatchesJournal(activationPath, item, journal, { temporary = false } = {}) {
  let stat;
  try { stat = fs.lstatSync(activationPath); } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  if (item.method === 'symlink') {
    return stat.isSymbolicLink()
      && path.resolve(path.dirname(activationPath), fs.readlinkSync(activationPath)) === journal.package_skill_root;
  }
  if (!stat.isDirectory()) return false;
  const marker = path.join(activationPath, '.codehelix-transaction');
  if (temporary && fs.existsSync(marker)
      && fs.readFileSync(marker, 'utf8') === journal.id) return true;
  const expected = journal.managed_files || {};
  const expectedExecutable = new Set(journal.executable_files || []);
  const seen = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return false;
      if (entry.isDirectory()) {
        if (walk(absolute) === false) return false;
      } else {
        const relative = path.relative(activationPath, absolute).split(path.sep).join('/');
        seen.push(relative);
        if (expected[relative] !== fileHash(absolute)) return false;
        if (Boolean(fs.statSync(absolute).mode & 0o111) !== expectedExecutable.has(relative)) return false;
      }
    }
    return true;
  }
  return walk(activationPath) && seen.length === Object.keys(expected).length;
}

function operationMayBeActive(home, pluginId) {
  if (typeof pluginId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginId)) return true;
  for (const root of [path.join(home, 'state', '.transactions'), path.join(home, 'plugins', 'state', '.transactions')]) {
    const lock = path.join(root, `${pluginId}.lock`);
    try {
      if (!fs.lstatSync(lock).isFile()) return true;
      const pid = JSON.parse(fs.readFileSync(lock, 'utf8')).pid;
      if (!Number.isSafeInteger(pid) || pid <= 0) return true;
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code !== 'ESRCH') return true; }
    } catch (error) { if (error.code !== 'ENOENT') return true; }
  }
  return false;
}

function recoverPendingTransactions(home, legacy = false) {
  const root = legacy ? path.join(home, 'plugins', 'state', '.transactions') : path.join(home, 'state', '.transactions');
  const recovered = legacy ? [] : recoverPendingTransactions(home, true);
  if (!fs.existsSync(root)) return recovered;
  for (const name of fs.readdirSync(root).filter(item => item.endsWith('.json')).sort()) {
    const file = path.join(root, name);
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (journal.schema === 'codehelix.managed_transaction/v1') continue;
    if (journal.schema !== 'codehelix.install_transaction/v1' || !journal.plugin_id) {
      throw new Error(`无法恢复未知 transaction journal：${file}`);
    }
    // A pending journal is not evidence of a crashed process. Another raw
    // prepare scans globally, so leave active/unknown owners entirely alone.
    if (operationMayBeActive(home, journal.plugin_id)) continue;
    const state = readPluginState(home, journal.plugin_id);
    if (state?.install_plan_digest === journal.plan_digest) {
      fs.rmSync(file);
      recovered.push({ id: journal.id, action: 'finalized' });
      continue;
    }
    if (journal.package_staging_root && fs.existsSync(journal.package_staging_root)) {
      const expectedStaging = legacy ? path.join(home, 'plugins', 'store', `.staging-${journal.id}`)
        : path.join(home, 'package-store', `.staging-${journal.id}`);
      if (journal.package_staging_root !== expectedStaging) {
        throw new Error(`pending transaction 的 Package staging 路径无效：${journal.package_staging_root}`);
      }
      fs.rmSync(journal.package_staging_root, { recursive: true, force: true });
    }
    for (const item of [...journal.activations].reverse()) {
      if (!['applying', 'complete'].includes(item.status)
          || (item.status === 'complete' && item.changed === false)) continue;
      if (item.temporary_path && fs.existsSync(item.temporary_path)) {
        if (!activationMatchesJournal(item.temporary_path, item, journal, { temporary: true })) {
          throw new Error(`pending transaction 的 activation staging 已被外部修改，请人工处理：${item.temporary_path}`);
        }
        fs.rmSync(item.temporary_path, { recursive: true, force: true });
      }
      if (!activationMatchesJournal(item.path, item, journal)) {
        throw new Error(`pending transaction 的 activation 已被外部修改，请人工处理：${item.path}`);
      }
      fs.rmSync(item.path, { recursive: true, force: true });
    }
    fs.rmSync(file);
    recovered.push({ id: journal.id, action: 'rolled_back' });
  }
  return recovered;
}

module.exports = {
  readPluginState, beginTransaction, markActivationApplying, recordActivation,
  commitPluginState, finishTransaction, recoverPendingTransactions,
  atomicWrite, statePath,
};
