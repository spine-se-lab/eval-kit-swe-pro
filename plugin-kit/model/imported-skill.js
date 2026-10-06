'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXCLUDED = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build']);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

function normalizeRelative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function parseSkillName(file) {
  const content = fs.readFileSync(file, 'utf8');
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    throw new Error(`SKILL.md 缺少 YAML frontmatter：${file}`);
  }
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontmatter === undefined) throw new Error(`SKILL.md frontmatter 未闭合：${file}`);
  const raw = frontmatter.match(/^name\s*:\s*(.+?)\s*$/m)?.[1];
  const name = raw?.replace(/^(['"])(.*)\1$/, '$2').trim();
  if (!name || !SKILL_NAME.test(name)) throw new Error(`SKILL.md name 必须使用小写 kebab-case：${file}`);
  const description = frontmatter.match(/^description\s*:\s*(.+?)\s*$/m)?.[1]
    ?.replace(/^(['"])(.*)\1$/, '$2').trim();
  if (!description) throw new Error(`SKILL.md description 不能为空：${file}`);
  return { name, content };
}

function findSkillFiles(root, current = root, found = []) {
  const realRoot = fs.realpathSync(root);
  const entries = fs.readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) findSkillFiles(realRoot, absolute, found);
    else if (entry.isFile() && entry.name === 'SKILL.md') found.push(absolute);
  }
  return found;
}

function collectFiles(root, current = root, files = [], totals = { bytes: 0 }) {
  const entries = fs.readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED.has(entry.name) || entry.name === '.DS_Store' || entry.name.endsWith('.pyc')) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill 不允许符号链接：${absolute}`);
    if (entry.isDirectory()) {
      collectFiles(root, absolute, files, totals);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Skill 只允许普通文件：${absolute}`);
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`Skill 文件过大：${absolute}`);
    totals.bytes += stat.size;
    if (totals.bytes > MAX_TOTAL_BYTES) throw new Error('Skill 总大小超过 100 MiB');
    if (files.length >= MAX_FILES) throw new Error(`Skill 文件数超过 ${MAX_FILES}`);
    files.push({
      absolute,
      relative: normalizeRelative(root, absolute),
      size: stat.size,
      executable: Boolean(stat.mode & 0o111),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
    });
  }
  return files;
}

function digestFiles(files) {
  const digest = crypto.createHash('sha256');
  for (const file of [...files].sort((a, b) => a.relative.localeCompare(b.relative))) {
    digest.update(file.relative);
    digest.update('\0');
    digest.update(file.executable ? 'x' : '-');
    digest.update('\0');
    digest.update(file.sha256);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function enclosingPluginDescriptor(candidateRoot) {
  let current = candidateRoot;
  while (true) {
    const descriptor = path.join(current, 'codehelix-plugin.json');
    if (fs.existsSync(descriptor)) return descriptor;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function assessSecurity(files) {
  const executableFiles = files.filter(file => file.executable).map(file => file.relative);
  const scriptFiles = files.filter(file => /(^|\/)(scripts?|bin)\//.test(file.relative)
    || /\.(?:sh|bash|zsh|py|js|cjs|mjs|ps1|bat|cmd)$/i.test(file.relative)).map(file => file.relative);
  const securityRelevant = new Set([...scriptFiles, 'SKILL.md']);
  const binaryFiles = files.filter(file => fs.readFileSync(file.absolute).includes(0)).map(file => file.relative);
  const readable = files.filter(file => file.size <= 1024 * 1024
    && securityRelevant.has(file.relative) && !binaryFiles.includes(file.relative)).map(file => {
    const content = fs.readFileSync(file.absolute);
    return { relative: file.relative, text: content.toString('utf8') };
  });
  const networkCommandFiles = readable.filter(file => /\b(?:curl|wget|Invoke-WebRequest)\b|https?:\/\/|\bfetch\s*\(|\brequests\.(?:get|post|put|delete)\s*\(/i.test(file.text))
    .map(file => file.relative);
  const environmentReferenceFiles = readable.filter(file => /\bprocess\.env\b|\bos\.environ\b|\$\{?[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\}?/i.test(file.text))
    .map(file => file.relative);
  const commandExecutionFiles = readable.filter(file => /\b(?:child_process|subprocess|os\.system|Runtime\.getRuntime)\b|\b(?:exec|execFile|spawn|Popen|system)\s*\(/i.test(file.text))
    .map(file => file.relative);
  const sensitiveReadFiles = readable.filter(file => /(?:~\/|\/home\/[^/]+\/)?\.(?:ssh|aws|config\/gcloud)\b|\/etc\/(?:passwd|shadow)\b|secrets?\.env\b/i.test(file.text))
    .map(file => file.relative);
  return {
    status: executableFiles.length || scriptFiles.length || binaryFiles.length || networkCommandFiles.length
      || environmentReferenceFiles.length || commandExecutionFiles.length || sensitiveReadFiles.length
      ? 'pass_with_findings' : 'pass',
    local: 'complete',
    external: 'not_configured',
    executableFiles,
    scriptFiles,
    binaryFiles,
    networkCommandFiles,
    environmentReferenceFiles,
    commandExecutionFiles,
    sensitiveReadFiles,
  };
}

function discoverSkill(root, selector) {
  const candidates = findSkillFiles(root).map(file => {
    const parsed = parseSkillName(file);
    return { name: parsed.name, root: path.dirname(file), skillFile: file };
  });
  const matches = candidates.filter(candidate => candidate.name === selector);
  if (!matches.length) {
    const available = candidates.map(item => item.name).sort();
    throw new Error(`未找到 Skill：${selector}${available.length ? `；可用：${available.join('、')}` : ''}`);
  }
  if (matches.length > 1) throw new Error(`Source 中存在多个名为 ${selector} 的 Skill`);
  const candidate = matches[0];
  const descriptor = enclosingPluginDescriptor(candidate.root);
  if (descriptor) {
    throw new Error(`Source 属于 CodeHelix Plugin；请使用 --plugin 走 descriptor/target/Delivery 安装：${descriptor}`);
  }
  const files = collectFiles(candidate.root);
  const digest = digestFiles(files);
  return { ...candidate, files, digest, security: assessSecurity(files) };
}

module.exports = { discoverSkill };
