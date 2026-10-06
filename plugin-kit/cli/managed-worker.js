'use strict';
const core = require('../installation/orchestrator.js');
let plan;
process.on('message', async message => {
  try {
    const options = { onProgress: event => process.send?.({ type: 'progress', event }), secretEnvironment: message.secretEnvironment || {} };
    let answer;
    if (message.operation === 'prepare') {
      answer = await core.prepare(message.delivery, message.request, options);
      plan = answer.plan;
    } else if (message.operation === 'commit') {
      answer = await core.commit(plan?.source_root, { plan, home: plan?.home }, options);
    } else answer = await core[message.operation](message.plugin_id, message.request, options);
    process.send?.({ type: 'result', result: answer });
  } catch (error) { process.send?.({ type: 'error', message: error.message }); }
});
process.on('disconnect', () => process.exit(0));
