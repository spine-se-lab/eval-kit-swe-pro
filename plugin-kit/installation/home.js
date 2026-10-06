'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function expandHome(value, userHome = os.homedir()) {
  if (value === '~') return userHome;
  if (value.startsWith(`~${path.sep}`)) return path.join(userHome, value.slice(2));
  return value;
}

function canonicalPath(value) {
  let current = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  const existing = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return path.join(existing, ...missing);
}

function resolveCodeHelixHome(explicitHome, { env = process.env, cwd = process.cwd(), userHome = os.homedir() } = {}) {
  const configured = String(explicitHome || env.CODEHELIX_HOME || '').trim();
  if (!configured) return canonicalPath(path.join(userHome, '.codehelix'));
  const expanded = expandHome(configured, userHome);
  if (!explicitHome && !path.isAbsolute(expanded)) {
    throw new Error('CODEHELIX_HOME 必须是绝对路径');
  }
  return canonicalPath(path.resolve(cwd, expanded));
}

module.exports = { canonicalPath, resolveCodeHelixHome };
