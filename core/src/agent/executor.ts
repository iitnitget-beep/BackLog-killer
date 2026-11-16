import type { ToolRegistry } from '../tools/registry';
import type { ToolResultEnvelope } from '../tools/types';
import type { ApprovalManager } from './approval';
import { gate } from '../security/scanner';
import { HookRunner } from '../ecc/runner';
import { DEFAULT_HOOKS } from '../ecc/registry';
import type { HookState, HookEvent } from '../ecc/types';

export interface ExecuteOptions {
  toolName: string;
  args: Record<string, unknown>;
  registry: ToolRegistry;
  approvals: ApprovalManager;
  workspaceRoot: string;
  /** Enforce the secret gate before any write (ECC PreToolUse hook). */
  secretGate?: boolean;
  /** ECC hook graph. Defaults to the standard ForgeX graph. */
  hookRunner?: HookRunner;
  /** Shared per-run hook state (read files, gated paths, exists cache). */
  hookState?: HookState;
  onHook?: (applied: { id: string; exitCode: number; message?: string; severity: string }) => void;
}

export interface ExecuteOutcome {
  envelope: ToolResultEnvelope;
  blocked: boolean;
  blockedReason?: string;
  /** Hooks that ran, for the event stream. */
  hooks?: { id: string; exitCode: number; message?: string }[];
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

/** Relative, forward-slash path used by path-aware hooks. */
export function targetPathFor(args: Record<string, unknown>, workspaceRoot: string): string | undefined {
  const raw = args['path'];
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return raw
    .replace(/\\/g, '/')
    .replace(new RegExp(`^${workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`), '')
    .replace(/^\/+/, '');
}

/**
 * The single choke point for tool execution. Order is deliberate:
 *   1. ECC PreToolUse hooks (fact-forcing gate, secret scan, config protection,
 *      destructive-command refusal) - first block wins
 *   2. resolve permission class from the tool itself
 *   3. ask the approval manager (mode + user)
 *   4. execute
 *   5. ECC PostToolUse hooks
 * Every branch produces an envelope, so the model always gets an answer.
 */
export async function executeTool(options: ExecuteOptions): Promise<ExecuteOutcome> {
  const { toolName, args, registry, approvals, workspaceRoot } = options;
  const applied: { id: string; exitCode: number; message?: string }[] = [];
  const runner = options.hookRunner;
  const hookState = options.hookState;

  if (runner && hookState) {
    const targetPath = targetPathFor(args, workspaceRoot);
    const exists = targetPath
      ? await registry.workspaceExists?.(targetPath)
      : undefined;
    if (targetPath && exists !== undefined) hookState.set(`exists:${targetPath}`, exists);
    const pre = await runner.dispatch('PreToolUse', {
      toolName,
      toolArgs: args,
      workspaceRoot,
      targetPath,
      state: hookState,
      now: Date.now(),
    });
    for (const result of pre.results) {
      applied.push({ id: result.id, exitCode: result.exitCode, message: result.message });
      options.onHook?.(result);
    }
    if (pre.blocked) {
      return {
        blocked: true,
        blockedReason: pre.message,
        hooks: applied,
        envelope: {
          ok: false,
          output: `Blocked by hook ${pre.by}: ${pre.message}`,
          error: { code: 'EHOOK', message: pre.message },
        },
      };
    }
  }

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
      hooks: applied,
      envelope: {
        ok: false,
        output: `Blocked: ${decision.reason ?? 'not approved'}`,
        error: { code: permission === 'deny' ? 'EDENIED' : 'EAPPROVAL', message: decision.reason ?? 'not approved' },
      },
    };
  }

  // Belt and braces: the hook graph already scanned writes, but a caller that
  // supplies its own hook list must not silently lose the secret gate.
  if (options.secretGate !== false && WRITE_TOOLS.has(toolName) && !runner) {
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

  let envelope: ToolResultEnvelope;
  try {
    envelope = await registry.execute(toolName, args, { workspaceRoot });
  } catch (error) {
    const err = error as { code?: string; message?: string; recoverable?: boolean };
    envelope = {
      ok: false,
      output: `Tool error: ${err.message ?? String(error)}`,
      error: { code: err.code ?? 'ETOOLFAIL', message: err.message ?? String(error) },
    };
  }

  if (runner && hookState) {
    const targetPath = targetPathFor(args, workspaceRoot);
    if (targetPath && envelope.ok && WRITE_TOOLS.has(toolName)) {
      hookState.touchedFiles.push(targetPath);
      if (typeof args['content'] === 'string') hookState.set(`content:${targetPath}`, args['content']);
      // The Stop hook inspects what was actually written, not just paths.
      if (/\.(kt|java)$/.test(targetPath)) {
        const written = hookState.get<{ path: string; content: string }[]>('writtenSources') ?? [];
        const existing = hookState.get<string>(`content:${targetPath}`) ?? '';
        hookState.set('writtenSources', [
          ...written.filter((entry) => entry.path !== targetPath),
          { path: targetPath, content: existing },
        ]);
      }
    }
    const post = await runner.dispatch('PostToolUse', {
      toolName,
      toolArgs: args,
      workspaceRoot,
      targetPath,
      toolResult: { ok: envelope.ok, output: envelope.output },
      state: hookState,
      now: Date.now(),
    });
    for (const result of post.results) {
      applied.push({ id: result.id, exitCode: result.exitCode, message: result.message });
      options.onHook?.(result);
    }
  }

  return { envelope, blocked: false, hooks: applied };
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

export type { HookEvent, HookState };
export { HookRunner, DEFAULT_HOOKS };
