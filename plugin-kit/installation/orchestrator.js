'use strict';

const { validateConfiguration } = require('../model/install-inputs.js');

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { resolveCodeHelixHome, canonicalPath } = require('./home.js');
const { safeChild } = require('../model/plugin.js');
const { packageRoot, deliveryCandidate, materializeDelivery, verifyDeliveryPackage } = require('../storage/package-store.js');
const { describeRuntimes, prepareRuntimes, verifyRuntime } = require('./runtime.js');
const { readPluginState, commitPluginState, atomicWrite, statePath } = require('./state-store.js');
const files = require('./managed-files.js');
const { sourceLayers } = require('./source-layers.js');
const native = require('../execution/native.js');
const { declaredEnvironment, runtimeEnvironment, redact } = require('../process/environment.js');
const { resolveDataRefs } = require('./data-refs.js');
const { retainKit, verifyRetainedKit } = require('../storage/kit-store.js');

const SCHEMA = 'codehelix.managed_result/v1';
function result(status, message, fields = {}) { return { schema: SCHEMA, status, message, changes: [], evidence: [], ...fields }; }
function publicDeployment(deployment) {
  if (!deployment) return null;
  return { ...deployment, activations: deployment.activations.map(({ original, post_state, ...item }) => ({
    ...item, installed_digest: files.digest(post_state),
  })) };
}

function safeBackup(item) {
  // Native configuration can contain unrelated user credentials. Its bytes are
  // only retained in process memory for immediate rollback, never in PluginState.
  if (item.kind === 'native_plugin') return files.observation(item.before);
  const serialized = JSON.stringify(item.before);
  const values = Object.entries(process.env).filter(([key, value]) => /TOKEN|PASSWORD|SECRET|API_KEY/i.test(key) && value?.length >= 8).map(([, value]) => value);
  const rejectCredential = () => {
    throw new Error(`Existing activation contains a credential; use an environment reference before managed installation: ${item.path}`);
  };
  const checkFields = (value, key = '') => {
    if (typeof value === 'string') {
      const reference = /^(?:\$\{[A-Z][A-Z0-9_]*\}|\{env:[A-Z][A-Z0-9_]*\})$/.test(value);
      if (values.some(secret => value.includes(secret)) || (value && !reference
        && /(?:^|[_-])(?:token|password|secret|api[_-]?key|authorization)(?:$|[_-])/i.test(key.replace(/([a-z])([A-Z])/g, '$1_$2')))) rejectCredential();
    } else if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) checkFields(child, Array.isArray(value) ? key : name);
    }
  };
  const check = saved => {
    if (saved.type === 'directory') Object.values(saved.entries).forEach(check);
    if (saved.type === 'jsonc') saved.values.forEach(entry => checkFields(entry.value, entry.path.at(-1)));
    if (saved.type !== 'file') return;
    const text = Buffer.from(saved.bytes || '', 'base64').toString('utf8');
    if (values.some(value => text.includes(value)) || (item.kind === 'profile'
      && /^\s*["']?(?:api[_-]?key|password|access[_-]?token|secret)["']?\s*[:=]\s*["']?[^\s"'$#{}][^\r\n]+/im.test(text))) {
      rejectCredential();
    }
  };
  check(item.before);
  return JSON.parse(serialized);
}
function managed(manifest) { return manifest.execution?.mode === 'native' || manifest.managed_install?.schema === 'codehelix.managed_install/v1'; }
function identity(target, scope) { return files.digest({ agent: target.agent_system, harness: target.harness, root: target.root, config_root: target.config_root, scope }).slice(0, 24); }
function planHash(plan) { const { digest, ...content } = plan; return files.digest(content); }
function requireId(id) { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id || '')) throw new Error('Invalid plugin id'); return id; }

function normalizeTarget(target, manifest) {
  if (!target || !path.isAbsolute(target.root || '') || !path.isAbsolute(target.config_root || '')) throw new Error('Target root and config_root must be explicit absolute directories');
  if (!fs.statSync(target.root).isDirectory()) throw new Error('Target root must exist');
  return { ...target, agent_system: target.agent_system || manifest.compatibility.agent_system,
    harness: target.harness || manifest.compatibility.harness, root: canonicalPath(target.root), config_root: canonicalPath(target.config_root) };
}

function configurationFor(manifest, configuration = {}) {
  const secretNames = new Set((manifest.requires?.credentials || []).map(item => item.env));
  const inspect = (object, prefix = '') => {
    for (const [key, value] of Object.entries(object)) {
      const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      if (secretNames.has(key) || /(^|_)(password|secret|token|api_key|private_key|authorization)($|_)/.test(normalized)
          && !/(env|ref|names?)$/.test(normalized)) {
        throw new Error(`Supply ${prefix}${key} through the startup environment; Secret values cannot be stored as configuration`);
      }
      if (value !== null && !['string', 'boolean', 'number', 'object'].includes(typeof value)) throw new Error(`Invalid configuration: ${prefix}${key}`);
      if (value && typeof value === 'object') inspect(value, `${prefix}${key}.`);
    }
  };
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('Configuration must be an object');
  inspect(configuration);
  return structuredClone(configuration);
}

