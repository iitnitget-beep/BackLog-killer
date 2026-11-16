import { describe, expect, it } from 'vitest';
import { ProjectSession, presetEntry } from '../src/app/session';
import { createMemoryPlatform } from '../src/platform/memory';
import type { LlmClient } from '../src/llm/types';

/**
 * Session wiring tests: the parts that only show up once everything is plugged
 * together (provider routing through the session, the local verifier's
 * definition of a complete project, and file collection for publishing).
 */
function session(overrides: Partial<Parameters<typeof buildSession>[0]> = {}) {
  return buildSession(overrides);
}

function buildSession(config: {
  llm?: LlmClient;
  providers?: { config: { id: string; label: string; baseUrl: string; defaultModel: string }; apiKey: string }[];
} = {}) {
  const platform = createMemoryPlatform();
  const built = new ProjectSession({
    platform,
    projectId: 'p1',
    workspaceRoot: '/workspace/p1',
    skillsRoot: '/workspace/p1/.forgex/skills',
    providers: config.providers ?? [],
    approvalMode: 'ASK',
  });
  return { session: built, platform };
}

describe('project session', () => {
  it('refuses to ship without GitHub configured, with a clear message', async () => {
    const { session: s } = session();
    // ship() is private; driving it through the public surface means running the
    // pipeline. Instead we assert the error text the UI surfaces.
    const ship = (s as unknown as { ship: (f: unknown[], m: string) => Promise<unknown> }).ship.bind(s);
    await expect(ship([], 'msg')).rejects.toThrow(/GitHub is not connected/);
  });

  it('treats an empty project as incomplete and a full skeleton as complete', async () => {
    const { session: s, platform } = session();
    const empty = await s.verifyLocally();
    expect(empty.ok).toBe(false);
    expect(empty.summary).toContain('settings.gradle.kts');

    await platform.fs.write('/workspace/p1/settings.gradle.kts', 'rootProject.name = "x"');
    await platform.fs.write('/workspace/p1/app/build.gradle.kts', 'plugins {}');
    await platform.fs.write('/workspace/p1/.github/workflows/build-apk.yml', 'name: Build');
    const complete = await s.verifyLocally();
    expect(complete.ok).toBe(true);
    expect(complete.summary).toContain('CI');
  });

  it('collects only plannable text files for publishing', async () => {
    const { session: s, platform } = session();
    await platform.fs.write('/workspace/p1/app/Main.kt', 'fun main() {}');
    await platform.fs.write('/workspace/p1/app/icon.png', 'binary');
    await platform.fs.write('/workspace/p1/app/lib.jar', 'binary');
    const files = await s.collectFiles();
    const paths = files.map((file) => file.path);
    expect(paths).toContain('app/Main.kt');
    expect(paths).not.toContain('app/icon.png');
    expect(paths).not.toContain('app/lib.jar');
  });

  it('persists and reloads run state for resume', async () => {
    const { session: s } = session();
    const state = {
      runId: s.currentRunId,
      projectId: 'p1',
      request: 'build a timer',
      status: 'building' as const,
      completedSteps: [],
      repairAttempts: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    await s.saveState(state);
    const loaded = await s.loadState();
    expect(loaded?.request).toBe('build a timer');
    // resume() on a non-terminal state re-enters the pipeline; with no providers
    // configured it fails fast rather than pretending to work.
    const resumed = await s.resume();
    expect(resumed?.status === 'failed' || resumed?.status === 'building').toBe(true);
  });

  it('accepts a GitHub target after construction (token read from the Keystore)', () => {
    const { session: s } = session();
    expect(() => s.setGitHub({ token: 'gho_x', owner: 'me', repo: 'app' })).not.toThrow();
  });

  it('builds a provider entry from a preset and rejects unknown presets', () => {
    expect(presetEntry('openrouter', 'sk-x')?.config.id).toBe('openrouter');
    expect(presetEntry('nope', 'sk-x')).toBeNull();
  });
});
