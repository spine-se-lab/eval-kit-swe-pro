'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ui = require('./ui.js');
const chrysCandidates = require('../installation/chrys-candidates.js');
const { isInteractive, choose, text: promptText, secret: promptSecret } = ui;
const { spawn } = require('node:child_process');

const { validatePlugin } = require('../model/plugin.js');
const { resolveCodeHelixHome } = require('../installation/home.js');
const { targetLocation, defaultConfigRoot, findExecutable } = require('../adapters/target-locations.js');
const { localized: inputLabel, inputsFor, inputLabel: configurationLabel, inputHelp, inputValidator, normalizeInputValue } = require('../model/install-inputs.js');

let pluginRoot = null;
const invokeCwd = process.cwd();

class CliError extends Error {
  constructor(message, diagnostics = '') {
    super(message);
    this.diagnostics = diagnostics;
  }
}

function loadDeliveries() {
  const direct = path.join(pluginRoot, 'codehelix-plugin.json');
  if (fs.existsSync(direct)) {
    const manifest = JSON.parse(fs.readFileSync(direct, 'utf8'));
    if (['codehelix.plugin_package/v1', 'codehelix.native_package/v1'].includes(manifest.schema)) {
      require('../storage/package-store.js').deliveryCandidate(pluginRoot);
      return [{ root: pluginRoot, manifest }];
    }
  }
  // Installation consumes the pre-generated Delivery. Source freshness is a
  // contributor concern checked by `npx . validate`, not an install runtime input.
  const validated = validatePlugin(pluginRoot, { checkSource: false });
  if (validated.targets.length === 0) {
    throw new CliError('该 Plugin 尚未声明可安装目标');
  }
  const deliveryRoot = path.join(pluginRoot, 'delivery');
  return validated.targets
    .map(({ target }) => {
      const root = path.join(deliveryRoot, target.profile);
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'codehelix-plugin.json'), 'utf8'));
      return { root, manifest };
    })
    .sort((left, right) => agentLabel(left.manifest.compatibility)
      .localeCompare(agentLabel(right.manifest.compatibility)));
}

// Chrys versions describe probe baselines, never a hard installation gate.
// Native platforms retain their own adapter contracts.
function agentLabel(compatibility) {
  const probed = compatibility.agent_system === 'icode' || compatibility.gate === 'capability';
  if (compatibility.agent_system === 'icode') {
    return probed
      ? `iCode / Chrys（能力探测，基线 ${compatibility.target_version}）`
      : `iCode / Chrys ${compatibility.target_version}`;
  }
  if (compatibility.agent_system === 'opencode') {
    const version = String(compatibility.target_version || '1');
    if (version.startsWith('>=')) return `OpenCode ${version}`;
    return probed
      ? `OpenCode（能力探测，基线 ${version}）`
      : `OpenCode ${version.endsWith('.x') ? version : `${version}.x`}`;
  }
  if (compatibility.agent_system === 'codex') return `Codex ${compatibility.target_version}`;
  if (compatibility.agent_system === 'pi') return `Pi ${compatibility.target_version}`;
  return compatibility.agent_system;
}

function printHelp(deliveries) {
  const plugin = deliveries[0].manifest.plugin;
  const agents = deliveries.map(({ manifest }) => agentLabel(manifest.compatibility));
  process.stdout.write([
    `安装 ${plugin.name} 到本地 Coding Agent`,
    '',
    `用法: codehelix-${plugin.id} <install|inspect|remove> [选项]`,
    '',
    '选项:',
    '  --agent <agent-system>    指定 target 声明中的 Coding Agent',
    '  --target <path>           指定 Coding Agent 或工作目录',
    '  --delivery <profile>      指定 Chrys Delivery；仍执行完整接入预检',
    '  --config-root <path>      指定 Coding Agent 配置目录',
    '  --home <path>             指定 CodeHelix home（默认 CODEHELIX_HOME 或 ~/.codehelix）',
    '  --scope project|global    指定激活范围',
    '  --method symlink|copy     指定 Skill 安装方式',
    '  --dry-run                 只生成并展示安装计划',
    '  --set <key=value>         提供插件配置，可重复使用',
    '  --yes                     跳过最终确认',
    '  --list-targets            列出扫描到的目标',
    '  -h, --help                显示帮助',
    '',
    '支持的 Coding Agent:',
    ...agents.map((agent) => `  - ${agent}`),
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  if (!['install', 'inspect', 'remove'].includes(argv[0])) {
    throw new CliError(`未知命令：${argv[0] || '(空)'}；请使用 install、inspect 或 remove`);
  }
  const options = { operation: argv[0], yes: false, listTargets: false, configuration: {} };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--yes') {
      options.yes = true;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--list-targets') {
      options.listTargets = true;
    } else if (['--agent', '--target', '--config-root', '--home', '--set', '--scope', '--method', '--delivery'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new CliError(`${argument} 缺少参数`);
      }
      index += 1;
      if (argument === '--set') {
        const separator = value.indexOf('=');
        if (separator < 1) {
          throw new CliError('--set 必须使用 key=value 格式');
        }
        options.configuration[value.slice(0, separator)] = value.slice(separator + 1);
      } else if (argument === '--config-root') {
        options.configRoot = value;
      } else if (argument === '--home') {
        options.home = value;
      } else {
        options[argument.slice(2)] = value;
      }
    } else {
      throw new CliError(`未知参数：${argument}`);
    }
  }
  return options;
}

function expandPath(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return path.resolve(invokeCwd, value);
}

function resolveConfigurationDefault(input, home) {
  const declaration = input.default;
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) return declaration;
  if (declaration.root !== 'codehelix_home') {
    throw new CliError('安装配置 default.root 仅支持 codehelix_home');
  }
  const relative = String(declaration.path || '');
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new CliError('安装配置 default.path 必须位于 CodeHelix home 内');
  }
  let root = home;
  if (!root) {
    const configured = String(process.env.CODEHELIX_HOME || '').trim();
    const homeShorthand = configured === '~' || configured.startsWith(`~${path.sep}`);
    if (configured && !homeShorthand && !path.isAbsolute(configured)) {
      throw new CliError('CODEHELIX_HOME 必须是绝对路径');
    }
    root = configured ? expandPath(configured) : path.join(os.homedir(), '.codehelix');
  }
  return path.resolve(root, relative);
}