function declaredDefaults(manifest, home) {
  const declarations = manifest.configuration || manifest.native_configuration || {};
  const inputs = Array.isArray(declarations.inputs) ? declarations.inputs
    : Object.entries(declarations).map(([id, input]) => ({ ...input, id }));
  return Object.fromEntries(inputs.filter(input => input.default !== undefined).map(input => {
    let value = input.default;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const relative = value.path || '';
      if (value.root !== 'codehelix_home' || typeof relative !== 'string' || path.isAbsolute(relative)
          || relative.split(/[\\/]/).includes('..') || /[\x00-\x1f]/.test(relative)) {
        throw new Error(`Invalid configuration default path: ${input.id}`);
      }
      value = path.resolve(home, relative);
    }
    return [input.id, value];
  }));
}

function configurationBaseline(candidate, home, target, scope, state) {
  const deploymentId = identity(target, scope);
  const previous = state?.deployments?.find(item => item.id === deploymentId && item.status !== 'removed');
  let saved = {}, defaults = declaredDefaults(candidate.manifest, home);
  if (previous) {
    const observed = files.snapshot(previous.config_ref.path);
    if (observed.type !== 'file' || previous.config_digest && observed.sha256 !== previous.config_digest) {
      throw new Error(`Managed configuration drift; refusing reuse: ${previous.config_ref.path}`);
    }
    const binding = JSON.parse(fs.readFileSync(previous.config_ref.path, 'utf8'));
    saved = configurationFor(candidate.manifest, binding.configuration);
    if (!verifyDeliveryPackage(previous.package_ref.root, previous.package_ref.delivery_digest)) {
      throw new Error(`Retained PackageStore drift; cannot recover configuration defaults: ${previous.package_ref.root}`);
    }
    const oldManifest = JSON.parse(fs.readFileSync(path.join(previous.package_ref.root, 'codehelix-plugin.json'), 'utf8'));
    const oldDefaults = declaredDefaults(oldManifest, home);
    // Missing keys in old bindings meant the old default, not a new opt-in.
    // Retain defaults only for inputs that still exist in the new declaration.
    const declarations = candidate.manifest.configuration || candidate.manifest.native_configuration || {};
    const keys = new Set(Array.isArray(declarations.inputs) ? declarations.inputs.map(input => input.id) : Object.keys(declarations));
    defaults = { ...defaults, ...Object.fromEntries(Object.entries(oldDefaults).filter(([key]) => keys.has(key))) };
  }
  return { defaults: configurationFor(candidate.manifest, defaults), saved, deployment_id: deploymentId };
}

// Prompt defaults are not explicit answers: frontends still offer each choice.
// prepare uses this same baseline so noninteractive/API installs preserve it too.
function configurationDefaults(delivery, request) {
  const candidate = deliveryCandidate(delivery);
  const home = resolveCodeHelixHome(request.home);
  const target = normalizeTarget(request.target, candidate.manifest);
  const scope = request.scope || 'global';
  if (!['project', 'global'].includes(scope)) throw new Error('Invalid installation scope');
  return configurationBaseline(candidate, home, target, scope, readPluginState(home, candidate.name));
}

function contextFor(candidate, home, target, configuration, scope, method) {
  const deploymentId = identity(target, scope);
  const packageRef = { plugin_id: candidate.name, version: candidate.manifest.plugin.version,
    delivery_digest: `sha256:${candidate.digest}`, root: packageRoot(home, candidate) };
  const runtimes = describeRuntimes(home, candidate, packageRef, configuration, target);
  const names = new Set();
  for (const command of candidate.manifest.managed_install?.commands || []) {
    if (!/^[a-z][a-z0-9-]*$/.test(command.name || '') || names.has(command.name)) throw new Error('Command name must be unique and path-safe');
    names.add(command.name);
    if (!runtimes[command.runtime]?.python) throw new Error('Command requires a bound Python runtime');
    if (!/^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/.test(command.module || '')) throw new Error('Invalid command module');
    const source = safeChild(candidate.root, command.source, 'Command source');
    if (!fs.statSync(source).isDirectory()) throw new Error('Command source must be a directory');
    const modulePath = path.join(source, ...command.module.split('.'));
    if (!fs.existsSync(modulePath + '.py') && !fs.existsSync(path.join(modulePath, '__main__.py'))) throw new Error('Command module has no entry point');
  }
  const skills = (candidate.manifest.managed_install?.skills || []).map(spec => {
    const source = safeChild(candidate.root, spec.source, 'Skill source');
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error(`Skill missing SKILL.md: ${spec.id}`);
    return { id: spec.id, source: safeChild(packageRef.root, spec.source, 'Installed Skill'),
      source_relative: spec.source, path: safeChild(target.config_root, spec.destination, 'Skill destination'), method };
  });
  const configRef = { path: path.join(home, 'config', 'plugins', candidate.name, `${deploymentId}.json`) };
  return { package_ref: packageRef, package_root: packageRef.root, runtimes, config_ref: configRef,
    state_root: path.join(home, 'state'), skill_activations: skills, scope, method, deployment_id: deploymentId };
}

