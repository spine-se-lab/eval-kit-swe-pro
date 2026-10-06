'use strict';

const STANDARD = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS',
  'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_LINK_MODE', 'UV_OFFLINE', 'UV_PYTHON_DOWNLOADS',
  'PYTHONUTF8', 'PYTHONIOENCODING', 'PYTHONDONTWRITEBYTECODE', 'PYTHONPYCACHEPREFIX',
  'CODEHELIX_HOME', 'CODEHELIX_INVOKE_CWD', 'CODEHELIX_PLUGIN_BINDING',
]);
const SECRET = /TOKEN|PASSWORD|SECRET|API_?KEY|PRIVATE_?KEY|AUTHORIZATION/i;

function declaredEnvironment(manifest) {
  return [...new Set([
    ...(manifest.requires?.credentials || []).map(item => item.env),
    ...(manifest.requires?.environment || []),
    ...(manifest.content?.mcp || []).flatMap(item => item.env_vars || []),
  ].filter(value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))];
}

function runtimeEnvironment(declared = [], supplied = {}, ambient = process.env) {
  const allowed = new Set(declared);
  return Object.fromEntries(Object.entries({ ...ambient, ...supplied }).filter(([name, value]) => typeof value === 'string'
    && (allowed.has(name) || STANDARD.has(name) || name.startsWith('XDG_') && !SECRET.test(name))));
}

function redact(text, environment = process.env) {
  let output = String(text);
  const values = Object.entries(environment).filter(([key, value]) => SECRET.test(key) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
  for (const value of values) {
    for (const variant of new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])) {
      output = output.replaceAll(variant, '[REDACTED]');
    }
  }
  return output;
}

module.exports = { declaredEnvironment, runtimeEnvironment, redact };
