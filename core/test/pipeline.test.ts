import { describe, expect, it } from 'vitest';
import { Pipeline, commitMessage } from '../src/run/pipeline';
import { Orchestrator } from '../src/agent/orchestrator';
import { ApprovalManager } from '../src/agent/approval';
import { EventStore } from '../src/events/store';
import { MemoryKv, createMemoryPlatform } from '../src/platform/memory';
import { ToolRegistry } from '../src/tools/registry';
import { ProjectMemoryStore } from '../src/memory/project';
import { SkillLibrary } from '../src/skills/loader';
import { RoleLlmRouter } from './helpers';
import type { RunState, ShipResult } from '../src/run/types';
import type { VerifyResult } from '../src/agent/orchestrator';

const ROOT = '/workspace/proj';

const PLAN_JSON = JSON.stringify({
  summary: 'A countdown timer app',
  features: [{ name: 'countdown', acceptance: 'timer ticks down' }],
  steps: [
    { id: 1, title: 'scaffold gradle project', files: ['settings.gradle.kts', 'app/build.gradle.kts'], doneWhen: 'gradle configures' },
    { id: 2, title: 'implement timer screen', files: ['app/src/main/java/MainActivity.kt'], doneWhen: 'UI shows countdown' },
  ],
  risks: ['Android SDK versions'],
  verify: ['gradle assembleDebug'],
});