function customCommand(delivery, manifest, operation) {
  const npm = JSON.parse(fs.readFileSync(path.join(delivery, 'package.json'), 'utf8'));
  const declared = manifest.installer.command;
  // Resolve the already validated local npm bin, without npm/network lifecycle execution.
  if (declared[0] === 'npx' && declared[1] === '--package' && declared[2] === '.' && npm.bin?.[declared[3]]) {
    const bin = safeChild(delivery, npm.bin[declared[3]], 'Installer bin');
    const relative = path.relative(delivery, bin).split(path.sep).join('/');
    const lock = JSON.parse(fs.readFileSync(path.join(delivery, 'delivery-lock.json'), 'utf8'));
    if (!Object.hasOwn(lock.files, relative)) throw new Error('Installer bin must be part of the locked Delivery payload');
    return [process.execPath, bin, ...declared.slice(4), operation];
  }
  throw new Error('Managed custom installer must declare a local Delivery bin');
}

function protocol(delivery, manifest, operation, request, { signal, secretEnvironment = {} } = {}) {
  const command = customCommand(delivery, manifest, operation);
  const childEnvironment = runtimeEnvironment(declaredEnvironment(manifest), secretEnvironment);
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd: delivery, signal,
      timeout: (manifest.installer.timeout_seconds?.[operation] || 300) * 1000,
      env: { ...childEnvironment, CODEHELIX_HOME: request.home,
        PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', CODEHELIX_INVOKE_CWD: request.target.root },
      stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failed;
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-8 * 1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-256 * 1024); });
    child.on('error', error => { failed = error; });
    child.on('close', code => {
      if (failed) { reject(failed); return; }
      let answer;
      try { answer = JSON.parse(redact(stdout.trim(), childEnvironment)); }
      catch { reject(new Error(`Installer ${operation} returned invalid JSON: ${redact(stderr.slice(-2000), childEnvironment)}`)); return; }
      if (!Array.isArray(answer.changes) || !Array.isArray(answer.evidence)) { reject(new Error('Invalid installer result')); return; }
      if (code !== 0 || answer.status !== 'ok') { reject(new Error(answer.message || `Installer ${operation} failed`)); return; }
      resolve(answer);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function legacyOwnsPath(candidate, target, item) {
  if (item.kind === 'skill' && files.contentMatches(item.path, path.join(candidate.root, item.source_relative))) return true;
  const declaration = candidate.manifest.managed_install?.legacy_ownership;
  if (!declaration) return false;
  try {
    const record = JSON.parse(fs.readFileSync(safeChild(target.config_root, declaration.path, 'Legacy ownership'), 'utf8'));
    const hashes = { ...(record[declaration.files_key] || {}) };
    for (const [file, value] of Object.entries(hashes)) {
      if (path.isAbsolute(file)) hashes[canonicalPath(file)] = value;
    }
    const walk = (file, current) => current.type === 'file'
      ? [hashes?.[file], hashes?.[path.relative(target.config_root, file)]].some(value => (typeof value === 'string' ? value : value?.sha256) === current.sha256)
      : current.type === 'directory' && Object.entries(current.entries).every(([name, child]) => walk(path.join(file, name), child));
    return walk(item.path, files.snapshot(item.path, false, item.json_paths));
  } catch { return false; }
}

function assessCompatibility(manifest, checked, hostObservation) {
  const evidence = checked.evidence || [];
  const observed = evidence.find(item => item.kind === 'target_identity')?.version || hostObservation?.version || null;
  const reported = evidence.find(item => item.kind === 'compatibility' && typeof item.verified === 'boolean');
  const baseline = manifest.compatibility.target_version;
  const versions = manifest.verification?.versions || [];
  const verified = reported ? reported.verified : Boolean(observed && manifest.verification?.level === 'real'
    && (versions.includes(observed) || /^\d+\.\d+\.\d+$/.test(baseline) && observed === baseline));
  return { kind: 'compatibility_assessment', status: verified ? 'verified' : 'unverified', verified,
    baseline, observed, preflight: 'passed',
    message: verified ? `目标 ${observed || ''} 已有验证记录，且本次预检通过`
      : `目标 ${observed || '版本未知'} 的能力预检通过，但该版本未验证；继续安装表示接受试装风险` };
}

async function prepare(delivery, request, options = {}) {
  const candidate = deliveryCandidate(delivery);
  if (!managed(candidate.manifest)) throw new Error('This Delivery has not declared managed_install; follow its migration guide');
  const home = resolveCodeHelixHome(request.home);
  const target = normalizeTarget(request.target, candidate.manifest);
  if (candidate.manifest.compatibility.agent_system === 'icode') {
    const missing = (candidate.manifest.compatibility.required_paths || [])
      .filter(relative => !fs.existsSync(path.join(target.root, relative)));
    if (missing.length) throw new Error(`目标缺少必需接入路径：${missing.join('、')}`);
  }
  const scope = request.scope || 'global', method = request.method || 'symlink';
  if (!['project', 'global'].includes(scope) || !['symlink', 'copy'].includes(method)) throw new Error('Invalid scope or Skill installation method');
  const previousState = readPluginState(home, candidate.name);
  const baseline = configurationBaseline(candidate, home, target, scope, previousState);
  const supplied = configurationFor(candidate.manifest, request.configuration);
  let configuration = configurationFor(candidate.manifest, {
    ...baseline.defaults, ...baseline.saved, ...supplied,
  });
  for (const input of candidate.manifest.configuration?.inputs || []) {
    if (input.when && configuration[input.when.configuration] !== input.when.equals && !Object.hasOwn(supplied, input.id)) {
      delete configuration[input.id];
    }
  }
  configuration = validateConfiguration(candidate.manifest, configuration, target.root);
  const context = contextFor(candidate, home, target, configuration, scope, method);
  context.data_refs = resolveDataRefs(candidate.manifest, { home, target, configuration });
  const previous = previousState?.deployments?.find(item => item.id === context.deployment_id && item.status !== 'removed');
  // Adapters may distinguish a framework-verified registration from a foreign
  // same-name entry without reading private State or retaining its contents.
  context.owned_activations = (previous?.activations || []).map(item => ({
    path: item.path, kind: item.kind, ...(item.json_paths ? { json_paths: item.json_paths } : {}),
  }));
  const paths = [...files.targets(candidate.manifest, target, context.skill_activations, candidate.root),
    { kind: 'binding', method: 'config', path: context.config_ref.path, internal: true }];
  // A newer Delivery need not repeat an older component. Its ownership still
  // belongs to this deployment until explicit deactivation, never disappears.
  for (const old of previous?.activations || []) if (!paths.some(item => item.path === old.path)) {
    paths.push({ kind: old.kind, path: old.path, method: old.method, json_paths: old.json_paths, retained: true });
  }
  for (const sibling of previousState?.deployments || []) {
    if (sibling.id === context.deployment_id || sibling.status === 'removed') continue;
    for (const item of paths.filter(item => !item.internal)) {
      const conflict = sibling.activations?.find(old => item.path === old.path
        || item.path.startsWith(`${old.path}${path.sep}`) || old.path.startsWith(`${item.path}${path.sep}`));
      if (conflict) throw new Error(`Activation target belongs to another deployment (${sibling.id}): ${item.path}; use the existing scope/target or a separate config_root`);
    }
  }
  const observations = paths.map(item => ({ ...item, observation: files.snapshot(item.path, false, item.json_paths) }));
  for (const item of observations.filter(item => item.json_paths)) safeBackup({ ...item, before: item.observation });
  for (const item of observations) {
    const owned = previous?.activations?.find(old => old.path === item.path);
    if (item.internal && previous?.config_digest && previous.config_digest !== item.observation.sha256) throw new Error(`Managed configuration drift; refusing overwrite: ${item.path}`);
    if (owned && item.kind !== 'native_plugin' && !files.same(owned.post_state, item.observation)) throw new Error(`Managed activation drift; refusing overwrite: ${item.path}`);
    if (item.kind === 'skill' && item.observation.type !== 'missing' && !owned && !legacyOwnsPath(candidate, target, item)) {
      throw new Error(`Unowned or modified Skill; refusing overwrite: ${item.path}`);
    }
  }
  const installerRequest = { home, target, configuration, managed: context };
  let checked, hostPlan, hostObservation, nativeSnapshot;
  options.onProgress?.({ label: '检查目标与安装条件', state: 'started' });
  if (candidate.manifest.execution?.mode === 'native') {
    const nativeContext = native.prepare(candidate.root, installerRequest);
    hostPlan = native.execute(nativeContext, 'plan');
    if (hostPlan.status !== 'ok') throw new Error(hostPlan.message);
    nativeSnapshot = nativeContext.adapter.host.capture(nativeContext);
    hostObservation = nativeContext.observation;
    checked = { status: 'ok', message: 'Native compatibility checked', evidence: [] };
  } else {
    checked = await protocol(candidate.root, candidate.manifest, 'check', installerRequest, options);
    hostPlan = await protocol(candidate.root, candidate.manifest, 'plan', installerRequest, options);
    hostObservation = checked.evidence.filter(item => ['compatibility', 'target_identity'].includes(item.kind));
  }
  // No probe may silently change an activation target while preparing a plan.
  for (const item of observations) if (!files.same(item.observation, files.snapshot(item.path, false, item.json_paths))) throw new Error(`Installer preflight mutated its target: ${item.path}`);
  for (const item of observations) {
    if (item.kind !== 'profile' || item.observation.type === 'missing'
        || previous?.activations?.some(old => old.path === item.path) || legacyOwnsPath(candidate, target, item)) continue;
    // A legacy adapter may prove an exact match to its deterministic legacy
    // rendering. Merely finding the same filename is never ownership evidence.
    const proof = checked.evidence?.find(fact => fact.kind === 'activation_ownership'
      && fact.path === item.path && fact.ownership === 'legacy_codehelix'
      && item.observation.type === 'file' && fact.sha256 === item.observation.sha256);
    if (!proof) throw new Error(`Unowned or modified Profile; refusing overwrite: ${item.path}`);
  }
  // Legacy adoption uses the same rollback snapshot, but removal can explicitly
  // deactivate proven plugin-owned bindings instead of re-enabling the old runtime.
  if (candidate.manifest.managed_install?.legacy_ownership?.on_remove === 'deactivate') {
    for (const item of observations) {
      const proof = checked.evidence?.find(fact => fact.kind === 'activation_ownership'
        && fact.path === item.path && fact.ownership === 'legacy_codehelix'
        && (item.observation.type === 'jsonc' ? fact.snapshot_digest === files.digest(item.observation)
          : item.observation.type === 'file' && fact.sha256 === item.observation.sha256));
      item.legacy_adopted = Boolean(legacyOwnsPath(candidate, target, item) || proof);
    }
  }
  const compatibilityAssessment = assessCompatibility(candidate.manifest, checked, hostObservation);
  checked = { ...checked, evidence: [...(checked.evidence || []), compatibilityAssessment] };
  const plan = { schema: 'codehelix.install_plan/v1', plugin_id: candidate.name, delivery_digest: candidate.digest,
    source_root: candidate.root, home, target, configuration, scope, method, deployment_id: context.deployment_id,
    package_ref: context.package_ref, managed: context, observations, previous_state_digest: files.digest(previousState),
    checked, host_plan: hostPlan, host_observation: hostObservation, compatibility_assessment: compatibilityAssessment,
    ...(nativeSnapshot ? { native_host_snapshot: nativeSnapshot } : {}),
    security: { integrity: 'delivery-lock verified', external_scan: 'not_configured', executes_package_installer: candidate.manifest.execution?.mode !== 'native' } };
  plan.digest = planHash(plan);
  options.onProgress?.({ label: '目标与安装条件检查通过', state: 'completed' });
  return result('ok', `安装计划已生成，等待确认。${compatibilityAssessment.message}`, { plan, compatibility_assessment: compatibilityAssessment,
    changes: [...hostPlan.changes, { kind: 'package_store', path: context.package_ref.root },
      ...Object.values(context.runtimes).filter(ref => ref.managed).map(ref => ({ kind: 'runtime', path: ref.root, name: ref.id }))],
    evidence: checked.evidence || [], package_ref: context.package_ref });
}

function writeConfig(ref, plan) {
  fs.mkdirSync(path.dirname(ref.path), { recursive: true });
  atomicWrite(ref.path, `${JSON.stringify({ schema: 'codehelix.plugin_binding/v1', home: plan.home,
    plugin_id: plan.plugin_id, deployment_id: plan.deployment_id, package_ref: plan.package_ref,
    target: plan.target, configuration: plan.configuration, runtimes: plan.managed.runtimes }, null, 2)}\n`);
}

function lockOperation(home, pluginId) {
  const root = path.join(home, 'state', '.transactions');
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, `${pluginId}.lock`);
  try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let active = true;
    try { process.kill(JSON.parse(fs.readFileSync(lock)).pid, 0); } catch (error) { if (error.code === 'ESRCH') active = false; }
    if (active) throw new Error(`Another installation is active for ${pluginId}`);
    fs.rmSync(lock);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  }
  return () => fs.rmSync(lock, { force: true });
}

