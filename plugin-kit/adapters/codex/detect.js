'use strict';

const fs = require('node:fs');
const { run } = require('../../process/run.js');

function detect(target) {
  const executable = target.executable || 'codex';
  const options = { cwd: target.root, env: { ...process.env, CODEX_HOME: target.config_root } };
  const version = /^codex-cli (\S+)\s*$/.exec(run(executable, ['--version'], options).trim())?.[1] || null;
  const help = run(executable, ['plugin', '--help'], options);
  return { platform: 'codex', version, executable,
    executable_identity: fs.existsSync(executable) ? fs.realpathSync(executable) : executable,
    capabilities: /\badd\b/.test(help) && /\blist\b/.test(help) && /\bremove\b/.test(help) ? ['plugin-cli'] : [],
  };
}

module.exports = { detect };
