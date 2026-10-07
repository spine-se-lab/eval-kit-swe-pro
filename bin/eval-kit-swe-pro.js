#!/usr/bin/env node
'use strict';

const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const pluginId = 'swe-pro-kit';
const pluginRoot = path.join(repositoryRoot, 'plugins', pluginId);
const contributorCommands = new Set(['build', 'validate', 'test-install']);

async function main() {
  let args = process.argv.slice(2);
  if (args[0] === pluginId) args = args.slice(1);

  if (contributorCommands.has(args[0])) {
    const contributor = require('../plugin-kit/cli/contributor-cli.js');
    return contributor.run(repositoryRoot, [args[0], pluginId, ...args.slice(1)]);
  }

  const cli = require('../plugin-kit/cli/plugin-cli.js');
  return cli.main(pluginRoot, args);
}

Promise.resolve(main()).then((code) => {
  if (Number.isInteger(code)) process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