async function recover(home, pluginId, options = {}) {
  const root = path.join(home, 'state', '.transactions');
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.json'))) {
    const file = path.join(root, name), journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (journal.schema !== 'codehelix.managed_transaction/v1' || journal.plugin_id !== pluginId) continue;
    const current = readPluginState(home, pluginId)?.deployments?.find(item => item.id === journal.deployment_id);
    const committed = current?.plan_digest === journal.plan_digest
      && (journal.operation === 'remove' ? current.status === 'removed' : current.status === 'installed');
    if (committed) { fs.rmSync(file); continue; }
    for (const item of [...journal.files].reverse()) {
      if (item.kind === 'native_plugin' && journal.native_reconcile) continue;
      const now = files.snapshot(item.path, false, item.json_paths);
      if (files.same(now, item.before)) continue;
      if (!item.after || !files.same(now, item.after)) throw new Error(`Interrupted installation has unverified changes: ${item.path}; inspect before recovery`);
      files.restore(item.path, item.before);
    }
    if (journal.native_reconcile) restoreNative(journal.native_reconcile);
    if (journal.host_reconcile) {
      const { package_root, operation, request } = journal.host_reconcile;
      const candidate = deliveryCandidate(package_root);
      await protocol(candidate.root, candidate.manifest, operation, request, options);
    }
    fs.rmSync(file);
  }
}

