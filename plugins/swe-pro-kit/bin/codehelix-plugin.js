#!/usr/bin/env node
'use strict';

const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');

let cli;
try {
  cli = require('../../../plugin-kit/cli/plugin-cli.js');
} catch (error) {
  process.stderr.write('\n安装未完成：插件根入口需要在完整仓库 checkout 中运行\n');
  if (process.env.CODEHELIX_DEBUG) process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

cli.main(pluginRoot);
