'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Compatibility fallback for existing deliveries. New inputs declare labels;
// do not add plugin-specific ids here.
const LEGACY_LABELS = {
  issue_tracking_provider: 'Issue 跟踪系统',
  repository: 'GitHub 仓库（可选，owner/repo）',
  gate_model_name: 'LLM Gate 模型（可选，留空使用当前 Agent 模型）',
  gate_model_base_url: 'LLM Gate API URL（可选，留空使用当前 Agent 模型）',
  allow_preretrieved_updates: '允许持久化预检索候选',
  workbench_workspace: 'Knowledge 所在工作区',
};

function localized(value, fallback = '') {
  return typeof value === 'string' ? value : value?.['zh-CN'] || value?.en || fallback;
}

function inputsFor(manifest) {
  return manifest.execution?.mode === 'native'
    ? Object.entries(manifest.configuration || {}).map(([id, input]) => ({ ...input, id }))
    : manifest.configuration?.inputs || [];
}

function inputLabel(input) { return localized(input.label, LEGACY_LABELS[input.id] || input.id); }

function inputHelp(input) {
  return [...new Set([localized(input.description), localized(input.note)].filter(Boolean))].join('\n');
}

// No filesystem writes or business-specific checks. The same validator is used
// for interactive answers and explicit CLI values; host/semantic probes remain
// the installer's responsibility.
function inputValidator(input, cwd) {
  const rules = input.path_options;
  if (rules !== undefined && (input.type !== 'path' || !rules || typeof rules !== 'object'
      || Array.isArray(rules) || Object.keys(rules).some(key => !['absolute', 'must_exist', 'kind'].includes(key))
      || ['absolute', 'must_exist'].some(key => rules[key] !== undefined && typeof rules[key] !== 'boolean')
      || rules.kind !== undefined && !['directory', 'file'].includes(rules.kind))) {
    throw new Error(`${input.id}: 无效的 path_options 声明`);
  }
  return value => {
    if (value === undefined || value === null || String(value).trim() === '') {
      return input.required ? `${inputLabel(input)}为必填项` : undefined;
    }
    if (!rules) return undefined;
    if (typeof value !== 'string') return '请输入路径字符串';
    const trimmed = value.trim();
    const expanded = trimmed === '~' ? os.homedir()
      : trimmed.startsWith(`~${path.sep}`) ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
    if (rules.absolute && !path.isAbsolute(expanded)) return '请输入绝对路径（支持 ~）';
    if (!rules.must_exist && !rules.kind) return undefined;
    try {
      const stat = fs.statSync(path.resolve(cwd, expanded));
      if (rules.kind === 'directory' && !stat.isDirectory()) return '请输入目录，而不是文件';
      if (rules.kind === 'file' && !stat.isFile()) return '请输入文件，而不是目录';
    } catch (error) {
      if (error.code === 'ENOENT') return rules.must_exist ? '路径不存在，请检查后重新输入' : undefined;
      return '无法读取路径，请检查路径和访问权限';
    }
  };
}

function normalizeInputValue(input, value, cwd) {
  if (input.type !== 'path' || !input.path_options || typeof value !== 'string' || !value.trim()) return value;
  const trimmed = value.trim();
  const expanded = trimmed === '~' ? os.homedir()
    : trimmed.startsWith(`~${path.sep}`) ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  return path.resolve(cwd, expanded);
}

function validateConfiguration(manifest, configuration, cwd) {
  const normalized = { ...configuration };
  for (const input of inputsFor(manifest)) {
    if (input.when && configuration[input.when.configuration] !== input.when.equals) continue;
    const error = inputValidator(input, cwd)(configuration[input.id]);
    if (error) throw new Error(`${inputLabel(input)}：${error}；请检查配置 ${input.id}`);
    if (Object.hasOwn(configuration, input.id)) normalized[input.id] = normalizeInputValue(input, configuration[input.id], cwd);
  }
  return normalized;
}

module.exports = { localized, inputsFor, inputLabel, inputHelp, inputValidator, normalizeInputValue, validateConfiguration };