function restoreNative(recovery) {
  const context = native.prepare(recovery.package_root, recovery.request, { requireConfiguration: false });
  return context.adapter.host.restore(context, recovery.snapshot);
}

function restoreOwned(item) {
  const now = files.snapshot(item.path, false, item.json_paths);
  if (files.same(now, item.before)) return;
  if (!item.after || !files.same(now, item.after)) throw new Error(`Rollback found unverified changes / drift: ${item.path}`);
  files.restore(item.path, item.before);
}

function finishJournal(file) {
  // State is the commit point. Cleanup is retryable and must never undo a
  // successful deployment; recover() recognizes a committed leftover journal.
  try { fs.rmSync(file, { force: true }); } catch { /* retry on next operation */ }
}

async function commit(delivery, request, options = {}) {
  const plan = request.plan;
  if (!plan || plan.schema !== 'codehelix.install_plan/v1' || planHash(plan) !== plan.digest) throw new Error('Missing or changed InstallPlan; prepare again');
  if (request.home && resolveCodeHelixHome(request.home) !== plan.home) throw new Error('InstallPlan belongs to a different Home');
  const unlock = lockOperation(plan.home, plan.plugin_id);
  let journal, journalFile, rollbackHost;
  try {
    await recover(plan.home, plan.plugin_id, options);
    const fresh = await prepare(plan.source_root, { home: plan.home, target: plan.target, configuration: plan.configuration,
      scope: plan.scope, method: plan.method }, options);
    if (fresh.plan.digest !== plan.digest) throw new Error('Source, target, configuration or state changed after preview; prepare again');
    const candidate = deliveryCandidate(plan.source_root);
    const nativeMode = candidate.manifest.execution?.mode === 'native';
    const before = plan.observations.map(item => ({ ...item, before: files.snapshot(item.path, true, item.json_paths) }));
    before.forEach(safeBackup);
    journalFile = path.join(plan.home, 'state', '.transactions', `${crypto.randomUUID()}.json`);
    journal = { schema: 'codehelix.managed_transaction/v1', plugin_id: plan.plugin_id,
      deployment_id: plan.deployment_id, plan_digest: plan.digest, files: before };
    const saveJournal = () => atomicWrite(journalFile, `${JSON.stringify({ ...journal,
      files: journal.files.map(item => ({ ...item, before: safeBackup(item),
        ...(item.after?.type === 'jsonc' ? { after: safeBackup({ ...item, before: item.after }) } : {}) })) }, null, 2)}\n`);
    saveJournal();
    options.onProgress?.({ label: '保存完整 Delivery 到 PackageStore', state: 'started' });
    const packageRef = materializeDelivery(plan.home, candidate);
    options.onProgress?.({ label: 'PackageStore 完整性校验通过', state: 'completed' });
    prepareRuntimes(plan.managed.runtimes, options);
    const kitRoot = retainKit(plan.home);
    writeConfig(plan.managed.config_ref, plan);
    journal.files.find(item => item.internal).after = files.snapshot(plan.managed.config_ref.path);
    saveJournal();
    for (const skill of plan.managed.skill_activations) {
      files.projectSkill(skill);
      const item = journal.files.find(item => item.path === skill.path);
      item.after = files.snapshot(skill.path);
      saveJournal();
    }
    const installerRequest = { home: plan.home, target: plan.target, configuration: plan.configuration, managed: plan.managed };
    let installed, verified;
    options.onProgress?.({ label: '激活 Coding Agent 插件组件', state: 'started' });
    if (nativeMode) {
      const context = native.prepare(packageRef.root, installerRequest);
      context.configuration._codehelix_binding = plan.managed.config_ref.path;
      journal.native_reconcile = { package_root: packageRef.root, request: installerRequest,
        snapshot: context.adapter.host.capture(context) };
      saveJournal();
      rollbackHost = () => restoreNative(journal.native_reconcile);
      installed = native.execute(context, 'install', options);
      if (installed.status !== 'ok') throw new Error(installed.message);
      verified = installed;
    } else {
      if (candidate.manifest.installer.operations.includes('remove')) {
        rollbackHost = () => protocol(packageRef.root, candidate.manifest, 'remove', installerRequest, options);
        journal.host_reconcile = { package_root: packageRef.root, operation: 'remove', request: installerRequest };
        saveJournal();
      }
      installed = await protocol(packageRef.root, candidate.manifest, 'install', installerRequest, options);
    }
    for (const item of journal.files) item.after = files.snapshot(item.path, false, item.json_paths);
    saveJournal();
    if (!nativeMode) verified = await protocol(packageRef.root, candidate.manifest, 'verify', installerRequest, options);
    if (!verifyDeliveryPackage(packageRef.root, plan.delivery_digest)) throw new Error('Installer modified immutable PackageStore contents');
    for (const ref of Object.values(plan.managed.runtimes)) if (!verifyRuntime(ref)) throw new Error(`Runtime became invalid: ${ref.id}`);
    const oldState = readPluginState(plan.home, plan.plugin_id);
    const old = oldState?.deployments?.find(item => item.id === plan.deployment_id && item.status !== 'removed');
    const activations = journal.files.filter(item => !item.internal && (!files.same(item.before, item.after) || old?.activations?.some(a => a.path === item.path)))
      .map(item => ({ kind: item.kind, path: item.path, method: item.method, source: item.source, ...(item.json_paths ? { json_paths: item.json_paths } : {}),
        ownership: 'codehelix', post_state: item.after,
        original: old?.activations?.find(a => a.path === item.path)?.original ||
          (item.legacy_adopted ? (item.before.type === 'jsonc'
            ? { type: 'jsonc', values: item.before.values.map(value => ({ path: value.path, present: false })) }
            : { type: 'missing' }) : safeBackup(item)) }));
    const deployment = { id: plan.deployment_id, status: 'installed', target: plan.target, scope: plan.scope,
      method: plan.method, package_ref: packageRef, previous_package_ref: old?.package_ref || null,
      commands: (candidate.manifest.managed_install?.commands || []).map(command => ({ name: command.name, argv: [path.join(kitRoot, 'plugin-kit/cli/codehelix'), command.name, '--home', plan.home, '--deployment', plan.deployment_id] })),
      runtime_refs: plan.managed.runtimes, config_ref: plan.managed.config_ref,
      config_digest: files.snapshot(plan.managed.config_ref.path).sha256,
      data_refs: plan.managed.data_refs,
      activations, plan_digest: plan.digest, kit_root: kitRoot, installed_at: new Date().toISOString(),
      verification: { message: verified.message, evidence: verified.evidence || [] } };
    if (nativeMode) deployment.native_observation = verified.observation;
    const state = { ...(oldState || {}), schema: 'codehelix.plugin_state/v2', plugin_id: plan.plugin_id,
      deployments: [...(oldState?.deployments || []).filter(item => item.id !== deployment.id), deployment] };
    const stateFile = commitPluginState(plan.home, plan.plugin_id, state);
    journal = null;
    finishJournal(journalFile);
    journalFile = null;
    options.onProgress?.({ label: '安装状态已提交', state: 'completed' });
    return result('ok', verified.message || '安装并验证完成', { changes: installed.changes || [], evidence: verified.evidence || [],
      deployment: publicDeployment(deployment), deployment_id: deployment.id, package_ref: packageRef, state_path: stateFile, kit_root: kitRoot,
      observation: { registered: true, enabled: true, loaded: verified.observation?.loaded ?? null, version: packageRef.version, drift: [] } });
  } catch (error) {
    if (journal) {
      // Only undo still-owned after-images; concurrent user edits are never ours.
      let rollbackError;
      for (const item of [...journal.files].reverse()) {
        if (item.kind === 'native_plugin' && journal.native_reconcile) continue;
        try { restoreOwned(item); }
        catch (failure) { rollbackError ||= failure; }
      }
      if (!rollbackError && rollbackHost) {
        try { await rollbackHost(); } catch (failure) { rollbackError = failure; }
      }
      if (!rollbackError && journalFile) fs.rmSync(journalFile, { force: true });
      if (rollbackError) return result('partial', `${error.message}; rollback requires attention: ${rollbackError.message}`);
    }
    throw error;
  } finally { unlock(); }
}

