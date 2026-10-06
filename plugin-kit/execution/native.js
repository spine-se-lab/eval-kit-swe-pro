'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { validateDelivery } = require('../model/native.js');
const { resolveAdapter } = require('../adapters/resolve.js');
const { validateConfiguration } = require('../model/install-inputs.js');

function prepare(delivery, request, { requireConfiguration = true } = {}) {
  delivery = fs.realpathSync(delivery);
  const manifest = JSON.parse(fs.readFileSync(path.join(delivery, 'codehelix-plugin.json'), 'utf8'));
  const adapter = validateDelivery(delivery, manifest);
  const target = structuredClone(request.target);
  if (!target || !path.isAbsolute(target.root || '') || !path.isAbsolute(target.config_root || '')) throw new Error('Target root and config_root must be absolute paths');
  if (!fs.statSync(target.root).isDirectory()) throw new Error('Target root is not a directory');
  const observation = adapter.detect(target);
  if (request.expected_host && !isDeepStrictEqual(request.expected_host, observation)) throw new Error('Host changed after preview; create a new plan');
  const selected = resolveAdapter(observation, manifest.required_capabilities);
  if (adapter.id !== selected.id) throw new Error('Artifact is not compatible with the selected adapter');
  let configuration = structuredClone(request.configuration || {});
  for (const key of Object.keys(configuration)) {
    if (!Object.hasOwn(manifest.configuration, key)) throw new Error(`Unknown configuration: ${key}`);
  }
  if (requireConfiguration) configuration = validateConfiguration(manifest, configuration, target.root);
  if (requireConfiguration && manifest.content.mcp?.length) {
    const workspace = configuration.workbench_workspace;
    if (!workspace || !path.isAbsolute(workspace) || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
      throw new Error('workbench_workspace must be an explicit existing absolute directory');
    }
  }
  return { delivery, manifest, target, adapter, observation, configuration };
}

function execute(context, operation, { onProgress = () => {} } = {}) {
  const changes = [];
  const phase = (label, action, completed = label) => {
    onProgress({ label, state: 'started' });
    const value = action();
    onProgress({ label: completed, state: 'completed' });
    return value;
  };
  try {
    if (!['install', 'inspect', 'remove', 'plan'].includes(operation)) throw new Error(`Unknown native operation: ${operation}`);
    phase('复核目标与插件', () => {
      const current = context.adapter.detect(context.target);
      if (!isDeepStrictEqual(current, context.observation)) throw new Error('Host changed after preview; create a new plan');
      const selected = resolveAdapter(current, context.manifest.required_capabilities);
      if (selected.id !== context.adapter.id) throw new Error('Adapter changed after preview');
      const manifestNow = JSON.parse(fs.readFileSync(path.join(context.delivery, 'codehelix-plugin.json'), 'utf8'));
      if (!isDeepStrictEqual(manifestNow, context.manifest)) throw new Error('Artifact changed after preview; create a new plan');
      validateDelivery(context.delivery, context.manifest);
    }, '目标与插件复核通过');
    if (['plan', 'install'].includes(operation)) phase('检查安装条件', () => context.adapter.host.preflight?.(context), '安装条件检查通过');
    if (operation === 'plan') return result('ok', 'Delegate registration to the host; restart required after installation', context,
      [{ kind: 'native_plugin', name: context.manifest.plugin.id, path: context.target.config_root, action: 'register' }], null);
    if (operation === 'install') phase('注册插件', () => context.adapter.host.install(context, changes), '插件注册操作完成');
    if (operation === 'remove') phase('解除插件注册', () => context.adapter.host.remove(context, changes), '解除注册操作完成');
    const observed = phase('验证注册状态', () => {
      const observation = context.adapter.host.inspect(context);
      if (operation === 'install' && (!observation.registered || !observation.enabled)) throw new Error('Host did not confirm an enabled registration');
      if (operation === 'remove' && observation.registered) throw new Error('Host still reports the plugin as registered');
      return observation;
    }, '注册状态检查完成');
    return result('ok', operation === 'inspect' ? 'Observed current native registration' : `Native ${operation} completed; restart the host to reload`, context, changes, observed);
  } catch (error) {
    return result(changes.length ? 'partial' : 'blocked', error.message, context, changes, null);
  }
}

function result(status, message, context, changes, observation) {
  return { schema: 'codehelix.adapter_result/v1', status, message,
    adapter: context.adapter.id, host: context.observation, changes, observation,
    restart_required: changes.length > 0,
    optional_capabilities: context.manifest.optional_capabilities.map(name => ({ name, available: context.adapter.capabilities.includes(name) })),
  };
}

module.exports = { prepare, execute };
