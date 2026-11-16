/**
 * OpenHands-style event model (src/types/agent-server/core/events, MIT):
 * every model thought is an Action, every tool answer is an Observation, and
 * the pair is appended to a durable, replayable log. See NOTICE.md.
 */
export type EventKind =
  | 'run_started'
  | 'run_finished'
  | 'run_paused'
  | 'run_failed'
  | 'step_started'
  | 'step_finished'
  | 'action'
  | 'observation'
  | 'agent_spawned'
  | 'agent_finished'
  | 'plan_updated'
  | 'gate_blocked'
  | 'condensation'
  | 'note'
  | 'log'
  | 'user_message'
  | 'assistant_message';

export interface BaseEvent {
  id: string;
  runId: string;
  kind: EventKind;
  /** Monotonic per-run sequence number. */
  seq: number;
  timestamp: number;
  agentId?: string;
  stepId?: string;
}

export interface ActionEvent extends BaseEvent {
  kind: 'action';
  thought: string;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

export interface ObservationEvent extends BaseEvent {
  kind: 'observation';
  toolName: string;
  toolCallId: string;
  ok: boolean;
  output: string;
  errorCode?: string;
}

export interface MessageEvent extends BaseEvent {
  kind: 'user_message' | 'assistant_message';
  content: string;
}

export interface StepEvent extends BaseEvent {
  kind: 'step_started' | 'step_finished';
  stepName: 'plan' | 'context' | 'code' | 'test' | 'review' | 'ship';
  detail?: string;
  ok?: boolean;
}

export interface RunEvent extends BaseEvent {
  kind: 'run_started' | 'run_finished' | 'run_paused' | 'run_failed';
  detail?: string;
}

export interface AgentLifecycleEvent extends BaseEvent {
  kind: 'agent_spawned' | 'agent_finished';
  childAgentId: string;
  summary?: string;
}

export interface NoteEvent extends BaseEvent {
  kind: 'note' | 'log' | 'plan_updated' | 'gate_blocked' | 'condensation';
  detail: string;
  data?: unknown;
}

export type ForgeEvent =
  | ActionEvent
  | ObservationEvent
  | MessageEvent
  | StepEvent
  | RunEvent
  | AgentLifecycleEvent
  | NoteEvent;

export interface EventFilter {
  kind?: EventKind | EventKind[];
  agentId?: string;
  stepId?: string;
  afterSeq?: number;
}

/**
 * Non-distributive Omit applied over a union keeps each member's own fields,
 * so `append({kind: 'action', toolName: ...})` type-checks.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type NewEvent = DistributiveOmit<ForgeEvent, 'id' | 'seq' | 'runId' | 'timestamp'> & {
  timestamp?: number;
};
