import { describe, expect, it } from 'vitest';
import { EventStore, listRuns, toTimeline } from '../src/events/store';
import { MemoryKv } from '../src/platform/memory';

describe('event store', () => {
  it('appends events with monotonic sequence numbers and persists them', async () => {
    const kv = new MemoryKv();
    const store = new EventStore(kv, 'run-1');
    await store.append({ kind: 'run_started' });
    await store.append({ kind: 'step_started', stepName: 'plan' });
    const events = await store.all();
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    // A new store instance reads the same log (resume after app kill).
    const reopened = new EventStore(kv, 'run-1');
    const replay = await reopened.all();
    expect(replay).toHaveLength(2);
    await reopened.append({ kind: 'note', detail: 'after restart' });
    expect((await reopened.all()).at(-1)?.seq).toBe(3);
  });

  it('filters by kind and agent', async () => {
    const store = new EventStore(new MemoryKv(), 'run-2');
    await store.append({ kind: 'action', agentId: 'editor-1', thought: '', toolName: 'read_file', toolCallId: 'c1', args: {} });
    await store.append({ kind: 'observation', agentId: 'editor-1', toolName: 'read_file', toolCallId: 'c1', ok: true, output: 'x' });
    await store.append({ kind: 'note', detail: 'other' });
    expect(await store.query({ kind: 'action' })).toHaveLength(1);
    expect(await store.query({ agentId: 'editor-1' })).toHaveLength(2);
    expect(await store.query({ afterSeq: 2 })).toHaveLength(1);
  });

  it('prunes old events beyond the retention window', async () => {
    const store = new EventStore(new MemoryKv(), 'run-3', { keep: 10 });
    for (let i = 0; i < 40; i += 1) await store.append({ kind: 'note', detail: `n${i}` });
    const events = await store.all();
    expect(events.length).toBeLessThanOrEqual(20);
    expect(events.at(-1)?.kind).toBe('note');
  });

  it('lists runs', async () => {
    const kv = new MemoryKv();
    await new EventStore(kv, 'run-b').append({ kind: 'run_started' });
    await new EventStore(kv, 'run-a').append({ kind: 'run_started' });
    expect(await listRuns(kv)).toEqual(['run-b', 'run-a']);
  });

  it('renders a timeline label per event', () => {
    const timeline = toTimeline([
      { id: '1', runId: 'r', kind: 'step_started', seq: 1, timestamp: 0, stepName: 'plan' },
      { id: '2', runId: 'r', kind: 'action', seq: 2, timestamp: 0, thought: '', toolName: 'write_file', toolCallId: 'c', args: {} },
    ]);
    expect(timeline[0].label).toBe('▶ plan');
    expect(timeline[1].label).toBe('action: write_file');
  });
});
