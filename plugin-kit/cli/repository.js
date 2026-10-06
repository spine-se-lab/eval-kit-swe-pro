'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ui = require('./ui.js');

function parseSource(value) {
  if (!value || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('-')) throw new Error('请提供仓库地址或本地路径');
  const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  if (fs.existsSync(expanded)) return { local: fs.realpathSync(expanded), display: fs.realpathSync(expanded) };
  if (/^[\w.-]+\/[\w.-]+$/.test(value) && !value.startsWith('.')) value = `https://github.com/${value}.git`;
  if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(value)) return { url: value, display: value };
  let url;
  try { url = new URL(value); } catch { throw new Error(`找不到本地路径或无法识别仓库地址：${ui.clean(value)}`); }
  if (!['https:', 'http:', 'ssh:', 'file:'].includes(url.protocol)) throw new Error('仓库地址须使用 HTTPS、SSH 或本地路径');
  if (url.password || (url.username && url.protocol !== 'ssh:') || url.search || url.hash) {
    throw new Error('仓库地址不能包含凭据、查询参数或片段；请使用 Git 凭据管理，并用 --ref 指定分支或标签');
  }
  return { url: url.href, display: url.href };
}

function git(args, { signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd, signal, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
    let error;
    child.once('error', failure => { error = failure; });
    child.once('close', (code, exitSignal) => {
      if (error) reject(error);
      else if (code === 0) resolve(stdout.trim());
      else reject(new Error(signal?.aborted ? '仓库获取已取消' : `Git 获取失败：${ui.clean(stderr.trim()) || exitSignal || code}`));
    });
  });
}

function assertRepository(root) {
  if (!fs.statSync(root).isDirectory() || (!fs.existsSync(path.join(root, 'plugins'))
      && !fs.existsSync(path.join(root, 'codehelix-plugin.json')))) {
    throw new Error('来源缺少 plugins/ 或独立 Delivery codehelix-plugin.json');
  }
}

const acquired = new Map();
function repositoryLease(root) {
  const source = acquired.get(root);
  if (!source || source.ownership !== 'installer') return null;
  return { root: source.root, url: source.url, gitHead: source.gitHead, ownership: source.ownership };
}

function releaseRepository(root) {
  const source = acquired.get(root);
  require('../installation/source-acquirer.js').releaseSource(source);
  acquired.delete(root);
}

async function acquireRepository(source, { ref } = {}) {
  const parsed = parseSource(source);
  ui.step(`Source: ${parsed.display}${ref ? ` @ ${ref}` : ''}`);
  if (parsed.local) {
    if (ref) throw new Error('本地仓库使用当前工作树；--ref 仅用于远程仓库');
    assertRepository(parsed.local);
    ui.step('Using local repository');
    return parsed.local;
  }
  if (ref && (ref.startsWith('-') || /[\x00-\x20\x7f]/.test(ref))) throw new Error('--ref 必须是有效分支或标签');
  let sourceLease;
  try {
    sourceLease = await ui.task('Cloning repository', (_report, signal) =>
      require('../installation/source-acquirer.js').acquireSource(source, { ref, signal }), 'Repository cloned');
    assertRepository(sourceLease.root);
    acquired.set(sourceLease.root, sourceLease);
    ui.step(`Repository ready: ${sourceLease.gitHead.slice(0, 12)}（临时 Source）`);
    return sourceLease.root;
  } catch (error) {
    require('../installation/source-acquirer.js').releaseSource(sourceLease);
    throw error;
  }
}

// Legacy installers may register absolute paths into their source checkout.
// Resolve this only after target selection AND confirmation: a mixed repository
// must not retain Source merely because one of its other targets is legacy.
async function retainLegacySelection(selection, options = {}) {
  if (options.operation !== 'install' || options.dryRun
      || require('../installation/orchestrator.js').managed(selection.delivery.manifest)) return selection;
  const serialized = options.repositoryLease ?? process.env.CODEHELIX_REPOSITORY_SOURCE;
  if (!serialized) return selection; // Borrowed local repository: never move/delete it.
  const lease = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  if (lease.ownership !== 'installer' || typeof lease.root !== 'string' || typeof lease.url !== 'string'
      || !/^[a-f0-9]{40,64}$/.test(lease.gitHead || '')) throw new Error('无效的临时 Repository lease');
  const sourceRoot = fs.realpathSync(lease.root);
  const selectedRoot = fs.realpathSync(selection.delivery.root);
  const relative = path.relative(sourceRoot, selectedRoot);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('选中的 Delivery 不在获取的 Repository 中');
  }
  const home = require('../installation/home.js').resolveCodeHelixHome(options.home);
  const sourceKey = crypto.createHash('sha256').update(lease.url).digest('hex').slice(0, 24);
  const family = path.join(home, 'repositories', sourceKey);
  const retained = path.join(family, lease.gitHead);
  async function verify(root) {
    if (fs.lstatSync(root).isSymbolicLink() || await git(['rev-parse', 'HEAD'], { cwd: root }) !== lease.gitHead
        || await git(['status', '--porcelain', '--untracked-files=no'], { cwd: root })) {
      throw new Error(`Legacy Repository 已修改，拒绝覆盖或复用：${root}`);
    }
    if (await git(['remote', 'get-url', 'origin'], { cwd: root }) !== lease.url) {
      throw new Error(`Legacy Repository 来源不匹配：${root}`);
    }
  }
  await verify(sourceRoot);
  fs.mkdirSync(family, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(retained)) {
    const staging = fs.mkdtempSync(path.join(family, '.retain-'));
    try {
      fs.cpSync(sourceRoot, staging, { recursive: true, errorOnExist: true, force: false });
      await verify(staging);
      try { fs.renameSync(staging, retained); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  await verify(retained);
  const deliveryRoot = path.join(retained, relative);
  // Tracked source must remain unchanged. Legacy installers may prepare an
  // untracked private environment here; this is not an immutable PackageStore.
  ui.step(`Legacy Repository retained: ${retained}`);
  return { ...selection, delivery: { ...selection.delivery, root: deliveryRoot } };
}

module.exports = { parseSource, acquireRepository, releaseRepository, repositoryLease, retainLegacySelection };
