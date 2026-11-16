/**
 * ECC's hook model, ported to TypeScript.
 *
 * Reference: affaan-m/ECC `hooks/README.md`, `hooks/hooks.json`,
 * `hooks/hooks.metadata.json`, `scripts/hooks/*.js` (MIT, Copyright (c) 2026
 * Affaan Mustafa). See NOTICE.md.
 *
 * The important detail ECC gets right, and which we keep exactly: a hook's
 * `exit code 2` **blocks** the tool, while stderr alone only **warns**. Hooks
 * also run in a fixed order within an event and the first blocking one wins.
 */

/** ECC hook events. We implement the subset that is meaningful without a Claude Code harness. */
export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCompact'
  | 'Stop'
  | 'SessionEnd';

/** Exit-code contract from ECC's hooks README. */
export const EXIT_ALLOW = 0;
export const EXIT_BLOCK = 2;

export type HookSeverity = 'block' | 'warn' | 'info';

export interface HookInput {
  event: HookEvent;
  /** Tool name as the model wrote it, e.g. "write_file". */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  /** Absolute workspace root, used by path-aware hooks. */
  workspaceRoot: string;
  /** Text of the user's request (UserPromptSubmit, SessionStart). */
  prompt?: string;
  /** Tool result (PostToolUse). */
  toolResult?: { ok: boolean; output: string };
  /** Normalised, forward-slash relative path of the target file, if any. */
  targetPath?: string;
  /** Per-run scratch state shared between hooks (ECC keeps this in a temp dir). */
  state: HookState;
  /** Estimated context tokens, for the compact suggester. */
  contextTokens?: number;
  /** Number of tool calls so far in this run. */
  toolCallCount?: number;
  now: number;
}

/** Mutable per-run state hooks may read/write (ECC uses a temp dir + JSON files). */
export interface HookState {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  /** Files touched this run, in order. */
  touchedFiles: string[];
  /** Paths already gated once (GateGuard "first touch"). */
  gatedPaths: Set<string>;
}

export interface HookResult {
  /** Mirrors process exit code: 0 allow, 2 block. */
  exitCode: number;
  severity: HookSeverity;
  /** stderr-equivalent: shown to the user and fed to the model. */
  message?: string;
  /** Reminder injected into the model's context (ECC "additionalContext"). */
  additionalContext?: string;
  /** Structured payload for the event stream / UI. */
  data?: Record<string, unknown>;
}

export interface HookDefinition {
  /** Stable id in ECC's namespace, e.g. "pre:config-protection". */
  id: string;
  event: HookEvent;
  /** ECC matcher syntax: "*", ".*", or a case-insensitive tool-name list "write_file|edit_file". */
  matcher: string;
  description: string;
  /** Attribution string for the UI + NOTICE.md. */
  derivedFrom: string;
  /** Which approval modes run this hook; ECC gates hooks by flags. */
  modes?: ('ASK' | 'AUTO_EDIT' | 'FULL_AUTO')[];
  run(input: HookInput): HookResult | Promise<HookResult>;
}

export type HookOutcome =
  | { blocked: true; by: string; message: string; results: AppliedHook[] }
  | { blocked: false; results: AppliedHook[] };

export interface AppliedHook {
  id: string;
  event: HookEvent;
  exitCode: number;
  severity: HookSeverity;
  message?: string;
  durationMs: number;
}

/** ECC's matcher grammar: "*" / ".*" matches everything, "a|b" lists tools. */
export function matchesTool(matcher: string, toolName: string | undefined): boolean {
  if (!toolName) return matcher === '*' || matcher === '.*';
  if (matcher === '*' || matcher === '.*') return true;
  // ECC matchers are regex-ish; we treat them as a case-insensitive alternation
  // of literal tool names, which is how the plugin graph actually uses them.
  return matcher
    .split('|')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .some((part) => part === toolName.toLowerCase() || (part.startsWith('^') && new RegExp(part, 'i').test(toolName)));
}

export function allow(message?: string, additionalContext?: string): HookResult {
  return { exitCode: EXIT_ALLOW, severity: 'info', message, additionalContext };
}

export function warn(message: string, additionalContext?: string): HookResult {
  return { exitCode: EXIT_ALLOW, severity: 'warn', message, additionalContext };
}

export function block(message: string, data?: Record<string, unknown>): HookResult {
  return { exitCode: EXIT_BLOCK, severity: 'block', message, data };
}
