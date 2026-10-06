'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TARGET_SCHEMA = 'codehelix.native_target/v1';
const PACKAGE_SCHEMA = 'codehelix.native_package/v1';

function contract(condition, message) {
  if (!condition) throw new (require('./plugin.js').PluginContractError)(message);
}

function validateTarget(target, label) {
  contract(target.schema === TARGET_SCHEMA, `${label}: unknown native target schema`);
  contract(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(target.profile || ''), `${label}: invalid profile`);
  contract(!Object.hasOwn(target, 'plugin'), `${label}: identity belongs in the descriptor`);
  contract(target.execution?.mode === 'native', `${label}: execution.mode must be native`);
  contract(typeof target.execution.adapter === 'string', `${label}: execution.adapter is required`);
  const adapter = require('../adapters/registry.js').getAdapter(target.execution.adapter);
  if (target.execution.tool_timeout_sec !== undefined) {
    contract(adapter.platform === 'codex'
      && Number.isInteger(target.execution.tool_timeout_sec)
      && target.execution.tool_timeout_sec > 0,
    `${label}: execution.tool_timeout_sec must be a positive integer for Codex`);
  }
  contract(!Object.hasOwn(target, 'installer') && !Object.hasOwn(target, 'installation'), `${label}: native targets must not declare an installer`);
  contract(target.compatibility?.agent_system === adapter.platform, `${label}: platform does not match adapter`);
  contract(target.compatibility.harness === adapter.platform, `${label}: unsupported harness`);
  contract(target.compatibility.target_version === adapter.versionRange, `${label}: use the adapter's supported range ${adapter.versionRange}`);
  contract(Array.isArray(target.required_capabilities) && target.required_capabilities.length > 0,
    `${label}: required_capabilities must be a nonempty array`);
  contract(target.required_capabilities.every(c => adapter.capabilities.includes(c)), `${label}: unavailable required capability`);
  contract(Array.isArray(target.optional_capabilities) && target.optional_capabilities.every(c => typeof c === 'string' && /^[a-z_]+$/.test(c)), `${label}: optional_capabilities must contain capability names`);
  contract(new Set([...target.required_capabilities, ...target.optional_capabilities]).size === target.required_capabilities.length + target.optional_capabilities.length, `${label}: duplicate capability`);
  require('./plugin.js').validateVerification(label, target);
  return target;
}

function validateContent(root, descriptor) {
  const { safeChild, walkFiles } = require('./plugin.js');
  const content = descriptor.content;
  contract(content && typeof content === 'object', 'Native plugins require descriptor.content');
  contract(typeof content.skills === 'string', 'content.skills must be a source directory');
  contract(content.skills.startsWith('source/'), 'Native content must live under source/');
  const skills = safeChild(path.join(root, 'source'), content.skills.slice(7), 'content.skills');
  contract(fs.existsSync(skills) && fs.statSync(skills).isDirectory(), 'Missing skills directory');
  const files = walkFiles(skills);
  contract(files.some(f => /^[^/]+\/SKILL\.md$/.test(f)), 'At least one Skill is required');
  for (const file of files.filter(f => f.endsWith('/SKILL.md'))) {
    const body = fs.readFileSync(path.join(skills, file), 'utf8');
    const name = /^name:\s*([a-z0-9-]+)\s*$/m.exec(body)?.[1];
    contract(body.startsWith('---\n') && name === path.dirname(file) && /^description:\s*\S/m.test(body), `Invalid Skill frontmatter: ${file}`);
  }
  const mcp = content.mcp || [];
  contract(Array.isArray(mcp), 'content.mcp must be an array');
  const names = new Set();
  for (const server of mcp) {
    contract(/^[a-z][a-z0-9-]+$/.test(server.name || '') && !names.has(server.name), 'MCP names must be unique kebab-case identifiers');
    names.add(server.name);
    contract(server.runtime?.kind === 'python', 'Only the Python package runtime is supported');
    contract(typeof server.runtime.source === 'string' && server.runtime.source.startsWith('source/'), 'Runtime must live under source/');
    const runtime = safeChild(path.join(root, 'source'), server.runtime.source.slice(7), 'runtime.source');
    contract(fs.existsSync(path.join(runtime, 'pyproject.toml')), 'Python runtime requires pyproject.toml');
    walkFiles(runtime);
    contract(/^[a-zA-Z0-9_.-]+$/.test(server.runtime.command || ''), 'runtime.command must be a console script');
    contract(/^[A-Z][A-Z0-9_]+$/.test(server.workspace_env || ''), 'MCP requires an explicit workspace environment variable');
    contract(server.env_vars === undefined || Array.isArray(server.env_vars)
      && server.env_vars.every(name => typeof name === 'string' && /^[A-Z][A-Z0-9_]+$/.test(name)), 'MCP env_vars must contain variable names, never values');
  }
  validateConfiguration(descriptor.native_configuration || {}, mcp.length > 0);
  if (content.legacy_opencode) {
    contract(typeof content.legacy_opencode === 'string' && content.legacy_opencode.startsWith('source/'), 'Legacy binding must live under source/');
    validateLegacy(JSON.parse(fs.readFileSync(safeChild(path.join(root, 'source'), content.legacy_opencode.slice(7), 'legacy_opencode'), 'utf8')));
  }
  return content;
}

