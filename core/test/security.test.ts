import { describe, expect, it } from 'vitest';
import { gate, scanText, redact } from '../src/security/scanner';

describe('secret scanner', () => {
  it('finds an OpenAI-style key', () => {
    const findings = scanText('const k = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";');
    expect(findings.map((f) => f.rule)).toContain('openai-key');
    expect(findings[0].severity).toBe('critical');
  });

  it('finds a GitHub token and a private key', () => {
    expect(scanText('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789').map((f) => f.rule)).toContain('github-token');
    expect(scanText('-----BEGIN RSA PRIVATE KEY-----').map((f) => f.rule)).toContain('private-key');
  });

  it('finds a generic credential assignment', () => {
    const findings = scanText('const apiKey = "a1b2c3d4e5f6g7h8i9j0";');
    expect(findings.length).toBeGreaterThan(0);
  });

  it('ignores env lookups and placeholders', () => {
    expect(scanText('const k = process.env.OPENAI_KEY ?? ""')).toEqual([]);
    expect(scanText('export const apiKey = "your_api_key_here"')).toEqual([]);
    expect(scanText('const key = "<YOUR_KEY>"')).toEqual([]);
  });

  it('does not flag test fixtures or lockfiles', () => {
    const text = 'const k = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";';
    expect(scanText(text, { path: 'src/config.test.ts' })).toEqual([]);
    expect(scanText(text, { path: 'package-lock.json' })).toEqual([]);
  });

  it('reports the line number and redacts evidence', () => {
    const findings = scanText('line one\nconst t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";');
    expect(findings[0].line).toBe(2);
    expect(findings[0].excerpt).not.toContain('abcdefghijklmnop');
  });

  it('gates a push on medium findings in strict mode', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(gate(jwt, { path: 'app.js' }).allowed).toBe(true);
    expect(gate(jwt, { path: 'app.js', strict: true }).allowed).toBe(false);
  });

  it('allows clean content', () => {
    expect(gate('fun main() = println("hello")').allowed).toBe(true);
  });

  it('redact keeps only a prefix and suffix', () => {
    expect(redact('ghp_abcdefghijklmnop')).toMatch(/^ghp_/);
    expect(redact('short')).toBe('***');
  });
});
