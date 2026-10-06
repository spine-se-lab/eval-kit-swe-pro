'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function rejectSymlinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
    if (path.dirname(current) === current) break;
  }
}

function readText(file, fallback = '') {
  rejectSymlinks(file);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback;
}

function writeText(file, content, previous, changes) {
  rejectSymlinks(file);
  if (readText(file) !== previous) throw new Error(`Configuration changed after preflight: ${file}`);
  if (content === previous) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    changes.push({ kind: 'configuration', path: file, action: 'written' });
  } finally { fs.rmSync(temporary, { force: true }); }
}

module.exports = { rejectSymlinks, readText, writeText };
