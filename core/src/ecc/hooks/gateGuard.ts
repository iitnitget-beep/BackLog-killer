/**
 * Ported from ECC `scripts/hooks/gateguard-fact-force.js` (MIT).
 *
 * The insight worth stealing: asking an LLM "are you sure?" is useless, because
 * it always says yes. Asking it for *concrete facts* forces an investigation,
 * and the investigation creates the awareness that self-assessment never did.
 *
 * On the phone we cannot read a transcript or a git index, so the port keeps the
 * part that survives without them:
 *   - the first edit of any sensitive target (secrets, auth, payment, CI
 *     workflows, migrations) is denied once with a specific question;
 *   - the agent must read the file (or grep for it) before it may write;
 *   - a file already read this run passes without a gate;
 *   - comments/whitespace-only changes pass, so cosmetic edits are not punished.
 *
 * Deny happens once per file per run: a second attempt after the required
 * investigation succeeds. That is ECC's "gated once" behaviour, simplified.
 */
import { block, allow, type HookDefinition } from '../types';

/** Targets ECC always gates, in our naming. */
const SENSITIVE = [
  /(^|\/)\.github\/workflows\//,
  /(^|\/)(secrets?|credentials?|keystore)(\/|\.|$)/i,
  /(^|\/)(auth|login|session|payment|billing)(\/|\.|$)/i,
  /(^|\/)(migrations?|migrate)(\/|\.|$)/i,
  /(^|\/)AndroidManifest\.xml$/,
  /(^|\/)local\.properties$/,
  /\.jks$/,
  /(^|\/)build\.gradle(\.kts)?$/,
];

/** Kotlin/Android specific question sets, selected by target class. */
export type TargetClass = 'ci' | 'secrets' | 'auth' | 'manifest' | 'build' | 'general';

export function classifyTarget(relativePath: string): TargetClass {
  const path = relativePath.replace(/\\/g, '/');
  if (/(^|\/)\.github\/workflows\//.test(path)) return 'ci';
  if (/\.jks$|keystore|secrets?|credentials?/i.test(path)) return 'secrets';
  if (/(^|\/)(auth|login|session|payment|billing)/i.test(path)) return 'auth';
  if (/AndroidManifest\.xml$/.test(path)) return 'manifest';
  if (/build\.gradle(\.kts)?$|settings\.gradle/.test(path)) return 'build';
  return 'general';
}

export function isSensitiveTarget(relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, '/');
  return SENSITIVE.some((pattern) => pattern.test(path));
}

const QUESTIONS: Record<TargetClass, string[]> = {
  ci: [
    'Which job will run this workflow, and does anything else depend on its name?',
    'Which permissions and secrets does it need, and are they scoped to the minimum?',
    'What happens on a fork PR where secrets are unavailable?',
  ],
  secrets: [
    'Where is this value read from at runtime, and what breaks if it is missing?',
    'Confirm no real credential is being written: what is the placeholder and where does the real value live?',
  ],
  auth: [
    'Which entry points reach this code, and what happens for an unauthenticated caller?',
    'Where is the authorization check, and is it on the server/domain side rather than the UI?',
  ],
  manifest: [
    'Does every added permission have a call site that needs it?',
    'Are exported components protected, and is cleartext traffic still disabled?',
  ],
  build: [
    'Which Gradle/AGP versions does this file pin, and do they agree with the wrapper and the CI JDK?',
    'Is anything here weakening a check (lint abortOnError, test skipping, minify off) rather than fixing a failure?',
  ],
  general: [
    'What does this file do today, and which callers depend on its current behaviour?',
    'Which test covers the behaviour you are about to change?',
  ],
};

export function questionsFor(relativePath: string): { targetClass: TargetClass; questions: string[] } {
  const targetClass = classifyTarget(relativePath);
  return { targetClass, questions: QUESTIONS[targetClass] };
}

/** Returns true when the only differences are comments or whitespace. */
export function isCosmeticChange(before: string, after: string): boolean {
  const normalise = (value: string) =>
    value
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/\s+/g, '')
      .trim();
  return normalise(before) === normalise(after);
}

export const gateGuardHook: HookDefinition = {
  id: 'pre:edit-write:gateguard-fact-force',
  event: 'PreToolUse',
  matcher: 'write_file|edit_file',
  description:
    'Fact-forcing gate: deny the first write of a sensitive file until the agent has read it, with questions chosen by target class.',
  derivedFrom: 'ECC scripts/hooks/gateguard-fact-force.js',
  run(input) {
    const target = input.targetPath;
    if (!target) return allow();
    const args = input.toolArgs ?? {};
    const sensitive = isSensitiveTarget(target);
    const alreadyGated = input.state.gatedPaths.has(target);
    const readThisRun = input.state.get<string[]>('readFiles')?.includes(target) ?? false;
    const exists = input.state.get<boolean>(`exists:${target}`);

    // Cosmetic edits are never worth a gate.
    const before = input.state.get<string>(`content:${target}`);
    const after = typeof args['content'] === 'string' ? args['content'] : args['new_string'];
    if (typeof before === 'string' && typeof after === 'string') {
      const proposed =
        typeof args['content'] === 'string'
          ? args['content']
          : before.replace(String(args['old_string'] ?? ''), String(after));
      if (isCosmeticChange(before, proposed)) {
        return allow(`${target}: comment/whitespace-only change, no investigation needed.`);
      }
    }

    // Not sensitive, already read, brand new, or already gated once: allow.
    if (!sensitive) return allow();
    if (readThisRun) return allow(`${target}: already read this run.`);
    if (exists === false) return allow(`${target}: new file, nothing to investigate.`);
    if (alreadyGated) return allow(`${target}: gate already raised once this run.`);

    input.state.gatedPaths.add(target);
    const { targetClass, questions } = questionsFor(target);
    return block(
      [
        `GateGuard: before editing ${target} (${targetClass} area), investigate first.`,
        ...questions.map((question, index) => `${index + 1}. ${question}`),
        `Read the file (read_file "${target}") or answer these in your next message, then retry the edit.`,
      ].join('\n'),
      { path: target, targetClass, questions, hook: 'pre:edit-write:gateguard-fact-force' },
    );
  },
};