function validateConfiguration(configuration, hasMcp) {
  contract(configuration && typeof configuration === 'object' && !Array.isArray(configuration), 'Native configuration must be an object');
  // The first contract only exposes explicit Knowledge workspace selection.
  // Add other input semantics together with their host/runtime mapping.
  for (const [key, value] of Object.entries(configuration)) {
    contract(key === 'workbench_workspace' && value?.type === 'path' && value.required === true,
      'Only the required workbench_workspace path input is supported');
  }
  contract(Boolean(configuration.workbench_workspace) === hasMcp, 'MCP content requires the workbench_workspace input');
}

function validateLegacy(legacy) {
  contract(legacy?.schema === 'codehelix.legacy_opencode/v1' && legacy.skills && typeof legacy.skills === 'object', 'Invalid legacy binding');
  for (const [file, digest] of Object.entries(legacy.skills)) {
    contract(/^[a-z0-9-]+\/[^\\]+$/.test(file) && !file.split('/').includes('..') && /^[a-f0-9]{64}$/.test(digest), 'Invalid legacy Skill fingerprint');
  }
  if (legacy.mcp) {
    contract(/^[a-z][a-z0-9-]+$/.test(legacy.mcp.name) && /^[a-zA-Z0-9_.-]+$/.test(legacy.mcp.console_script)
      && /^[A-Z][A-Z0-9_]+$/.test(legacy.mcp.workspace_env), 'Invalid legacy MCP binding');
  }
}

function compiledManifest(descriptor, target) {
  const { schema, profile, ...fields } = target;
  return {
    schema: PACKAGE_SCHEMA,
    plugin: descriptor.plugin,
    ...fields,
    configuration: descriptor.native_configuration || {},
    content: descriptor.content,
    components: [
      { kind: 'skills', name: descriptor.plugin.name },
      ...(descriptor.content.mcp || []).map(server => ({ kind: 'mcp_server', name: server.name, transport: server.transport || 'stdio',
        ...Object.fromEntries(['description', 'tools', 'data_access'].filter(key => server[key] !== undefined).map(key => [key, server[key]])) })),
    ],
  };
}

function validateDelivery(delivery, manifest) {
  const { validateDeliveryLock } = require('./plugin.js');
  contract(manifest.schema === PACKAGE_SCHEMA && manifest.execution?.mode === 'native', 'Invalid native package');
  contract(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.plugin?.id || '') && /^\d+\.\d+\.\d+$/.test(manifest.plugin?.version || ''), 'Invalid native plugin identity');
  const { plugin, ...targetFields } = manifest;
  validateTarget({ ...targetFields, schema: TARGET_SCHEMA, profile: 'delivery' }, 'Native package');
  validateConfiguration(manifest.configuration, Boolean(manifest.content?.mcp?.length));
  contract(manifest.required_capabilities.includes('skills') && (manifest.required_capabilities.includes('mcp') === Boolean(manifest.content?.mcp?.length)), 'Required capabilities must match the packaged content');
  const adapter = require('../adapters/registry.js').getAdapter(manifest.execution.adapter);
  contract(manifest.compatibility?.agent_system === adapter.platform, 'Native package platform mismatch');
  contract(manifest.compatibility?.target_version === adapter.versionRange, 'Native package adapter range mismatch');
  validateDeliveryLock(delivery, manifest.plugin.id);
  const legacy = path.join(delivery, 'legacy-opencode.json');
  if (fs.existsSync(legacy)) validateLegacy(JSON.parse(fs.readFileSync(legacy, 'utf8')));
  adapter.validatePackage(delivery, manifest);
  const root = adapter.packageRoot(delivery, manifest);
  if (manifest.content?.mcp?.length) {
    contract(fs.statSync(path.join(root, 'runtime/launch.cjs')).isFile(), 'Missing MCP launcher');
    const servers = JSON.parse(fs.readFileSync(path.join(root, 'runtime/servers.json'), 'utf8'));
    contract(Array.isArray(servers) && servers.length === manifest.content.mcp.length, 'MCP server inventory mismatch');
    for (let i = 0; i < servers.length; i++) {
      const { wheel, ...server } = servers[i];
      contract(require('node:util').isDeepStrictEqual(server, manifest.content.mcp[i]), 'MCP runtime mapping mismatch');
      contract(typeof wheel === 'string' && path.basename(wheel) === wheel && wheel.endsWith('.whl'), 'Invalid MCP wheel');
      contract(fs.statSync(path.join(root, 'runtime', server.name, wheel)).isFile(), 'Missing MCP wheel');
    }
  }
  return adapter;
}

module.exports = { TARGET_SCHEMA, PACKAGE_SCHEMA, validateTarget, validateContent, compiledManifest, validateDelivery };
