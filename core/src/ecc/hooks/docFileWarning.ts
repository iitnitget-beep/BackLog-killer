/**
 * Ported from ECC `scripts/hooks/doc-file-warning.js` (MIT).
 *
 * Warn-only (exit code 0) about ad-hoc scratch documentation: NOTES.md, TODO.md,
 * SCRATCH.md and friends outside structured directories. Agents leave debris in
 * repositories; this nudges without blocking a legitimate docs workflow.
 */
import { warn, allow, type HookDefinition } from '../types';

/** Uppercase scratch filenames, same as ECC's ADHOC_FILENAMES. */
export const ADHOC_FILENAMES = /^(NOTES|TODO|SCRATCH|TEMP|DRAFT|BRAINSTORM|SPIKE|DEBUG|WIP)\.(md|txt)$/;

/** Directories where such a name is intentional. */
export const STRUCTURED_DIRS = /(^|\/)(docs|\.github|commands|skills|benchmarks|templates|memory|\.forgex)\//;

export function isSuspiciousDocPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  if (!/\.(md|txt)$/.test(basename)) return false;
  if (!ADHOC_FILENAMES.test(basename)) return false;
  if (STRUCTURED_DIRS.test(normalized)) return false;
  return true;
}

export const docFileWarningHook: HookDefinition = {
  id: 'pre:write:doc-file-warning',
  event: 'PreToolUse',
  matcher: 'write_file',
  description: 'Warn about non-standard scratch documentation files (warns only, never blocks).',
  derivedFrom: 'ECC scripts/hooks/doc-file-warning.js',
  run(input) {
    const target = input.targetPath;
    if (!target || !isSuspiciousDocPath(target)) return allow();
    return warn(
      `"${target}" looks like a scratch notes file. Put durable docs in docs/ or AGENTS.md, and delete this before shipping.`,
    );
  },
};
