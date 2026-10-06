import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const binding = JSON.parse(fs.readFileSync(new URL('binding.json', root), 'utf8'));

// Loaded by OpenCode. This artifact has no dependency on the Kit checkout.
export default async (_input, options = {}) => ({
  config: async config => {
    config.skills ??= {};
    config.skills.paths ??= [];
    const skills = fileURLToPath(new URL('skills', root));
    if (!config.skills.paths.includes(skills)) config.skills.paths.push(skills);
    config.mcp ??= {};
    for (const name of binding.servers) {
      if (config.mcp[name]) throw new Error(`MCP name is already configured: ${name}`);
      config.mcp[name] = {
        type: 'local', enabled: true,
        command: ['node', fileURLToPath(new URL('runtime/launch.cjs', root)), name],
        ...((options.workbench_workspace || options._codehelix_binding) ? { environment: {
          ...(options.workbench_workspace ? { [JSON.parse(fs.readFileSync(new URL('runtime/servers.json', root), 'utf8')).find(s => s.name === name).workspace_env]: options.workbench_workspace } : {}),
          ...(options._codehelix_binding ? { CODEHELIX_PLUGIN_BINDING: options._codehelix_binding } : {}),
        } } : {}),
      };
    }
  },
});
