import type { Platform } from '../platform/types';

/**
 * PostToolUse-style lint hook (ECC rules/common/hooks.md). After an edit the
 * orchestrator asks the platform for the project's lint command and records the
 * result on the event stream. Lint failures are advisory - they are fed back to
 * the model, not treated as hard stops.
 */
export interface LintOutcome {
  ran: boolean;
  command?: string[];
  ok: boolean;
  output: string;
}

export interface LintStrategy {
  /** Command to run, or null when the project has no linting setup. */
  detect(files: string[]): string[] | null;
}

export const defaultLintStrategy: LintStrategy = {
  detect(files) {
    const has = (ext: string) => files.some((f) => f.endsWith(ext));
    if (files.includes('package.json')) return ['npm', 'run', 'lint', '--if-present'];
    if (has('.kt') && files.includes('gradlew')) return ['sh', 'gradlew', 'lintDebug', '--offline'];
    if (has('.py')) return ['python3', '-m', 'ruff', 'check', '.'];
    return null;
  },
};

export async function runLint(
  platform: Platform,
  root: string,
  files: string[],
  strategy: LintStrategy = defaultLintStrategy,
): Promise<LintOutcome> {
  const command = strategy.detect(files);
  if (!command) return { ran: false, ok: true, output: 'no lint command detected' };
  const result = await platform.exec(command, { cwd: root, timeoutMs: 180_000 });
  return {
    ran: true,
    command,
    ok: result.code === 0,
    output: `${result.stdout}\n${result.stderr}`.trim().slice(-4000),
  };
}