function pathHasRequiredFiles(root, requiredPaths) {
  return requiredPaths.every((requiredPath) => fs.existsSync(path.join(root, requiredPath)));
}

function chrysIdentityMatches(root) {
  return chrysCandidates.hostVersion(root) !== null;
}

function discoverTargets(deliveries) {
  const candidates = [];
  const roots = [invokeCwd];
  try {
    roots.push(...fs.readdirSync(invokeCwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(invokeCwd, entry.name)));
  } catch {
    // An explicit target remains available when the current directory is unreadable.
  }
  for (const delivery of deliveries) {
    const compatibility = delivery.manifest.compatibility;
    if (delivery.manifest.execution?.mode === 'native') {
      const executable = findExecutable(compatibility.agent_system);
      if (executable) candidates.push({ delivery, root: invokeCwd, configRoot: defaultConfigRoot(compatibility.agent_system), executable });
    } else if (compatibility.agent_system === 'icode') {
      for (const root of roots) {
        if (fs.existsSync(path.join(root, '.git'))
          && pathHasRequiredFiles(root, compatibility.required_paths || [])
          && chrysIdentityMatches(root)) {
          candidates.push({
            delivery,
            root: path.resolve(root),
            configRoot: defaultConfigRoot('icode'),
            executable: null,
          });
        }
      }
    } else if (['opencode', 'pi'].includes(compatibility.agent_system)) {
      const executable = findExecutable(compatibility.agent_system);
      const configRoot = defaultConfigRoot(compatibility.agent_system);
      if (executable && (compatibility.agent_system === 'pi' || fs.existsSync(configRoot))) {
        candidates.push({ delivery, root: invokeCwd, configRoot, executable });
      }
    }
  }
  return candidates;
}

function targetLabel(target) {
  const label = agentLabel(target.delivery.manifest.compatibility);
  if (['opencode', 'pi'].includes(target.delivery.manifest.compatibility.agent_system)) {
    return `声明：${label}  ·  程序：${target.executable}`;
  }
  return `声明：${label}  ·  目录：${target.root}`;
}

function discoveryDeliveries(deliveries, agent) {
  return agent ? deliveries.filter(item => item.manifest.compatibility.agent_system === normalizeAgent(agent)) : deliveries;
}

function discoveryGuidance(deliveries, count) {
  const agents = [...new Set(deliveries.map(item => item.manifest.compatibility.agent_system))];
  return [
    `本插件提供适配：${[...new Set(deliveries.map(item => agentLabel(item.manifest.compatibility)))].join('；') || '所选 Agent 无对应适配'}`,
    '仅查找本插件已适配的 Agent，不是本机所有 Agent 的清单。',
    ...(!count && agents.length === 1 ? [targetLocation(agents[0], invokeCwd).notFound] : []),
    ...agents.map(agent => targetLocation(agent, invokeCwd).discovery),
    '候选显示声明范围 / 基线，不是现场检测版本；选择后仍需预检。',
  ];
}

function printTargets(deliveries, options = {}) {
  deliveries = discoveryDeliveries(deliveries, options.agent);
  process.stdout.write('当前插件的安装候选（待预检）\n\n');
  const targets = discoverTargets(deliveries);
  process.stdout.write(`${discoveryGuidance(deliveries, targets.length).join('\n')}\n\n`);
  if (targets.length === 0) {
    process.stdout.write('  未自动找到本插件的安装候选\n');
  } else {
    for (const target of targets) process.stdout.write(`  ${targetLabel(target)}\n`);
  }
  process.stdout.write('\n  手动指定路径…\n');
}

function normalizeAgent(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['icode', 'chrys', 'icode/chrys'].includes(normalized)) return 'icode';
  if (['opencode', 'open-code'].includes(normalized)) return 'opencode';
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) return normalized;
  throw new CliError(`无效的 Coding Agent ID：${value}`);
}

function deliveryForAgent(deliveries, agentSystem, options = {}) {
  let matches = deliveries.filter(({ manifest }) => manifest.compatibility.agent_system === agentSystem);
  const native = matches.filter(({ manifest }) => manifest.execution?.mode === 'native');
  if (native.length) {
    matches = native;
    if (native.length > 1) {
      const { getAdapter } = require('../adapters/registry.js');
      const { resolveAdapter } = require('../adapters/resolve.js');
      const adapter = getAdapter(native[0].manifest.execution.adapter);
      const observation = adapter.detect({ root: expandPath(options.target) || invokeCwd,
        config_root: expandPath(options.configRoot) || defaultConfigRoot(agentSystem), executable: findExecutable(agentSystem) });
      const selected = resolveAdapter(observation);
      matches = native.filter(delivery => delivery.manifest.execution.adapter === selected.id);
    }
  } else if (agentSystem === 'icode' && options.target) {
    const root = expandPath(options.target);
    // Provisional selection for configuration collection. Installation selects
    // again using read-only adapter probes, including fallback deliveries.
    return chrysCandidates.candidates(matches, root, options.delivery)[0];
  }
  if (matches.length === 0) throw new CliError(`该插件没有匹配 ${agentSystem}${options.target ? ` 目标 ${options.target}` : ''} 的 Delivery；请检查路径和版本`);
  if (matches.length > 1) throw new CliError(`${agentSystem} 存在多个兼容 Delivery；请先明确版本`);
  return matches[0];
}

function agentName(agentSystem) {
  return targetLocation(agentSystem, invokeCwd).name;
}

function directoryValidator(defaultValue, { existing = true } = {}) {
  return value => {
    const input = String(value || '').trim() || defaultValue;
    if (!input) return '请输入目录路径；示例不是默认值。';
    const root = expandPath(input);
    try {
      if (!fs.statSync(root).isDirectory()) return '请输入目录，而不是文件或可执行程序。';
    } catch (error) {
      if (error.code === 'ENOENT') return existing ? '目录不存在，请检查路径后重新输入。' : undefined;
      return '无法读取目录，请检查路径和访问权限。';
    }
  };
}

