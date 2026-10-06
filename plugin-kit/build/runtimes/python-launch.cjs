'use strict';

// Standard Python-package launch through uv's own environment/cache management.
// No per-plugin installer or postinstall script runs in the host's installation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

try {
  const [name, settingsEnv, settingsDefault, pluginId] = process.argv.slice(2);
  const servers = JSON.parse(fs.readFileSync(path.join(__dirname, 'servers.json'), 'utf8'));
  const server = servers.find(s => s.name === name);
  if (!server) throw new Error('Unknown MCP server');
  let workspace = process.env[server.workspace_env];
  let bindingPath = process.env.CODEHELIX_PLUGIN_BINDING;
  if (settingsEnv && settingsDefault && pluginId) {
    const configRoot = process.env[settingsEnv] || path.join(os.homedir(), settingsDefault);
    const file = path.join(configRoot, 'codehelix', `${pluginId}.json`);
    if (fs.existsSync(file)) {
      const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
      workspace ||= settings.workbench_workspace;
      bindingPath ||= settings._codehelix_binding;
    }
  }
  let prepared;
  if (bindingPath) {
    if (!path.isAbsolute(bindingPath)) throw new Error('Managed binding must be an absolute path');
    const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    if (binding.schema !== 'codehelix.plugin_binding/v1') throw new Error('Invalid managed Runtime binding');
    workspace ||= binding.configuration?.workbench_workspace;
    prepared = binding.runtimes?.[name];
    if (!prepared?.executable || !fs.existsSync(path.join(prepared.root, 'ready.json'))) throw new Error('Managed MCP Runtime is not ready; reinstall the plugin');
  }
  if (!workspace || !path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error(`Set ${server.workspace_env} to an existing absolute knowledge workspace; refusing an implicit cwd fallback`);
  }
  if (!server.wheel || path.basename(server.wheel) !== server.wheel || !server.wheel.endsWith('.whl')) throw new Error('Missing Python runtime wheel');
  const { runtimeEnvironment } = require('./environment.cjs');
  const environment = runtimeEnvironment([server.workspace_env, ...(server.env_vars || [])],
    { [server.workspace_env]: workspace, PYTHONDONTWRITEBYTECODE: '1' });
  const child = prepared
    ? spawn(prepared.executable, [], { stdio: 'inherit', env: environment })
    : spawn('uv', ['tool', 'run', '--from', path.join(__dirname, name, server.wheel), server.runtime.command], {
    stdio: 'inherit', env: environment,
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
