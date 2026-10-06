'use strict';

const fs = require('node:fs');
const { run } = require('../../process/run.js');

function detect(target) {
  const executable = target.executable || 'opencode';
  const options = { cwd: target.root, env: { ...process.env, OPENCODE_CONFIG_DIR: target.config_root } };
  const version = run(executable, ['--version'], options).trim();
  const help = run(executable, ['debug', '--help'], { ...options, includeStderr: true });
  return { platform: 'opencode', version, executable,
    executable_identity: fs.existsSync(executable) ? fs.realpathSync(executable) : executable,
    capabilities: /debug config/.test(help) && /debug skill/.test(help) ? ['plugin-loader-v1'] : [],
  };
}

module.exports = { detect };
