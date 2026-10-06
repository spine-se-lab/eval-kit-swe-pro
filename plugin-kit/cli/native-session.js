'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');

function createNativeSession(worker = 'native-worker.js', { timeoutMs = 300000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('无效的宿主操作超时');
  const child = fork(path.join(__dirname, worker), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [], detached: process.platform !== 'win32',
  });
  let pending;
  let exited = false;
  let closing = false;
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-65536); });
  child.on('message', message => {
    if (!pending) return;
    if (message.type === 'progress') pending.report(message.event);
    else if (message.type === 'result') pending.finish(null, message.result);
    else if (message.type === 'error') pending.finish(new Error(message.message));
  });
  child.on('error', error => { exited = true; pending?.finish(error); });
  child.on('exit', (code, signal) => {
    exited = true;
    pending?.finish(new Error(`宿主操作进程已退出（${signal || code}）；请运行 inspect 确认当前状态${diagnostics ? `\n${diagnostics}` : ''}`));
  });

  function close() {
    if (exited || closing) return;
    closing = true;
    try {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, 'SIGTERM');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  function request(message, report = () => {}, signal) {
    if (pending || exited || closing) return Promise.reject(new Error('安装进程不可用'));
    return new Promise((resolve, reject) => {
      const cancel = () => {
        close();
        finish(new Error('操作已中断；可能已有变更，请运行 inspect 确认当前状态'));
      };
      // Managed operations have their own bounded phase/subprocess deadlines.
      // They may legitimately exceed the native adapter's five-minute total.
      const timer = timeoutMs === 0 ? null : setTimeout(() => {
        close();
        finish(new Error('宿主操作超时；请运行 inspect 确认当前状态'));
      }, timeoutMs);
      const finish = (error, result) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        pending = null;
        if (error) reject(error);
        else resolve(result);
      };
      pending = { report, finish };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      child.send(message, error => { if (error && pending) finish(error); });
    });
  }

  return { request, close };
}

module.exports = { createNativeSession };
