import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The CLI is the only way a user can reproduce a phone run on a laptop, so its
 * failure modes are covered: no key, unknown provider, and the usage text. It is
 * never allowed to silently do nothing.
 */
describe('cli harness', () => {
  it('explains a missing provider key instead of failing obscurely', async () => {
    const env = { ...process.env };
    delete env['FORGEX_API_KEY'];
    const result = await run('./scripts/run-cli.sh', ['run', 'a timer'], { env, timeout: 90_000 }).catch(
      (error: { code: number; stderr: string }) => error,
    );
    expect((result as { code: number }).code).toBe(2);
    expect((result as { stderr: string }).stderr).toContain('FORGEX_API_KEY');
  }, 120_000);

  it('rejects an unknown provider preset', async () => {
    const result = await run('./scripts/run-cli.sh', ['plan', 'a timer', '--provider', 'nope'], {
      env: { ...process.env, FORGEX_API_KEY: 'sk-test' },
      timeout: 90_000,
    }).catch((error: { code: number; stderr: string }) => error);
    expect((result as { code: number }).code).toBe(2);
    expect((result as { stderr: string }).stderr).toContain('unknown provider');
  }, 120_000);

  it('prints usage when no request is given', async () => {
    const result = await run('./scripts/run-cli.sh', [], { timeout: 90_000 }).catch(
      (error: { code: number; stderr: string }) => error,
    );
    expect((result as { stderr: string }).stderr).toContain('usage:');
  }, 120_000);

  it('scans a workspace for secrets and exits non-zero on a finding', async () => {
    const fs = await import('node:fs/promises');
    const out = './.cli-test-out';
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(`${out}/workspace`, { recursive: true });
    await fs.writeFile(`${out}/workspace/leak.ts`, 'const key = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";\n');
    const result = await run('./scripts/run-cli.sh', ['scan', 'check', '--out', out], {
      env: { ...process.env, FORGEX_API_KEY: 'sk-test' },
      timeout: 90_000,
    }).catch((error: { code: number; stdout: string }) => error);
    expect((result as { code: number }).code).toBe(1);
    expect((result as { stdout: string }).stdout).toContain('openai-key');
    await fs.rm(out, { recursive: true, force: true });
  }, 120_000);
});
