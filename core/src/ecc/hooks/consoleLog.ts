/**
 * Ported from ECC `scripts/hooks/check-console-log.js` (MIT), adapted to Kotlin.
 *
 * ECC's Stop hook flags `console.log` left in modified JS/TS. ForgeX generates
 * Android apps, so the equivalent debris is `println(...)`,
 * `System.out.println` and Android `Log.*` calls in production Kotlin files.
 */
import { warn, allow, type HookDefinition } from '../types';

const EXCLUDED = [/\/test\//, /\/(androidTest|test)\//, /Test\.kt$/, /\/scripts\//, /\/build\//];

const DEBUG_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bprintln\s*\(/, label: 'println(' },
  { re: /\bSystem\.out\.println\s*\(/, label: 'System.out.println(' },
  { re: /\bLog\.(d|v|i|w|e)\s*\(/, label: 'android.util.Log call' },
  { re: /\bprintStackTrace\s*\(/, label: 'printStackTrace()' },
];

export interface DebugFinding {
  line: number;
  label: string;
  text: string;
}

export function findDebugLogging(relativePath: string, content: string): DebugFinding[] {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!/\.(kt|java)$/.test(normalized)) return [];
  if (EXCLUDED.some((pattern) => pattern.test(normalized))) return [];
  const findings: DebugFinding[] = [];
  content.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    for (const pattern of DEBUG_PATTERNS) {
      if (pattern.re.test(line)) {
        findings.push({ line: index + 1, label: pattern.label, text: trimmed.slice(0, 120) });
        break;
      }
    }
  });
  return findings;
}

export const consoleLogHook: HookDefinition = {
  id: 'stop:check-debug-logging',
  event: 'Stop',
  matcher: '*',
  description: 'Warn about println/Log statements left in production Kotlin files.',
  derivedFrom: 'ECC scripts/hooks/check-console-log.js (console.log adapted to Kotlin logging)',
  run(input) {
    const sources =
      input.state.get<{ path: string; content: string }[]>('writtenSources') ??
      input.state.get<{ path: string; content: string }[]>('kotlinSources') ??
      [];
    const findings = sources.flatMap((source) =>
      findDebugLogging(source.path, source.content).map((finding) => ({ path: source.path, ...finding })),
    );
    if (findings.length === 0) return allow();
    const preview = findings
      .slice(0, 5)
      .map((finding) => `${finding.path}:${finding.line} ${finding.label}`)
      .join('; ');
    return warn(
      `${findings.length} debug logging call(s) in shipped Kotlin: ${preview}${findings.length > 5 ? ' …' : ''}`,
    );
  },
};
