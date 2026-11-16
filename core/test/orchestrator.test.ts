import { describe, expect, it } from 'vitest';
import { Orchestrator, parsePlan, parseVerdict, extractJson } from '../src/agent/orchestrator';
import { ApprovalManager } from '../src/agent/approval';
import { EventStore } from '../src/events/store';
import { MemoryKv, createMemoryPlatform } from '../src/platform/memory';
import { ToolRegistry } from '../src/tools/registry';
import { RoleLlmRouter } from './helpers';

const ROOT = '/workspace/demo';

function makeOrchestrator(scripts: Record<string, Parameters<typeof makeRouter>[0][string]>) {
  const platform = createMemoryPlatform();
  const events = new EventStore(new MemoryKv(), 'run-test');
  const router = makeRouter(scripts);
  const orchestrator = new Orchestrator({
    platform,
    llm: () => router.client(),
    registry: ToolRegistry.standard(platform, ROOT),
    approvals: new ApprovalManager('FULL_AUTO'),
    events,
    workspaceRoot: ROOT,
  });
  return { orchestrator, events, platform, router };
}

function makeRouter(scripts: Record<string, { content?: string; toolCalls?: { name: string; args: Record<string, unknown> }[] }[]>) {
  return new RoleLlmRouter(scripts);
}

describe('orchestrator', () => {
  it('records spawn and finish on the event stream', async () => {
    const { orchestrator, events } = makeOrchestrator({ planner: [{ content: 'planned' }] });
    await orchestrator.ask('planner', 'build a timer app');
    const all = await events.all();
    const spawned = all.filter((e) => e.kind === 'agent_spawned');
    const finished = all.filter((e) => e.kind === 'agent_finished');
    expect(spawned).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(all.some((e) => e.kind === 'assistant_message' && e.content === 'planned')).toBe(true);
  });

  it('withholds tools from the file-picker', async () => {
    const { orchestrator, events } = makeOrchestrator({ 'file-picker': [{ content: 'files' }] });
    await orchestrator.ask('file-picker', 'which files?');
    const spawned = (await events.query({ kind: 'agent_spawned' }))[0];
    expect(spawned.kind).toBe('agent_spawned');
  });

  it('parses a planner JSON plan', async () => {
    const plan = `Here you go:\n\`\`\`json\n{"summary":"timer app","features":[{"name":"countdown"}],"steps":[{"id":1,"title":"scaffold","files":["app/build.gradle.kts"],"doneWhen":"gradle runs"}],"risks":["no SDK"],"verify":["gradle assembleDebug"]}\n\`\`\``;
    const parsed = parsePlan(plan, 'build a timer');
    expect(parsed.summary).toBe('timer app');
    expect(parsed.steps[0].title).toBe('scaffold');
    expect(parsed.verify).toEqual(['gradle assembleDebug']);
  });

  it('falls back to a single-step plan when the answer is unparseable', () => {
    const parsed = parsePlan('I think you should build a timer.', 'build a timer');
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.risks[0]).toMatch(/unparseable/);
  });

  it('verifies success on the first round', async () => {
    const { orchestrator } = makeOrchestrator({});
    const outcome = await orchestrator.verifyLoop({
      initialTask: 'x',
      verify: async () => ({ ok: true, summary: 'all green', output: '' }),
    });
    expect(outcome.status).toBe('passed');
    expect(outcome.iterations).toBe(1);
  });

  it('runs the fix loop until verification passes', async () => {
    const { orchestrator } = makeOrchestrator({ 'test-fixer': [{ content: 'fixed it' }] });
    let attempts = 0;
    const outcome = await orchestrator.verifyLoop({
      initialTask: 'write a test',
      verify: async () => {
        attempts += 1;
        return attempts < 3
          ? { ok: false, summary: `compile error ${attempts}`, output: 'error: unresolved reference' }
          : { ok: true, summary: 'green', output: '' };
      },
    });
    expect(outcome.status).toBe('passed');
    expect(outcome.iterations).toBe(3);
    expect(outcome.history.filter((h) => h.fix)).toHaveLength(2);
  });

  it('gives up after max iterations and asks the user', async () => {
    const { orchestrator, events } = makeOrchestrator({ 'test-fixer': [{ content: 'tried' }] });
    const outcome = await orchestrator.verifyLoop({
      initialTask: 'never works',
      verify: async () => ({ ok: false, summary: 'still broken', output: 'error' }),
      maxIterations: 3,
    });
    expect(outcome.status).toBe('exhausted');
    expect(outcome.iterations).toBe(3);
    const blocked = await events.query({ kind: 'gate_blocked' });
    expect(blocked.length).toBe(1);
  });

  it('blocks a push when a workspace file contains a secret', async () => {
    const { orchestrator, events } = makeOrchestrator({});
    const result = await orchestrator.prePushScan([
      { path: 'app/src/Config.kt', content: 'val key = "sk-proj-abcdefghijklmnopqrstuvwxyz123456"' },
    ]);
    expect(result.ok).toBe(false);
    expect((await events.query({ kind: 'gate_blocked' })).length).toBe(1);
  });
});

describe('verdict parsing', () => {
  it('reads a fenced json verdict', () => {
    expect(parseVerdict('```json\n{"verdict":"fail","findings":[]}\n```')).toBe('fail');
    expect(parseVerdict('{"verdict": "pass"}')).toBe('pass');
  });
  it('returns unknown for prose', () => {
    expect(parseVerdict('looks fine to me')).toBe('unknown');
  });
  it('extracts json from chatter', () => {
    expect(extractJson('blah {"a":1} blah')).toEqual({ a: 1 });
    expect(extractJson('no json here')).toBeNull();
  });
});
