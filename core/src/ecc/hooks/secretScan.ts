/**
 * ForgeX hook: run the secret scanner as a PreToolUse gate.
 *
 * The scanner itself predates this work (`src/security/scanner.ts`); the hook
 * wrapper makes it part of the ECC graph so it appears in Settings, is recorded
 * on the event stream like every other hook, and cannot be forgotten by a caller
 * that bypasses `executeTool`.
 */
import { block, allow, type HookDefinition } from '../types';
import { scanText } from '../../security/scanner';

export const secretScanHook: HookDefinition = {
  id: 'pre:secret-scan',
  event: 'PreToolUse',
  matcher: 'write_file|edit_file',
  description: 'Block writes that contain an API key, token, private key or keystore password.',
  derivedFrom: 'ForgeX (ECC rules/common/hooks.md PreToolUse discipline)',
  run(input) {
    const target = input.targetPath ?? '';
    const args = input.toolArgs ?? {};
    const payload = [args['content'], args['new_string']].filter((value) => typeof value === 'string').join('\n');
    if (!payload) return allow();
    const findings = scanText(payload, { path: target });
    if (findings.length === 0) return allow();
    const detail = findings
      .slice(0, 3)
      .map((finding) => `${finding.rule} (${finding.description}) ${finding.excerpt}`)
      .join('; ');
    return block(
      `Refusing to write ${target}: it contains what looks like a credential. ${detail}. Use a placeholder and read the real value from the Keystore or an environment variable.`,
      { path: target, rules: findings.map((finding) => finding.rule) },
    );
  },
};
