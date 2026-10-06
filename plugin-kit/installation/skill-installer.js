'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { resolveCodeHelixHome } = require('./home.js');
const { acquireSource, refreshSource, releaseSource } = require('./source-acquirer.js');
const { discoverSkill } = require('../model/imported-skill.js');
const { packageRoot, materializeSkill } = require('../storage/package-store.js');
const { resolveSkillTargets, probeSymlink, activateTarget, rollbackActivation } = require('./skill-hosts.js');
const {
  readPluginState,
  beginTransaction,
  markActivationApplying,
  recordActivation,
  commitPluginState,
  finishTransaction,
  recoverPendingTransactions,
} = require('./state-store.js');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function sourceSummary(source, candidate) {
  if (source.kind === 'local') {
    return {
      kind: 'local',
      ownership: 'borrowed',
      path: source.path,
      git_head: source.gitHead,
      dirty: source.dirty,
      candidate_digest: `sha256:${candidate.digest}`,
    };
  }
  return {
    kind: 'git',
    ownership: 'installer',
    url: source.url,
    commit: source.gitHead,
    candidate_digest: `sha256:${candidate.digest}`,
  };
}

function publicPlan(plan) {
  return {
    schema: plan.schema,
    skill: plan.skill,
    home: plan.home,
    source: plan.source,
    package: plan.package,
    targets: plan.targets,
    scope: plan.scope,
    method: plan.method,
    security: plan.security,
    requires_dirty_consent: plan.requires_dirty_consent,
    writes: plan.writes,
  };
}

function attachInternals(plan, internals) {
  Object.defineProperty(plan, '_internals', { value: internals, enumerable: false });
  return Object.freeze(plan);
}

function recoverSkillInstalls(options = {}) {
  const home = resolveCodeHelixHome(options.home, { cwd: options.cwd });
  return recoverPendingTransactions(home);
}

async function prepareSkillInstall(request) {
  if (!request || typeof request !== 'object') throw new Error('InstallRequest 必须是对象');
  if (!request.skill) throw new Error('请使用 --skill 指定 Skill');
  const home = resolveCodeHelixHome(request.home, { cwd: request.cwd });
  recoverSkillInstalls({ home });
  let acquired;
  try {
    acquired = await acquireSource(request.source, {
      ref: request.ref,
      cwd: request.cwd,
      signal: request.signal,
      report: request.report,
    });
    const candidate = discoverSkill(acquired.root, request.skill);
    request.report?.({ phase: 'candidate', message: `Validated Skill: ${candidate.name}` });
    const choices = request.chooseActivation ? await request.chooseActivation({
      source: sourceSummary(acquired, candidate),
      skill: candidate.name,
      security: candidate.security,
    }) : {};
    const selected = { ...request, ...choices };
    if (!['symlink', 'copy'].includes(selected.method)) throw new Error('Activation method 必须是 symlink 或 copy');
    if (acquired.kind === 'local' && acquired.dirty && !selected.allowDirty && !selected.deferDirtyConsent) {
      throw new Error('本地 Git Source 存在未提交变更；请检查安装计划并使用 --allow-dirty 明确安装当前快照');
    }
    const provenance = sourceSummary(acquired, candidate);
    const displayVersion = acquired.gitHead && !acquired.dirty
      ? `0.0.0+git.${acquired.gitHead.slice(0, 12)}`
      : `0.0.0+local.${candidate.digest.slice(0, 12)}`;
    const finalPackageRoot = packageRoot(home, candidate);
    const packageSkill = path.join(finalPackageRoot, 'skills', candidate.name);
    const previousState = readPluginState(home, candidate.name);
    const targetOptions = {
      projectRoot: selected.projectRoot,
      env: selected.env,
      userHome: selected.userHome,
    };
    const targets = resolveSkillTargets(selected.agents, selected.scope, candidate.name, packageSkill,
      targetOptions, previousState, selected.method);
    const blocked = targets.find(target => target.observation.action === 'blocked');
    if (blocked) throw new Error(`${blocked.observation.reason}：${blocked.path}`);
    if (selected.method === 'symlink') targets.forEach(probeSymlink);
    const plan = {
      schema: 'codehelix.skill_install_plan/v1',
      skill: candidate.name,
      home,
      source: provenance,
      package: {
        root: finalPackageRoot,
        skill_root: packageSkill,
        delivery_digest: `sha256:${candidate.digest}`,
        display_version: displayVersion,
      },
      targets,
      scope: selected.scope,
      method: selected.method,
      security: { ...candidate.security, symlink_probe: selected.method === 'symlink' ? 'pass' : 'not_applicable' },
      requires_dirty_consent: Boolean(acquired.kind === 'local' && acquired.dirty && !selected.allowDirty),
      writes: {
        create_home: !fs.existsSync(home),
        package: !fs.existsSync(finalPackageRoot),
        activations: targets.filter(target => target.observation.action !== 'noop').map(target => target.path),
        state: path.join(home, 'state', `${candidate.name}.json`),
      },
    };
    plan.planDigest = digest(publicPlan(plan));
    return attachInternals(plan, { acquired, candidate, previousState, targetOptions });
  } catch (error) {
    releaseSource(acquired);
    throw error;
  }
}

function releaseInstallPlan(plan) {
  releaseSource(plan?._internals?.acquired);
}