async function promptTargetDirectory(deliveries, agentSystem, defaultValue = '') {
  const location = targetLocation(agentSystem, invokeCwd);
  const candidates = deliveries.filter(item => item.manifest.compatibility.agent_system === agentSystem);
  const declarations = [...new Set(candidates.map(item => agentLabel(item.manifest.compatibility)))];
  const runtimes = [...new Set(candidates.flatMap(item => item.manifest.requires?.runtimes || []))];
  const baselines = [...new Set(candidates.flatMap(({ manifest }) => manifest.compatibility.base_commit
    ? [`${agentLabel(manifest.compatibility)} @ ${manifest.compatibility.base_commit}`] : []))];
  ui.note([
    location.description,
    `声明目标：${declarations.join('；')}`,
    ...(runtimes.length ? [`环境要求：${runtimes.join('；')}`] : []),
    ...(baselines.length ? [`适配基线：${baselines.join('；')}`] : []),
    '版本仅作验证基线与候选排序；后续检查所需能力及适用的源码补丁。',
    `支持绝对路径、~ 和相对路径（相对启动目录 ${invokeCwd}）。`,
    '输入后按 Enter 确认，Ctrl+C 取消；示例不会自动作为路径。',
  ].join('\n'), '目标目录说明');
  return promptText(location.label, defaultValue, {
    placeholder: defaultValue || `例如 ${location.example}（请输入实际路径）`,
    validate: directoryValidator(defaultValue),
  });
}

async function promptConfigDirectory(agentSystem) {
  const defaultValue = defaultConfigRoot(agentSystem) || '';
  ui.note('这里是宿主读取配置的位置，不是源码 / 项目目录，也不是 CodeHelix Home。\n'
    + '可输入自定义目录；有默认值时按 Enter 接受。目录可尚未创建，正式安装前不会创建。', '配置目录说明');
  return promptText(`${agentName(agentSystem)} 配置目录`, defaultValue, {
    placeholder: defaultValue || `例如 ${path.join(os.homedir(), 'agent-config')}（请输入实际路径）`,
    validate: directoryValidator(defaultValue, { existing: false }),
  });
}

async function manualTarget(deliveries, options) {
  const uniqueAgents = [...new Set(deliveries.map(({ manifest }) => manifest.compatibility.agent_system))];
  const agentSystem = options.agent ? normalizeAgent(options.agent) : uniqueAgents.length === 1
    ? uniqueAgents[0]
    : await choose('选择 Coding Agent 类型', uniqueAgents.map((agent) => ({
      label: agent === 'icode' ? 'iCode / Chrys' : agent,
      value: agent,
    })));
  if (uniqueAgents.length === 1 && !options.agent) ui.step(`本插件安装到 ${agentName(agentSystem)}`);
  const defaultTarget = targetLocation(agentSystem, invokeCwd).defaultTarget;
  const root = expandPath(options.target || await promptTargetDirectory(deliveries, agentSystem, defaultTarget));
  const configRoot = expandPath(options.configRoot
    || await promptConfigDirectory(agentSystem));
  const delivery = deliveryForAgent(deliveries, agentSystem, { ...options, target: root, configRoot });
  const executable = ['opencode', 'pi'].includes(agentSystem) || delivery.manifest.execution?.mode === 'native'
    ? findExecutable(agentSystem) : null;
  if ((['opencode', 'pi'].includes(agentSystem) || delivery.manifest.execution?.mode === 'native') && !executable) {
    throw new CliError(`未找到 ${agentSystem} executable`);
  }
  return {
    delivery,
    root,
    configRoot,
    executable,
  };
}

