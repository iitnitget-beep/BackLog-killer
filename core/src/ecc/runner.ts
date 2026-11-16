/**
 * Hook runner: ECC's execution contract in TypeScript.
 *
 * Reference: ECC `hooks/README.md` — hooks are matcher-scoped per event, they run
 * in declaration order, exit 2 blocks, stderr without exit 2 only warns, and a
 * blocking hook stops the chain. ECC additionally records every hook run for its
 * dashboard; we emit the same information onto the event stream so the phone UI
 * can show it.
 */
import {
  matchesTool,
  type AppliedHook,
  type HookDefinition,
  type HookEvent,
  type HookInput,
  type HookOutcome,
  type HookResult,
  type HookState,
} from './types';

export interface HookRunnerOptions {
  hooks: HookDefinition[];
  /** Max time a single hook may take before it is treated as a failure-to-allow. */
  timeoutMs?: number;
  onApplied?: (applied: AppliedHook, result: HookResult, hook: HookDefinition) => void;
}

/** In-memory HookState. ECC persists this to a temp dir; we keep it per run. */
export function createHookState(): HookState & { snapshot(): Record<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    set(key: string, value: unknown): void {
      store.set(key, value);
    },
    touchedFiles: [],
    gatedPaths: new Set<string>(),
    snapshot() {
      return Object.fromEntries(store);
    },
  };
}

export class HookRunner {
  private readonly hooks: HookDefinition[];
  private readonly timeoutMs: number;

  constructor(private readonly options: HookRunnerOptions) {
    this.hooks = options.hooks;
    this.timeoutMs = options.timeoutMs ?? 2_000;
  }

  /** Hooks registered for an event, in declaration order (ECC's ordering). */
  forEvent(event: HookEvent, toolName?: string): HookDefinition[] {
    return this.hooks.filter((hook) => hook.event === event && matchesTool(hook.matcher, toolName));
  }

  ids(event?: HookEvent): string[] {
    return this.hooks.filter((hook) => !event || hook.event === event).map((hook) => hook.id);
  }

  /**
   * Runs every matching hook for an event. The first block wins and stops the
   * chain, because a later hook's warnings are irrelevant once the tool is
   * refused.
   */
  async dispatch(event: HookEvent, input: Omit<HookInput, 'event'>): Promise<HookOutcome> {
    const applicable = this.forEvent(event, input.toolName);
    const results: AppliedHook[] = [];
    for (const hook of applicable) {
      const started = Date.now();
      let result: HookResult;
      try {
        result = await this.withTimeout(Promise.resolve(hook.run({ ...input, event })));
      } catch (error) {
        // A crashing hook must not silently grant permission, and it must not
        // take the run down either: warn and continue, like ECC's guard.
        result = {
          exitCode: 0,
          severity: 'warn',
          message: `hook ${hook.id} failed: ${(error as Error).message}`,
        };
      }
      const applied: AppliedHook = {
        id: hook.id,
        event,
        exitCode: result.exitCode,
        severity: result.severity,
        message: result.message,
        durationMs: Date.now() - started,
      };
      results.push(applied);
      if (result.additionalContext) this.contextById.set(hook.id, result.additionalContext);
      else this.contextById.delete(hook.id);
      this.options.onApplied?.(applied, result, hook);
      if (result.exitCode === 2) {
        return {
          blocked: true,
          by: hook.id,
          message: result.message ?? `blocked by ${hook.id}`,
          results,
        };
      }
    }
    return { blocked: false, results };
  }

  /** lastContext: additionalContext produced by a hook in the most recent dispatch. */
  private readonly contextById = new Map<string, string>();

  /** additionalContext a hook produced during the last dispatch (if any). */
  lastContext(hookId: string): string | undefined {
    return this.contextById.get(hookId);
  }

  /** Aggregated additionalContext returned to the model, in run order. */
  static contextFrom(results: AppliedHook[], raw: Map<string, HookResult>): string {
    return results
      .map((applied) => raw.get(applied.id)?.additionalContext)
      .filter((value): value is string => Boolean(value && value.trim()))
      .join('\n\n');
  }

  private async withTimeout(promise: Promise<HookResult>): Promise<HookResult> {
    return Promise.race([
      promise,
      new Promise<HookResult>((resolve) =>
        setTimeout(
          () => resolve({ exitCode: 0, severity: 'warn', message: `hook timed out after ${this.timeoutMs}ms` }),
          this.timeoutMs,
        ),
      ),
    ]);
  }
}
