'use strict';

// Keep synchronous adapter calls off the terminal's event loop. This worker
// retains the exact prepared context across preview, confirmation and execution.
const { prepare, execute } = require('../execution/native.js');
let context;

process.on('message', message => {
  try {
    let result;
    if (message.operation === 'prepare') {
      context = prepare(message.delivery, message.request, message.options);
      result = {
        manifest: context.manifest, observation: context.observation,
        target: context.target, adapter: { id: context.adapter.id },
      };
    } else {
      if (!context) throw new Error('尚未检查安装目标');
      result = execute(context, message.operation, {
        onProgress: event => process.send?.({ type: 'progress', event }),
      });
    }
    process.send?.({ type: 'result', result });
  } catch (error) {
    process.send?.({ type: 'error', message: error.message });
  }
});

process.on('disconnect', () => process.exit(0));
