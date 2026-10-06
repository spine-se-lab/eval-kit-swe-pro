'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { run } = require('../../../process/run.js');
const { readText, writeText } = require('../../../files/config.js');
const { replacement } = require('./marketplace.js');

function invoke(context, args) {
  return run(context.target.executable || 'codex', ['plugin', ...args], {
    cwd: context.target.root, env: { ...process.env, CODEX_HOME: context.target.config_root },
  });
}

function identity(manifest) {
  return `${manifest.plugin.id}@codehelix-${manifest.plugin.id}`;
}

function inspect(context) {
  if (!fs.existsSync(context.target.config_root)) return { registered: false, enabled: false, version: null, loaded: null };
  // 0.136's CLI has no JSON output. Parse only its fixed, version-gated table;
  // unfamiliar output is unknown, never a successful installation.
  const id = identity(context.manifest);
  const output = invoke(context, ['list']);
  if (!/^PLUGIN\s+STATUS\s+VERSION\s+PATH\s*$/m.test(output) && output.trim() !== 'No marketplace plugins found.') {
    throw new Error('Unrecognized Codex plugin list output; current state is unknown');
  }
  const line = output.split('\n').find(row => row.trim().startsWith(`${id} `));
  if (!line) return { registered: false, enabled: false, version: null, loaded: null };
  const columns = line.trim().split(/\s{2,}/);
  if (columns[0] !== id || !['installed, enabled', 'installed, disabled', 'not installed'].includes(columns[1])) {
    throw new Error('Unrecognized Codex plugin list output');
  }
  const registered = columns[1].startsWith('installed,');
  return { registered, enabled: columns[1] === 'installed, enabled',
    version: registered && /^\d+\.\d+\.\d+/.test(columns[2]) ? columns[2] : null, loaded: null };
}

function install(context, changes) {
  const previous = preflight(context);
  fs.mkdirSync(context.target.config_root, { recursive: true });
  if (context.configuration.workbench_workspace) {
    const file = path.join(context.target.config_root, 'codehelix', `${context.manifest.plugin.id}.json`);
    const before = readText(file);
    const settings = before ? JSON.parse(before) : {};
    writeText(file, `${JSON.stringify({ ...settings, ...context.configuration }, null, 2)}\n`, before, changes);
  }
  // Mark attempted host mutations before invocation: an interrupted command can
  // have committed state even when it returns no parseable result.
  if (previous) {
    changes.push({ kind: 'native_marketplace', name: previous.name, path: previous.source, action: 'repoint-attempted' });
    invoke(context, ['marketplace', 'remove', previous.name]);
  }
  changes.push({ kind: 'native_marketplace', action: 'attempted', path: context.delivery });
  invoke(context, ['marketplace', 'add', context.delivery]);
  changes.push({ kind: 'native_plugin', name: identity(context.manifest), action: 'attempted' });
  invoke(context, ['add', identity(context.manifest)]);
}

function preflight(context) {
  if (!fs.existsSync(context.target.config_root)) return null;
  const text = readText(path.join(context.target.config_root, 'config.toml'));
  assertNoSecrets(sections(text).filter(section => ownSection(context, section)).map(section => section.text).join('\n'));
  return replacement(context, invoke(context, ['marketplace', 'list']));
}

function remove(context, changes) {
  if (!inspect(context).registered) return;
  changes.push({ kind: 'native_plugin', name: identity(context.manifest), action: 'remove-attempted' });
  invoke(context, ['remove', identity(context.manifest)]);
}

function marketplace(context) {
  if (!fs.existsSync(context.target.config_root)) return null;
  const listing = invoke(context, ['marketplace', 'list']);
  if (listing.trim() === 'No plugin marketplaces in scope.') return null;
  if (!/^MARKETPLACE\s+ROOT\s*$/m.test(listing)) throw new Error('Unrecognized Codex marketplace list output');
  const name = `codehelix-${context.manifest.plugin.id}`;
  const matches = listing.trim().split('\n').slice(1).map(line => line.trim().split(/\s{2,}/)).filter(row => row[0] === name);
  if (matches.length > 1 || (matches.length && !path.isAbsolute(matches[0][1] || ''))) throw new Error('Unknown Codex marketplace ownership');
  return matches.length ? { name, source: matches[0][1] } : null;
}

