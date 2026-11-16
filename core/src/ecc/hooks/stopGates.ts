/**
 * Two small Stop/PreCompact hooks in the spirit of ECC's session-boundary hooks
 * (`hooks/memory-persistence/hooks.json`, `scripts/hooks/suggest-compact.js`).
 *
 *  - `pre:compact` persists a summary before the condenser drops history.
 *  - `stop:unverified-claim` blocks finishing when the agent claims success but
 *    no verification ran. This is the single most valuable guardrail for a tool
 *    that tells a user "your app is built".
 */
import { block, warn, allow, type HookDefinition } from '../types';

const SUCCESS_CLAIMS = [
  /\bbuild (?:succeeded|passed|is green)\b/i,
  /\b(?:all )?tests? (?:pass|passed|are green)\b/i,
  /\bcompiles?\b/i,
  /\bworks\b/i,
  /\bdone\b/i,
  /\b(successfully|correctly) (?:built|created|implemented|added)\b/i,
];

export function claimsSuccess(text: string): boolean {
  return SUCCESS_CLAIMS.some((pattern) => pattern.test(text));
}

export const unverifiedClaimHook: HookDefinition = {
  id: 'stop:unverified-claim',
  event: 'Stop',
  matcher: '*',
  description: 'Block a success claim when no verification command ran in this run.',
  derivedFrom: 'ECC rules/common/testing.md + agents/build-error-resolver.md verification discipline',
  run(input) {
    const ranVerification = input.state.get<boolean>('verificationRan') === true;
    const lastMessage = input.state.get<string>('lastAssistantMessage') ?? '';
    if (!claimsSuccess(lastMessage)) return allow();
    if (ranVerification) return allow();
    return block(
      'You reported success but no verification ran in this run. Run the project build/test command, or say plainly that it is unverified.',
      { hook: 'stop:unverified-claim' },
    );
  },
};

export const preCompactHook: HookDefinition = {
  id: 'pre:compact',
  event: 'PreCompact',
  matcher: '*',
  description: 'Persist a compact summary of the run before older context is condensed away.',
  derivedFrom: 'ECC hooks/memory-persistence/hooks.json (pre:compact)',
  run(input) {
    const touched = input.state.touchedFiles.slice(-15);
    if (touched.length === 0) return allow();
    input.state.set('compactionNote', `Files touched so far: ${touched.join(', ')}`);
    return warn(`Compacting context. Files touched this run: ${touched.length} (checkpoint saved).`);
  },
};

export const sessionStartHook: HookDefinition = {
  id: 'session:start',
  event: 'SessionStart',
  matcher: '*',
  description: 'Inject project memory (AGENTS.md + learned notes) at the start of a run.',
  derivedFrom: 'ECC hooks/memory-persistence/hooks.json (session:start)',
  run(input) {
    const memory = input.state.get<string>('projectMemory') ?? '';
    if (!memory.trim()) return allow();
    return allow('Loaded project memory.', memory.slice(0, 6000));
  },
};
