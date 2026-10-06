'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Versions rank probes; they never decide whether an adapter can be installed.
function hostVersion(root) {
  try {
    const text = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8');
    const project = text.match(/^\[project\][ \t]*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] || '';
    if (!/^\s*name\s*=\s*["']chrys["']/m.test(project)) return null;
    return project.match(/^\s*version\s*=\s*["']([^"']+)["']/m)?.[1] || null;
  } catch { return null; }
}

function deliveryId(delivery) { return path.basename(delivery.root || delivery.manifest.compatibility.target_version); }

function rank(delivery, version) {
  const manifest = delivery.manifest;
  if (manifest.verification?.versions?.includes(version)) return 3;
  const baseline = String(manifest.compatibility.target_version || '').replace(/\.x$/, '');
  if (version === baseline) return 3;
  if (version?.startsWith(`${baseline}.`)) return 2;
  return 1;
}

function candidates(deliveries, root, explicit) {
  const version = hostVersion(root);
  const available = deliveries.filter(d => d.manifest.compatibility.agent_system === 'icode');
  const selected = explicit ? available.filter(d => deliveryId(d) === explicit) : available;
  if (!selected.length) throw new Error(`没有对应的 Chrys Delivery${explicit ? `：${explicit}` : ''}`);
  return selected.sort((a, b) => rank(b, version) - rank(a, version)
    || String(b.manifest.compatibility.target_version).localeCompare(String(a.manifest.compatibility.target_version), undefined, { numeric: true }));
}

async function selectByProbe(deliveries, version, probe) {
  const failures = [];
  for (const priority of [...new Set(deliveries.map(d => rank(d, version)))].sort((a, b) => b - a)) {
    const passing = [];
    for (const delivery of deliveries.filter(d => rank(d, version) === priority)) {
      try { passing.push({ delivery, result: await probe(delivery) }); }
      catch (error) { failures.push(`${deliveryId(delivery)}：${error.message}`); }
    }
    if (passing.length === 1) return passing[0];
    if (passing.length > 1) throw new Error(`多套 Delivery 通过能力预检，请用 --delivery 指定：${passing.map(p => deliveryId(p.delivery)).join('、')}`);
  }
  throw new Error(`没有 Delivery 通过接入预检：\n${failures.join('\n')}`);
}

module.exports = { hostVersion, deliveryId, candidates, selectByProbe };
