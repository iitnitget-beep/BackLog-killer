/**
 * The default ForgeX hook graph.
 *
 * This mirrors ECC's `hooks/hooks.json` + `hooks/hooks.metadata.json` split: the
 * definitions live here, and their ids/descriptions are what the Settings screen
 * renders and what the event stream records.
 */
import type { HookDefinition } from './types';
import { configProtectionHook } from './hooks/configProtection';
import { docFileWarningHook } from './hooks/docFileWarning';
import { consoleLogHook } from './hooks/consoleLog';
import { gateGuardHook } from './hooks/gateGuard';
import { preCompactHook, sessionStartHook, unverifiedClaimHook } from './hooks/stopGates';
import { secretScanHook } from './hooks/secretScan';
import { destructiveCommandHook } from './hooks/destructiveCommand';

export const DEFAULT_HOOKS: HookDefinition[] = [
  sessionStartHook,
  gateGuardHook,
  configProtectionHook,
  docFileWarningHook,
  secretScanHook,
  destructiveCommandHook,
  preCompactHook,
  unverifiedClaimHook,
  consoleLogHook,
];

export interface HookInfo {
  id: string;
  event: string;
  matcher: string;
  description: string;
  derivedFrom: string;
  derivation: string;
  blocking: boolean;
  origin: 'ECC port' | 'ForgeX';
}

/**
 * Hook catalogue for the UI. `blocking` is what the user actually cares about:
 * which hooks can refuse an action.
 */
export function hookCatalogue(hooks: HookDefinition[] = DEFAULT_HOOKS): HookInfo[] {
  return hooks.map((hook) => ({
    id: hook.id,
    event: hook.event,
    matcher: hook.matcher,
    description: hook.description,
    derivedFrom: hook.derivedFrom,
    /** Human label for the derivation, shown in Settings. */
    derivation: `${hook.derivedFrom.startsWith('ECC') ? 'ECC port' : 'ForgeX'} · ${hook.derivedFrom}`,
    blocking: BLOCKING_IDS.has(hook.id),
    origin: hook.derivedFrom.startsWith('ECC') ? 'ECC port' : 'ForgeX',
  }));
}

/** Hooks that can return exit code 2 (kept in sync by test/hooks.test.ts). */
const BLOCKING_IDS = new Set([
  'pre:config-protection',
  'pre:edit-write:gateguard-fact-force',
  'pre:secret-scan',
  'pre:destructive-command',
  'stop:unverified-claim',
]);
