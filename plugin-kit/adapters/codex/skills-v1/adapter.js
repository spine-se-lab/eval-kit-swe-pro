'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalPath } = require('../../../installation/home.js');

function executableOnPath(name, env = process.env) {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return (env.PATH || '').split(path.delimiter).some(folder => extensions.some(extension => {
    if (!folder) return false;
    try { fs.accessSync(path.join(folder, `${name}${extension}`), fs.constants.X_OK); return true; }
    catch { return false; }
  }));
}

function detect({ env = process.env, userHome = os.homedir() } = {}) {
  return Boolean(env.CODEX_HOME || fs.existsSync(path.join(userHome, '.codex')) || executableOnPath('codex', env));
}

function targetRoot(scope, { projectRoot, env = process.env, userHome = os.homedir() } = {}) {
  if (!['project', 'global'].includes(scope)) throw new Error('Scope 必须是 project 或 global');
  if (scope === 'project') {
    if (!projectRoot) throw new Error('Project scope 需要 projectRoot');
    return canonicalPath(path.join(projectRoot, '.codex', 'skills'));
  }
  return canonicalPath(path.join(env.CODEX_HOME || path.join(userHome, '.codex'), 'skills'));
}

module.exports = {
  id: 'codex',
  label: 'Codex',
  contract: { id: 'codex.skills-v1', version: 1, capability: 'skill-directory-v1' },
  detect,
  targetRoot,
};
