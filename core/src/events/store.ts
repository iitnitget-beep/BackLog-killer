import type { KeyValuePort } from '../platform/types';
import type { EventFilter, ForgeEvent, NewEvent } from './types';

/**
 * Append-only event log persisted through the platform KV port (SQLite on
 * Android, files under Node). Events are the single source of truth for the UI
 * timeline and for resuming a run after the app is killed.
 */
export class EventStore {
  private seq = 0;
  private cache: ForgeEvent[] | null = null;

  constructor(
    private readonly kv: KeyValuePort,
    private readonly runId: string,
    private readonly options: { keep?: number } = {},
  ) {}

  private get key(): string {
    return `runs/${this.runId}/events`;
  }

  private async load(): Promise<ForgeEvent[]> {
    if (this.cache) return this.cache;
    const raw = await this.kv.get(this.key);
    this.cache = raw ? (JSON.parse(raw) as ForgeEvent[]) : [];
    this.seq = this.cache.reduce((max, event) => Math.max(max, event.seq), 0);
    return this.cache;
  }

  async append(event: NewEvent): Promise<ForgeEvent> {
    const events = await this.load();
    this.seq += 1;
    const stored = {
      ...event,
      id: `${this.runId}-${this.seq}`,
      runId: this.runId,
      seq: this.seq,
      timestamp: event.timestamp ?? Date.now(),
    } as ForgeEvent;
    events.push(stored);
    const keep = this.options.keep ?? 2000;
    const pruned = events.length > keep * 1.25 ? events.slice(-keep) : events;
    this.cache = pruned;
    await this.kv.set(this.key, JSON.stringify(pruned));
    return stored;
  }

  async all(): Promise<ForgeEvent[]> {
    return [...(await this.load())];
  }

  async query(filter: EventFilter = {}): Promise<ForgeEvent[]> {
    const events = await this.load();
    const kinds = filter.kind ? (Array.isArray(filter.kind) ? filter.kind : [filter.kind]) : null;
    return events.filter(
      (event) =>
        (!kinds || kinds.includes(event.kind)) &&
        (!filter.agentId || event.agentId === filter.agentId) &&
        (!filter.stepId || event.stepId === filter.stepId) &&
        (filter.afterSeq === undefined || event.seq > filter.afterSeq),
    );
  }
}

/** Lists run ids that have persisted state, newest first. */
export async function listRuns(kv: KeyValuePort): Promise<string[]> {
  const keys = await kv.keys('runs/');
  const ids = new Set<string>();
  for (const key of keys) {
    const match = /^runs\/([^/]+)\//.exec(key);
    if (match) ids.add(match[1]);
  }
  return [...ids].sort().reverse();
}

/** Minimal projection used by the timeline UI. */
export interface TimelineEntry {
  seq: number;
  timestamp: number;
  kind: string;
  label: string;
  agentId?: string;
}

export function toTimeline(events: ForgeEvent[]): TimelineEntry[] {
  return events.map((event) => {
    let label: string = event.kind;
    if (event.kind === 'action') label = `action: ${event.toolName}`;
    else if (event.kind === 'observation') label = `${event.ok ? 'ok' : 'fail'}: ${event.toolName}`;
    else if (event.kind === 'step_started') label = `▶ ${event.stepName}`;
    else if (event.kind === 'step_finished') label = `${event.ok ? '✔' : '✘'} ${event.stepName}`;
    else if (event.kind === 'agent_spawned') label = `spawned ${event.childAgentId}`;
    else if (event.kind === 'agent_finished') label = `finished ${event.childAgentId}`;
    else if ('detail' in event && event.detail) label = `${event.kind}: ${event.detail}`;
    return { seq: event.seq, timestamp: event.timestamp, kind: event.kind, label, agentId: event.agentId };
  });
}
