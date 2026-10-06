'use strict';

const ui = require('./ui.js');
const { detectedAgents } = require('../installation/skill-hosts.js');
const {
  prepareSkillInstall,
  commitSkillInstall,
  releaseInstallPlan,
} = require('../installation/skill-installer.js');

function valueAfter(args, index) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${args[index]} 缺少参数`);
  return value;
}

function parseArgs(args) {
  const options = { agents: [], yes: false, allowDirty: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--yes') options.yes = true;
    else if (argument === '--allow-dirty') options.allowDirty = true;
    else if (['--skill', '--agent', '--scope', '--method', '--project', '--home', '--ref'].includes(argument)) {
      const value = valueAfter(args, index);
      index += 1;
      if (argument === '--agent') options.agents.push(...value.split(',').filter(Boolean));
      else options[argument.slice(2)] = value;
    } else throw new Error(`未知 Skill 安装参数：${argument}`);
  }
  if (!options.skill) throw new Error('请使用 --skill 指定 Skill');
  return options;
}

async function completeChoices(options) {
  if (!options.agents.length) {
    if (!ui.isInteractive() || options.yes) throw new Error('非交互安装请至少提供一个 --agent codex|opencode');
    const detected = detectedAgents();
    options.agents = await ui.multiselect('选择要安装到的 Agent', [
      { label: 'Codex', value: 'codex', hint: detected.includes('codex') ? '已检测' : '将创建 Skill 目录' },
      { label: 'OpenCode', value: 'opencode', hint: detected.includes('opencode') ? '已检测' : '将创建 Skill 目录' },
    ], detected.length ? detected : ['codex']);
  }
  if (!options.scope) {
    if (!ui.isInteractive() || options.yes) throw new Error('非交互安装请提供 --scope project|global');
    options.scope = await ui.choose('Installation scope', [
      { label: 'Project', value: 'project', hint: '当前项目的 Agent 目录' },
      { label: 'Global', value: 'global', hint: '用户级 Agent 目录' },
    ], { searchable: false });
  }
  if (!options.method) {
    if (!ui.isInteractive() || options.yes) throw new Error('非交互安装请提供 --method symlink|copy');
    options.method = await ui.choose('Installation method', [
      { label: 'Symlink（Recommended）', value: 'symlink', hint: '单一权威副本，便于更新' },
      { label: 'Copy to all agents', value: 'copy', hint: '宿主目录保留受管理副本' },
    ], { searchable: false });
  }
  return options;
}

function renderPlan(plan) {
  const targetLines = plan.targets.map(target => `  ${target.agent}  ${target.path}  [${target.observation.action}]`);
  const findings = [...new Set([
    ...plan.security.executableFiles,
    ...plan.security.scriptFiles,
    ...plan.security.binaryFiles,
    ...plan.security.networkCommandFiles,
    ...plan.security.environmentReferenceFiles,
    ...plan.security.commandExecutionFiles,
    ...plan.security.sensitiveReadFiles,
  ])];
  const visibleFindings = findings.slice(0, 12);
  ui.note([
    `Source       ${plan.source.kind === 'local' ? plan.source.path : `${plan.source.url} @ ${plan.source.commit}`}`,
    `Ownership    ${plan.source.ownership}`,
    ...(plan.source.dirty ? ['Dirty        yes (installing exact working-tree snapshot)'] : []),
    `Skill        ${plan.skill}`,
    `Package      ${plan.package.root}`,
    `Scope        ${plan.scope}`,
    `Method       ${plan.method}`,
    `Create home  ${plan.writes.create_home ? 'yes' : 'no'}`,
    'Targets',
    ...targetLines,
    `Security     local ${plan.security.status}; external ${plan.security.external}; symlink ${plan.security.symlink_probe}`,
    ...(findings.length ? [`Review files ${visibleFindings.join('、')}${findings.length > visibleFindings.length
      ? `（另有 ${findings.length - visibleFindings.length} 个）` : ''}`] : []),
    `Plan digest  ${plan.planDigest}`,
  ].join('\n'), '安装计划');
}

async function addSkill(source, args) {
  const options = parseArgs(args);
  const interactive = ui.isInteractive() && !options.yes;
  if (!interactive) await completeChoices(options);
  const requestFrom = selected => ({
    agents: selected.agents,
    scope: selected.scope,
    method: selected.method,
    projectRoot: selected.project || process.cwd(),
    allowDirty: selected.allowDirty,
  });
  let plan;
  try {
    const prepare = (report, signal) => prepareSkillInstall({
      source,
      skill: options.skill,
      ref: options.ref,
      home: options.home,
      ...requestFrom(options),
      deferDirtyConsent: interactive,
      chooseActivation: interactive ? async () => requestFrom(await completeChoices(options)) : undefined,
      signal,
      report,
    });
    if (interactive) {
      plan = await prepare(event => ui.step(event.message));
      ui.step('Install plan prepared');
    } else {
      plan = await ui.task('Preparing managed Skill installation',
        (report, signal) => prepare(event => report({ label: event.message, state: 'started' }), signal),
        'Install plan prepared');
    }
    renderPlan(plan);
    if (!options.yes) {
      const confirmed = await ui.choose(plan.requires_dirty_consent
        ? '确认安装以上 dirty working-tree snapshot？'
        : '执行以上安装计划？', [
        { label: plan.requires_dirty_consent ? '确认安装 dirty snapshot' : '确认安装', value: true },
        { label: '取消', value: false },
      ], { searchable: false });
      if (!confirmed) {
        releaseInstallPlan(plan);
        plan = null;
        throw new Error('用户已取消安装');
      }
    }
    const result = await ui.task('Installing managed Skill', () => commitSkillInstall(plan, {
      planDigest: plan.planDigest,
      allowDirty: options.allowDirty || plan.requires_dirty_consent,
    }), 'Managed Skill installed and verified');
    plan = null;
    ui.note([
      `Package: ${result.package.root}`,
      `State: ${result.stateFile}`,
      ...result.activations.map(item => `${item.agent}: ${item.path}`),
    ].join('\n'), '安装结果');
    ui.outro('安装完成。需要发现更多 Skill 时，可使用 find-skills；本次未自动安装其他内容。');
    return 0;
  } finally {
    if (plan) releaseInstallPlan(plan);
  }
}

module.exports = { addSkill, parseArgs, completeChoices };
