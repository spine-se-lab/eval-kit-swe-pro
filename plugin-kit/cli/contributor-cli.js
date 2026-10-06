'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { PluginContractError, loadDescriptor, validatePlugin } = require('../model/plugin.js');

class ContributorError extends Error {}

function titleFromId(pluginId) {
  return pluginId
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function scaffoldFiles(pluginId, name) {
  const executable = `codehelix-${pluginId}`;
  return {
    'README.md': [
      `# ${name}`,
      '',
      '状态：draft。这里说明能力用途、Source 来源、支持目标和验收证据。',
      '',
      '先在 `source/` 维护能力，在 `targets/` 声明目标；不要直接维护 `delivery/`。',
      '',
    ].join('\n'),
    'package.json': `${JSON.stringify({
      name: executable,
      version: '0.1.0',
      private: true,
      description: `${name} 本地交互安装入口`,
      bin: { [executable]: 'bin/codehelix-plugin.js' },
      files: ['bin', 'delivery'],
      engines: { node: '>=18' },
    }, null, 2)}\n`,
    'bin/codehelix-plugin.js': [
      '#!/usr/bin/env node',
      "'use strict';",
      '',
      "const path = require('node:path');",
      '',
      "const pluginRoot = path.resolve(__dirname, '..');",
      'let cli;',
      'try {',
      "  cli = require('../../../plugin-kit/cli/plugin-cli.js');",
      '} catch (error) {',
      "  process.stderr.write('\\n安装未完成：插件根入口需要在完整仓库 checkout 中运行\\n');",
      "  if (process.env.CODEHELIX_DEBUG) process.stderr.write(`${error.message}\\n`);",
      '  process.exit(1);',
      '}',
      '',
      'cli.main(pluginRoot);',
      '',
    ].join('\n'),
    'build-delivery': [
      '#!/usr/bin/env python3',
      '"""Build this plugin\'s declared target deliveries."""',
      '',
      'raise SystemExit(',
      '    "尚未实现目标打包：先按目标官方规范添加 targets 声明和 Source 适配，再实现本脚本。"',
      ')',
      '',
    ].join('\n'),
    'source/.gitkeep': '',
    'targets/.gitkeep': '',
  };
}

function createPlugin(repoRoot, args) {
  const pluginId = args[0];
  if (!pluginId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginId)) {
    throw new ContributorError('用法：npx . create-plugin <kebab-case-plugin-id>');
  }
  const custom = args[1] === '--custom';
  if (args.length > (custom ? 2 : 1)) throw new ContributorError(`未知参数：${args[1]}`);

  const pluginRoot = path.join(repoRoot, 'plugins', pluginId);
  if (fs.existsSync(pluginRoot)) throw new ContributorError(`Plugin 已存在：${pluginId}`);

  const name = titleFromId(pluginId);
  fs.mkdirSync(pluginRoot, { recursive: false });
  writeJson(path.join(pluginRoot, 'codehelix-plugin.json'), {
    schema: 'codehelix.plugin/v1',
    plugin: {
      id: pluginId,
      name,
      version: '0.1.0',
      description: {
        'zh-CN': 'TODO: 描述这个 Plugin 的用途。',
        en: 'TODO: describe this plugin.',
      },
    },
    status: 'draft',
    documentation: 'README.md',
    targets: custom ? [] : ['targets/codex-native.json', 'targets/opencode-native.json'],
    ...(custom ? {} : { content: { skills: 'source/assets/skills' } }),
  });

  for (const [relative, contents] of Object.entries(scaffoldFiles(pluginId, name))) {
    if (!custom && ['build-delivery', 'source/.gitkeep', 'targets/.gitkeep'].includes(relative)) continue;
    const destination = path.join(pluginRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents, 'utf8');
  }
  fs.chmodSync(path.join(pluginRoot, 'bin', 'codehelix-plugin.js'), 0o755);
  if (custom) fs.chmodSync(path.join(pluginRoot, 'build-delivery'), 0o755);
  else {
    const skill = path.join(pluginRoot, 'source/assets/skills', pluginId, 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, `---\nname: ${pluginId}\ndescription: Use when the user explicitly requests the ${name} workflow.\n---\n\n# ${name}\n\nThis is a draft Skill. Ask the contributor to define the workflow before using it.\n`);
    for (const adapter of require('../adapters/registry.js').adapters) {
      fs.mkdirSync(path.join(pluginRoot, 'targets'), { recursive: true });
      writeJson(path.join(pluginRoot, 'targets', `${adapter.platform}-native.json`), {
        schema: 'codehelix.native_target/v1', profile: `${adapter.platform}-native`,
        execution: { mode: 'native', adapter: adapter.id },
        compatibility: { agent_system: adapter.platform, harness: adapter.platform, target_version: adapter.versionRange, required_paths: [] },
        required_capabilities: ['skills'], optional_capabilities: [], verification: { level: 'none' },
      });
    }
  }

  process.stdout.write([
    `已创建 draft Plugin：plugins/${pluginId}`,
    custom ? '下一步：维护 source/，添加 custom target 和 build-delivery。' : `下一步：编辑 source/assets/skills/，运行 npx . build ${pluginId}；原生目标不需要编写 installer。`,
    '',
  ].join('\n'));
  return 0;
}

