import type { PermissionClass } from '../tools/types';

export type ApprovalMode = 'ASK' | 'AUTO_EDIT' | 'FULL_AUTO';

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  permission: PermissionClass;
  description: string;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Persist this choice for the rest of the run. */
  remember?: boolean;
  reason?: string;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch']);

/**
 * Approval manager: implements the three modes from the spec.
 *
 *  ASK        - every mutating tool needs a human decision.
 *  AUTO_EDIT  - file writes are auto-approved, commands still ask.
 *  FULL_AUTO  - everything except hard 'deny' is auto-approved.
 *
 * 'deny' is never overridable - it is a security refusal, not a preference.
 */
export class ApprovalManager {
  private readonly remembered = new Set<string>();
  private pending = new Map<string, (decision: ApprovalDecision) => void>();
  private counter = 0;

  constructor(
    private mode: ApprovalMode,
    private readonly handler?: ApprovalHandler,
    private readonly onChange?: (mode: ApprovalMode) => void,
  ) {}

  get approvalMode(): ApprovalMode {
    return this.mode;
  }

  setMode(mode: ApprovalMode): void {
    this.mode = mode;
    this.onChange?.(mode);
  }

  /** UI hook: resolve a pending request from the Build screen. */
  resolve(id: string, decision: ApprovalDecision): void {
    const resolver = this.pending.get(id);
    if (resolver) {
      resolver(decision);
      this.pending.delete(id);
    }
  }

  pendingRequests(): string[] {
    return [...this.pending.keys()];
  }

  async check(request: Omit<ApprovalRequest, 'id'>): Promise<ApprovalDecision> {
    if (request.permission === 'deny') {
      return { approved: false, reason: 'blocked by policy' };
    }
    if (request.permission === 'allow') return { approved: true };
    const key = `${request.toolName}:${JSON.stringify(request.args).slice(0, 120)}`;
    if (this.remembered.has(key)) return { approved: true, reason: 'remembered' };
    if (this.mode === 'FULL_AUTO') return { approved: true, reason: 'full-auto' };
    if (this.mode === 'AUTO_EDIT' && FILE_WRITE_TOOLS.has(request.toolName)) {
      return { approved: true, reason: 'auto-edit' };
    }
    if (!this.handler) {
      // No UI attached: fail closed. A missing approval surface must never
      // silently grant write access.
      return { approved: false, reason: 'no approval handler attached' };
    }
    this.counter += 1;
    const id = `approval-${this.counter}`;
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(id, resolve);
      Promise.resolve(this.handler!({ ...request, id })).then(
        (result) => {
          this.pending.delete(id);
          resolve(result);
        },
        () => {
          this.pending.delete(id);
          resolve({ approved: false, reason: 'approval handler failed' });
        },
      );
    });
    if (decision.approved && decision.remember) this.remembered.add(key);
    return decision;
  }
}

/** Convenience handlers used by tests and by the CLI harness. */
export const approveAll: ApprovalHandler = async () => ({ approved: true });
export const denyAll: ApprovalHandler = async () => ({ approved: false, reason: 'auto-deny' });
export function approveFirstN(n: number): ApprovalHandler {
  let seen = 0;
  return async (request) => {
    seen += 1;
    return seen <= n
      ? { approved: true }
      : { approved: false, reason: `auto-deny after ${n} approvals (${request.toolName})` };
  };
}
