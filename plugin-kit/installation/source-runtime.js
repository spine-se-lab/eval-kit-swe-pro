'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('../process/run.js');
const { runtimeEnvironment } = require('../process/environment.js');
const { digestTree, safeChild } = require('../model/plugin.js');
const { atomicWrite } = require('./state-store.js');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const execute = (command, args) => run(command, args, { env: runtimeEnvironment([]), timeout: 120000 });

function describe(home, candidate, packageRef, spec, configuration) {
  const repository = configuration[spec.repository_configuration];
  if (!repository) return null;
  if (!path.isAbsolute(repository) || !/^[a-f0-9]{40}$/.test(spec.revision)) throw new Error('Source runtime requires an absolute repository and fixed commit');
  const revision = execute('git', ['-C', repository, 'rev-parse', '--verify', `${spec.revision}^{commit}`]).trim();
  if (revision !== spec.revision) throw new Error('Source runtime revision mismatch');
  if (!Array.isArray(spec.paths) || !spec.paths.length) throw new Error('Source runtime requires an explicit paths list');
  for (const entry of spec.paths) safeChild(repository, entry, 'Source archive path');
  const metadata = execute('git', ['-C', repository, 'show', `${revision}:pyproject.toml`]);
  const id = hash(JSON.stringify({ package: candidate.digest, spec, revision }));
  const root = path.join(home, 'runtimes', candidate.name, `${spec.id}-${id}`);
  if (spec.patch) safeChild(candidate.root, spec.patch, 'Source runtime patch');
  return { id: spec.id, kind: 'git-snapshot', managed: true, runtime_id: id, root, source: path.join(root, 'source'),
    repository, revision, paths: spec.paths, metadata_sha256: hash(JSON.stringify(metadata)),
    patch: spec.patch ? path.join(packageRef.root, spec.patch) : null };
}

function verify(ref) {
  try {
    const ready = JSON.parse(fs.readFileSync(path.join(ref.root, 'ready.json'), 'utf8'));
    return ready.runtime_id === ref.runtime_id && ready.source_sha256 === digestTree(ref.source);
  } catch { return false; }
}

function prepare(ref) {
  if (verify(ref)) return;
  if (fs.existsSync(ref.source)) throw new Error(`Prepared source drift or incomplete source: ${ref.source}; preserve it and choose a fresh Home for recovery`);
  fs.mkdirSync(ref.root, { recursive: true });
  const archive = path.join(ref.root, 'source.tar');
  fs.mkdirSync(ref.source);
  try {
    execute('git', ['-C', ref.repository, 'archive', '--format=tar', '--output', archive, ref.revision, ...ref.paths]);
    execute('tar', ['-xf', archive, '-C', ref.source]);
    if (ref.patch) execute('git', ['-C', ref.source, 'apply', ref.patch]);
    atomicWrite(path.join(ref.root, 'ready.json'), JSON.stringify({ runtime_id: ref.runtime_id, source_sha256: digestTree(ref.source) }));
  } catch (error) {
    fs.rmSync(ref.source, { recursive: true, force: true });
    throw error;
  } finally { fs.rmSync(archive, { force: true }); }
}
module.exports = { describe, prepare, verify };
