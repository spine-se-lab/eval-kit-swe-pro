'use strict';

// Installed business commands resolve through the same state and integrity checks
// as inspect. No evaluator or Coding Agent knowledge belongs in this dispatcher.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveCodeHelixHome } = require('../installation/home.js');
const { inspect } = require('../installation/orchestrator.js');
const { safeChild } = require('../model/plugin.js');
const { runtimeEnvironment, declaredEnvironment } = require('../process/environment.js');

async function runCommand(name, argv) {
  const args = [], options = {};
  for (let i = 0; i < argv.length; i++) {
    if (['--home', '--deployment'].includes(argv[i])) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing ${argv[i]}`);
      options[argv[i].slice(2)] = argv[++i];
    } else args.push(argv[i]);
  }
  const home = resolveCodeHelixHome(options.home), stateRoot = path.join(home, 'state');
  const matches = [];
  for (const file of fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot).filter(n => n.endsWith('.json')) : []) {
    const state = JSON.parse(fs.readFileSync(path.join(stateRoot, file), 'utf8'));
    for (const deployment of state.deployments || []) {
      if (deployment.status !== 'installed' || options.deployment && options.deployment !== deployment.id) continue;
      const manifest = JSON.parse(fs.readFileSync(path.join(deployment.package_ref.root, 'codehelix-plugin.json'), 'utf8'));
      const command = manifest.managed_install?.commands?.find(c => c.name === name);
      if (command) matches.push({ plugin: state.plugin_id, deployment, manifest, command });
    }
  }
  if (!matches.length) throw new Error(`Command ${name} is not installed in ${home}; install its plugin first`);
  if (matches.length !== 1) throw new Error(`Multiple deployments export ${name}; select --deployment: ${matches.map(m => m.deployment.id).join(', ')}`);
  const { plugin, deployment, manifest, command } = matches[0];
  const checked = await inspect(plugin, { home, deployment_id: deployment.id });
  if (checked.status !== 'ok' || checked.observation?.drift?.length || checked.observation?.loaded === false || !checked.observation?.registered) throw new Error(`Installed command is unhealthy: ${checked.message}`);
  const runtime = deployment.runtime_refs[command.runtime];
  if (!runtime?.python || !path.isAbsolute(runtime.python)) throw new Error('Command has no bound Python');
  if (!/^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/.test(command.module)) throw new Error('Invalid command module');
  const source = safeChild(deployment.package_ref.root, command.source, 'Command source');
  const bootstrap = 'import sys,runpy; sys.path.insert(0,sys.argv.pop(1)); runpy.run_module(sys.argv.pop(1),run_name="__main__")';
  const env = runtimeEnvironment(declaredEnvironment(manifest), { CODEHELIX_PLUGIN_BINDING: deployment.config_ref.path, PYTHONDONTWRITEBYTECODE: '1' });
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.python, ['-B', '-c', bootstrap, source, command.module, ...args], { env, stdio: 'inherit' });
    const signals = ['SIGINT', 'SIGTERM'];
    const forward = signal => { if (!child.killed) child.kill(signal); };
    const handlers = signals.map(signal => { const handler = () => forward(signal); process.on(signal, handler); return handler; });
    const cleanup = () => signals.forEach((signal, i) => process.off(signal, handlers[i]));
    child.on('error', error => { cleanup(); reject(error); });
    child.on('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}

module.exports = { runCommand };
if (require.main === module) {
  const [name, ...args] = process.argv.slice(2);
  runCommand(name, args).then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
