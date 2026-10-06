'use strict';

// Deliberately limited to the stable half-open ranges used by registered adapters.
// Nightly, forks and prereleases require a separate, explicit contract detector.
function stableVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version || '');
  return match ? match.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function inRange(version, range) {
  const parts = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(range || '');
  if (!parts) throw new Error(`Unsupported adapter range: ${range}`);
  const lower = stableVersion(parts[1]);
  const upper = stableVersion(parts[2]);
  if (!lower || !upper || compare(lower, upper) >= 0) throw new Error(`Invalid adapter range: ${range}`);
  const actual = stableVersion(version);
  return Boolean(actual && compare(actual, lower) >= 0 && compare(actual, upper) < 0);
}

function validateRegistry(adapters) {
  const ids = new Set();
  for (const adapter of adapters) {
    if (ids.has(adapter.id)) throw new Error(`Duplicate adapter: ${adapter.id}`);
    ids.add(adapter.id);
    inRange('0.0.0', adapter.versionRange);
    for (const other of adapters) {
      if (other === adapter || other.platform !== adapter.platform) continue;
      const minimum = /^>=([^ ]+)/.exec(adapter.versionRange)[1];
      if (inRange(minimum, other.versionRange)) throw new Error(`Overlapping adapters: ${adapter.id}, ${other.id}`);
    }
  }
}

function resolveAdapter(observation, required = [], candidates = require('./registry.js').adapters) {
  const matches = candidates.filter(adapter => adapter.platform === observation.platform
    && inRange(observation.version, adapter.versionRange)
    && (adapter.probes || []).every(cap => observation.capabilities.includes(cap))
    && required.every(cap => adapter.capabilities.includes(cap)));
  if (matches.length !== 1) throw new Error(`Expected one compatible adapter for ${observation.platform} ${observation.version || '(unknown version)'}; found ${matches.length}`);
  return matches[0];
}

module.exports = { stableVersion, inRange, resolveAdapter, validateRegistry };
