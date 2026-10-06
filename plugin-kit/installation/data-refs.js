'use strict';

const path = require('node:path');
const os = require('node:os');

// DataRefs are metadata, not data ownership or health observations. This module
// deliberately has no filesystem access: binding never creates/copies data and
// does not establish that the path exists, is readable, or is used by a process.
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function literal(value) {
  return typeof value === 'string' && Boolean(value.trim())
    && !/[\x00-\x1f$]/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}
function absolute(value, userHome) {
  if (!literal(value)) return null;
  if (value === '~' || value.startsWith('~/')) {
    return path.isAbsolute(userHome || '') ? path.resolve(userHome, value.slice(2)) : null;
  }
  return path.isAbsolute(value) ? path.normalize(value) : null;
}
function relative(value) {
  return literal(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..')
    && !value.startsWith('~') && !value.includes('\\');
}
function child(root, relative) {
  if (!path.isAbsolute(root || '') || !literal(relative) || path.isAbsolute(relative)
      || relative.split(/[\\/]/).includes('..') || relative.startsWith('~')) return null;
  const resolved = path.resolve(root, relative), suffix = path.relative(root, resolved);
  return suffix === '..' || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix) ? null : resolved;
}
function declaredPath(declaration, context) {
  const value = declaration.path;
  if (!literal(value)) return null;
  if (declaration.root !== undefined) {
    const roots = { codehelix_home: context.home, target_root: context.target?.root,
      target_config: context.target?.config_root };
    return Object.hasOwn(roots, declaration.root) ? child(roots[declaration.root], value) : null;
  }
  if (value.startsWith('~/')) return absolute(value, context.userHome);
  return value.startsWith('./') ? child(context.target?.root, value) : null;
}
function inputDeclaration(manifest, name) {
  const inputs = manifest.configuration?.inputs;
  return Array.isArray(inputs) ? inputs.find(input => input.id === name)
    : (manifest.configuration || manifest.native_configuration || {})[name];
}
function resolveOne(declaration, manifest, context, origin) {
  const base = { ...declaration, ...origin, managed: false, resolution: 'unresolved',
    resolved_path: null, binding_source: null };
  if (!plain(declaration)) return { ...base, reason: 'Invalid data declaration' };
  if (Object.hasOwn(declaration, 'locations')) {
    const locations = declaration.locations;
    if (!plain(locations) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(locations.configuration || '')
        || !plain(locations.cases)) return { ...base, reason: 'Invalid choice-dependent data locations' };
    const key = locations.configuration, input = inputDeclaration(manifest, key);
    if (!input) return { ...base, reason: 'Data locations selector is not a declared configuration input' };
    const configured = Object.hasOwn(context.configuration || {}, key);
    const value = configured ? context.configuration[key] : input.default;
    if (typeof value !== 'string' || !Object.hasOwn(locations.cases, value)) {
      return { ...base, reason: 'Data locations selector has no matching declared case' };
    }
    const selected = locations.cases[value];
    if (!plain(selected) || Object.hasOwn(selected, 'locations')) {
      return { ...base, reason: 'Invalid selected data location; nested selectors are unsupported' };
    }
    // A selected case replaces, rather than supplements, any top-level path:
    // unknown/host-owned locations must never fall back to an unrelated root.
    const resolved = resolveOne(selected, manifest, context, origin);
    if (resolved.resolution === 'unresolved') return { ...base, reason: resolved.reason };
    return { ...base, resolution: configured || resolved.resolution === 'bound' ? 'bound' : 'default',
      resolved_path: resolved.resolved_path,
      binding_source: configured ? `configuration.${key}` : `configuration.${key}.default`,
      reason: 'Selected declared data location; not a runtime observation' };
  }
  if (Object.hasOwn(declaration, 'binding')) {
    const binding = declaration.binding;
    if (!plain(binding) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(binding.configuration || '')
        || !relative(binding.path)) {
      return { ...base, reason: 'Invalid data binding; expected a configuration key and a safe relative path' };
    }
    const input = inputDeclaration(manifest, binding.configuration);
    if (input?.type !== 'path') return { ...base, reason: 'Data binding does not reference a declared path input' };
    const key = binding.configuration, value = context.configuration?.[key];
    if (value !== undefined && value !== null && value !== '') {
      const root = absolute(value, context.userHome);
      const resolved = root && child(root, binding.path);
      return resolved ? { ...base, resolution: 'bound', resolved_path: resolved,
        binding_source: `configuration.${key}` }
        : { ...base, reason: 'Configured data root is not an explicit absolute or home-relative local path' };
    }
    const defaultRoot = plain(input.default) ? declaredPath(input.default, context)
      : absolute(input.default, context.userHome);
    if (defaultRoot) return { ...base, resolution: 'default', resolved_path: child(defaultRoot, binding.path),
      binding_source: `configuration.${key}.default`, reason: 'Declared configuration default; not a runtime observation' };
  }
  const resolved = declaredPath(declaration, context);
  return resolved ? { ...base, resolution: 'default', resolved_path: resolved,
    binding_source: 'declaration', reason: 'Declared default; not a configured or observed runtime location' }
    : { ...base, reason: 'Data declaration has no supported explicit local root/path binding' };
}

/** Resolve top-level pointers plus native MCP data declarations without I/O.
 * `binding: {configuration: "workspace", path: "knowledge/entries"}` references
 * a declared path input. Only explicit configured values produce `bound` refs.
 * `locations: {configuration: "mode", cases: {choice: {root, path}}}` selects
 * one complete location, including a binding; an empty case stays unresolved.
 * Unknown declarations remain visible as `unresolved`, never fabricated paths.
 */
function resolveDataRefs(manifest, { home, target = {}, configuration = {}, userHome = os.homedir() } = {}) {
  const context = { home, target, configuration, userHome };
  return [
    ...(manifest.data_pointers || []).map(item => resolveOne(item, manifest, context, {})),
    ...(manifest.content?.mcp || []).flatMap(server => (server.data_access || [])
      .map(item => resolveOne(item, manifest, context, { server_name: server.name }))),
  ];
}

module.exports = { resolveDataRefs };
