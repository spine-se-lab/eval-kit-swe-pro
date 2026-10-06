#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { prepare, execute } = require('../execution/native.js');

try {
  const [operation, delivery] = process.argv.slice(2);
  if (!delivery || process.argv.length !== 4) throw new Error('Usage: adapter-cli.js <plan|install|inspect|remove> <delivery>; JSON request on stdin');
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (operation === 'select') {
    const context = prepare(delivery, request, { requireConfiguration: false });
    process.stdout.write(`${JSON.stringify({ schema: 'codehelix.adapter_result/v1', status: 'ok', adapter: context.adapter.id, host: context.observation, changes: [], message: 'Compatible native artifact' })}\n`);
    process.exit(0);
  }
  const context = prepare(delivery, request, { requireConfiguration: ['plan', 'install'].includes(operation) });
  const result = execute(context, operation);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'ok' ? 0 : 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ schema: 'codehelix.adapter_result/v1', status: 'blocked', message: error.message, changes: [], observation: null })}\n`);
  process.exitCode = 1;
}
