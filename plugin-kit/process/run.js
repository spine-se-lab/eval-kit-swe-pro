'use strict';

const { spawnSync } = require('node:child_process');

function run(command, args, options = {}) {
  const { includeStderr = false, ...spawnOptions } = options;
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 45000, maxBuffer: 16 * 1024 * 1024, ...spawnOptions });
  if (result.error || result.status !== 0) {
    const error = new Error(`${command} ${args.join(' ')}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
    error.command = [command, ...args];
    error.exitCode = result.status;
    throw error;
  }
  return result.stdout + (includeStderr ? result.stderr : '');
}

module.exports = { run };
