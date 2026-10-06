'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../../process/run.js');

function buildPythonPackage(source, destination, copyTree) {
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), '.python-build-'));
  try {
    const sourceRoot = path.join(staging, 'source');
    const output = path.join(staging, 'dist');
    copyTree(source, sourceRoot);
    run('uv', ['build', '--wheel', sourceRoot, '--out-dir', output], {
      env: { ...process.env, SOURCE_DATE_EPOCH: '315532800' }, timeout: 180000,
    });
    const wheels = fs.readdirSync(output).filter(file => file.endsWith('.whl'));
    if (wheels.length !== 1) throw new Error('Python runtime build must produce exactly one wheel');
    // setuptools writes Core Metadata with the host platform's newline style.
    // Canonicalise the archive so a wheel built on Windows is byte-identical to
    // one rebuilt by CI on Linux (and by contributors on macOS).
    run('uv', [
      'run', '--no-project', 'python', path.join(__dirname, 'normalize-wheel.py'),
      path.join(output, wheels[0]),
    ], { env: { ...process.env, SOURCE_DATE_EPOCH: '315532800' } });
    // uv adds an ignore-all .gitignore to its output. Deliver only the wheel,
    // so a normal git add includes the runtime in the published package.
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(path.join(output, wheels[0]), path.join(destination, wheels[0]));
    if (fs.existsSync(path.join(source, 'requirements.lock'))) {
      fs.copyFileSync(path.join(source, 'requirements.lock'), path.join(destination, 'requirements.lock'));
    }
    return wheels[0];
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

module.exports = { buildPythonPackage };
