/**
 * Ported from ECC `scripts/hooks/config-protection.js` (MIT).
 *
 * The failure mode it prevents is real and common with coding agents: a lint
 * error appears, the agent "fixes" it by relaxing the linter. This hook blocks
 * modification of an *existing* config file while still allowing first-time
 * creation, exactly like the original's exit-code contract.
 *
 * Exit 0 = allow (not a config file, or the file does not exist yet)
 * Exit 2 = block (an existing config file is being modified)
 */
import { block, allow, type HookDefinition } from '../types';

/** Same set as ECC's PROTECTED_FILES, extended with Kotlin/Android lint configs. */
export const PROTECTED_CONFIGS = new Set([
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts',
  '.prettierrc', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml',
  'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
  'biome.json', 'biome.jsonc', '.biome.json',
  'tsconfig.json', 'tsconfig.base.json', 'vitest.config.ts', 'vitest.config.js', 'jest.config.js', 'jest.config.ts',
  'detekt.yml', 'detekt.yaml', 'lint.xml',
]);

/** Directories whose contents are build output or dependencies. */
const ALLOWED_SUFFIXES = ['/node_modules/', '/build/', '/.gradle/'];

export function isProtectedConfig(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  if (ALLOWED_SUFFIXES.some((suffix) => normalized.includes(suffix))) return false;
  const basename = normalized.split('/').pop() ?? normalized;
  return PROTECTED_CONFIGS.has(basename);
}

export const configProtectionHook: HookDefinition = {
  id: 'pre:config-protection',
  event: 'PreToolUse',
  matcher: 'write_file|edit_file',
  description:
    'Block modifications to existing linter/formatter config files. Steers the agent to fix code instead of weakening configs.',
  derivedFrom: 'ECC scripts/hooks/config-protection.js',
  run(input) {
    const target = input.targetPath;
    if (!target) return allow();
    if (!isProtectedConfig(target)) return allow();
    // First-time creation is allowed: a project may legitimately add a linter.
    // Unknown existence is treated as "already there" on purpose - if the
    // existence probe failed we must not let the agent overwrite a config.
    const existed = input.state.get<boolean>(`exists:${target}`);
    if (existed === false) return allow(`Creating ${target} for the first time is allowed.`);
    return block(
      `Refusing to modify the linter/build config "${target}". Fix the code the config is complaining about instead of relaxing the check. If the config genuinely needs a change, the user must approve it explicitly.`,
      { path: target, hook: 'pre:config-protection' },
    );
  },
};
