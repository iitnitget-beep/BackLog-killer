/**
 * Deterministic secret scanner. This is the "hook" that ECC would run as
 * PreToolUse (rules/common/hooks.md) - here it runs inside our own code before
 * every file write and before every git push, so a leaked key is caught on the
 * device and never reaches GitHub.
 *
 * Patterns are inspired by ECC's secret-scan guidance and gitleaks-style
 * detectors; the implementation is our own. See NOTICE.md.
 */
export type Severity = 'critical' | 'high' | 'medium';

export interface SecretFinding {
  rule: string;
  severity: Severity;
  line: number;
  /** Redacted evidence: only the matched prefix is kept. */
  excerpt: string;
  description: string;
}

interface Rule {
  id: string;
  severity: Severity;
  description: string;
  pattern: RegExp;
  /** Optional extra predicate to filter obvious placeholders. */
  allow?: (match: string) => boolean;
}

const PLACEHOLDER =
  /(example|placeholder|your[_-]?key|your[_-]?api|your|xxx+|dummy|sample|redacted|changeme|insert[_-]?|_here|test[_-]?key|<.*>)/i;

function notPlaceholder(match: string): boolean {
  return !PLACEHOLDER.test(match);
}

const RULES: Rule[] = [
  {
    id: 'private-key',
    severity: 'critical',
    description: 'Private key material committed to the workspace',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g,
  },
  {
    id: 'aws-access-key',
    severity: 'critical',
    description: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'aws-secret-key',
    severity: 'critical',
    description: 'AWS secret access key assignment',
    pattern: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi,
  },
  {
    id: 'github-token',
    severity: 'critical',
    description: 'GitHub personal access / app token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
    allow: notPlaceholder,
  },
  {
    id: 'github-fine-grained',
    severity: 'critical',
    description: 'GitHub fine-grained token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  },
  {
    id: 'openai-key',
    severity: 'critical',
    description: 'OpenAI-style API key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    allow: notPlaceholder,
  },
  {
    id: 'anthropic-key',
    severity: 'critical',
    description: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'google-api-key',
    severity: 'high',
    description: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    allow: notPlaceholder,
  },
  {
    id: 'slack-token',
    severity: 'critical',
    description: 'Slack token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'stripe-key',
    severity: 'critical',
    description: 'Stripe secret key',
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'jwt',
    severity: 'medium',
    description: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    allow: notPlaceholder,
  },
  {
    id: 'generic-assignment',
    severity: 'high',
    description: 'Hardcoded credential assignment',
    pattern:
      /\b(?:api[_-]?key|apikey|secret|password|passwd|token|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']([A-Za-z0-9_\-./+=]{16,})["']/gi,
    allow: (match) => notPlaceholder(match) && !/process\.env|System\.getenv|\$\{|os\.environ/i.test(match),
  },
  {
    id: 'android-keystore',
    severity: 'critical',
    description: 'Keystore / key password in a build file',
    pattern: /\b(?:storePassword|keyPassword)\s*[=:]\s*["'][^"']{6,}["']/g,
    allow: notPlaceholder,
  },
];

const ALLOWLISTED_PATH = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)\.git\//,
  /(^|\/)test\//,
  /\.test\.[jt]s$/,
  /(^|\/)__snapshots__\//,
];

export interface ScanOptions {
  /** Path of the file being scanned - used for allowlisting and reporting. */
  path?: string;
  /** Treat this as a push gate: medium findings also block. */
  strict?: boolean;
}

export function scanText(text: string, options: ScanOptions = {}): SecretFinding[] {
  const path = options.path ?? '';
  if (ALLOWLISTED_PATH.some((re) => re.test(path))) return [];
  const findings: SecretFinding[] = [];
  const lines = text.split('\n');
  for (const rule of RULES) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.length > 2000) continue;
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(line)) !== null) {
        const raw = match[0];
        if (rule.allow && !rule.allow(raw)) break;
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          line: index + 1,
          excerpt: redact(raw),
          description: rule.description,
        });
        if (rule.pattern.lastIndex === match.index) rule.pattern.lastIndex += 1;
      }
    }
  }
  return findings;
}

export function redact(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-2)} (${trimmed.length} chars)`;
}

export interface ScanVerdict {
  allowed: boolean;
  findings: SecretFinding[];
  reason?: string;
}

export function gate(text: string, options: ScanOptions = {}): ScanVerdict {
  const findings = scanText(text, options);
  const blocking = findings.filter(
    (f) => f.severity === 'critical' || f.severity === 'high' || options.strict === true,
  );
  if (blocking.length === 0) return { allowed: true, findings };
  return {
    allowed: false,
    findings,
    reason: `Blocked: ${blocking.length} possible secret(s) detected (${blocking.map((f) => f.rule).join(', ')})`,
  };
}