async function resolveTarget(deliveries, options) {
  const standalone = deliveries.filter(d => d.manifest.compatibility.agent_system === 'codehelix');
  if (standalone.length === 1 && (!options.agent || normalizeAgent(options.agent) === 'codehelix')) {
    const root = expandPath(options.target) || invokeCwd;
    const home = resolveCodeHelixHome(options.home);
    return { delivery: standalone[0], root,
      configRoot: path.join(home, 'config', 'plugins', standalone[0].manifest.plugin.id, 'user'), executable: null };
  }
  const candidates = discoveryDeliveries(deliveries, options.agent);
  const discovered = options.target ? [] : discoverTargets(candidates);
  if (options.target) ui.step(`使用指定目标目录：${expandPath(options.target)}`);
  else ui.step(discovered.length
    ? `为当前插件发现 ${discovered.length} 个安装候选（待预检）`
    : '未自动找到本插件的安装候选');
  if (!options.target && isInteractive() && !options.yes) {
    ui.note([...discoveryGuidance(candidates, discovered.length), '手动指定路径可继续；Ctrl+C 可取消。'].join('\n'), '目标选择说明');
  }
  if (options.agent) {
    const agentSystem = normalizeAgent(options.agent);
    let root = options.target && expandPath(options.target);
    let executable = null;
    if (!root && agentSystem === 'icode') {
      const matches = discovered.filter((candidate) => candidate.delivery.manifest.compatibility.agent_system === agentSystem);
      if (matches.length === 1) {
        return { ...matches[0], configRoot: expandPath(options.configRoot) || matches[0].configRoot };
      }
      if (matches.length > 1 && isInteractive() && !options.yes) {
        const selected = await choose('选择目标 Coding Agent', matches.map((candidate) => ({
          label: targetLabel(candidate), value: candidate,
        })));
        return { ...selected, configRoot: expandPath(options.configRoot) || selected.configRoot };
      }
      if (matches.length === 0 && isInteractive() && !options.yes) {
        root = expandPath(await promptTargetDirectory(deliveries, agentSystem));
      } else {
        throw new CliError('无法唯一确定 iCode / Chrys 目标；请使用 --target');
      }
    }
    const delivery = deliveryForAgent(deliveries, agentSystem, { ...options, target: root });
    if (['opencode', 'pi'].includes(agentSystem) || delivery.manifest.execution?.mode === 'native') {
      root ||= invokeCwd;
      executable = findExecutable(agentSystem);
      if (!executable) throw new CliError(`未找到 ${agentSystem} executable`);
    }
    if (!root) {
      if (isInteractive() && !options.yes) {
        root = expandPath(await promptTargetDirectory(deliveries, agentSystem));
      } else {
        throw new CliError(`无法确定 ${agentSystem} 目标；请使用 --target`);
      }
    }
    let configRoot = expandPath(options.configRoot) || defaultConfigRoot(agentSystem);
    if (!configRoot) {
      if (isInteractive() && !options.yes) {
        configRoot = expandPath(await promptConfigDirectory(agentSystem));
      } else {
        throw new CliError(`无法确定 ${agentSystem} 配置目录；请使用 --config-root`);
      }
    }
    return {
      delivery,
      root,
      configRoot,
      executable,
    };
  }

  if (options.target) {
    const explicitRoot = expandPath(options.target);
    const matches = deliveries.filter(({ manifest }) => (
      manifest.compatibility.agent_system === 'icode'
      && pathHasRequiredFiles(explicitRoot, manifest.compatibility.required_paths || [])
      && chrysIdentityMatches(explicitRoot)
    ));
    if (matches.length) {
      return {
        delivery: chrysCandidates.candidates(matches, explicitRoot, options.delivery)[0],
        root: explicitRoot,
        configRoot: expandPath(options.configRoot) || defaultConfigRoot('icode'),
        executable: null,
      };
    }
    throw new CliError('无法从 --target 判断 Coding Agent 类型；请同时使用 --agent');
  }

  if (!isInteractive() || options.yes) {
    if (discovered.length === 1) return { ...discovered[0], configRoot: expandPath(options.configRoot) || discovered[0].configRoot };
    throw new CliError('无法唯一确定目标；请使用 --agent 和 --target，或在交互终端运行');
  }
  const manual = Symbol('manual');
  const cancel = Symbol('cancel');
  const selected = await choose('选择目标 Coding Agent', [
    ...discovered.map((candidate) => ({ label: targetLabel(candidate), value: candidate })),
    { label: '手动指定路径…', hint: '按 Enter 后输入路径', value: manual },
    { label: '取消', value: cancel },
  ]);
  if (selected === cancel) throw new CliError('用户已取消');
  if (selected === manual) return manualTarget(deliveries, options);
  return { ...selected, configRoot: expandPath(options.configRoot) || selected.configRoot };
}

const CHOICE_LABELS = { github: 'GitHub', false: '关闭', true: '开启' };

async function collectConfiguration(selection, options, initialConfiguration = {}) {
  // Inspect/remove consume the saved binding. They must not ask for install
  // configuration or require credentials merely to view/undo an activation.
  if (['inspect', 'remove'].includes(options.operation)) return { configuration: {}, secretEnvironment: {} };
  const manifest = selection.delivery.manifest;
  const configuration = { ...options.configuration };
  const secretEnvironment = {};
  const credentials = manifest.requires?.credentials || [];
  const collectCredentials = async (items) => {
    for (const credential of items) {
      const label = credential.label || `${credential.provider} 凭据`;
      if (credential.repeatable === true) {
        const maximum = Number.isInteger(credential.max_entries) && credential.max_entries > 0
          ? credential.max_entries : 16;
        const values = [];
        for (let index = 0; index < maximum; index += 1) {
          const name = index === 0 ? credential.env : `${credential.env}_${index}`;
          const value = process.env[name];
          if (value) values.push(value);
        }
        if (!options.yes && credential.prompt !== false) {
          while (values.length < maximum) {
            const number = values.length + 1;
            const hint = values.length === 0 && credential.required
              ? '（必填）' : '（可选，直接回车结束）';
            const value = await promptSecret(`${label} ${number}${hint}`);
            if (!value) break;
            if (/[,;\r\n]/.test(value)) {
              throw new CliError(`${label} 每次只输入一个值；请勿使用逗号或分号拼接`);
            }
            values.push(value);
          }
        }
        if (credential.required && values.length === 0) {
          throw new CliError(`缺少必需凭据：环境变量 ${credential.env}`);
        }
        values.forEach((value, index) => {
          secretEnvironment[index === 0 ? credential.env : `${credential.env}_${index}`] = value;
        });
        continue;
      }
      let value = process.env[credential.env];
      const shouldPrompt = credential.required || credential.prompt === true;
      if (!value && !options.yes && shouldPrompt) value = await promptSecret(label);
      if (!value && credential.required) {
        throw new CliError(`缺少必需凭据：环境变量 ${credential.env}`);
      }
      if (value) secretEnvironment[credential.env] = value;
    }
  };

  await collectCredentials(credentials.filter(item => item.prompt_before_configuration === true));
  const inputs = inputsFor(manifest);
  for (const input of inputs) {
    if (input.when && (configuration[input.when.configuration] ?? initialConfiguration[input.when.configuration]) !== input.when.equals) continue;
    let value = configuration[input.id];
    const label = configurationLabel(input);
    const validate = inputValidator(input, invokeCwd);
    const defaultValue = initialConfiguration[input.id] ?? resolveConfigurationDefault(input, resolveCodeHelixHome(options.home, { cwd: invokeCwd }));
    if (value === undefined && input.prompt !== false
        && !options.yes && isInteractive()) {
      const help = [inputHelp(input),
        ...(input.type !== 'choice' && defaultValue !== undefined && defaultValue !== ''
          ? [`默认值（直接回车使用）：${defaultValue}`] : []),
      ].filter(Boolean).join('\n');
      if (help) ui.note(help, `${label}说明`);
      if (input.type === 'choice') {
        const choices = [...(input.choices || [])].sort((left, right) => Number(right === defaultValue) - Number(left === defaultValue));
        const manual = Symbol('manual-choice');
        const selected = await choose(`选择 ${label}`, [
          ...choices.map((choice) => ({ label: inputLabel(input.choice_labels?.[choice], CHOICE_LABELS[choice] || choice), value: choice })),
          { label: '手动输入…', value: manual },
        ]);
        value = selected === manual
          ? await promptText(`输入 ${label}`, '', { placeholder: inputLabel(input.placeholder), validate })
          : selected;
      } else {
        value = await promptText(label, defaultValue ?? '', {
          placeholder: inputLabel(input.placeholder, String(defaultValue ?? '')),
          validate: answer => validate(answer === undefined || String(answer).trim() === '' ? defaultValue : answer),
        });
      }
    }
    if (!Object.hasOwn(options.configuration || {}, input.id)
        && (value === undefined || value === '') && defaultValue !== undefined) value = defaultValue;
    if (input.required && (value === undefined || value === '')) {
      throw new CliError(`缺少必填配置：${input.id}；请使用 --set ${input.id}=<value>`);
    }
    const invalid = validate(value);
    if (invalid) throw new CliError(`${label}：${invalid}；请检查 --set ${input.id}`);
    if (value !== undefined && value !== '') configuration[input.id] = normalizeInputValue(input, value, invokeCwd);
  }

  await collectCredentials(credentials.filter(item => item.prompt_before_configuration !== true));
  return { configuration, secretEnvironment };
}

