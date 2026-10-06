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
  return Boolean(env.OPENCODE_CONFIG_DIR
    || fs.existsSync(path.join(userHome, '.config', 'opencode'))
    || executableOnPath('opencode', env));
}

function targetRoot(scope, { projectRoot, env = process.env, userHome = os.homedir() } = {}) {
  if (!['project', 'global'].includes(scope)) throw new Error('Scope 必须是 project 或 global');
  if (scope === 'project') {
    if (!projectRoot) throw new Error('Project scope 需要 projectRoot');
    return canonicalPath(path.join(projectRoot, '.opencode', 'skills'));
  }
  const configRoot = env.OPENCODE_CONFIG_DIR
    || path.join(env.XDG_CONFIG_HOME || path.join(userHome, '.config'), 'opencode');
  return canonicalPath(path.join(configRoot, 'skills'));
}

module.exports = {
  id: 'opencode',
  label: 'OpenCode',
  contract: { id: 'opencode.skills-v1', version: 1, capability: 'skill-directory-v1' },
  detect,
  targetRoot,
};
