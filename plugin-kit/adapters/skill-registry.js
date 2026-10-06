'use strict';

const adapters = [
  require('./codex/skills-v1/adapter.js'),
  require('./opencode/skills-v1/adapter.js'),
];

const byId = new Map(adapters.map(adapter => [adapter.id, adapter]));

function resolveSkillAdapter(id) {
  const adapter = byId.get(id);
  if (!adapter) throw new Error(`没有注册 Skill activation Adapter：${id}`);
  if (adapter.contract?.capability !== 'skill-directory-v1') {
    throw new Error(`Skill activation Adapter capability 不受支持：${id}`);
  }
  return adapter;
}

function listSkillAdapters() {
  return [...adapters];
}

module.exports = { resolveSkillAdapter, listSkillAdapters };