function buildRequest(selection, configuration, explicitHome) {
  const compatibility = selection.delivery.manifest.compatibility;
  return {
    target: {
      agent_system: compatibility.agent_system,
      harness: compatibility.harness,
      root: selection.root,
      config_root: selection.configRoot,
      executable: selection.executable,
    },
    home: resolveCodeHelixHome(explicitHome, { cwd: invokeCwd }),
    configuration,
  };
}

function validateResult(result) {
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(result) || !['ok', 'blocked', 'failed'].includes(result.status)
      || typeof result.message !== 'string'
      || !['changes', 'evidence'].every((key) => Array.isArray(result[key]) && result[key].every(object))) {
    throw new CliError('安装器 result 必须包含有效 status、message、changes 和 evidence');
  }
  for (const item of result.evidence) {
    if (item.kind === 'mutation_state' && !['unchanged', 'modified', 'unknown'].includes(item.state)) {
      throw new CliError('mutation_state.state 无效');
    }
    if (item.kind === 'target_identity' && (typeof item.version !== 'string' || !item.version.trim())) {
      throw new CliError('target_identity.version 必须为非空字符串');
    }
  }
  return result;
}

function runProtocol(selection, operation, request, secretEnvironment, signal) {
  let command = selection.delivery.manifest.installer.command;
  if (process.platform === 'win32' && command[0] === 'npx') {
    // Node cannot spawn a .cmd shim directly. Invoke npm's JS entry point
    // without a shell so paths with spaces and protocol arguments stay literal.
    const candidates = [
      process.env.npm_execpath && path.join(path.dirname(process.env.npm_execpath), 'npx-cli.js'),
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    ].filter(Boolean);
    const entry = candidates.find((file) => fs.existsSync(file));
    if (!entry) throw new CliError('找不到 npm 的 npx-cli.js；请通过 npx . 启动，或修复 Node.js/npm 安装');
    command = [process.execPath, entry, ...command.slice(1)];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1).concat(operation), {
      cwd: selection.delivery.root,
      signal,
      timeout: (selection.delivery.manifest.installer.timeout_seconds?.[operation] || 300) * 1000,
      env: {
        ...process.env,
        ...secretEnvironment,
        CODEHELIX_INVOKE_CWD: invokeCwd,
        npm_config_yes: 'true',
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new CliError(`无法启动安装器：${error.message}`, stderr)));
    child.on('close', (code) => {
      let result;
      try {
        result = validateResult(JSON.parse(stdout.trim()));
      } catch {
        reject(new CliError('安装器返回了无法识别的结果', `${stderr}\n${stdout}`.trim()));
        return;
      }
      resolve({ result, code: code ?? 1, diagnostics: stderr.trim() });
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

const PHASE_LABELS = {
  check: '检查目标',
  plan: '生成安装计划',
  install: '安装插件组件',
  verify: '验证安装结果',
};

function outputRedactor(selection, secretEnvironment = {}) {
  const secrets = new Set(Object.values(secretEnvironment).filter(value => typeof value === 'string' && value));
  const credentialNames = new Set((selection.delivery.manifest.requires?.credentials || []).map(item => item.env));
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (credentialNames.has(name) || [...credentialNames].some(key => name.startsWith(`${key}_`))
        || /(?:^|_)(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIALS?)(?:_|$)/i.test(name)) secrets.add(value);
  }
  const variants = [...new Set([...secrets].flatMap(value => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]))]
    .filter(Boolean).sort((left, right) => right.length - left.length);
  return value => variants.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value ?? ''));
}

function writeFailureLog(selection, operation, response, request = {}, secretEnvironment = {}) {
  const redact = outputRedactor(selection, secretEnvironment);
  const logRoot = path.join(resolveCodeHelixHome(request.home, { cwd: invokeCwd }), 'logs');
  fs.mkdirSync(logRoot, { recursive: true });
  const pluginId = selection.delivery.manifest.plugin.id;
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const logPath = path.join(logRoot, `${pluginId}-install-${timestamp}.log`);
  fs.writeFileSync(logPath, redact([
    `plugin=${pluginId}`,
    `operation=${operation}`,
    `target=${selection.root}`,
    `status=${response.result?.status || 'failed'}`,
    `message=${response.result?.message || ''}`,
    '',
    response.diagnostics || '',
  ].join('\n')), { mode: 0o600 });
  return logPath;
}

async function runPhase(selection, operation, request, secretEnvironment) {
  const label = PHASE_LABELS[operation];
  const redact = outputRedactor(selection, secretEnvironment);
  return ui.task(label, async (_report, signal) => {
    try {
      const response = await runProtocol(selection, operation, request, secretEnvironment, signal);
      if (response.code !== 0 || response.result.status !== 'ok') throw new CliError(response.result.message, response.diagnostics);
      return response.result;
    } catch (error) {
      if (signal.aborted) throw new CliError(redact(error.message));
      const logPath = writeFailureLog(selection, operation, { result: { message: error.message }, diagnostics: error.diagnostics }, request, secretEnvironment);
      throw new CliError(`${label}失败：${redact(error.message)}\n失败日志：${logPath}`, redact(error.diagnostics));
    }
  }, result => `${label}：${redact(result.message)}`);
}