function findDeployment(pluginId, request) {
  const home = resolveCodeHelixHome(request.home);
  const state = readPluginState(home, requireId(pluginId));
  let matches = (state?.deployments || []).filter(item => item.status !== 'removed');
  if (request.deployment_id) matches = matches.filter(item => item.id === request.deployment_id);
  else if (request.target) matches = matches.filter(item => item.target.root === canonicalPath(request.target.root)
    && item.target.config_root === canonicalPath(request.target.config_root));
  if (matches.length > 1) throw new Error('Multiple deployments; select deployment_id or target');
  return { home, state, deployment: matches[0] || null };
}

function installedContext(home, deployment) {
  // Verification and removal must use the committed deployment, not a partial
  // package-only request or defaults recalculated from a new installation.
  return {
    deployment_id: deployment.id, package_ref: deployment.package_ref,
    package_root: deployment.package_ref.root, runtimes: deployment.runtime_refs,
    config_ref: deployment.config_ref, state_root: path.join(home, 'state'),
    scope: deployment.scope, method: deployment.method, data_refs: deployment.data_refs || [],
    skill_activations: deployment.activations.filter(item => item.kind === 'skill'),
    owned_activations: deployment.activations.map(item => ({
      path: item.path, kind: item.kind, ...(item.json_paths ? { json_paths: item.json_paths } : {}),
    })),
  };
}

