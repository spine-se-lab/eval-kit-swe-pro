'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const PLUGIN_SCHEMA = 'codehelix.plugin/v1';
const TARGET_SCHEMA = 'codehelix.plugin_target/v1';
const PACKAGE_SCHEMA = 'codehelix.plugin_package/v1';
const PLUGIN_STATUSES = new Set(['draft', 'planned', 'active', 'deprecated']);
const COMPATIBILITY_GATES = new Set(['version', 'capability']);
const SURFACE_LANDINGS = new Set(['native', 'source-overlay', 'unavailable']);
const PLUGIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TARGET_PROFILE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERIFICATION_LEVELS = new Set(['none', 'fixture', 'real']);
const VERIFICATION_LABELS = {
  none: '未验证',
  fixture: 'fixture 验证',
  real: '已真实验收',
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

class PluginContractError extends Error {}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function walkFiles(root, current = root, excluded = false, ignoredRootDirectories = []) {
  if (fs.lstatSync(current).isSymbolicLink()) throw new PluginContractError(`Delivery/Source 不允许符号链接：${current}`);
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (current === root && ignoredRootDirectories.includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new PluginContractError(`Delivery/Source 不允许符号链接：${path.join(current, entry.name)}`);
    const skip = excluded || entry.name === '__pycache__' || entry.name === '.DS_Store' || entry.name.endsWith('.pyc');
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, absolute, skip, ignoredRootDirectories));
    else if (!skip && entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  return files;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function digestTree(root, { ignoreNpmDependencies = false } = {}) {
  const digest = crypto.createHash('sha256');
  for (const relative of walkFiles(root, root, false, ignoreNpmDependencies ? ['node_modules'] : []).sort()) {
    digest.update(Buffer.from(relative));
    digest.update(Buffer.from([0]));
    digest.update(fs.readFileSync(path.join(root, relative)));
    digest.update(Buffer.from([0]));
  }
  return digest.digest('hex');
}

function validateSourceLock(delivery, profile, source) {
  const lock = readJson(path.join(delivery, 'source-lock.json'), `source-lock ${profile}`);
  if (lock.schema !== 'codehelix.source_lock/v1') {
    throw new PluginContractError(`source-lock 格式无效：${profile}`);
  }
  if (typeof lock.source_tree_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(lock.source_tree_sha256)) {
    throw new PluginContractError(`source-lock 缺少有效的 source_tree_sha256：${profile}`);
  }
  if (digestTree(source) !== lock.source_tree_sha256) {
    throw new PluginContractError(`source-lock 与当前 Source 不一致：${profile}；请重新运行 npx . build`);
  }
}

function validateDeliveryLock(delivery, profile) {
  const lockPath = path.join(delivery, 'delivery-lock.json');
  const lock = readJson(lockPath, `delivery-lock ${profile}`);
  if (lock.schema !== 'codehelix.delivery_lock/v1' || !lock.files || typeof lock.files !== 'object') {
    throw new PluginContractError(`delivery-lock 格式无效：${profile}`);
  }
  const expected = Object.keys(lock.files).sort();
  const actual = walkFiles(delivery, delivery, false, ['node_modules']).filter((relative) => relative !== 'delivery-lock.json').sort();
  if (!isDeepStrictEqual(actual, expected)) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const extra = actual.filter((relative) => !expectedSet.has(relative));
    const missing = expected.filter((relative) => !actualSet.has(relative));
    const detail = [
      extra.length ? `多出：${extra.join('、')}` : null,
      missing.length ? `缺少：${missing.join('、')}` : null,
    ].filter(Boolean).join('；');
    throw new PluginContractError(
      `delivery-lock 文件列表与 Delivery 不一致：${profile}（${detail}）；请重新运行 npx . build`,
    );
  }
  for (const relative of expected) {
    if (sha256(path.join(delivery, relative)) !== lock.files[relative]) {
      throw new PluginContractError(`delivery-lock digest 不匹配：${profile}/${relative}`);
    }
  }
}

function readJson(file, label = file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new PluginContractError(`${label} 不是有效 JSON：${error.message}`);
  }
}