function setup(options: {
  shipResults?: (ShipResult | Error)[];
  verify?: () => Promise<VerifyResult>;
  ciLogs?: string;
} = {}) {
  const platform = createMemoryPlatform();
  const kv = new MemoryKv();
  const events = new EventStore(kv, 'run-1');
  const router = new RoleLlmRouter({
    planner: [{ content: '```json\n' + PLAN_JSON + '\n```' }],
    editor: [
      {
        toolCalls: [
          { name: 'write_file', args: { path: 'settings.gradle.kts', content: 'rootProject.name = "timer"' } },
          { name: 'write_file', args: { path: 'app/build.gradle.kts', content: 'plugins { id("com.android.application") }' } },
        ],
      },
      { content: 'scaffolded' },
      {
        toolCalls: [
          {
            name: 'write_file',
            args: { path: 'app/src/main/java/MainActivity.kt', content: 'class MainActivity : Activity() { fun render() = Unit }' },
          },
        ],
      },
      { content: 'implemented' },
    ],
    reviewer: [{ content: '```json\n{"verdict":"pass","findings":[],"summary":"ok"}\n```' }],
    'security-reviewer': [{ content: '```json\n{"verdict":"pass","findings":[]}\n```' }],
    'test-fixer': [{ content: 'ROOT CAUSE: bad import\nFIX: removed it' }],
  });
  const orchestrator = new Orchestrator({
    platform,
    llm: () => router.client(),
    registry: ToolRegistry.standard(platform, ROOT),
    approvals: new ApprovalManager('FULL_AUTO'),
    events,
    workspaceRoot: ROOT,
  });
  const memory = new ProjectMemoryStore(platform, ROOT, 'proj-1');
  const skills = new SkillLibrary(platform, `${ROOT}/.forgex/skills`);
  const shipResults = options.shipResults ?? [{ repoFullName: 'me/timer', branch: 'main', commitSha: 'sha1', commitMessage: 'x', ciStatus: 'success' }];
  let shipIndex = 0;
  const shipped: { files: { path: string; content: string }[]; message: string }[] = [];
  const state: RunState = {
    runId: 'run-1',
    projectId: 'proj-1',
    request: 'build me a countdown timer app',
    status: 'idle',
    completedSteps: [],
    repairAttempts: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  const pipeline = new Pipeline({
    platform,
    orchestrator,
    events,
    memory,
    skills,
    workspaceRoot: ROOT,
    collectFiles: async () => {
      const entries = await platform.fs.list(ROOT, { recursive: true, includeDirs: false });
      const files = [];
      for (const entry of entries) files.push({ path: entry.name, content: await platform.fs.read(entry.path) });
      return files;
    },
    localVerify: options.verify,
    ship: async (files, message) => {
      shipped.push({ files, message });
      const next = shipResults[Math.min(shipIndex, shipResults.length - 1)];
      shipIndex += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    repairFromLogs: options.ciLogs
      ? async () => {
          await orchestrator.ask('test-fixer', `Fix CI:\n${options.ciLogs}`);
        }
      : undefined,
    saveState: async (s) => {
      await kv.set('run/run-1/state', JSON.stringify(s));
    },
  });
  return { pipeline, events, platform, memory, kv, router, state, shipped, orchestrator };
}

describe('pipeline', () => {
  it('plans, builds, reviews, ships and records every step', async () => {
    const { pipeline, events, state, platform, shipped } = setup();
    const result = await pipeline.run(state);
    expect(result.state.status).toBe('done');
    expect(result.plan.steps).toHaveLength(2);
    const steps = await events.query({ kind: 'step_finished' });
    expect(steps.map((s) => (s as { stepName?: string }).stepName)).toEqual(
      expect.arrayContaining(['plan', 'context', 'code', 'test', 'review', 'ship']),
    );
    // Files written by the editor + the CI workflow we inject.
    const paths = shipped[0].files.map((file) => file.path);
    expect(paths).toContain('app/src/main/java/MainActivity.kt');
    expect(paths).toContain('.github/workflows/build-apk.yml');
    const workflow = await platform.fs.read(`${ROOT}/.github/workflows/build-apk.yml`);
    expect(workflow).toContain('assembleDebug');
    // Note learned after a successful run.
    const notes = await platform.kv.get('memory/notes/proj-1');
    expect(notes).toContain('Verified with');
  });

  it('resumes: a saved plan is not re-planned', async () => {
    const { pipeline, state, events } = setup();
    const planned = await pipeline.run(state);
    const before = (await events.all()).length;
    const resumed: RunState = { ...planned.state, status: 'building', completedSteps: ['plan'], plan: planned.plan };
    await pipeline.run(resumed);
    const plannerCalls = (await events.query({ kind: 'step_started' })).filter(
      (e) => (e as { stepName?: string }).stepName === 'plan',
    );
    expect(plannerCalls).toHaveLength(1); // only the first run planned
    expect((await events.all()).length).toBeGreaterThan(before);
  });

  it('runs the local verify loop when verification fails first', async () => {
    let attempt = 0;
    const { pipeline, state, platform } = setup({
      verify: async () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, summary: 'compileDebugKotlin FAILED', output: 'e: unresolved reference' }
          : { ok: true, summary: 'BUILD SUCCESSFUL', output: '' };
      },
    });
    const result = await pipeline.run(state);
    expect(result.state.status).toBe('done');
    expect(attempt).toBeGreaterThanOrEqual(2);
    expect(await platform.kv.get('memory/notes/proj-1')).toContain('Round 1 failed');
  });

  it('repairs a failing CI run by feeding logs to the test-fixer, then succeeds', async () => {
    const { pipeline, state, events, router } = setup({
      ciLogs: 'e: MainActivity.kt:3 unresolved reference',
      shipResults: [
        { repoFullName: 'me/timer', branch: 'main', commitSha: 'sha1', commitMessage: 'a', ciStatus: 'failure', ciUrl: 'https://ci/1' },
        { repoFullName: 'me/timer', branch: 'main', commitSha: 'sha2', commitMessage: 'b', ciStatus: 'success' },
      ],
    });
    const result = await pipeline.run(state);
    expect(result.state.status).toBe('done');
    expect(result.state.repairAttempts).toBe(1);
    const fixerCalls = router.calls.filter((call) => call.role === 'test-fixer');
    expect(fixerCalls.length).toBeGreaterThan(0);
    expect(fixerCalls[0].request.messages.some((m) => (m.content ?? '').includes('unresolved reference'))).toBe(true);
    expect((await events.query({ kind: 'note' })).some((e) => (e as { detail: string }).detail.includes('repair attempt'))).toBe(true);
  });

  it('stops after 5 CI repair attempts and asks the user', async () => {
    const { pipeline, state, events } = setup({
      ciLogs: 'still broken',
      shipResults: [
        { repoFullName: 'me/t', branch: 'main', commitSha: 's1', commitMessage: 'a', ciStatus: 'failure', ciUrl: 'u' },
      ],
    });
    const result = await pipeline.run(state);
    expect(result.state.status).toBe('failed');
    expect(result.state.repairAttempts).toBe(5);
    expect((await events.query({ kind: 'gate_blocked' })).length).toBe(1);
  });

  it('fails cleanly when the secret gate blocks the push', async () => {
    const platform = createMemoryPlatform();
    await platform.fs.write(`${ROOT}/leak.txt`, 'sk-proj-abcdefghijklmnopqrstuvwxyz123456');
    const kv = new MemoryKv();
    const events = new EventStore(kv, 'run-secret');
    const router = new RoleLlmRouter({
      planner: [{ content: '```json\n' + PLAN_JSON + '\n```' }],
      editor: [{ content: 'done' }],
      reviewer: [{ content: '{"verdict":"pass"}' }],
      'security-reviewer': [{ content: 'ok' }],
    });
    const orchestrator = new Orchestrator({
      platform,
      llm: () => router.client(),
      registry: ToolRegistry.standard(platform, ROOT),
      approvals: new ApprovalManager('FULL_AUTO'),
      events,
      workspaceRoot: ROOT,
    });
    let shipped = false;
    const pipeline = new Pipeline({
      platform,
      orchestrator,
      events,
      memory: new ProjectMemoryStore(platform, ROOT, 'p'),
      skills: new SkillLibrary(platform, `${ROOT}/.forgex/skills`),
      workspaceRoot: ROOT,
      collectFiles: async () => [{ path: 'leak.txt', content: await platform.fs.read(`${ROOT}/leak.txt`) }],
      ship: async () => {
        shipped = true;
        return { repoFullName: 'x', branch: 'main', commitSha: 's', commitMessage: 'm', ciStatus: 'success' };
      },
      saveState: async () => undefined,
    });
    const state: RunState = {
      runId: 'run-secret',
      projectId: 'p',
      request: 'leak a key',
      status: 'idle',
      completedSteps: [],
      repairAttempts: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const result = await pipeline.run(state);
    expect(shipped).toBe(false);
    expect(result.state.status).toBe('failed');
    expect(result.state.error).toMatch(/secret/i);
  });

  it('halts when the user cancels', async () => {
    const { pipeline, state } = setup();
    const controller = new AbortController();
    controller.abort();
    const result = await pipeline.run(state, { signal: controller.signal });
    expect(result.state.status).toBe('cancelled');
  });

  it('writes a conventional commit message', () => {
    const message = commitMessage('build a timer', {
      summary: 'A countdown timer app',
      features: [],
      steps: [{ id: 1, title: 'scaffold', files: [], doneWhen: 'x' }],
      risks: [],
      verify: [],
    });
    expect(message.startsWith('feat: A countdown timer app')).toBe(true);
    expect(message).toContain('- scaffold');
  });
});

describe('project memory', () => {
  it('stores AGENTS.md and learned notes, de-duplicating repeats', async () => {
    const platform = createMemoryPlatform();
    const memory = new ProjectMemoryStore(platform, ROOT, 'p1');
    await memory.writeAgentsMd('# Project\nUse Kotlin.');
    expect(await memory.readAgentsMd()).toContain('Use Kotlin');
    await memory.addNote({ timestamp: 1, runId: 'r', kind: 'success', text: 'Verified with: gradle' });
    await memory.addNote({ timestamp: 2, runId: 'r', kind: 'success', text: 'Verified with: gradle' });
    expect(await memory.notes()).toHaveLength(1);
    const context = await memory.context();
    expect(context).toContain('AGENTS.md');
    expect(context).toContain('Learned notes');
  });
});

describe('skills', () => {
  it('loads skills and selects microagents by trigger', async () => {
    const platform = createMemoryPlatform();
    const library = new SkillLibrary(platform, `${ROOT}/.forgex/skills`);
    await library.save(
      `${ROOT}/.forgex/skills/android.md`,
      '---\nname: android\ntriggers: gradle, kotlin\n---\nAlways pin the AGP version.',
    );
    await library.save(`${ROOT}/.forgex/skills/always.md`, '---\nname: always\n---\nWrite tests.');
    const relevant = await library.relevant('build a kotlin app');
    expect(relevant.map((skill) => skill.name).sort()).toEqual(['always', 'android']);
    const irrelevant = await library.relevant('write a python script');
    expect(irrelevant.map((skill) => skill.name)).toEqual(['always']);
    const context = await library.contextFor('gradle build');
    expect(context).toContain('pin the AGP version');
  });

  it('respects enabled: false', async () => {
    const platform = createMemoryPlatform();
    const library = new SkillLibrary(platform, `${ROOT}/.forgex/skills`);
    await library.save(`${ROOT}/.forgex/skills/off.md`, '---\nname: off\nenabled: false\n---\nNever load me.');
    expect(await library.relevant('anything')).toHaveLength(0);
  });
});

describe('scaffold seeding', () => {
  function pipelineWithSeed() {
    const platform = createMemoryPlatform();
    const kv = new MemoryKv();
    const events = new EventStore(kv, 'seed-run');
    const router = new RoleLlmRouter({
      planner: [{ content: '```json\n' + PLAN_JSON + '\n```' }],
      editor: [{ content: 'edited' }],
      reviewer: [{ content: '{"verdict":"pass"}' }],
      'security-reviewer': [{ content: 'ok' }],
    });
    const orchestrator = new Orchestrator({
      platform,
      llm: () => router.client(),
      registry: ToolRegistry.standard(platform, ROOT),
      approvals: new ApprovalManager('FULL_AUTO'),
      events,
      workspaceRoot: ROOT,
    });
    const shipped: { path: string; content: string }[][] = [];
    const pipeline = new Pipeline({
      platform,
      orchestrator,
      events,
      memory: new ProjectMemoryStore(platform, ROOT, 'p'),
      skills: new SkillLibrary(platform, `${ROOT}/.forgex/skills`),
      workspaceRoot: ROOT,
      collectFiles: async () => {
        const entries = await platform.fs.list(ROOT, { recursive: true, includeDirs: false });
        return Promise.all(
          entries.map(async (entry) => ({ path: entry.name, content: await platform.fs.read(entry.path) })),
        );
      },
      ship: async (files) => {
        shipped.push(files);
        return { repoFullName: 'me/app', branch: 'main', commitSha: 's', commitMessage: 'm', ciStatus: 'success' };
      },
      saveState: async () => undefined,
      seedScaffold: true,
    });
    const state: RunState = {
      runId: 'seed-run',
      projectId: 'p',
      request: 'build me a habit tracker app',
      status: 'idle',
      completedSteps: [],
      repairAttempts: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    return { pipeline, state, platform, shipped, events };
  }

  it('seeds a known-good Android skeleton into an empty workspace', async () => {
    const { pipeline, state, shipped, events } = pipelineWithSeed();
    await pipeline.run(state);
    const paths = shipped[0].map((file) => file.path);
    expect(paths).toContain('settings.gradle.kts');
    expect(paths).toContain('app/build.gradle.kts');
    expect(paths.some((path) => path.endsWith('MainActivity.kt'))).toBe(true);
    expect(paths).toContain('.github/workflows/build-apk.yml');
    expect((await events.query({ kind: 'note' })).some((event) => (event as { detail: string }).detail.includes('seeded'))).toBe(true);
  });

  it('does not overwrite a workspace that already has a Gradle project', async () => {
    const { pipeline, state, platform, shipped } = pipelineWithSeed();
    await platform.fs.write(`${ROOT}/settings.gradle.kts`, 'rootProject.name = "mine"');
    await pipeline.run(state);
    const settings = shipped[0].find((file) => file.path === 'settings.gradle.kts');
    expect(settings?.content).toBe('rootProject.name = "mine"');
  });
});

describe('package and app name derivation', () => {
  it('derives a valid package name from a request', async () => {
    const { derivePackageName } = await import('../src/run/pipeline');
    expect(derivePackageName('build me a habit tracker app')).toBe('dev.forgex.habit_tracker');
    expect(derivePackageName('!!!')).toBe('dev.forgex.app');
    expect(derivePackageName('a timer')).toMatch(/^dev\.forgex\./);
  });

  it('derives a short human app name', async () => {
    const { deriveAppName } = await import('../src/run/pipeline');
    expect(deriveAppName('build me a habit tracker app')).toBe('Habit Tracker');
    expect(deriveAppName('')).toBe('ForgeX App');
  });
});
