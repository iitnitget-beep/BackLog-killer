import type { ToolRegistry } from '../tools/registry';
import type { ToolResultEnvelope } from '../tools/types';
import type { ApprovalManager } from './approval';
import { gate } from '../security/scanner';

export interface ExecuteOptions {
  toolName: string;
  args: Record<string, unknown>;
  registry: ToolRegistry;
  approvals: ApprovalManager;
  workspaceRoot: string;
  /** Enforce the secret gate before any write (ECC PreToolUse hook). */
  secretGate?: boolean;
}

export interface ExecuteOutcome {
  envelope: ToolResultEnvelope;
  blocked: boolean;
  blockedReason?: string;
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

/**
 * The single choke point for tool execution. Order is deliberate:
 *   1. resolve permission class from the tool itself
 *   2. ask the approval manager (mode + user)
 *   3. run the PreToolUse secret gate on write payloads
 *   4. execute
 * Every branch produces an envelope, so the model always gets an answer.
 */
export async function executeTool(options: ExecuteOptions): Promise<ExecuteOutcome> {
  const { toolName, args, registry, approvals, workspaceRoot } = options;
  const permission = registry.permissionFor(toolName, args);
  const decision = await approvals.check({
    toolName,
    args,
    permission,
    description: describeCall(toolName, args),
  });
  if (!decision.approved) {
    return {
      blocked: true,
      blockedReason: decision.reason ?? `not approved (${permission})`,
      envelope: {
        ok: false,
        output: `Blocked: ${decision.reason ?? 'not approved'}`,
        error: { code: permission === 'deny' ? 'EDENIED' : 'EAPPROVAL', message: decision.reason ?? 'not approved' },
      },
    };
  }
  if (options.secretGate !== false && WRITE_TOOLS.has(toolName)) {
    const payload = String(args['content'] ?? args['new_string'] ?? '');
    const path = String(args['path'] ?? '');
    const verdict = gate(payload, { path });
    if (!verdict.allowed) {
      return {
        blocked: true,
        blockedReason: verdict.reason,
        envelope: {
          ok: false,
          output: `${verdict.reason}\n${verdict.findings.map((f) => `- ${f.rule} line ${f.line}: ${f.excerpt}`).join('\n')}`,
          error: { code: 'ESECRET', message: verdict.reason ?? 'secret detected' },
        },
      };
    }
  }
  try {
    const envelope = await registry.execute(toolName, args, { workspaceRoot });
    return { envelope, blocked: false };
  } catch (error) {
    const err = error as { code?: string; message?: string; recoverable?: boolean };
    return {
      blocked: false,
      envelope: {
        ok: false,
        output: `Tool error: ${err.message ?? String(error)}`,
        error: { code: err.code ?? 'ETOOLFAIL', message: err.message ?? String(error) },
      },
    };
  }
}

export function describeCall(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'write_file') return `Write ${args['path']} (${String(args['content'] ?? '').length} bytes)`;
  if (toolName === 'edit_file') return `Edit ${args['path']}`;
  if (toolName === 'run_command') return `Run: ${args['command']}`;
  if (toolName === 'read_file') return `Read ${args['path']}`;
  if (toolName === 'grep') return `Search: ${args['pattern']}`;
  if (toolName === 'glob') return `Glob: ${args['pattern']}`;
  return `${toolName} ${JSON.stringify(args).slice(0, 100)}`;
}