function safeChild(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) {
    throw new PluginContractError(`${label} 必须是 Plugin 根目录内的相对路径`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relative);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new PluginContractError(`${label} 不能离开 Plugin 根目录`);
  }
  return resolved;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PluginContractError(`${label} 必须是非空字符串`);
  }
}

function loadDescriptor(pluginRoot) {
  const descriptorPath = path.join(pluginRoot, 'codehelix-plugin.json');
  if (!fs.existsSync(descriptorPath)) {
    throw new PluginContractError(`缺少 Plugin 描述符：${descriptorPath}`);
  }
  const descriptor = readJson(descriptorPath, 'Plugin 描述符');
  if (descriptor.schema !== PLUGIN_SCHEMA) {
    throw new PluginContractError(`Plugin 描述符 schema 必须是 ${PLUGIN_SCHEMA}`);
  }
  if (!descriptor.plugin || typeof descriptor.plugin !== 'object') {
    throw new PluginContractError('Plugin 描述符缺少 plugin 对象');
  }
  requiredString(descriptor.plugin.id, 'plugin.id');
  if (!PLUGIN_ID.test(descriptor.plugin.id)) {
    throw new PluginContractError('plugin.id 必须使用小写 kebab-case');
  }
  if (descriptor.plugin.id !== path.basename(pluginRoot)) {
    throw new PluginContractError(`plugin.id 必须与目录名一致：${path.basename(pluginRoot)}`);
  }
  requiredString(descriptor.plugin.name, 'plugin.name');
  requiredString(descriptor.plugin.version, 'plugin.version');
  if (!descriptor.plugin.description || typeof descriptor.plugin.description !== 'object') {
    throw new PluginContractError('plugin.description 必须是本地化描述对象');
  }
  requiredString(descriptor.plugin.description['zh-CN'], 'plugin.description.zh-CN');
  requiredString(descriptor.plugin.description.en, 'plugin.description.en');
  if (!PLUGIN_STATUSES.has(descriptor.status)) {
    throw new PluginContractError(`status 必须是 ${[...PLUGIN_STATUSES].join('、')} 之一`);
  }
  if (!Array.isArray(descriptor.targets)) {
    throw new PluginContractError('targets 必须是 target 声明路径数组');
  }
  const documentation = safeChild(pluginRoot, descriptor.documentation, 'documentation');
  if (!isFile(documentation)) {
    throw new PluginContractError(`documentation 不存在：${descriptor.documentation}`);
  }
  if (descriptor.status === 'active' && descriptor.targets.length === 0) {
    throw new PluginContractError('active Plugin 至少需要一个 target 声明');
  }
  return descriptor;
}

// installation 的三个清单是安装器实际执行的东西。它们只被检查成“数组”时，
// 一条畸形项会一路带到真实安装现场才炸，所以这里逐项点名 profile、字段和序号。
function validateInstallationItems(relative, target) {
  const where = (field, index) => `${relative}.installation.${field}[${index}]（target profile：${target.profile}）`;
  const requiredFields = { payload: ['source', 'target'], patches: ['id', 'path', 'reason'] };
  for (const [field, fields] of Object.entries(requiredFields)) {
    target.installation[field].forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new PluginContractError(`${where(field, index)} 必须是对象`);
      }
      for (const name of fields) {
        requiredString(item[name], `${where(field, index)}.${name}`);
      }
    });
  }
  target.installation.registrations.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new PluginContractError(`${where('registrations', index)} 必须是对象`);
    }
  });
}