const COMPONENT_LABELS = {
  agent_profile: 'Agent Profile',
  agent_profiles: 'Agent Profile',
  skill: 'Skill',
  skills: 'Skill',
  skill_and_mcp: 'Skill 与 MCP',
  mcp_server: 'MCP Server',
  mcp_stdio: 'MCP 工具',
  command: '命令',
  middleware: '运行时中间件',
  monitor: '监控界面',
  executable: '可执行程序',
  python_package: 'Python 包',
  compatibility: '兼容性',
  source_patch: '源码适配',
  target_modified: '目标变更',
  target_overlay: '源码适配',
  memory_files: '记忆文件',
  data_location: '数据位置',
  opencode_config: 'OpenCode 配置',
  module_load: '模块加载',
  post_state: '落盘状态',
  payload: '安装资产',
  profile: 'Agent Profile',
};

// The installer decides what this run actually installs — an optional surface it
// cannot land is absent from `plan.changes` — so a change is rendered from the
// installer's own entry, never from the manifest declaration.
function changeDetail(change) {
  if (change.name !== undefined && change.count !== undefined) return `${change.name} × ${change.count}`;
  if (change.name !== undefined) return String(change.name);
  if (change.count !== undefined) return `${change.count} 个`;
  if (Array.isArray(change.paths) && change.paths.length > 0) return change.paths.join('、');
  if (change.reason !== undefined) return String(change.reason);
  if (change.files !== undefined) return `${change.files} 个文件`;
  return '';
}

function planLines(manifest, plan) {
  if (Array.isArray(plan.changes)) {
    // `plan.changes` is the installer's authoritative account of this run,
    // including a legitimately empty one (no-op, or every candidate was an
    // optional surface that got skipped) — render it as-is rather than
    // falling back to the manifest, which would fabricate a component list
    // the installer never actually plans to install.
    if (plan.changes.length === 0) return ['  （本次无组件安装）'];
    return plan.changes.map((change) => {
      const detail = changeDetail(change);
      const label = COMPONENT_LABELS[change.kind] || change.kind;
      return detail ? `  • ${label}：${detail}` : `  • ${label}`;
    });
  }
  throw new CliError('plan.changes 必须为 object 数组');
}

function renderPlan(selection, plan, secretEnvironment = {}) {
  const manifest = selection.delivery.manifest;
  const plugin = manifest.plugin;
  const lines = [
    `  插件             ${plugin.name} ${plugin.version}`,
    `  目标 Coding Agent ${agentLabel(manifest.compatibility)}`,
    `  目标位置         ${selection.root}`,
    `  配置目录         ${selection.configRoot}`,
    '',
    '  将安装的组件',
    ...planLines(manifest, plan),
    '',
    `  ${plan.message}`,
  ];
  const patches = manifest.installation?.patches || [];
  if (patches.length > 0) {
    lines.push('', '注意：本次安装会修改 Coding Agent 源码。');
    for (const patch of patches) lines.push(`• ${patch.reason}`);
  }
  ui.note(outputRedactor(selection, secretEnvironment)(lines.join('\n')), '安装计划');
}

function evidenceDetail(evidence) {
  if (evidence.names) return evidence.names.join('、');
  if (evidence.tools) return evidence.tools.join('、');
  if (evidence.name && evidence.path) return `${evidence.name} (${evidence.path})`;
  if (evidence.name) return evidence.name;
  if (evidence.path) return evidence.path;
  if (evidence.paths) return evidence.paths.join('、');
  if (evidence.status) return evidence.status;
  return '已确认';
}

function renderCompletion(selection, verified, secretEnvironment = {}) {
  ui.step(`${selection.delivery.manifest.plugin.name} 已安装`);
  ui.note(outputRedactor(selection, secretEnvironment)([
    `自检通过：${verified.message}`,
    ...(verified.evidence || []).map(evidence => `${COMPONENT_LABELS[evidence.kind] || evidence.kind}：${evidenceDetail(evidence)}`),
  ].join('\n')), '安装结果');
  const commands = verified.deployment?.commands || [];
  for (const command of commands) {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    ui.note(command.argv.map(quote).join(' ') + ' --help', '可直接复制的持久入口');
    if (process.platform !== 'win32') {
      ui.note(`export PATH=${quote(path.dirname(command.argv[0]))}:"$PATH"\n` +
        ['codehelix', ...command.argv.slice(1), '--help'].map(quote).join(' '),
      '在当前终端启用 codehelix 业务命令（保留其他版本的安装）');
    }
  }
  ui.outro(commands.length ? '外挂安装完成。先查看入口帮助并运行 run --check 检查评测配置。' : '安装完成。请按插件说明重启宿主或开启新会话。');
}

