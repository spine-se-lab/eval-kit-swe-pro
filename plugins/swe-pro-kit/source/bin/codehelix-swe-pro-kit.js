#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (process.argv[2] !== 'protocol') {
  // Reuse the same human-facing Kit CLI in a full checkout. A standalone
  // Delivery is a source consumed by that CLI, not another copy of the Kit.
  for (let current = root; ; current = path.dirname(current)) {
    const entry = path.join(current, 'plugin-kit/cli/plugin-cli.js');
    if (fs.existsSync(entry)) { require(entry).main(root); return; }
    if (path.dirname(current) === current) break;
  }
  const help = 'SWE-Pro Kit managed installation\n\n在 CodeHelix Plugin 仓库执行：npx . add <此 Delivery 目录> --agent icode --target <Chrys目录>\n统一入口负责 install、inspect、remove；本地 protocol <check|plan|install|verify> 仅供 Kit 调用。\n';
  if (process.argv.includes('--help')) process.stdout.write(help);
  else process.stderr.write(help);
  process.exit(process.argv.includes('--help') ? 0 : 1);
}
const candidates = [process.env.PYTHON, ...(process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])].filter(Boolean);
let result;
for (const command of candidates) {
  result = spawnSync(command, ['-B', '-m', 'installer.installer', ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', CODEHELIX_INVOKE_CWD: process.cwd() },
  });
  if (!result.error || result.error.code !== 'ENOENT') break;
}
if (!result || result.error) {
  process.stderr.write('无法启动 Python installer；需要 Python >=3.11\n');
  process.exit(127);
}
process.exit(result.status === null ? 1 : result.status);