async function inspect(pluginId, request, options = {}) {
  const { home, deployment } = findDeployment(pluginId, request);
  if (!deployment) return result('ok', 'Plugin is not installed', { deployment: null, observation: { registered: false, enabled: false, loaded: null, drift: [] } });
  const evidence = [{ kind: 'managed_state', path: statePath(home, pluginId) }];
  const drift = [];
  for (const item of deployment.activations) {
    if (item.kind === 'native_plugin') continue;
    const current = files.snapshot(item.path, false, item.json_paths);
    if (files.same(current, item.post_state)) continue;
    const layers = sourceLayers(home, deployment, item, current);
    if (layers) evidence.push({ kind: 'managed_source_layers', path: item.path, layers });
    else drift.push(item.path);
  }
  if (deployment.config_digest && files.snapshot(deployment.config_ref.path).sha256 !== deployment.config_digest) drift.push(deployment.config_ref.path);
  if (!verifyDeliveryPackage(deployment.package_ref.root, deployment.package_ref.delivery_digest)) drift.push(deployment.package_ref.root);
  if (deployment.kit_root && !verifyRetainedKit(deployment.kit_root)) drift.push(deployment.kit_root);
  for (const ref of Object.values(deployment.runtime_refs)) if (!verifyRuntime(ref)) drift.push(ref.root);
  let observation = { registered: !drift.length, enabled: !drift.length, loaded: null, version: deployment.package_ref.version, drift };
  if (!drift.length) {
    const candidate = deliveryCandidate(deployment.package_ref.root);
    if (candidate.manifest.execution?.mode === 'native') {
      const binding = JSON.parse(fs.readFileSync(deployment.config_ref.path, 'utf8'));
      const context = native.prepare(candidate.root, { target: deployment.target, configuration: binding.configuration }, { requireConfiguration: false });
      const observed = native.execute(context, 'inspect', options);
      if (observed.status !== 'ok') throw new Error(observed.message);
      observation = { ...observation, ...observed.observation };
      if (deployment.native_observation?.registration_digest && observed.observation?.registration_digest !== deployment.native_observation.registration_digest) {
        observation.drift.push('native registration');
      }
    } else if (candidate.manifest.managed_install?.verify_on_inspect) {
      const binding = JSON.parse(fs.readFileSync(deployment.config_ref.path, 'utf8'));
      try {
        await protocol(candidate.root, candidate.manifest, 'verify', {
          home, target: deployment.target, configuration: binding.configuration,
          managed: installedContext(home, deployment),
        }, options);
        observation.loaded = true;
      } catch (error) {
        observation.loaded = false;
        // A broken host dependency does not change ownership of installed files.
        evidence.push({ kind: 'module_load', status: 'error', message: error.message });
      }
    }
  }
  const message = drift.length ? 'Installed deployment has drift'
    : observation.loaded === false ? 'Installed deployment could not be loaded' : 'Installed deployment verified';
  return result('ok', message, {
    deployment: publicDeployment(deployment), deployment_id: deployment.id, package_ref: deployment.package_ref, kit_root: deployment.kit_root,
    state_path: statePath(home, pluginId), state_digest: files.digest(deployment), observation,
    evidence });
}

