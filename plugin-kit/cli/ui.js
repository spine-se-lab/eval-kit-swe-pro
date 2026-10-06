'use strict';

// Human-facing output only. Protocol stdout remains owned by the protocol CLI.
const { stripVTControlCharacters } = require('node:util');
const readline = require('node:readline');

let prompts;
const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
const clean = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

async function init() {
  if (isInteractive() && !prompts) {
    // Some PTY hosts initially report a zero-sized window. Clack otherwise
    // wraps every character onto its own line until the first resize event.
    if (!process.stdout.columns) process.stdout.columns = 80;
    if (!process.stdout.rows) process.stdout.rows = 24;
    prompts = await import('@clack/prompts');
  }
}

function intro(title = 'CodeHelix') {
  if (prompts) prompts.intro(clean(title));
  else process.stdout.write(`${clean(title)}\n\n`);
}

function step(message) {
  if (prompts) prompts.log.step(clean(message));
  else process.stdout.write(`✓ ${clean(message)}\n`);
}

function note(message, title) {
  if (prompts) prompts.note(clean(message), clean(title));
  else process.stdout.write(`\n${clean(title)}\n${clean(message)}\n\n`);
}

function outro(message) {
  if (prompts) prompts.outro(clean(message));
  else process.stdout.write(`\n${clean(message)}\n`);
}

function fail(message) {
  if (prompts) prompts.cancel(clean(message));
  else process.stderr.write(`${clean(message)}\n`);
}

function answer(value) {
  if (prompts.isCancel(value)) throw new Error('用户已取消');
  return value;
}

async function choose(title, options, { searchable = options.length > 3 } = {}) {
  if (!isInteractive()) throw new Error(`${title}需要交互输入；请改用显式参数`);
  if (!options.length) throw new Error(`${title}没有可选项`);
  await init();
  // Use numeric values so caller-owned Symbols and objects are never interpreted
  // as Clack cancellation values or stringified by the search renderer.
  const items = options.map((option, value) => ({
    value, label: clean(option.label), ...(option.hint ? { hint: clean(option.hint) } : {}),
  }));
  const index = answer(await (searchable ? prompts.autocomplete : prompts.select)({
    message: clean(title), options: items, maxItems: 7, initialValue: 0,
    ...(searchable ? { placeholder: '输入名称搜索 · ↑↓ 选择 · Enter 确认' } : {}),
  }));
  return options[index].value;
}

async function multiselect(title, options, initialValues = []) {
  if (!isInteractive()) throw new Error(`${title}需要交互输入；请改用显式参数`);
  if (!options.length) throw new Error(`${title}没有可选项`);
  await init();
  const items = options.map(option => ({
    value: option.value,
    label: clean(option.label),
    ...(option.hint ? { hint: clean(option.hint) } : {}),
  }));
  return answer(await prompts.multiselect({
    message: clean(title),
    options: items,
    initialValues,
    required: true,
  }));
}

async function text(label, defaultValue = '', { placeholder = defaultValue, validate } = {}) {
  if (!isInteractive()) throw new Error(`${label}需要交互输入；请使用命令行参数提供`);
  await init();
  return answer(await prompts.text({
    message: clean(label), placeholder: clean(placeholder), defaultValue, validate,
  })).trim() || defaultValue;
}

async function secret(label) {
  if (!isInteractive()) throw new Error(`${label}需要交互输入；请通过环境变量提供`);
  await init();
  return answer(await prompts.password({ message: clean(label) }));
}

// Clack 1.0's spinner exits with code 0 on Ctrl-C. Own this small animation so
// cancellation aborts the running child, restores the terminal, and fails the CLI.
function progressSpinner(cancel) {
  let timer;
  let message = '';
  let previousRaw;
  const onKey = (_text, key) => {
    if (key?.ctrl && key.name === 'c') cancel();
  };
  const clear = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    process.stdin.off('keypress', onKey);
    process.stdin.setRawMode(previousRaw || false);
    process.stdin.pause();
    process.stdout.write('\r\x1b[2K\x1b[?25h');
  };
  return {
    start(label) {
      message = label;
      previousRaw = process.stdin.isRaw;
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('keypress', onKey);
      process.stdout.write('\x1b[?25l');
      const frames = ['◒', '◐', '◓', '◑'];
      let frame = 0;
      const render = () => {
        // Reserve two columns per code point, including CJK, to prevent wrapping.
        const max = Math.max(1, Math.floor((process.stdout.columns - 6) / 2));
        const points = Array.from(message.replace(/\s+/g, ' '));
        const shown = points.length > max ? `${points.slice(0, max - 1).join('')}…` : message;
        process.stdout.write(`\r\x1b[2K${frames[frame++ % frames.length]}  ${shown}…`);
      };
      render();
      timer = setInterval(render, 100);
    },
    message(label) { message = label; },
    stop(label) { clear(); step(label); },
    error(label) { clear(); prompts.log.error(label); },
    cancel(label) { clear(); prompts.log.warn(label); },
  };
}

// Work receives a phase reporter and an AbortSignal. Each completed phase stays
// in the transcript; only the current phase animates. Pipes contain plain lines.
async function task(label, work, completed = label) {
  await init();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const spinner = prompts ? progressSpinner(cancel) : null;
  let active = false;
  let current = label;
  const report = event => {
    if (controller.signal.aborted) return;
    current = event.label;
    if (event.state === 'completed') {
      if (spinner && active) spinner.stop(clean(current));
      else step(current);
      active = false;
    } else {
      if (spinner) {
        if (active) spinner.message(clean(current));
        else spinner.start(clean(current));
      } else process.stdout.write(`○ ${clean(current)}…\n`);
      active = true;
    }
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  report({ label, state: 'started' });
  try {
    const result = await work(report, controller.signal);
    if (controller.signal.aborted) throw new Error('操作已中断');
    if (active) report({ label: typeof completed === 'function' ? completed(result) : completed, state: 'completed' });
    return result;
  } catch (error) {
    if (spinner && active) {
      if (controller.signal.aborted) spinner.cancel('操作已中断');
      else spinner.error(`${clean(current)}失败`);
    }
    throw error;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

module.exports = { init, isInteractive, clean, intro, step, note, outro, fail, choose, multiselect, text, secret, task };
