'use strict';

const fs = require('node:fs');
const path = require('node:path');
const files = require('./managed-files.js');

// Source patches may touch the same host file. Recognize only a complete chain
// of committed before/after images, never an arbitrary diff or an unowned edit.
// This is read-only evidence, not permission to restore a lower layer.
function sourceLayers(home, deployment, activation, current) {
  const relative = path.relative(path.join(deployment.target.root, 'src'), activation.path);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || activation.post_state.type !== 'file' || current.type !== 'file') return null;
  const root = path.join(home, 'state');
  if (!fs.existsSync(root)) return null;
  const edges = [];
  for (const name of fs.readdirSync(root).filter(name => /^[a-z0-9-]+\.json$/.test(name))) {
    const state = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    if (state.schema !== 'codehelix.plugin_state/v2') continue;
    for (const other of state.deployments || []) {
      if ((state.plugin_id === deployment.package_ref.plugin_id && other.id === deployment.id) || other.status !== 'installed'
          || other.target.root !== deployment.target.root) continue;
      for (const item of other.activations || []) {
        if (item.path === activation.path && item.ownership === 'codehelix'
            && item.original?.type === 'file' && item.post_state?.type === 'file'
            && !files.same(item.original, item.post_state)) {
          edges.push({ plugin_id: state.plugin_id, deployment_id: other.id, ...item });
        }
      }
    }
  }
  let image = activation.post_state;
  const layers = [], visited = new Set();
  while (!files.same(image, current)) {
    const matches = edges.filter(item => files.same(item.original, image));
    if (matches.length !== 1 || visited.has(matches[0])) return null;
    const edge = matches[0];
    visited.add(edge);
    layers.push({ plugin_id: edge.plugin_id, deployment_id: edge.deployment_id });
    image = edge.post_state;
  }
  return layers.length ? layers : null;
}

module.exports = { sourceLayers };
