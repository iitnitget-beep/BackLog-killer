import type { Platform } from '../platform/types';
import type { LlmClient } from '../llm/types';
import type { ToolRegistry } from '../tools/registry';
import type { EventStore } from '../events/store';
import type { ApprovalManager } from './approval';
import type { AgentDefinition, AgentRole } from './definitions';
import { getAgent } from './definitions';
import { runAgentLoop, type EngineResult } from './engine';
import { gate } from '../security/scanner';
import type { PlanDraft } from '../run/plan';

export interface AgentRunRequest {
  agent: AgentRole;
  task: string;
  /** Extra context (file lists, previous output, CI logs). */
  context?: string;
  maxRounds?: number;
  /** Withhold tools per call (e.g. no run_command during planning). */
  excludeTools?: string[];
  signal?: AbortSignal;
}

export interface AgentRunResult {
  agent: AgentRole;
  result: EngineResult;
  output: string;
}

export interface OrchestratorDeps {
  platform: Platform;
  /** Returns a client for an agent, already routed to a healthy provider. */
  llm: (agent: AgentDefinition) => LlmClient;
  registry: ToolRegistry;
  approvals: ApprovalManager;
  events: EventStore;
  workspaceRoot: string;
  /** Extra markdown injected into every system prompt (AGENTS.md, skills). */
  extraContext?: () => Promise<string>;
  maxRoundsPerAgent?: number;
}

/**
 * Multi-agent orchestrator. Implements freebuff/codebuff's "a parent agent can
 * spawn others and wait for results" pattern, but without any hosted backend:
 * agents are plain declarative definitions executed sequentially in one
 * workspace, with every spawn/finish recorded on the event stream so the UI can
 * render the Agent Timeline.
 */
export class Orchestrator {
  private counter = 0;

  constructor(private readonly deps: OrchestratorDeps) {}

  private nextAgentId(role: AgentRole): string {
    this.counter += 1;
    return `${role}-${this.counter}`;
  }

  async spawn(request: AgentRunRequest, parentAgentId?: string): Promise<AgentRunResult> {
    const agent = getAgent(request.agent);
    const agentId = this.nextAgentId(request.agent);
    const { events, approvals, platform } = this.deps;
    await events.append({
      kind: 'agent_spawned',
      agentId,
      childAgentId: agentId,
      summary: `${agent.title}: ${request.task.slice(0, 160)}`,
    });
    // A sub-agent inherits the approval mode but never a remembered "allow all"
    // for destructive commands - ApprovalManager handles that per call.
    const tools = request.excludeTools?.length
      ? this.deps.registry.subset(agent.tools.filter((t) => !request.excludeTools!.includes(t)))
      : this.deps.registry.subset(agent.tools);
    const extra = this.deps.extraContext ? await this.deps.extraContext() : '';
    const systemPrompt = [
      agent.instructions,
      '',
      `## Available tools\n${tools.names().map((n) => `- ${n}`).join('\n')}`,
      `## Workspace\n${this.deps.workspaceRoot}`,
      extra ? `\n## Project context (AGENTS.md, skills, learned notes)\n${extra}` : '',
      parentAgentId ? `\nYou were spawned by ${parentAgentId}.` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await runAgentLoop({
      llm: this.deps.llm(agent),
      registry: tools,
      approvals,
      workspaceRoot: this.deps.workspaceRoot,
      systemPrompt,
      userPrompt: request.context ? `${request.task}\n\n## Additional context\n${request.context}` : request.task,
      maxRounds: request.maxRounds ?? this.deps.maxRoundsPerAgent ?? 30,
      signal: request.signal,
      onAssistantMessage: async (content) => {
        await events.append({ kind: 'assistant_message', agentId, content: content.slice(0, 4000) });
      },
      onToolResult: async (toolName, ok, output) => {
        await events.append({
          kind: 'observation',
          agentId,
          toolName,
          toolCallId: `${agentId}-${toolName}`,
          ok,
          output: output.slice(0, 2000),
        });
      },
    });
    await events.append({
      kind: 'agent_finished',
      agentId,
      childAgentId: agentId,
      summary: `${result.reason} after ${result.rounds} rounds, ${result.toolCalls} tool calls`,
    });
    const output = result.finalMessage || result.messages.filter((m) => m.role === 'assistant').map((m) => m.content ?? '').join('\n');
    void platform;
    return { agent: request.agent, result, output };
  }

  /** Runs a named agent as a one-shot: used for planning, review, fixes. */
  async ask(agent: AgentRole, task: string, context?: string, signal?: AbortSignal): Promise<string> {
    const result = await this.spawn({ agent, task, context, signal });
    return result.output;
  }

  /**
   * ECC verify loop: implement -> verify -> fresh-context review -> fix,
   * bounded by `maxIterations` (spec: max 5, then ask the user).
   */
  async verifyLoop(options: VerifyLoopOptions): Promise<VerifyLoopOutcome> {
    const maxIterations = options.maxIterations ?? 5;
    const history: VerifyAttempt[] = [];
    let lastFixContext = options.initialTask;
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (options.signal?.aborted) {
        return { status: 'aborted', iterations: iteration - 1, history };
      }
      await this.deps.events.append({
        kind: 'step_started',
        stepName: 'test',
        detail: `verification round ${iteration}/${maxIterations}`,
      });
      const verify = await options.verify();
      if (verify.ok) {
        const review = options.review
          ? await this.ask('reviewer', options.review.task, options.review.context, options.signal)
          : '';
        const verdict = parseVerdict(review);
        history.push({ iteration, verify, review, verdict });
        await this.deps.events.append({
          kind: 'step_finished',
          stepName: 'test',
          ok: true,
          detail: `round ${iteration}: verify passed, review=${verdict}`,
        });
        if (verdict === 'fail') {
          // A reviewer failure still costs an iteration: feed it back to the fixer.
          lastFixContext = `Verification passed but review failed:\n${review}`;
          const fix = await this.ask('test-fixer', `Fix the review findings.\n${review}`, lastFixContext, options.signal);
          history[history.length - 1].fix = fix;
          continue;
        }
        return { status: 'passed', iterations: iteration, history };
      }
      history.push({ iteration, verify });
      await this.deps.events.append({
        kind: 'step_finished',
        stepName: 'test',
        ok: false,
        detail: `round ${iteration}: ${verify.summary.slice(0, 300)}`,
      });
      if (iteration === maxIterations) break;
      const fixTask = [
        `The build/test failed. Fix it.`,
        '',
        `## Failure output`,
        verify.output.slice(-6000),
        '',
        `## Original task`,
        options.initialTask,
      ].join('\n');
      const fix = await this.ask('test-fixer', fixTask, lastFixContext, options.signal);
      history[history.length - 1].fix = fix;
      lastFixContext = `Previous attempt failed:\n${verify.output.slice(-2000)}\nYour previous fix:\n${fix.slice(-2000)}`;
    }
    await this.deps.events.append({
      kind: 'gate_blocked',
      detail: `verification loop exhausted after ${maxIterations} iterations; user input required`,
    });
    return { status: 'exhausted', iterations: maxIterations, history };
  }

