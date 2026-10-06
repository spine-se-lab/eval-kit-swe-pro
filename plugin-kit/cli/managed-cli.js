#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const core = require('../installation/orchestrator.js');
const { redact } = require('../process/environment.js');

async function main() {
  const [operation, subject] = process.argv.slice(2);
  if (!['configuration-defaults', 'prepare', 'commit', 'inspect', 'remove'].includes(operation) || !subject) throw new Error('Usage: managed-cli.js <configuration-defaults|prepare|commit|inspect|remove> <delivery-or-plugin-id>; JSON request on stdin');
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const answer = operation === 'configuration-defaults'
    ? { schema: 'codehelix.managed_result/v1', status: 'ok', message: 'Installation configuration defaults resolved',
      changes: [], evidence: [], configuration_defaults: core.configurationDefaults(subject, request) }
    : await core[operation](subject, request, { onProgress: event => process.stderr.write(`${redact(JSON.stringify(event))}\n`) });
  process.stdout.write(`${redact(JSON.stringify(answer))}\n`);
  process.exitCode = answer.status === 'ok' ? 0 : 1;
}

main().catch(error => {
  process.stdout.write(`${redact(JSON.stringify({ schema: 'codehelix.managed_result/v1', status: 'blocked', message: error.message, changes: [], evidence: [], observation: null }))}\n`);
  process.exitCode = 1;
});
