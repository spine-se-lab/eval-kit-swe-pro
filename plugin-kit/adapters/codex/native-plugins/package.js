'use strict';

const fs = require('node:fs');
const path = require('node:path');

function packageRoot(delivery, manifest) {
  return path.join(delivery, 'plugins', manifest.plugin.id);
}

function buildPackage({ delivery, manifest, copyContent, writeJson }) {
  const root = packageRoot(delivery, manifest);
  const servers = copyContent(root);
  const plugin = { name: manifest.plugin.id, version: manifest.plugin.version,
    description: manifest.plugin.description.en, skills: './skills/',
    author: { name: 'CodeHelix' },
    interface: {
      displayName: manifest.plugin.name, shortDescription: manifest.plugin.description.en,
      longDescription: manifest.plugin.description.en, developerName: 'CodeHelix',
      category: 'Productivity', capabilities: manifest.required_capabilities,
      defaultPrompt: `Use ${manifest.plugin.name} when its Skills match the current task.`,
    },
  };
  if (servers.length) {
    plugin.mcpServers = './.mcp.json';
    writeJson(path.join(root, '.mcp.json'), { mcpServers: Object.fromEntries(servers.map(server => [server.name, {
      command: 'node', cwd: '.',
      args: ['runtime/launch.cjs', server.name, 'CODEX_HOME', '.codex', manifest.plugin.id],
      env_vars: [...new Set(['CODEX_HOME', 'CODEHELIX_HOME', server.workspace_env, 'UV_CACHE_DIR', ...(server.env_vars || [])])],
      ...(manifest.execution.tool_timeout_sec === undefined
        ? {} : { tool_timeout_sec: manifest.execution.tool_timeout_sec }),
    }])) });
  }
  writeJson(path.join(root, '.codex-plugin/plugin.json'), plugin);
  writeJson(path.join(delivery, '.agents/plugins/marketplace.json'), {
    name: `codehelix-${manifest.plugin.id}`,
    interface: { displayName: 'CodeHelix' },
    plugins: [{ name: manifest.plugin.id, source: { source: 'local', path: `./plugins/${manifest.plugin.id}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
  });
}

function validatePackage(delivery, manifest) {
  const root = packageRoot(delivery, manifest);
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'), 'utf8'));
  if (plugin.name !== manifest.plugin.id || plugin.version !== manifest.plugin.version || plugin.skills !== './skills/') {
    throw new Error('Codex manifest does not match plugin identity or skills');
  }
  if (!fs.statSync(path.join(root, 'skills')).isDirectory()) throw new Error('Missing Codex skills');
  if (manifest.content.mcp?.length) {
    if (plugin.mcpServers !== './.mcp.json') throw new Error('Missing Codex MCP manifest');
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers;
    for (const server of manifest.content.mcp) {
      const actual = mcp?.[server.name];
      if (actual?.command !== 'node' || actual.cwd !== '.' || actual.args?.[0] !== 'runtime/launch.cjs'
        || actual.args?.[1] !== server.name || !actual.env_vars?.includes(server.workspace_env)
        || actual.tool_timeout_sec !== manifest.execution.tool_timeout_sec) throw new Error('Invalid Codex MCP binding');
    }
  }
  const market = JSON.parse(fs.readFileSync(path.join(delivery, '.agents/plugins/marketplace.json'), 'utf8'));
  if (market.name !== `codehelix-${manifest.plugin.id}` || market.plugins.length !== 1
      || market.plugins[0].source.path !== `./plugins/${manifest.plugin.id}`) throw new Error('Invalid local marketplace');
}

module.exports = { buildPackage, validatePackage, packageRoot };
