'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function expandPath(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseSource(value, cwd = process.cwd()) {
  if (!value || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('-')) {
    throw new Error('请提供仓库地址或本地路径');
  }
  const localCandidate = path.resolve(cwd, expandPath(value));
  if (fs.existsSync(localCandidate)) {
    const root = fs.realpathSync(localCandidate);
    if (!fs.statSync(root).isDirectory()) throw new Error('本地 Source 必须是目录');
    return { kind: 'local', path: root, display: root, ownership: 'borrowed' };
  }
  let normalized = value;
  if (/^[\w.-]+\/[\w.-]+$/.test(value) && !value.startsWith('.')) {
    normalized = `https://github.com/${value}.git`;
  }
  if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(normalized)) {
    return { kind: 'git', url: normalized, display: normalized, ownership: 'installer' };
  }
  let url;
  try { url = new URL(normalized); } catch {
    throw new Error(`找不到本地路径或无法识别仓库地址：${value}`);
  }
  if (!['https:', 'http:', 'ssh:', 'file:'].includes(url.protocol)) {
    throw new Error('仓库地址须使用 HTTPS、SSH 或本地路径');
  }
  if (url.password || (url.username && url.protocol !== 'ssh:') || url.search || url.hash) {
    throw new Error('仓库地址不能包含凭据、查询参数或片段；请使用 Git 凭据管理，并用 --ref 指定分支或标签');
  }
  return { kind: 'git', url: url.href, display: url.href, ownership: 'installer' };
}

function git(args, { cwd, signal, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      signal,
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
      },
    });
    let stdout = '';
    let stderr = '';
    let spawnError;
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
    child.once('error', error => { spawnError = error; });
    child.once('close', (code) => {
      if (!spawnError && (code === 0 || allowFailure)) {
        resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      reject(spawnError || new Error(signal?.aborted ? 'Source 获取已取消' : `Git 获取失败：${stderr.trim() || code}`));
    });
  });
}

async function gitMetadata(root) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], { cwd: root, allowFailure: true });
  if (!inside.ok || inside.stdout !== 'true') return { gitHead: null, dirty: false };
  const head = await git(['rev-parse', 'HEAD'], { cwd: root, allowFailure: true });
  const status = await git(['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root });
  return {
    gitHead: head.ok && /^[a-f0-9]{40,64}$/.test(head.stdout) ? head.stdout : null,
    dirty: Boolean(status.stdout),
  };
}

async function acquireSource(source, { ref, cwd, signal, report = () => {} } = {}) {
  const spec = parseSource(source, cwd);
  report({ phase: 'source', message: `Source: ${spec.display}${ref ? ` @ ${ref}` : ''}` });
  if (spec.kind === 'local') {
    if (ref) throw new Error('本地 Source 使用当前工作树；--ref 仅用于远程 Git');
    const metadata = await gitMetadata(spec.path);
    return { ...spec, root: spec.path, ...metadata, released: false };
  }
  if (ref && (ref.startsWith('-') || /[\x00-\x20\x7f]/.test(ref))) {
    throw new Error('--ref 必须是有效分支或标签');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codehelix-source-'));
  try {
    report({ phase: 'source', message: 'Shallow cloning remote Git source' });
    await git(['clone', '--depth', '1', '--single-branch', ...(ref ? ['--branch', ref] : []), '--', spec.url, root], { signal });
    const metadata = await gitMetadata(root);
    if (!metadata.gitHead) throw new Error('无法确定远程 Source 的 exact commit');
    return { ...spec, root, ...metadata, dirty: false, released: false };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function releaseSource(source) {
  if (!source || source.released) return;
  source.released = true;
  if (source.ownership === 'installer') fs.rmSync(source.root, { recursive: true, force: true });
}

async function refreshSource(source) {
  if (!source?.root) throw new Error('无法重新观察 Source');
  const metadata = await gitMetadata(source.root);
  return { gitHead: metadata.gitHead, dirty: metadata.dirty };
}

module.exports = { parseSource, acquireSource, refreshSource, releaseSource };