// A narrow TOML section scanner, not a second Codex configuration parser. It
// preserves unrelated bytes, skips headers inside strings/arrays, and refuses
// unsupported own-table layouts rather than guessing at their ownership.
function tablePath(header) {
  const parts = [], pattern = /\s*(?:([A-Za-z0-9_-]+)|("(?:[^"\\]|\\.)*")|'([^']*)')\s*(\.|$)/gy;
  let match;
  while ((match = pattern.exec(header))) {
    try { parts.push(match[1] || (match[2] ? JSON.parse(match[2]) : match[3])); } catch { return null; }
    if (!match[4]) return pattern.lastIndex === header.length ? parts : null;
  }
  return null;
}

function sections(text) {
  const result = [];
  let current = { keys: null, text: '' }, quote = null, depth = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const header = !quote && depth === 0 ? line.match(/^\s*(?:\[([^\[\]\r\n]+)\]|\[\[([^\[\]\r\n]+)\]\])\s*(?:#.*)?(?:\r?\n)?$/) : null;
    if (header) {
      result.push(current);
      current = { keys: tablePath(header[1] || header[2]), text: line };
      continue;
    }
    current.text += line;
    for (let i = 0; i < line.length; i++) {
      const char = line[i], triple = line.slice(i, i + 3);
      if (quote) {
        if (quote[0] === '"' && char === '\\') { i++; continue; }
        if (quote.length === 3 ? triple === quote : char === quote) { i += quote.length - 1; quote = null; }
      } else if (char === '#') break;
      else if (triple === '"""' || triple === "'''") { quote = triple; i += 2; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') depth--;
    }
    if (quote?.length === 1 || depth < 0) throw new Error('Unsupported Codex TOML layout; native recovery cannot be captured safely');
  }
  if (quote || depth) throw new Error('Unsupported Codex TOML layout; native recovery cannot be captured safely');
  result.push(current);
  return result;
}

function ownSection(context, section) {
  return (section.keys?.[0] === 'plugins' && section.keys[1] === identity(context.manifest))
    || (section.keys?.[0] === 'marketplaces' && section.keys[1] === `codehelix-${context.manifest.plugin.id}`);
}

function assertNoSecrets(text) {
  for (const line of text.split('\n')) {
    const assignment = line.match(/^\s*("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (assignment && /token|secret|password|api[_-]?key|authorization/i.test(assignment[1])
        && !/^["']?(?:\$\{[A-Z_][A-Z0-9_]*\}|\{env:[A-Z_][A-Z0-9_]*\})["']?\s*(?:#.*)?$/.test(assignment[2])) {
      throw new Error('Native rollback snapshot contains a credential; replace it with an environment reference before installation');
    }
  }
  if (/https?:\/\/[^\s/:@]+:[^\s/@]+@/i.test(text)) throw new Error('Native rollback snapshot contains a credential-bearing URL');
}

function capture(context) {
  preflight(context);
  const market = marketplace(context), plugin = inspect(context);
  const config = path.join(context.target.config_root, 'config.toml');
  const tables = sections(readText(config)).filter(section => ownSection(context, section));
  if (market && !tables.some(section => section.keys[0] === 'marketplaces' && section.keys.length === 2)) {
    throw new Error('Codex marketplace uses an unsupported configuration layout; cannot capture native recovery');
  }
  if (plugin.registered && !tables.some(section => section.keys[0] === 'plugins' && section.keys.length === 2)) {
    throw new Error('Codex plugin uses an unsupported configuration layout; cannot capture native recovery');
  }
  const settingsFile = path.join(context.target.config_root, 'codehelix', `${context.manifest.plugin.id}.json`);
  const settings = readText(settingsFile);
  assertNoSecrets(tables.map(section => section.text).join('\n'));
  if (settings && /"[^"\n]*(?:token|secret|password|api[_-]?key|authorization)[^"\n]*"\s*:/i.test(settings)) {
    throw new Error('Native plugin settings contain a credential; use an environment reference before installation');
  }
  return { schema: 'codehelix.native_host_snapshot/v1', adapter: 'codex/native-plugins', persistable: true,
    plugin_id: context.manifest.plugin.id, config_root: context.target.config_root,
    marketplace: market, marketplace_digest: market ? require('../../../model/plugin.js').digestTree(market.source) : null,
    plugin, tables, settings: { exists: fs.existsSync(settingsFile), text: settings } };
}

function restore(context, snapshot, changes = []) {
  if (snapshot?.schema !== 'codehelix.native_host_snapshot/v1' || snapshot.adapter !== 'codex/native-plugins'
      || snapshot.plugin_id !== context.manifest.plugin.id || snapshot.config_root !== context.target.config_root || snapshot.persistable !== true) {
    throw new Error('Native recovery snapshot does not match this Codex plugin target');
  }
  if (!Array.isArray(snapshot.tables) || snapshot.tables.some(section => !ownSection(context, section))
      || (snapshot.marketplace && snapshot.marketplace.name !== `codehelix-${context.manifest.plugin.id}`)) {
    throw new Error('Native recovery snapshot contains unrelated Codex registrations');
  }
  assertNoSecrets(snapshot.tables.map(section => section.text).join('\n'));
  if (snapshot.marketplace) {
    if (require('../../../model/plugin.js').digestTree(snapshot.marketplace.source) !== snapshot.marketplace_digest) {
      throw new Error('Previous Codex marketplace contents changed; refusing rollback');
    }
    replacement(context, `MARKETPLACE  ROOT\n${snapshot.marketplace.name}  ${snapshot.marketplace.source}\n`);
  }
  let current = marketplace(context);
  if (current && ![context.delivery, snapshot.marketplace?.source].filter(Boolean)
    .some(source => fs.realpathSync(source) === fs.realpathSync(current.source))) {
    throw new Error('Codex marketplace source changed outside this installation; refusing rollback');
  }
  // Remove only this plugin/cache, never the whole marketplace registry.
  if (inspect(context).registered) {
    changes.push({ kind: 'native_plugin', name: identity(context.manifest), action: 'rollback-remove-attempted' });
    invoke(context, ['remove', identity(context.manifest)]);
  }
  if (current && (!snapshot.marketplace || fs.realpathSync(current.source) !== fs.realpathSync(snapshot.marketplace.source))) {
    changes.push({ kind: 'native_marketplace', name: current.name, action: 'rollback-remove-attempted' });
    invoke(context, ['marketplace', 'remove', current.name]);
    current = null;
  }
  if (snapshot.marketplace && !current) {
    changes.push({ kind: 'native_marketplace', name: snapshot.marketplace.name, action: 'rollback-add-attempted' });
    invoke(context, ['marketplace', 'add', snapshot.marketplace.source]);
  }
  if (snapshot.plugin.registered) {
    changes.push({ kind: 'native_plugin', name: identity(context.manifest), action: 'rollback-add-attempted' });
    invoke(context, ['add', identity(context.manifest)]);
  }
  const config = path.join(context.target.config_root, 'config.toml'), before = readText(config);
  const others = sections(before).filter(section => !ownSection(context, section)).map(section => section.text).join('');
  const own = snapshot.tables.map(section => section.text).join('');
  writeText(config, `${others}${others && !others.endsWith('\n') && own ? '\n' : ''}${own}`, before, changes);
  const settingsFile = path.join(context.target.config_root, 'codehelix', `${context.manifest.plugin.id}.json`);
  const settingsNow = readText(settingsFile);
  if (snapshot.settings.exists) writeText(settingsFile, snapshot.settings.text, settingsNow, changes);
  else if (fs.existsSync(settingsFile)) {
    fs.unlinkSync(settingsFile);
    changes.push({ kind: 'configuration', path: settingsFile, action: 'rollback-removed' });
  }
  const observed = inspect(context), restoredMarket = marketplace(context);
  if (observed.registered !== snapshot.plugin.registered || observed.enabled !== snapshot.plugin.enabled
      || (snapshot.plugin.registered && observed.version !== snapshot.plugin.version)
      || JSON.stringify(restoredMarket) !== JSON.stringify(snapshot.marketplace)) throw new Error('Codex native rollback verification failed');
  return observed;
}

module.exports = { inspect, install, remove, preflight, capture, restore };
