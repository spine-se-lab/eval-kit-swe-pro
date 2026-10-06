#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const root = join(__dirname, '..');
const platformCandidates = process.platform === 'win32'
  ? ['python', 'python3']
  : ['python3', 'python'];
const candidates = [process.env.PYTHON, ...platformCandidates].filter(Boolean);
let result;
for (const command of candidates) {
  result = spawnSync(command, ['-m', 'installer.installer', ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CODEHELIX_INVOKE_CWD: process.cwd() },
  });
  if (!result.error || result.error.code !== 'ENOENT') break;
}
if (!result || result.error) {
  process.stderr.write(`无法启动 Python installer: ${result && result.error ? result.error.message : '未找到 Python'}\n`);
  process.exit(127);
}
process.exit(result.status === null ? 1 : result.status);