// verification 记录“这个 target 声明被验证到什么程度”。none 之外必须留下日期和证据，
// 否则 `npx . --list` 的验证等级只是一句无法追溯的自我声明。
function validateVerification(relative, target) {
  const verification = target.verification;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    throw new PluginContractError(
      `${relative} 缺少 verification 对象；请声明 {"level": "none"|"fixture"|"real"}`,
    );
  }
  if (!VERIFICATION_LEVELS.has(verification.level)) {
    throw new PluginContractError(
      `${relative}.verification.level 必须是 ${[...VERIFICATION_LEVELS].join('、')} 之一`,
    );
  }
  if (verification.level === 'none') return;
  if (typeof verification.date !== 'string' || !ISO_DATE.test(verification.date)) {
    throw new PluginContractError(
      `${relative}.verification.date 在 level=${verification.level} 时必填，格式 YYYY-MM-DD`,
    );
  }
  if (typeof verification.evidence !== 'string' || !verification.evidence.trim()) {
    throw new PluginContractError(
      `${relative}.verification.evidence 在 level=${verification.level} 时必填，`
      + '填证据文件的相对路径或说明',
    );
  }
}

function loadTarget(pluginRoot, relative) {
  const targetPath = safeChild(pluginRoot, relative, 'targets[]');
  if (!isFile(targetPath)) {
    throw new PluginContractError(`target 声明不存在：${relative}`);
  }
  const target = readJson(targetPath, `target 声明 ${relative}`);
  if (target.schema === require('./native.js').TARGET_SCHEMA) {
    return require('./native.js').validateTarget(target, relative);
  }
  if (target.schema !== TARGET_SCHEMA) {
    throw new PluginContractError(`${relative} 的 schema 必须是 ${TARGET_SCHEMA}`);
  }
  if (Object.hasOwn(target, 'execution')) throw new PluginContractError(`${relative}: v1 targets use the legacy installer contract; use native_target/v1 for explicit native execution`);
  requiredString(target.profile, `${relative}.profile`);
  if (Object.hasOwn(target, 'plugin')) {
    throw new PluginContractError(`${relative} 不能声明 plugin；Plugin 身份只在根描述符维护`);
  }
  if (!TARGET_PROFILE.test(target.profile)) {
    throw new PluginContractError(`${relative}.profile 只能使用小写字母、数字、连字符和点`);
  }
  if (!target.compatibility || typeof target.compatibility !== 'object') {
    throw new PluginContractError(`${relative} 缺少 compatibility`);
  }
  requiredString(target.compatibility.agent_system, `${relative}.compatibility.agent_system`);
  if (!PLUGIN_ID.test(target.compatibility.agent_system)) {
    throw new PluginContractError(`${relative}.compatibility.agent_system 必须使用小写 kebab-case`);
  }
  requiredString(target.compatibility.harness, `${relative}.compatibility.harness`);
  requiredString(String(target.compatibility.target_version || ''), `${relative}.compatibility.target_version`);
  if (!Array.isArray(target.compatibility.required_paths)) {
    throw new PluginContractError(`${relative}.compatibility.required_paths 必须是数组`);
  }
  const gate = Object.hasOwn(target.compatibility, 'gate') ? target.compatibility.gate : 'version';
  if (!COMPATIBILITY_GATES.has(gate)) {
    throw new PluginContractError(`${relative}.compatibility.gate 必须是 version 或 capability`);
  }
  for (const field of ['capabilities', 'requires', 'configuration', 'extensions', 'installer', 'installation']) {
    if (!target[field] || typeof target[field] !== 'object' || Array.isArray(target[field])) {
      throw new PluginContractError(`${relative} 缺少 ${field} 对象`);
    }
  }
  for (const field of ['dependencies', 'components', 'data_pointers', 'harness_bindings']) {
    if (!Array.isArray(target[field])) {
      throw new PluginContractError(`${relative} 缺少 ${field} 数组`);
    }
  }
  for (const field of ['harness_features', 'runtimes', 'credentials']) {
    if (!Array.isArray(target.requires[field])) {
      throw new PluginContractError(`${relative}.requires.${field} 必须是数组`);
    }
  }
  for (const component of target.components) {
    if (!component || typeof component !== 'object' || Array.isArray(component)) {
      throw new PluginContractError(`${relative}.components[] 必须是对象`);
    }
    requiredString(component.kind, `${relative}.components[].kind`);
    requiredString(component.name, `${relative}.components[].name`);
  }
  if (target.installer.protocol !== 'codehelix.plugin_installer/v1') {
    throw new PluginContractError(`${relative}.installer.protocol 必须是 codehelix.plugin_installer/v1`);
  }
  if (!Array.isArray(target.installer.command) || target.installer.command.length === 0
    || target.installer.command.some((item) => typeof item !== 'string' || !item)) {
    throw new PluginContractError(`${relative}.installer.command 必须是非空字符串数组`);
  }
  const operations = target.installer.operations;
  if (!Array.isArray(operations)
    || !['check', 'plan', 'install', 'verify'].every((operation) => operations.includes(operation))) {
    throw new PluginContractError(`${relative}.installer.operations 必须包含 check、plan、install、verify`);
  }
  for (const field of ['target_inputs', 'payload', 'patches', 'registrations']) {
    if (!Array.isArray(target.installation[field])) {
      throw new PluginContractError(`${relative}.installation.${field} 必须是数组`);
    }
  }
  validateInstallationItems(relative, target);
  validateVerification(relative, target);
  if (target.surfaces !== undefined) {
    if (!target.surfaces || typeof target.surfaces !== 'object' || Array.isArray(target.surfaces)) {
      throw new PluginContractError(`${relative}.surfaces 必须是对象`);
    }
    const componentKinds = new Set(target.components.map((component) => component.kind));
    for (const kind of componentKinds) {
      if (!target.surfaces[kind]) {
        throw new PluginContractError(`${relative}.surfaces 缺少组件面 ${kind}`);
      }
    }
    for (const [kind, surface] of Object.entries(target.surfaces)) {
      if (!surface || typeof surface !== 'object' || typeof surface.required !== 'boolean'
        || !surface.targets || typeof surface.targets !== 'object' || Array.isArray(surface.targets)) {
        throw new PluginContractError(`${relative}.surfaces.${kind} 必须声明 required 和 targets`);
      }
      for (const landing of Object.values(surface.targets)) {
        if (!SURFACE_LANDINGS.has(landing)) {
          throw new PluginContractError(
            `${relative}.surfaces.${kind} 的落地方式必须是 native、source-overlay 或 unavailable`,
          );
        }
      }
      const currentLanding = surface.targets[target.compatibility.agent_system];
      if (!currentLanding) {
        throw new PluginContractError(
          `${relative}.surfaces.${kind} 缺少 ${target.compatibility.agent_system} 的落地方式`,
        );
      }
      if (surface.required && currentLanding === 'unavailable') {
        throw new PluginContractError(`${relative}.surfaces.${kind} 是 required，不能声明 unavailable`);
      }
    }
  }
  return target;
}