async function runNative(selection, options, request) {
  const { createNativeSession } = require('./native-session.js');
  const session = createNativeSession();
  const operation = options.operation;
  const run = message => ui.task(
    message.operation === 'plan' ? '生成安装计划' : '执行宿主操作',
    async (report, signal) => {
      const result = await session.request(message, report, signal);
      if (result.status !== 'ok') {
        const logPath = writeFailureLog(selection, operation, { result, diagnostics: result.message }, request);
        throw new CliError(`${result.message}${result.status === 'partial' ? '\n操作已产生部分变更，请运行 inspect 确认当前状态。' : ''}\n失败日志：${logPath}`);
      }
      return result;
    },
  );
  try {
    const context = await ui.task('检查目标兼容性', (report, signal) => session.request({
      operation: 'prepare', delivery: selection.delivery.root, request,
      options: { requireConfiguration: operation === 'install' },
    }, report, signal), '目标兼容性检查通过');
    if (operation === 'install') await run({ operation: 'plan' });
    if (operation !== 'inspect') {
      const details = [
        `插件：${context.manifest.plugin.name} ${context.manifest.plugin.version}`,
        `宿主：${context.observation.platform} ${context.observation.version}`,
        `工作目录：${context.target.root}`,
        `配置目录：${context.target.config_root}`,
        ...Object.entries(request.configuration).map(([key, value]) =>
          `${configurationLabel(inputsFor(selection.delivery.manifest).find(input => input.id === key) || { id: key })}：${value}`),
        '', operation === 'install' ? '将注册插件并检查注册状态；完成后需要重启宿主或开启新会话。' : '将解除插件注册，保留已保存的业务数据。',
      ];
      ui.note(details.join('\n'), operation === 'install' ? '安装计划' : '移除计划');
      if (process.env.CODEHELIX_DEBUG) ui.step(`Adapter: ${context.adapter.id}`);
      if (!options.yes) {
        const confirmed = await choose(operation === 'install' ? '执行以上安装计划？' : '解除插件注册？', [
          { label: '确认', value: true }, { label: '取消', value: false },
        ]);
        if (!confirmed) throw new CliError('用户已取消');
      }
    }
    const result = await run({ operation });
    const observed = result.observation;
    if (observed) ui.step(`注册：${observed.registered ? '已注册' : '未注册'} · 启用：${observed.enabled ? '已启用' : '未启用'} · 版本：${observed.version || '未知'}`);
    for (const cap of result.optional_capabilities) if (!cap.available) ui.step(`未提供的可选增强: ${cap.name}`);
    ui.outro(operation === 'install'
      ? `${context.manifest.plugin.name} 安装完成。请重启宿主或开启新会话后使用。`
      : operation === 'remove' ? '插件注册已解除，业务数据已保留。' : '注册状态检查完成。');
    return 0;
  } finally {
    session.close();
  }
}

async function runInstall(argv) {
  const humanFlow = ['install', 'inspect', 'remove'].includes(argv[0])
    && !argv.some(arg => ['--help', '-h', '--list-targets'].includes(arg));
  if (humanFlow) {
    await ui.init();
    if (process.env.CODEHELIX_INSTALL_SESSION !== '1') {
      ui.intro();
      ui.step(`Source: ${pluginRoot}`);
      ui.step('Using local repository');
    }
  }
  const deliveries = humanFlow
    ? await ui.task('检查插件内容', async () => loadDeliveries(), '插件内容检查通过')
    : loadDeliveries();
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    printHelp(deliveries);
    return 0;
  }
  const options = parseArgs(argv);
  if (options.listTargets) {
    printTargets(deliveries, options);
    return 0;
  }
  const selection = await resolveTarget(deliveries, options);
  const managed = require('../installation/orchestrator.js').managed(selection.delivery.manifest);
  if (selection.delivery.manifest.execution?.mode === 'native' && options.method) {
    throw new CliError('此 Delivery 使用宿主原生插件注册，不支持 --method symlink/copy；请移除 --method 后重试。');
  }
  if (managed && options.operation === 'install') {
    if (!options.scope && isInteractive() && !options.yes) options.scope = await choose('Installation scope', [
      { label: 'Global', value: 'global' }, { label: 'Project', value: 'project' },
    ]);
    options.scope ||= 'global';
    if (options.scope === 'project' && !options.configRoot) {
      const agent = selection.delivery.manifest.compatibility.agent_system;
      selection.configRoot = path.join(selection.root, agent === 'icode' ? '.chrys' : `.${agent}`);
    }
    if (selection.delivery.manifest.managed_install?.skills?.length && !options.method && isInteractive() && !options.yes) {
      options.method = await choose('Installation method', [
        { label: 'Symlink', hint: '链接到 CodeHelix PackageStore', value: 'symlink' },
        { label: 'Copy', hint: '复制到目标并记录文件所有权', value: 'copy' },
      ]);
    }
    options.method ||= 'symlink';
  }
  const initial = managed && options.operation === 'install'
    ? require('../installation/orchestrator.js').configurationDefaults(selection.delivery.root,
      { ...buildRequest(selection, {}, options.home), scope: options.scope || 'global' })
    : { defaults: {}, saved: {} };
  const { configuration, secretEnvironment } = await collectConfiguration(selection, options, { ...initial.defaults, ...initial.saved });
  const request = buildRequest(selection, configuration, options.home);
  request.scope = options.scope || 'global';
  request.method = options.method || 'symlink';
  if (managed) {
    if (selection.delivery.manifest.compatibility.agent_system === 'icode' && options.operation === 'install') {
      selection.candidates = chrysCandidates.candidates(deliveries, selection.root, options.delivery);
    }
    return runManaged(selection, options, request, secretEnvironment);
  }
  if (selection.delivery.manifest.execution?.mode === 'native') {
    return runNative(selection, options, request);
  }
  if (options.operation !== 'install') throw new CliError('该 custom Delivery 尚未提供 inspect/remove');
  let checked, plan;
  if (selection.delivery.manifest.compatibility.agent_system === 'icode') {
    const selected = await chrysCandidates.selectByProbe(
      chrysCandidates.candidates(deliveries, selection.root, options.delivery),
      chrysCandidates.hostVersion(selection.root), async delivery => {
        const candidate = { ...selection, delivery };
        const checked = await runPhase(candidate, 'check', request, secretEnvironment);
        const plan = await runPhase(candidate, 'plan', request, secretEnvironment);
        return { checked, plan };
      });
    selection.delivery = selected.delivery;
    ({ checked, plan } = selected.result);
  } else {
    checked = await runPhase(selection, 'check', request, secretEnvironment);
    plan = await runPhase(selection, 'plan', request, secretEnvironment);
  }
  renderPlan(selection, plan, secretEnvironment);
  const assessment = selection.delivery.manifest.compatibility.agent_system === 'icode'
    ? require('../installation/orchestrator.js').assessCompatibility(selection.delivery.manifest, checked,
      { version: chrysCandidates.hostVersion(selection.root) })
    : null;
  if (assessment) ui.step(assessment.message);
  if (options.dryRun) { ui.outro('Dry run 完成，尚未写入安装内容。'); return 0; }
  const unverified = assessment?.status === 'unverified' || checked.evidence?.find(item => (
    item.kind === 'compatibility' && item.status === 'compatible' && item.verified === false
  ));
  if (!options.yes) {
    const confirmed = await choose(unverified ? '该目标版本未验证，仍执行以上安装计划？' : '执行以上安装计划？', [
      { label: unverified ? '确认试装并接受未验证风险' : '确认安装', value: true },
      { label: '取消', value: false },
    ]);
    if (!confirmed) throw new CliError('用户已取消安装');
  }
  const retainedSelection = await require('./repository.js').retainLegacySelection(selection, { ...options, home: request.home });
  await runPhase(retainedSelection, 'install', request, secretEnvironment);
  const verified = await runPhase(retainedSelection, 'verify', request, secretEnvironment);
  renderCompletion(retainedSelection, verified, secretEnvironment);
  return 0;
}

