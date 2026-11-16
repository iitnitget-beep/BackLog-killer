import type { ChatMessage, CompletionRequest, CompletionResponse, LlmClient, ToolCall } from '../src/llm/types';

export interface ScriptedTurn {
  content?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}

/**
 * Scripted LLM: replays a fixed list of turns. Every call is recorded so tests
 * can assert on what the agent was sent (e.g. that AGENTS.md reached the prompt).
 */
export class ScriptedLlm implements LlmClient {
  readonly providerId = 'scripted';
  readonly model = 'scripted-1';
  readonly requests: CompletionRequest[] = [];
  private index = 0;

  constructor(private readonly turns: ScriptedTurn[]) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)] ?? {};
    this.index += 1;
    const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((call, i) => ({
      id: `call-${this.index}-${i}`,
      type: 'function' as const,
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    return {
      content: turn.content ?? '',
      toolCalls,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      usage: { promptTokens: 100, completionTokens: 50 },
      provider: this.providerId,
      model: this.model,
    };
  }

  systemPrompt(): string {
    const first: ChatMessage | undefined = this.requests[0]?.messages.find((m) => m.role === 'system');
    return first?.content ?? '';
  }
}

/** Returns a scripted LLM per agent role, keyed by a marker in the system prompt. */
export class RoleLlmRouter {
  readonly calls: { role: string; request: CompletionRequest }[] = [];
  constructor(private readonly scripts: Record<string, ScriptedTurn[]>) {}

  client(): LlmClient {
    const router = this;
    return {
      providerId: 'role-router',
      model: 'role-router',
      async complete(request: CompletionRequest): Promise<CompletionResponse> {
        const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
        const role = detectRole(system);
        router.calls.push({ role, request });
        const turns = router.scripts[role] ?? router.scripts['default'] ?? [{ content: 'ok' }];
        const already = router.calls.filter((call) => call.role === role).length - 1;
        const turn = turns[Math.min(already, turns.length - 1)];
        const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((call, i) => ({
          id: `${role}-${already}-${i}`,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }));
        return {
          content: turn.content ?? '',
          toolCalls,
          finishReason: toolCalls.length ? 'tool_calls' : 'stop',
          usage: { promptTokens: 10, completionTokens: 10 },
          provider: 'role-router',
          model: 'role-router',
        };
      },
    };
  }
}

export function detectRole(system: string): string {
  if (system.includes('You are the planner')) return 'planner';
  if (system.includes('You are the editor')) return 'editor';
  if (system.includes('You are a senior code reviewer')) return 'reviewer';
  if (system.includes('You are the test-fixer')) return 'test-fixer';
  if (system.includes('You are the file-picker')) return 'file-picker';
  if (system.includes('You are a security reviewer')) return 'security-reviewer';
  if (system.includes('You are the thinker')) return 'thinker';
  if (system.includes('You are the ForgeX orchestrator')) return 'orchestrator';
  return 'unknown';
}