function assertNoSourceLayers(observed) {
  const layers = observed.evidence.filter(item => item.kind === 'managed_source_layers');
  if (layers.length) {
    const plugins = [...new Set(layers.flatMap(item => item.layers.map(layer => layer.plugin_id)))];
    throw new Error(`Remove overlaid source plugins first (reverse installation order): ${plugins.join(', ')}`);
  }
}

async function remove(pluginId, request, options = {}) {
  let { home, state, deployment } = findDeployment(pluginId, request);
  if (!deployment) return result('ok', 'Plugin is not installed', { observation: { registered: false, enabled: false, loaded: null, drift: [] } });
  const observed = await inspect(pluginId, request, options);
  if (observed.observation.drift.length) throw new Error(`Refusing removal after drift: ${observed.observation.drift.join(', ')}`);
  assertNoSourceLayers(observed);
  if (request.expected_state_digest && request.expected_state_digest !== observed.state_digest) throw new Error('Deployment changed after removal preview');
  if (request.dry_run) return result('ok', 'Remove the listed activations; preserve data and Runtime', {
    changes: deployment.activations.map(item => ({ kind: item.kind, path: item.path, action: 'deactivate' })), deployment: publicDeployment(deployment),
    state_digest: observed.state_digest, observation: observed.observation });
  if (request.confirmed !== true) throw new Error('Removal requires confirmed:true after preview');
  const unlock = lockOperation(home, pluginId);
  let journal, journalFile, reconcileHost;
  try {
    await recover(home, pluginId, options);
    ({ state, deployment } = findDeployment(pluginId, request));
    const fresh = await inspect(pluginId, request, options);
    assertNoSourceLayers(fresh);
    if (!deployment || fresh.state_digest !== observed.state_digest || fresh.observation.drift.length) {
      throw new Error('Deployment changed while waiting for removal; preview again');
    }
    const candidate = deliveryCandidate(deployment.package_ref.root);
    const binding = JSON.parse(fs.readFileSync(deployment.config_ref.path, 'utf8'));
    const installerRequest = { home, target: deployment.target, configuration: binding.configuration,
      managed: installedContext(home, deployment) };
    journalFile = path.join(home, 'state', '.transactions', `${crypto.randomUUID()}.json`);
    journal = { schema: 'codehelix.managed_transaction/v1', operation: 'remove', plugin_id: pluginId,
      deployment_id: deployment.id, plan_digest: deployment.plan_digest,
      files: deployment.activations.map(item => ({ ...item, before: files.snapshot(item.path, true, item.json_paths) })) };
    const save = () => atomicWrite(journalFile, `${JSON.stringify({ ...journal,
      files: journal.files.map(item => ({ ...item, original: undefined, post_state: undefined, before: safeBackup(item) })) }, null, 2)}\n`);
    save();
    if (candidate.manifest.execution?.mode === 'native') {
      const context = native.prepare(candidate.root, { target: deployment.target, configuration: binding.configuration }, { requireConfiguration: false });
      journal.native_reconcile = { package_root: candidate.root, request: installerRequest,
        snapshot: context.adapter.host.capture(context) };
      save();
      reconcileHost = () => restoreNative(journal.native_reconcile);
      const removed = native.execute(context, 'remove', options);
      if (removed.status !== 'ok') throw new Error(removed.message);
    } else {
      for (const item of [...deployment.activations].reverse()) {
        files.restore(item.path, item.original);
        journal.files.find(saved => saved.path === item.path).after = files.snapshot(item.path, false, item.json_paths);
        save();
      }
      if (candidate.manifest.installer.operations.includes('remove')) {
        reconcileHost = () => protocol(candidate.root, candidate.manifest, 'install', installerRequest, options);
        journal.host_reconcile = { package_root: candidate.root, operation: 'install', request: installerRequest };
        save();
        await protocol(candidate.root, candidate.manifest, 'remove', installerRequest, options);
      }
    }
    deployment.status = 'removed';
    deployment.removed_at = new Date().toISOString();
    commitPluginState(home, pluginId, state);
    journal = null;
    finishJournal(journalFile);
    journalFile = null;
    return result('ok', 'Plugin deactivated; user data and prepared Runtime preserved', { deployment: publicDeployment(deployment),
      deployment_id: deployment.id, state_path: statePath(home, pluginId),
      observation: { registered: false, enabled: false, loaded: null, drift: [] } });
  } catch (error) {
    if (journal) {
      try {
        for (const item of [...journal.files].reverse()) {
          if (item.kind === 'native_plugin' && journal.native_reconcile) continue;
          restoreOwned(item);
        }
        if (reconcileHost) await reconcileHost();
        if (journalFile) fs.rmSync(journalFile, { force: true });
      } catch (failure) {
        return result('partial', `${error.message}; removal rollback requires attention: ${failure.message}`,
          { state_path: statePath(home, pluginId), observation: { registered: null, enabled: null, loaded: null, drift: ['removal interrupted'] } });
      }
    }
    throw error;
  } finally { unlock(); }
}

module.exports = { managed, assessCompatibility, configurationDefaults, prepare, commit, inspect, remove, recover, protocol, retainKit, lockOperation };
