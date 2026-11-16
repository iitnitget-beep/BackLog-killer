/**
 * ForgeX hook: refuse destructive shell commands before they run.
 *
 * ECC implements this in its Bash preflight dispatcher
 * (`scripts/hooks/bash-hook-dispatcher.js` -> gateguard destructive checks).
 * We keep our own `isDestructive` matcher and expose it through the hook graph so
 * a command is refused at the hook layer even if a future tool skips
 * `shellTool.permission()`.
 */
import { block, warn, allow, type HookDefinition } from '../types';
import { isDestructive, splitCommand } from '../../tools/shell';

export const destructiveCommandHook: HookDefinition = {
  id: 'pre:destructive-command',
  event: 'PreToolUse',
  matcher: 'run_command',
  description: 'Block force-push, branch deletion, rm -rf and other destructive commands.',
  derivedFrom: 'ForgeX (ECC bash preflight / gateguard destructive checks)',
  run(input) {
    const command = String(input.toolArgs?.['command'] ?? '');
    if (!command) return allow();
    if (isDestructive(command)) {
      return block(
        `Refusing destructive command: "${command}". Destructive git operations need explicit user confirmation and are never auto-approved.`,
        { command },
      );
    }
    // Surface shell metacharacters early: the tool layer will refuse them, but a
    // clear warning here is cheaper than a confusing tool error later.
    try {
      splitCommand(command);
    } catch (error) {
      return warn(`Command will be refused by the shell tool: ${(error as Error).message}`);
    }
    return allow();
  },
};
