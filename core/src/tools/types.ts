/**
 * Tool contract, loosely modelled on qwen-code's ToolInvocation
 * (packages/core/src/tools/tools.ts, Apache-2.0): a declarative schema, a
 * permission class, and a single `run` entry point. See NOTICE.md.
 */
export type PermissionClass = 'allow' | 'ask' | 'deny';

export interface ToolSpec {
  /** JSON-schema style parameter description given to the model. */
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  description: string;
}

export interface ToolContext {
  /** Absolute root of the current project workspace. */
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface ToolDefinition<Args = Record<string, unknown>, Result = unknown> {
  name: string;
  spec: ToolSpec;
  /**
   * Intrinsic permission for this call. Mirrors qwen-code's
   * getDefaultPermission(): 'allow' is read-only, 'ask' mutates state,
   * 'deny' is a hard refusal.
   */
  permission(args: Args): PermissionClass;
  run(args: Args, context: ToolContext): Promise<Result>;
}

export class ToolError extends Error {
  constructor(message: string, readonly code: string, readonly recoverable = true) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Result shape returned to the model. Every tool answers in this envelope. */
export interface ToolResultEnvelope {
  ok: boolean;
  output: string;
  /** Structured payload for UI rendering. */
  data?: unknown;
  error?: { code: string; message: string };
}