function compiledManifest(descriptor, target) {
  if (target.schema === require('./native.js').TARGET_SCHEMA) {
    return require('./native.js').compiledManifest(descriptor, target);
  }
  const { schema: _schema, profile: _profile, ...packageFields } = target;
  return {
    schema: PACKAGE_SCHEMA,
    plugin: descriptor.plugin,
    ...packageFields,
  };
}

// validate 的绿灯要能被读成“这个 Delivery 装得上”，所以生成物这一层检查的是
// 安装入口链路本身：npx 能解析到的 bin key、bin 转发到的 installer 模块、
// 以及 installation 清单里每一条真的躺在 Delivery 里的文件。
function validateDeliveryInstallability(delivery, descriptor, target, packageJson) {
  const profile = target.profile;
  const binKeys = Object.keys(packageJson.bin);
  const command = target.installer.command;
  if (command.length !== 5 || command[0] !== 'npx' || command[1] !== '--package'
      || command[2] !== '.' || !binKeys.includes(command[3]) || command[4] !== 'protocol') {
    throw new PluginContractError(`Delivery installer.command 必须是 npx --package . <bin> protocol，bin 必须匹配实际入口：${profile}；command=${JSON.stringify(command)}；bin=${binKeys.join(", ")}`);
  }
  // Implementation language is Package-owned. A shim may explicitly declare
  // the additional file it invokes; native bin implementations need no shim.
  if (Object.hasOwn(target.installer, 'entrypoint')) {
    const entrypoint = safeChild(delivery, target.installer.entrypoint, 'installer.entrypoint');
    if (!isFile(entrypoint)) throw new PluginContractError(`Delivery 缺少 installer 实现：${profile}/${target.installer.entrypoint}`);
  }
  const expectedName = `codehelix-${descriptor.plugin.id}`;
  if (packageJson.name !== expectedName) {
    throw new PluginContractError(
      `Delivery package.json name 与 Plugin 根 package.json name 不一致：${profile}；`
      + `期望 ${expectedName}，实际 ${packageJson.name}；请修维护源后重新运行 npx . build`,
    );
  }
  const referenced = [
    ...target.installation.payload.map((item, index) => ({
      field: `installation.payload[${index}].source`, value: item.source,
    })),
    ...target.installation.patches.map((item, index) => ({
      field: `installation.patches[${index}].path`, value: item.path,
    })),
  ];
  for (const { field, value } of referenced) {
    const resolved = safeChild(delivery, value, `${profile} 的 ${field}`);
    if (!fs.existsSync(resolved)) {
      throw new PluginContractError(
        `${field} 指向的文件在 Delivery 里不存在：delivery/${profile}/${value}`,
      );
    }
  }
}

