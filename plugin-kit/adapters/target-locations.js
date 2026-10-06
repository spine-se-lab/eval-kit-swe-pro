'use strict';

// Host directory semantics, shared by every plugin. Discovery only yields
// candidates; the selected Delivery's preflight still decides compatibility.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function targetLocation(agent, cwd) {
  const name = { icode: 'iCode / Chrys', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' }[agent] || agent;
  const chrys = agent === 'icode';
  return {
    name,
    label: chrys ? `${name} 源码目录` : `${name} 项目 / 工作目录`,
    description: chrys ? '填写 Chrys 源码仓库根目录；不是插件仓库、.chrys 配置目录或 .venv。'
      : `填写 ${name} 将处理代码的项目 / 工作目录，不是配置目录或可执行程序。`,
    example: path.join(os.homedir(), 'WorkSpace', chrys ? 'chrys' : 'my-project'),
    defaultTarget: ['opencode', 'pi'].includes(agent) ? cwd : '',
    discovery: chrys ? 'Chrys 源码只扫描当前目录及其直接子目录，不含兄弟目录；其他位置请手动指定。'
      : `${name} 从 PATH 查找可执行程序；发现候选不代表版本或能力已验证。`,
    notFound: chrys ? '未自动找到对应的 Chrys 源码目录，请手动指定。'
      : `未自动找到 ${name} 的安装候选，请检查程序及配置位置。`,
  };
}

function defaultConfigRoot(agent) {
  if (agent === 'pi') return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent');
  if (agent === 'codex') return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (agent === 'opencode') return process.env.OPENCODE_CONFIG_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
  if (agent === 'icode') return path.join(os.homedir(), '.chrys');
  return null;
}

function findExecutable(name) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    if (!folder) continue;
    for (const extension of extensions) {
      const candidate = path.join(folder, `${name}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* Continue scanning PATH. */ }
    }
  }
  return null;
}

module.exports = { targetLocation, defaultConfigRoot, findExecutable };