async function runManaged(selection, options, request, secretEnvironment) {
  // Core bounds each installer/runtime phase. A commit can include several
  // phases (and rollback), so a five-minute outer timer would kill valid work.
  const session = require('./native-session.js').createNativeSession('managed-worker.js', { timeoutMs: 0 });
  const redact = outputRedactor(selection, secretEnvironment);
  const invoke = (message, label) => ui.task(label, async (report, signal) => {
    try {
      const answer = await session.request({ ...message, secretEnvironment }, event => report({ ...event, label: redact(event.label) }), signal);
      if (answer.status !== 'ok') throw new CliError(answer.message);
      return answer;
    } catch (error) {
      if (signal.aborted) throw new CliError(redact(error.message));
      const logPath = writeFailureLog(selection, message.operation, { result: { message: error.message }, diagnostics: error.diagnostics }, request, secretEnvironment);
      throw new CliError(`${label}失败：${redact(error.message)}\n失败日志：${logPath}`, redact(error.diagnostics));
    }
  });
  try {
    const pluginId = selection.delivery.manifest.plugin.id;
    if (options.operation === 'inspect') {
      const inspected = await invoke({ operation: 'inspect', plugin_id: pluginId, request }, '检查已安装插件');
      ui.note(redact(JSON.stringify(inspected.observation, null, 2)), '安装状态');
      ui.outro(redact(inspected.message));
      return 0;
    }
    if (options.operation === 'remove') {
      const preview = await invoke({ operation: 'remove', plugin_id: pluginId, request: { ...request, dry_run: true } }, '生成移除计划');
      renderPlan(selection, preview, secretEnvironment);
      if (options.dryRun) { ui.outro('Dry run 完成，尚未解除插件激活。'); return 0; }
      if (!options.yes && !await choose('解除以上插件激活？业务数据会保留。', [{ label: '确认移除', value: true }, { label: '取消', value: false }])) throw new CliError('用户已取消');
      const removed = await invoke({ operation: 'remove', plugin_id: pluginId, request: { ...request, confirmed: true, expected_state_digest: preview.state_digest } }, '移除插件激活');
      ui.outro(redact(removed.message));
      return 0;
    }
    let prepared;
    if (selection.candidates?.length > 1) {
      const selected = await chrysCandidates.selectByProbe(selection.candidates, chrysCandidates.hostVersion(selection.root),
        delivery => invoke({ operation: 'prepare', delivery: delivery.root, request }, `检查接入：${chrysCandidates.deliveryId(delivery)}`));
      selection.delivery = selected.delivery;
      // The worker owns the pending plan; bind it to the selected candidate.
      prepared = await invoke({ operation: 'prepare', delivery: selection.delivery.root, request }, '生成所选 Delivery 安装计划');
    } else {
      prepared = await invoke({ operation: 'prepare', delivery: selection.delivery.root, request }, '检查目标并生成安装计划');
    }
    renderPlan(selection, prepared, secretEnvironment);
    ui.step(`PackageStore: ${prepared.package_ref.root}`);
    const methodLabel = selection.delivery.manifest.execution?.mode === 'native'
      ? '接入方式：宿主原生插件注册'
      : selection.delivery.manifest.managed_install?.skills?.length ? `Skill 方式：${request.method}` : '接入方式：宿主适配器接线';
    ui.step(`范围：${request.scope} · ${methodLabel}`);
    ui.step('内容完整性：Delivery lock 校验通过 · 外部安全扫描：未配置');
    if (options.dryRun) { ui.outro('Dry run 完成，尚未写入安装内容。'); return 0; }
    const unverified = prepared.compatibility_assessment?.status === 'unverified'
      || prepared.evidence.some(item => item.kind === 'compatibility' && item.verified === false);
    if (!options.yes && !await choose(unverified ? '该目标版本未验证，仍执行以上安装计划？' : '执行以上安装计划？', [
      { label: unverified ? '确认试装并接受未验证风险' : '确认安装', value: true }, { label: '取消', value: false },
    ])) throw new CliError('用户已取消安装');
    const installed = await invoke({ operation: 'commit' }, '安装并验证插件');
    renderCompletion(selection, installed, secretEnvironment);
    return 0;
  } finally { session.close(); }
}

function main(pluginRootPath, argv = process.argv.slice(2)) {
  if (!pluginRootPath) throw new Error('plugin-cli 需要调用方提供 pluginRoot');
  pluginRoot = path.resolve(pluginRootPath);
  return runInstall(argv).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    ui.fail(`安装未完成：${error.message}`);
    if (error.diagnostics && process.env.CODEHELIX_DEBUG) process.stderr.write(`${error.diagnostics}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  main, normalizeAgent, planLines, resolveConfigurationDefault, manualTarget,
  deliveryForAgent, resolveTarget, collectConfiguration, buildRequest, writeFailureLog, outputRedactor, runManaged,
  addSkill: require('./skill-cli.js').addSkill,
};

if (require.main === module) main(process.argv[2], process.argv.slice(3));