function pluginRootFor(repoRoot, pluginId) {
  if (!pluginId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginId)) {
    throw new ContributorError('必须提供有效的 Plugin ID');
  }
  const pluginRoot = path.join(repoRoot, 'plugins', pluginId);
  if (!fs.existsSync(pluginRoot) || !fs.statSync(pluginRoot).isDirectory()) {
    throw new ContributorError(`Plugin 不存在：${pluginId}`);
  }
  return pluginRoot;
}

function validateCommand(repoRoot, args) {
  if (args.length !== 1) throw new ContributorError('用法：npx . validate <plugin-id>');
  const result = validatePlugin(pluginRootFor(repoRoot, args[0]));
  const lines = [
    `Plugin 描述符有效：${result.descriptor.plugin.id} ${result.descriptor.plugin.version}`,
    `${result.targets.length} 个目标声明，${result.deliveryCount} 个 Delivery`,
  ];
  // 0 target 的 draft 是合法状态，但“描述符有效”本身不代表任何目标装得上，
  // 所以这里必须显式说明它还不可构建、不可安装。
  if (result.targets.length === 0) {
    lines.push('该 Plugin 尚未声明任何目标，还不能构建或安装；请添加 targets/<profile>.json 并在描述符中登记。');
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));
  return 0;
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', (error) => {
      process.stderr.write(`无法执行 ${command}：${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code, signal) => resolve(code === null ? (signal ? 1 : 0) : code));
  });
}

async function buildCommand(repoRoot, args) {
  if (args.length !== 1) throw new ContributorError('用法：npx . build <plugin-id>');
  const pluginRoot = pluginRootFor(repoRoot, args[0]);
  const descriptor = loadDescriptor(pluginRoot);
  const buildScript = path.join(pluginRoot, 'build-delivery');
  const targets = descriptor.targets.map(relative => require('../model/plugin.js').loadTarget(pluginRoot, relative));
  const hasCustom = targets.some(target => target.execution?.mode !== 'native');
  if (hasCustom && !fs.existsSync(buildScript)) throw new ContributorError(`缺少构建入口：plugins/${args[0]}/build-delivery`);
  const needsCustomBuild = hasCustom || (!targets.length && fs.existsSync(buildScript));
  // Standalone repositories may be checked out from filesystems that cannot
  // preserve POSIX executable bits. The custom build entry is Python on every
  // platform, so invoke it explicitly and keep the build behavior identical.
  const buildExecutable = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const buildArgs = [buildScript];
  const code = needsCustomBuild
    ? await runProcess(buildExecutable, buildArgs, { cwd: repoRoot }) : 0;
  if (code !== 0) {
    process.stderr.write(`构建失败：plugins/${args[0]}/build-delivery 退出码 ${code}\n`);
    return code;
  }
  require('../build/native-build.js').buildNative(pluginRoot);
  const result = validatePlugin(pluginRoot);
  process.stdout.write(`构建并验证完成：${descriptor.plugin.id}（${result.deliveryCount} 个 Delivery）\n`);
  return 0;
}

async function testInstallCommand(repoRoot, args) {
  const [pluginId, ...installArgs] = args;
  if (!pluginId) {
    throw new ContributorError('用法：npx . test-install <plugin-id> --target <real-path> [安装选项]');
  }
  const targetIndex = installArgs.indexOf('--target');
  const target = targetIndex >= 0 ? installArgs[targetIndex + 1] : null;
  if (!target || target.startsWith('--')) {
    throw new ContributorError('建议验收必须显式提供真实目标：--target <real-path>');
  }
  const pluginRoot = pluginRootFor(repoRoot, pluginId);
  process.stdout.write('开始建议验收：委托 Plugin 的真实 install 流程；此命令不属于 build/validate 强制门禁。\n');
  return runProcess('npx', ['--yes', pluginRoot, 'install', ...installArgs], { cwd: process.cwd() });
}

// 每个分支都必须 await：不 await 时 async 命令的 rejection 会绕过本函数的 try/catch，
// 退出码与错误前缀改由调用方的兜底处理决定，同一类合同错误就会出现两种表现。
async function run(repoRoot, argv) {
  const [command, ...args] = argv;
  try {
    if (command === 'create-plugin') return await createPlugin(repoRoot, args);
    if (command === 'build') return await buildCommand(repoRoot, args);
    if (command === 'validate') return await validateCommand(repoRoot, args);
    if (command === 'test-install') return await testInstallCommand(repoRoot, args);
    throw new ContributorError(`贡献者命令尚未实现：${command}`);
  } catch (error) {
    if (!(error instanceof ContributorError) && !(error instanceof PluginContractError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

module.exports = { run };
