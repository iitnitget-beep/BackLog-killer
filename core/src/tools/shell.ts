import type { Platform } from '../platform/types';
import { ToolError, type ToolDefinition, type ToolResultEnvelope } from './types';

/**
 * Command execution on Android has no shell: the bridge runs an allowlisted
 * executable with an argument vector. We therefore accept a tokenised command
 * *string* for model ergonomics but split it ourselves and refuse shell
 * metacharacters, which is the equivalent of qwen-code's shell hardening
 * (packages/core/src/tools/shell.ts) without needing a POSIX shell.
 */
const DENIED_TOKENS = ['&&', '||', ';', '|', '>', '<', '`', '$(', '&>'];

export function splitCommand(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) throw new ToolError('command is empty', 'EARGS');
  for (const token of DENIED_TOKENS) {
    if (trimmed.includes(token)) {
      throw new ToolError(`shell metacharacter not allowed: ${token}`, 'ESHELL');
    }
  }
  return trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, '')) ?? [];
}

export const DESTRUCTIVE_PATTERNS = [
  /(^|\s)rm\s+-rf\s+\/(\s|$)/,
  /(^|\s)rm\s+-rf\s+~/,
  /git\s+push\s+.*--force(?!-with-lease)/,
  /git\s+push\s+.*-f(\s|$)/,
  /git\s+branch\s+-D\s+/,
  /git\s+reset\s+--hard/,
  /mkfs/,
  /:\(\)\s*\{.*\}\s*;/,
];

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

export function shellTool(
  platform: Platform,
  root: string,
  options: { allowedCommands?: string[]; defaultTimeoutMs?: number } = {},
): ToolDefinition {
  const allowed = options.allowedCommands ? new Set(options.allowedCommands) : null;
  return {
    name: 'run_command',
    spec: {
      description:
        'Run a command in the project workspace (no shell operators, no pipes). Useful for tests, lint and build.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'e.g. "npm test" or "gradle assembleDebug"' },
          cwd: { type: 'string' },
          timeout_ms: { type: 'number' },
        },
        required: ['command'],
      },
    },
    permission: (args) => {
      const command = String((args as Record<string, unknown>)['command'] ?? '');
      return isDestructive(command) ? 'deny' : 'ask';
    },
    async run(args): Promise<ToolResultEnvelope> {
      const command = String(args['command'] ?? '');
      const argv = splitCommand(command);
      if (isDestructive(command)) {
        throw new ToolError('refused: destructive command requires explicit user confirmation', 'EDESTRUCTIVE', false);
      }
      if (allowed && !allowed.has(argv[0])) {
        throw new ToolError(`command not in allowlist: ${argv[0]}`, 'EALLOWLIST');
      }
      const cwd = args['cwd'] ? `${root}/${String(args['cwd'])}`.replace(/\/+/g, '/') : root;
      const result = await platform.exec(argv, {
        cwd,
        timeoutMs: Number(args['timeout_ms'] ?? options.defaultTimeoutMs ?? 300_000),
      });
      const output = [
        result.stdout ? `stdout:\n${result.stdout.slice(-8000)}` : '',
        result.stderr ? `stderr:\n${result.stderr.slice(-8000)}` : '',
        `exit code: ${result.code}${result.timedOut ? ' (timed out)' : ''}`,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        ok: result.code === 0 && !result.timedOut,
        output,
        data: { argv, code: result.code, timedOut: result.timedOut },
        ...(result.code !== 0 ? { error: { code: 'EEXIT', message: `exit ${result.code}` } } : {}),
      };
    },
  };
}
