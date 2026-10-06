'use strict';

module.exports = {
  id: 'opencode/plugin-v1', platform: 'opencode',
  versionRange: '>=1.18.25 <1.19.0',
  capabilities: ['skills', 'mcp'], probes: ['plugin-loader-v1'],
  ...require('./package.js'),
  detect: require('../detect.js').detect,
  get host() { return require('./host/index.js'); },
};
