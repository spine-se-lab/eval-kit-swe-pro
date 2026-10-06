'use strict';

module.exports = {
  id: 'codex/native-plugins', platform: 'codex',
  versionRange: '>=0.136.0 <0.137.0',
  capabilities: ['skills', 'mcp'], probes: ['plugin-cli'],
  ...require('./package.js'),
  detect: require('../detect.js').detect,
  get host() { return require('./host.js'); },
};
