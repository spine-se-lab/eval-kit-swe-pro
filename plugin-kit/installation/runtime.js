'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('../process/run.js');
const { declaredEnvironment, runtimeEnvironment, redact } = require('../process/environment.js');
const { safeChild } = require('../model/plugin.js');
const { atomicWrite } = require('./state-store.js');

function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function redactRuntimeText(value, names = [], supplied = {}) {
  const ambient = { ...process.env, ...supplied };
  // Credential names need not contain TOKEN/SECRET. Values stay in memory, not
  // RuntimeRef or ready.json. Treat explicit injections as private by default.
  const privateValues = [...names.map(name => ambient[name]), ...Object.values(supplied)];
  for (const value of Object.values(ambient)) {
    if (typeof value !== 'string' || !value.includes('://')) continue;
    try {
      const url = new URL(value);
      if (url.password) privateValues.push(value, decodeURIComponent(url.password));
    } catch { /* Not an ordinary URL. */ }
  }
  let result = redact(value, ambient);
  // Explicitly declared/injected credentials may be shorter than the generic
  // heuristic's minimum length; never omit those known values from redaction.
  for (const secret of [...new Set(privateValues)].filter(item => typeof item === 'string' && item.length).sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])) {
      result = result.replaceAll(variant, '[REDACTED]');
    }
  }
  return result;
}

function runtimeRun(names, command, args, options = {}, supplied = {}) {
  const env = runtimeEnvironment(names, { ...supplied, PYTHONDONTWRITEBYTECODE: '1' });
  try { return run(command, args, { ...options, env }); }
  catch (error) {
    // Never carry raw stderr, command, cause, or stack properties across this
    // boundary: build backends may echo credentials in any of them.
    const safe = new Error(redactRuntimeText(error.message || String(error), names, supplied));
    if (Number.isInteger(error.exitCode)) safe.exitCode = error.exitCode;
    throw safe;
  }
}

function installedDistributions(ref, secretEnvironment = {}) {
  const probe = 'import importlib.metadata,json,sys; assert sys.prefix != sys.base_prefix; print(json.dumps([[d.metadata.get("Name"), d.version] for d in importlib.metadata.distributions()]))';
  const inventory = JSON.parse(runtimeRun(ref.environment || [], ref.python, ['-I', '-c', probe], { timeout: 15000 }, secretEnvironment));
  if (!Array.isArray(inventory) || inventory.some(item => !Array.isArray(item) || item.length !== 2
    || typeof item[0] !== 'string' || !item[0] || typeof item[1] !== 'string' || !item[1])) throw new Error('Invalid installed Runtime distribution inventory');
  return inventory.map(([name, version]) => [name.toLowerCase().replace(/[-_.]+/g, '-'), version])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));
}

function requireRegularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`Missing ${label}: ${file}`); throw error; }
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${file}`);
}

function runtimeSpecs(candidate) {
  const explicit = candidate.manifest.managed_install?.runtimes;
  if (explicit) return explicit;
  if (candidate.manifest.execution?.mode !== 'native') return [];
  const runtimeRoot = candidate.manifest.compatibility.agent_system === 'codex'
    ? `plugins/${candidate.name}/runtime` : 'package/runtime';
  const serversFile = path.join(candidate.root, runtimeRoot, 'servers.json');
  if (!fs.existsSync(serversFile)) return [];
  return JSON.parse(fs.readFileSync(serversFile, 'utf8')).map(server => ({
    id: server.name, kind: 'python', python: server.runtime.python || '3.11',
    source: `${runtimeRoot}/${server.name}/${server.wheel}`, command: server.runtime.command,
    ...(fs.existsSync(path.join(candidate.root, runtimeRoot, server.name, 'requirements.lock'))
      ? { requirements: `${runtimeRoot}/${server.name}/requirements.lock` } : {}),
    workspace_env: server.workspace_env,
  }));
}

function describeRuntimes(home, candidate, packageRef, configuration = {}, target = {}) {
  const seen = new Set();
  const environment = declaredEnvironment(candidate.manifest);
  const refs = Object.fromEntries(runtimeSpecs(candidate).map(declaration => {
    const spec = { ...declaration };
    if (spec.requirements_when && configuration[spec.requirements_when.configuration]) spec.requirements = spec.requirements_when.path;
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(spec.id || '') || seen.has(spec.id)) throw new Error('Runtime id must be unique and path-safe');
    seen.add(spec.id);
    if (spec.kind === 'git-snapshot') {
      const ref = require('./source-runtime.js').describe(home, candidate, packageRef, spec, configuration);
      return [spec.id, ref];
    }
    if (spec.kind === 'external' || spec.kind === 'system') {
      return [spec.id, { id: spec.id, kind: spec.kind, binding: spec.binding || null, managed: false }];
    }
    if (spec.kind !== 'python') throw new Error(`Unsupported Runtime backend: ${spec.kind}`);
    // An explicit caller-owned interpreter overrides the managed default. Never
    // prepare an unused venv or install packages into this external environment.
    const external = spec.binding?.configuration && configuration[spec.binding.configuration];
    if (external) {
      if (typeof external !== 'string' || !path.isAbsolute(external)) throw new Error('External Python binding must be an absolute path');
      return [spec.id, { id: spec.id, kind: 'external', managed: false, python: external, binding: spec.binding }];
    }
    safeChild(candidate.root, spec.source, 'Runtime source');
    if (spec.requirements) {
      safeChild(candidate.root, spec.requirements, 'Runtime requirements');
      requireRegularFile(path.join(candidate.root, spec.requirements), 'Runtime requirements');
    }
    if (!fs.existsSync(path.join(candidate.root, spec.source))) throw new Error(`Missing Runtime artifact: ${spec.source}`);
    if (!/^[\w.-]+$/.test(spec.command || '')) throw new Error('Runtime command must be an executable name');
    let interpreter, identity;
    if (spec.provision_python === true) {
      if (!/^3\.\d+\.\d+$/.test(spec.python || '')) throw new Error('Provisioned Python requires an exact stable version');
      // Planning must work before Python exists and must not download anything.
      // uv resolves/downloads this pinned CPython only in prepareRuntimes.
      runtimeRun(environment, 'uv', ['--version'], { timeout: 15000 });
      interpreter = `cpython@${spec.python}`;
      identity = JSON.stringify({ requested: interpreter, platform: process.platform, arch: process.arch });
    } else {
      interpreter = runtimeRun(environment, 'uv', ['python', 'find', spec.python || '3.11'], { timeout: 30000 }).trim();
      identity = runtimeRun(environment, interpreter, ['-I', '-c', 'import sys,sysconfig,platform,json; print(json.dumps([sys.version,sys.executable,sysconfig.get_platform(),platform.machine()]))']).trim();
    }
    let hostProject;
    if (spec.host_project === true) {
      if (!target.root || !path.isAbsolute(target.root)) throw new Error('Runtime host project requires an absolute target root');
      const metadata = path.join(target.root, 'pyproject.toml');
      requireRegularFile(metadata, 'host project metadata');
      hostProject = { root: target.root, metadata_sha256: hash(fs.readFileSync(metadata, 'utf8')) };
    }
    const runtimeId = hash({ package: candidate.digest, spec, identity,
      ...(hostProject ? { host_project: hostProject } : {}), platform: process.platform, arch: process.arch });
    const root = path.join(home, 'runtimes', candidate.name, `${spec.id}-${runtimeId}`);
    const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
    return [spec.id, { id: spec.id, kind: 'python', managed: true, root, runtime_id: runtimeId,
      source: path.join(packageRef.root, spec.source), interpreter, identity,
      ...(hostProject ? { host_project: hostProject } : {}),
      requirements: spec.requirements ? path.join(packageRef.root, spec.requirements) : null,
      python: path.join(root, 'venv', bin, process.platform === 'win32' ? 'python.exe' : 'python'),
      executable: path.join(root, 'venv', bin, spec.command + (process.platform === 'win32' ? '.exe' : '')),
      command: spec.command, workspace_env: spec.workspace_env || null, environment }];
  }).filter(([, ref]) => ref));
  for (const spec of runtimeSpecs(candidate)) {
    const ref = refs[spec.id], host = refs[spec.host_runtime];
    if (!ref?.managed || !host) continue;
    ref.host_project = { root: host.source, metadata_sha256: host.metadata_sha256 };
    const previous = ref.root;
    ref.runtime_id = hash({ runtime: ref.runtime_id, host: host.runtime_id });
    ref.root = path.join(home, 'runtimes', candidate.name, `${spec.id}-${ref.runtime_id}`);
    ref.python = ref.python.replace(previous, ref.root);
    ref.executable = ref.executable.replace(previous, ref.root);
  }
  return refs;
}

function verifyRuntime(ref, { preparing = false, secretEnvironment = {} } = {}) {
  if (!ref.managed) return true;
  if (ref.kind === 'git-snapshot') return require('./source-runtime.js').verify(ref);
  try {
    if (!preparing && fs.existsSync(path.join(ref.root, '.preparing'))) return false;
    const ready = JSON.parse(fs.readFileSync(path.join(ref.root, 'ready.json'), 'utf8'));
    if (ready.runtime_id !== ref.runtime_id || !fs.existsSync(ref.python) || !fs.existsSync(ref.executable)) return false;
    const resolved = path.join(ref.root, 'resolved-requirements.txt');
    requireRegularFile(resolved, 'resolved Runtime requirements');
    if (hash(fs.readFileSync(resolved, 'utf8')) !== ready.resolved_requirements_sha256) return false;
    if (ref.requirements) {
      requireRegularFile(ref.requirements, 'Runtime requirements');
      if (hash(fs.readFileSync(ref.requirements, 'utf8')) !== ready.requirements_sha256) return false;
    }
    if (ref.host_project && hash(fs.readFileSync(path.join(ref.host_project.root, 'pyproject.toml'), 'utf8')) !== ref.host_project.metadata_sha256) return false;
    if (hash(installedDistributions(ref, secretEnvironment)) !== ready.installed_distributions_sha256) return false;
    return true;
  } catch { return false; }
}

function preparationLock(root) {
  const lock = path.join(root, '.preparing');
  // The orchestrator also serializes per-plugin operations. This check preserves a
  // live/unknown owner and only reclaims an unchanged record of a dead process.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return { lock, descriptor: fs.openSync(lock, 'wx', 0o600) }; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let before;
    try { before = fs.lstatSync(lock); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!before.isFile() || before.size > 65536) throw new Error(`Unknown Runtime preparation lock owner: ${root}`);
    let owner;
    try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); }
    catch { throw new Error(`Unknown Runtime preparation lock owner: ${root}`); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(`Unknown Runtime preparation lock owner: ${root}`);
    try {
      process.kill(owner.pid, 0);
      throw new Error(`Runtime preparation already running (pid ${owner.pid}): ${root}`);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        if (error.code === 'EPERM') throw new Error(`Runtime preparation already running (pid ${owner.pid}): ${root}`);
        throw error;
      }
    }
    let current;
    try { current = fs.lstatSync(lock); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (current.dev !== before.dev || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs || current.size !== before.size) continue;
    fs.unlinkSync(lock);
  }
  throw new Error(`Runtime preparation lock changed during recovery: ${root}`);
}

function makeBuildCopyWritable(root) {
  const stat = fs.lstatSync(root);
  // Only normalize the generated Runtime copy, never a link's Store/external
  // target. Preserve executable bits while restoring owner write/traversal.
  if (stat.isSymbolicLink()) return;
  fs.chmodSync(root, (stat.mode & 0o777) | (stat.isDirectory() ? 0o700 : 0o600));
  if (stat.isDirectory()) for (const name of fs.readdirSync(root)) makeBuildCopyWritable(path.join(root, name));
}

function prepareRuntimes(refs, { onProgress = () => {}, secretEnvironment = {} } = {}) {
  for (const ref of Object.values(refs)) {
    if (!ref.managed || verifyRuntime(ref, { secretEnvironment })) continue;
    if (ref.kind === 'git-snapshot') { require('./source-runtime.js').prepare(ref); continue; }
    const execute = (command, args, options) => runtimeRun(ref.environment || [], command, args, options, secretEnvironment);
    fs.mkdirSync(ref.root, { recursive: true });
    const { lock, descriptor } = preparationLock(ref.root);
    const lockIdentity = fs.fstatSync(descriptor);
    const readyFile = path.join(ref.root, 'ready.json');
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.fsyncSync(descriptor);
      fs.rmSync(readyFile, { force: true });
      if (ref.requirements) requireRegularFile(ref.requirements, 'Runtime requirements');
      onProgress({ label: `准备 Python 环境：${ref.id}`, state: 'started' });
      // Create at its final absolute path: venv console scripts embed that path.
      const venv = path.join(ref.root, 'venv');
      let existingVenv;
      try { existingVenv = fs.lstatSync(venv); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existingVenv && !existingVenv.isDirectory()) throw new Error(`Refusing to replace non-directory Runtime venv: ${venv}`);
      // A failed/crashed preparation may leave a venv. Only this generated child
      // is rebuilt, never an external binding or symlink to another environment.
      execute('uv', ['venv', ...(existingVenv ? ['--clear'] : []), '--python', ref.interpreter, venv], { timeout: 180000 });
      let installSource = ref.source;
      if (fs.statSync(ref.source).isDirectory()) {
        installSource = path.join(ref.root, 'build-source');
        if (fs.existsSync(installSource)) {
          makeBuildCopyWritable(installSource);
          fs.rmSync(installSource, { recursive: true, force: true });
        }
        fs.cpSync(ref.source, installSource, { recursive: true });
        makeBuildCopyWritable(installSource);
      }
      if (ref.requirements) execute('uv', ['pip', 'install', '--python', ref.python, '--require-hashes', '-r', ref.requirements], { timeout: 300000 });
      const args = ['pip', 'install', '--python', ref.python, ...(ref.requirements ? ['--no-deps'] : []), installSource];
      execute('uv', args, { timeout: 300000 });
      if (ref.host_project) {
        const metadata = path.join(ref.host_project.root, 'pyproject.toml');
        if (hash(fs.readFileSync(metadata, 'utf8')) !== ref.host_project.metadata_sha256) throw new Error('Host project metadata changed after planning');
        // Register the selected mutable host checkout in this owned venv. Its
        // dependencies come from the Delivery lock; its code remains at target.
        execute('uv', ['pip', 'install', '--python', ref.python, '--no-deps', '--editable', ref.host_project.root], { timeout: 300000 });
      }
      if (!fs.existsSync(ref.executable)) throw new Error(`Runtime did not provide ${ref.command}`);
      const resolved = redactRuntimeText(execute('uv', ['pip', 'freeze', '--python', ref.python]), ref.environment || [], secretEnvironment);
      const installed = installedDistributions(ref, secretEnvironment);
      atomicWrite(path.join(ref.root, 'resolved-requirements.txt'), resolved);
      atomicWrite(path.join(ref.root, 'ready.json'), `${JSON.stringify({ runtime_id: ref.runtime_id, interpreter: ref.identity,
        ...(ref.requirements ? { requirements_sha256: hash(fs.readFileSync(ref.requirements, 'utf8')) } : {}),
        resolved_requirements_sha256: hash(resolved), installed_distributions_sha256: hash(installed),
        prepared_at: new Date().toISOString() }, null, 2)}\n`);
      if (!verifyRuntime(ref, { preparing: true, secretEnvironment })) throw new Error(`Runtime verification failed: ${ref.id}`);
      onProgress({ label: `Python 环境已准备：${ref.id}`, state: 'completed' });
    } catch (error) {
      fs.rmSync(readyFile, { force: true });
      throw new Error(redactRuntimeText(error.message || String(error), ref.environment || [], secretEnvironment));
    } finally {
      fs.closeSync(descriptor);
      let current;
      try { current = fs.lstatSync(lock); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current?.dev === lockIdentity.dev && current?.ino === lockIdentity.ino) fs.unlinkSync(lock);
    }
  }
  return refs;
}

module.exports = { runtimeSpecs, describeRuntimes, prepareRuntimes, verifyRuntime };
