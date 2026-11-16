import { describe, expect, it } from 'vitest';
import { runAgentLoop, parseArgs } from '../src/agent/engine';
import { ApprovalManager } from '../src/agent/approval';
import { LoopDetector, fingerprint } from '../src/agent/loopDetection';
import { ToolRegistry } from '../src/tools/registry';
import { createMemoryPlatform } from '../src/platform/memory';
import { ScriptedLlm } from './helpers';

const ROOT = '/workspace/demo';

function setup(turns: ConstructorParameters<typeof ScriptedLlm>[0], approvals = new ApprovalManager('FULL_AUTO')) {
  const platform = createMemoryPlatform();
  const registry = ToolRegistry.standard(platform, ROOT);
  const llm = new ScriptedLlm(turns);
  return { platform, registry, llm, approvals };
}

describe('single-agent loop', () => {
  it('creates, edits and reads a file from a prompt', async () => {
    const { platform, registry, llm, approvals } = setup([
      { toolCalls: [{ name: 'write_file', args: { path: 'app/Main.kt', content: 'fun main() = Unit' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'app/Main.kt', old_string: 'Unit', new_string: 'println("hi")' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'app/Main.kt' } }] },
      { content: 'Done: created and edited app/Main.kt' },
    ]);
    const observed: string[] = [];
    const result = await runAgentLoop({
      llm,
      registry,
      approvals,
      workspaceRoot: ROOT,
      systemPrompt: 'You are a test agent.',
      onToolResult: (name) => observed.push(name),
    });
    expect(result.reason).toBe('completed');
    expect(result.toolCalls).toBe(3);
    expect(await platform.fs.read(`${ROOT}/app/Main.kt`)).toBe('fun main() = println("hi")');
    expect(observed).toEqual(['write_file', 'edit_file', 'read_file']);
    // The model must have been given tool declarations.
    expect(llm.requests[0].tools?.map((t) => t.name)).toContain('write_file');
  });

  it('stops when the model stops calling tools', async () => {
    const { registry, llm, approvals } = setup([{ content: 'nothing to do' }]);
    const result = await runAgentLoop({ llm, registry, approvals, workspaceRoot: ROOT, systemPrompt: 'x' });
    expect(result.reason).toBe('completed');
    expect(result.finalMessage).toBe('nothing to do');
    expect(result.rounds).toBe(1);
  });

  it('detects a tool-call loop and stops', async () => {
    const same = [{ name: 'list_dir', args: { path: '.' } }];
    const { registry, llm, approvals } = setup(Array.from({ length: 8 }, () => ({ toolCalls: same })));
    const result = await runAgentLoop({ llm, registry, approvals, workspaceRoot: ROOT, systemPrompt: 'x', maxRounds: 20 });
    expect(result.reason).toBe('loop_detected');
    expect(result.loop?.reason).toBe('tool_call_loop');
  });

  it('respects maxRounds', async () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      toolCalls: [{ name: 'list_dir', args: { path: `.`, marker: i } }],
    }));
    const { registry, llm, approvals } = setup(turns);
    const result = await runAgentLoop({ llm, registry, approvals, workspaceRoot: ROOT, systemPrompt: 'x', maxRounds: 3 });
    expect(result.reason).toBe('max_rounds');
    expect(result.rounds).toBe(3);
  });

  it('surfaces a provider failure without throwing', async () => {
    const registry = ToolRegistry.standard(createMemoryPlatform(), ROOT);
    const failing = {
      providerId: 'broken',
      model: 'broken',
      complete: async () => {
        throw Object.assign(new Error('boom 500'), { retryable: true, status: 500 });
      },
    };
    const result = await runAgentLoop({
      llm: failing,
      registry,
      approvals: new ApprovalManager('FULL_AUTO'),
      workspaceRoot: ROOT,
      systemPrompt: 'x',
    });
    expect(result.reason).toBe('error');
    expect(result.error).toContain('boom');
  });

  it('feeds a blocked approval back to the model instead of crashing', async () => {
    const { registry, llm } = setup(
      [{ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'x' } }] }, { content: 'could not write' }],
      new ApprovalManager('ASK'),
    );
    let blockedOutput = '';
    const result = await runAgentLoop({
      llm,
      registry,
      approvals: new ApprovalManager('ASK'),
      workspaceRoot: ROOT,
      systemPrompt: 'x',
      onToolResult: (_name, ok, output) => {
        if (!ok) blockedOutput = output;
      },
    });
    expect(result.reason).toBe('completed');
    expect(blockedOutput).toMatch(/Blocked/);
  });

  it('refuses to write a hardcoded secret', async () => {
    const { platform, registry, llm, approvals } = setup([
      { toolCalls: [{ name: 'write_file', args: { path: 'config.ts', content: 'const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123"' } }] },
      { content: 'blocked' },
    ]);
    await runAgentLoop({ llm, registry, approvals, workspaceRoot: ROOT, systemPrompt: 'x' });
    expect(await platform.fs.exists(`${ROOT}/config.ts`)).toBe(false);
  });

  it('cancels when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { registry, llm, approvals } = setup([{ content: 'x' }]);
    const result = await runAgentLoop({
      llm,
      registry,
      approvals,
      workspaceRoot: ROOT,
      systemPrompt: 'x',
      signal: controller.signal,
    });
    expect(result.reason).toBe('cancelled');
  });
});

describe('parseArgs', () => {
  it('returns {} for malformed JSON rather than throwing', () => {
    expect(parseArgs({ id: '1', type: 'function', function: { name: 'x', arguments: '{broken' } })).toEqual({
      __parse_error: '{broken',
    });
  });
});

describe('loop detector', () => {
  it('fingerprints regardless of key order', () => {
    expect(fingerprint('t', { a: 1, b: 2 })).toBe(fingerprint('t', { b: 2, a: 1 }));
  });
  it('flags content repetition', () => {
    const detector = new LoopDetector(5, 3);
    expect(detector.recordContent('same').looped).toBe(false);
    detector.recordContent('same');
    expect(detector.recordContent('same').looped).toBe(true);
  });
});