  /** Plans a request, returning both the raw draft and the parsed plan. */
  async plan(task: string, signal?: AbortSignal): Promise<{ raw: string; draft: PlanDraft }> {
    const raw = await this.ask('planner', task, undefined, signal);
    return { raw, draft: parsePlan(raw, task) };
  }

  /** Secret gate before push (ECC PreToolUse hook applied to git push). */
  async prePushScan(files: { path: string; content: string }[]): Promise<{ ok: boolean; blockers: string[] }> {
    const blockers: string[] = [];
    for (const file of files) {
      const verdict = gate(file.content, { path: file.path, strict: true });
      if (!verdict.allowed) blockers.push(`${file.path}: ${verdict.reason}`);
    }
    if (blockers.length) {
      await this.deps.events.append({ kind: 'gate_blocked', detail: blockers.join('; ').slice(0, 1500) });
    }
    return { ok: blockers.length === 0, blockers };
  }
}

export interface VerifyResult {
  ok: boolean;
  summary: string;
  output: string;
  /** Exit codes per command, for the timeline. */
  commands?: { command: string; code: number }[];
}

export interface VerifyAttempt {
  iteration: number;
  verify: VerifyResult;
  review?: string;
  verdict?: 'pass' | 'fail' | 'unknown';
  fix?: string;
}

export interface VerifyLoopOptions {
  initialTask: string;
  verify: () => Promise<VerifyResult>;
  review?: { task: string; context: string };
  maxIterations?: number;
  signal?: AbortSignal;
}

export interface VerifyLoopOutcome {
  status: 'passed' | 'exhausted' | 'aborted';
  iterations: number;
  history: VerifyAttempt[];
}

/** Extracts verdict/findings from a reviewer answer, tolerating chatter. */
export function parseVerdict(review: string): 'pass' | 'fail' | 'unknown' {
  const json = extractJson(review);
  if (json && typeof json === 'object' && 'verdict' in json) {
    const verdict = String((json as Record<string, unknown>)['verdict']).toLowerCase();
    if (verdict.includes('pass')) return 'pass';
    if (verdict.includes('fail')) return 'fail';
  }
  const lower = review.toLowerCase();
  if (/\bverdict\b[^\n]{0,20}pass|\"verdict\":\s*\"pass\"/.test(lower)) return 'pass';
  if (/\bverdict\b[^\n]{0,20}fail|\"verdict\":\s*\"fail\"/.test(lower)) return 'fail';
  return 'unknown';
}

export function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(text)) !== null) {
    try {
      return JSON.parse(match[1].trim());
    } catch {
      continue;
    }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** Parses a planner answer into a plan, with a deterministic fallback. */
export function parsePlan(raw: string, task: string): PlanDraft {
  const json = extractJson(raw);
  const candidate = json as Partial<PlanDraft> | null;
  if (candidate && Array.isArray(candidate.steps) && candidate.steps.length > 0) {
    return {
      summary: String(candidate.summary ?? task).slice(0, 300),
      features: Array.isArray(candidate.features) ? candidate.features : [],
      steps: candidate.steps.map((step, index) => ({
        id: Number(step.id ?? index + 1),
        title: String(step.title ?? `Step ${index + 1}`),
        files: Array.isArray(step.files) ? step.files.map(String) : [],
        doneWhen: String(step.doneWhen ?? 'build passes'),
      })),
      risks: Array.isArray(candidate.risks) ? candidate.risks.map(String) : [],
      verify: Array.isArray(candidate.verify) ? candidate.verify.map(String) : ['gradle assembleDebug'],
    };
  }
  return {
    summary: task.slice(0, 300),
    features: [],
    steps: [{ id: 1, title: 'Implement the requested app', files: [], doneWhen: 'build passes' }],
    risks: ['planner returned an unparseable plan; using a single-step fallback'],
    verify: ['gradle assembleDebug'],
  };
}
