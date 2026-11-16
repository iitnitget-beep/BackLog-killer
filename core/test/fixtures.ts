import { createMemoryPlatform } from '../src/platform/memory';
import { ToolRegistry } from '../src/tools/registry';
import { ApprovalManager, type ApprovalHandler, type ApprovalMode } from '../src/agent/approval';
import type { PermissionClass } from '../src/tools/types';

export const ROOT = '/workspace/demo';

export function makeRegistry(options: { allowedCommands?: string[] } = {}) {
  const platform = createMemoryPlatform();
  const registry = ToolRegistry.standard(platform, ROOT, { allowedCommands: options.allowedCommands });
  return { platform, registry, root: ROOT };
}

export async function approvalFor(
  mode: ApprovalMode,
  handler: ApprovalHandler | undefined,
  request: { toolName: string; args: Record<string, unknown>; permission?: PermissionClass },
) {
  const manager = new ApprovalManager(mode, handler);
  return manager.check({
    toolName: request.toolName,
    args: request.args,
    permission: request.permission ?? (request.toolName === 'write_file' || request.toolName === 'edit_file' ? 'ask' : 'ask'),
    description: 'test',
  });
}