function validatePlugin(pluginRoot, { checkSource = true } = {}) {
  const descriptor = loadDescriptor(pluginRoot);
  const seenProfiles = new Set();
  const targets = descriptor.targets.map((relative) => {
    const target = loadTarget(pluginRoot, relative);
    if (seenProfiles.has(target.profile)) {
      throw new PluginContractError(`重复的 target profile：${target.profile}`);
    }
    seenProfiles.add(target.profile);
    return { relative, target };
  });

  // 目录里躺着但没被描述符登记的 target 声明既不会被构建也不会被校验，
  // 静默忽略等于让一份看起来生效的声明永远是死的。
  const targetsDir = path.join(pluginRoot, 'targets');
  if (isDirectory(targetsDir)) {
    const declared = new Set(descriptor.targets);
    for (const entry of fs.readdirSync(targetsDir).sort()) {
      const candidate = `targets/${entry}`;
      if (entry.endsWith('.json') && !declared.has(candidate)) {
        throw new PluginContractError(
          `发现未登记的 target 声明：${candidate}；请登记进 codehelix-plugin.json 或删除`,
        );
      }
    }
  }

  const deliveryRoot = path.join(pluginRoot, 'delivery');
  const actualProfiles = fs.existsSync(deliveryRoot)
    ? fs.readdirSync(deliveryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    : [];
  for (const profile of actualProfiles) {
    if (!seenProfiles.has(profile)) {
      throw new PluginContractError(`发现未声明的 Delivery：delivery/${profile}`);
    }
  }

  for (const { relative, target } of targets) {
    const delivery = path.join(deliveryRoot, target.profile);
    if (!isDirectory(delivery)) {
      throw new PluginContractError(`${relative} 尚未生成 delivery/${target.profile}；请运行 npx . build ${descriptor.plugin.id}`);
    }
    const manifestPath = path.join(delivery, 'codehelix-plugin.json');
    if (!isFile(manifestPath)) {
      throw new PluginContractError(`Delivery 缺少 manifest：delivery/${target.profile}/codehelix-plugin.json`);
    }
    const manifest = readJson(manifestPath, `Delivery manifest ${target.profile}`);
    if (!isDeepStrictEqual(manifest, compiledManifest(descriptor, target))) {
      throw new PluginContractError(
        `Delivery manifest 与 Plugin/target 维护源不一致：${target.profile}；请重新运行 npx . build`,
      );
    }
    const native = target.execution?.mode === 'native';
    for (const required of [...(native ? [] : ['package.json']), 'source-lock.json', 'delivery-lock.json']) {
      if (!isFile(path.join(delivery, required))) {
        throw new PluginContractError(`Delivery 缺少 ${required}：delivery/${target.profile}`);
      }
    }
    if (checkSource) validateSourceLock(delivery, target.profile, path.join(pluginRoot, 'source'));
    validateDeliveryLock(delivery, target.profile);
    if (native) {
      if (checkSource) require('./native.js').validateContent(pluginRoot, descriptor);
      if (checkSource) {
        const provenance = readJson(path.join(delivery, 'source-lock.json'), `source-lock ${target.profile}`);
        if (provenance.kit_tree_sha256 !== digestTree(path.join(__dirname, '..'))) {
          throw new PluginContractError(`Native Delivery was built with a different Kit; rebuild ${target.profile}`);
        }
      }
      require('./native.js').validateDelivery(delivery, manifest);
      continue;
    }
    const packageJson = readJson(path.join(delivery, 'package.json'), `Delivery package.json ${target.profile}`);
    if (packageJson.version !== descriptor.plugin.version) {
      throw new PluginContractError(`Delivery package.json 版本与 Plugin 描述符不一致：${target.profile}`);
    }
    if (!packageJson.bin || typeof packageJson.bin !== 'object' || Object.keys(packageJson.bin).length === 0) {
      throw new PluginContractError(`Delivery package.json 缺少 bin：${target.profile}`);
    }
    for (const executable of Object.values(packageJson.bin)) {
      const executablePath = safeChild(delivery, executable, `Delivery bin ${target.profile}`);
      if (!isFile(executablePath)) {
        throw new PluginContractError(`Delivery bin 不存在：delivery/${target.profile}/${executable}`);
      }
    }
    validateDeliveryInstallability(delivery, descriptor, target, packageJson);
  }

  const rootPackagePath = path.join(pluginRoot, 'package.json');
  if (isFile(rootPackagePath)) {
    const rootPackage = readJson(rootPackagePath, 'Plugin root package.json');
    if (rootPackage.version !== descriptor.plugin.version) {
      throw new PluginContractError('Plugin root package.json 版本与 Plugin 描述符不一致');
    }
    const expectedName = `codehelix-${descriptor.plugin.id}`;
    if (rootPackage.name !== expectedName) {
      throw new PluginContractError(`Plugin root package.json name 必须是 ${expectedName}`);
    }
    if (!rootPackage.bin || rootPackage.bin[expectedName] !== 'bin/codehelix-plugin.js') {
      throw new PluginContractError(`Plugin root package.json 必须声明 ${expectedName} 的薄入口`);
    }
    if (!isFile(path.join(pluginRoot, 'bin', 'codehelix-plugin.js'))) {
      throw new PluginContractError('Plugin root 缺少 bin/codehelix-plugin.js');
    }
  } else if (descriptor.status === 'active') {
    throw new PluginContractError('active Plugin 缺少根 package.json');
  }

  return { descriptor, targets, deliveryCount: actualProfiles.length };
}

// 未知等级不静默降级成空串：调用方拿到的永远是一句人能读的验证结论。
function verificationLabel(level) {
  return VERIFICATION_LABELS[level] || VERIFICATION_LABELS.none;
}

module.exports = {
  PACKAGE_SCHEMA,
  PLUGIN_SCHEMA,
  TARGET_SCHEMA,
  VERIFICATION_LEVELS,
  PluginContractError,
  compiledManifest,
  loadDescriptor,
  loadTarget,
  validatePlugin,
  verificationLabel,
  validateVerification,
  validateDeliveryLock,
  validateSourceLock,
  safeChild,
  walkFiles,
  digestTree,
  sha256,
};