function verifyActivation(activation, packageSkill) {
  if (activation.method === 'symlink') {
    const actual = path.resolve(path.dirname(activation.path), fs.readlinkSync(activation.path));
    if (actual !== packageSkill) throw new Error(`Activation symlink 校验失败：${activation.path}`);
  } else if (!fs.statSync(activation.path).isDirectory()) {
    throw new Error(`Activation copy 校验失败：${activation.path}`);
  }
  if (!fs.existsSync(path.join(activation.path, 'SKILL.md'))) {
    throw new Error(`Activation 缺少 SKILL.md：${activation.path}`);
  }
}

async function commitSkillInstall(plan, confirmation) {
  if (!plan?._internals) throw new Error('InstallPlan 不是当前 InstallerOrchestrator 创建的有效计划');
  if (!confirmation || confirmation.planDigest !== plan.planDigest) throw new Error('确认与 InstallPlan digest 不匹配');
  if (plan.requires_dirty_consent && confirmation.allowDirty !== true) {
    throw new Error('dirty local snapshot 尚未获得明确确认');
  }
  if (digest(publicPlan(plan)) !== plan.planDigest) throw new Error('InstallPlan 已被修改');
  const { acquired, candidate, previousState, targetOptions } = plan._internals;
  let transaction;
  let unlock;
  const activations = [];
  try {
    const freshHome = resolveCodeHelixHome(plan.home);
    if (freshHome !== plan.home) throw new Error('CodeHelix home 在确认后发生变化；请重新生成安装计划');
    const freshSource = await refreshSource(acquired);
    const plannedHead = plan.source.kind === 'local' ? plan.source.git_head : plan.source.commit;
    if (freshSource.gitHead !== plannedHead || freshSource.dirty !== Boolean(plan.source.dirty)) {
      throw new Error('Source 的 Git HEAD 或 dirty 状态在确认后发生变化；请重新生成安装计划');
    }
    const current = discoverSkill(acquired.root, plan.skill);
    if (current.digest !== candidate.digest) throw new Error('Source 在确认后发生变化；请重新生成安装计划');
    const freshTargets = resolveSkillTargets(plan.targets.map(target => target.agent), plan.scope, plan.skill,
      plan.package.skill_root, targetOptions, previousState, plan.method);
    if (digest(freshTargets) !== digest(plan.targets)) {
      throw new Error('Agent target 的路径或状态在确认后发生变化；请重新生成安装计划');
    }
    // Raw Skills and complete Deliveries share the same per-id state file.
    // Use the same operation lock, then recheck the preview before any writes
    // so a newer deployment cannot be lost to this raw Skill's stale plan.
    unlock = require('./orchestrator.js').lockOperation(plan.home, plan.skill);
    const currentState = readPluginState(plan.home, plan.skill);
    if (digest(currentState) !== digest(previousState)) {
      throw new Error('PluginState 在确认后发生变化；请重新生成安装计划');
    }
    transaction = beginTransaction(plan.home, plan);
    const packageRef = materializeSkill(plan.home, current, {
      displayVersion: plan.package.display_version,
      provenance: plan.source,
      stagingRoot: transaction.packageStagingRoot,
      transactionId: transaction.id,
    });
    for (const target of freshTargets) {
      const temporaryPath = target.observation.action === 'create'
        ? markActivationApplying(transaction, target) : undefined;
      const activation = activateTarget(target, plan.package.skill_root, plan.method, {
        temporaryPath,
        transactionId: transaction.id,
      });
      activations.push(activation);
      recordActivation(transaction, activation);
      verifyActivation(activation, plan.package.skill_root);
    }
    const now = new Date().toISOString();
    const installedActivations = activations.map(item => ({
      kind: 'skill', agent: item.agent, scope: item.scope, method: item.method,
      path: item.path, package_skill_root: plan.package.skill_root,
      ...(item.method === 'copy' ? {
        managed_files: Object.fromEntries(candidate.files.map(file => [file.relative, file.sha256])),
        executable_files: candidate.files.filter(file => file.executable).map(file => file.relative),
      } : {}),
    }));
    const selectedKeys = new Set(installedActivations.map(item => `${item.agent}\0${item.scope}`));
    const retainedActivations = (previousState?.activations || [])
      .filter(item => !selectedKeys.has(`${item.agent}\0${item.scope}`));
    const state = {
      ...currentState,
      schema: currentState?.schema === 'codehelix.plugin_state/v2' || Array.isArray(currentState?.deployments)
        ? 'codehelix.plugin_state/v2' : 'codehelix.installed_plugin/v1',
      plugin_id: plan.skill,
      mode: 'managed',
      source: plan.source,
      current_package: {
        delivery_digest: packageRef.deliveryDigest,
        root: packageRef.root,
      },
      previous_package: previousState?.current_package || null,
      runtime: null,
      activations: [...retainedActivations, ...installedActivations],
      configuration_ref: null,
      data_roots: {},
      verification: { status: 'ok', verified_at: now },
      install_plan_digest: plan.planDigest,
      updated_at: now,
    };
    const stateFile = commitPluginState(plan.home, plan.skill, state);
    try { finishTransaction(transaction); } catch { /* committed state is authoritative; stale journal is recoverable */ }
    transaction = null;
    return { status: 'installed', package: packageRef, activations: installedActivations, stateFile };
  } catch (error) {
    let rollbackFailed = false;
    for (const activation of activations.reverse()) {
      try { rollbackActivation(activation); } catch { rollbackFailed = true; }
    }
    if (transaction && !rollbackFailed) {
      try { finishTransaction(transaction); } catch { /* leave recovery evidence when cleanup itself fails */ }
    }
    throw error;
  } finally {
    try { unlock?.(); } finally { releaseSource(acquired); }
  }
}

module.exports = { prepareSkillInstall, commitSkillInstall, releaseInstallPlan, recoverSkillInstalls };
