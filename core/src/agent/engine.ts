import type { ChatMessage, CompletionResponse, LlmClient, ToolCall } from '../llm/types';
import type { ToolRegistry } from '../tools/registry';
import { ToolRegistry as Registry } from '../tools/registry';
import type { ApprovalManager } from './approval';
import { executeTool } from './executor';
import { LoopDetector, type LoopVerdict } from './loopDetection';
import { condense, estimateTokens } from '../context/condenser';

export interface EngineOptions {
  llm: LlmClient;
  registry: ToolRegistry;
  approvals: ApprovalManager;
  workspaceRoot: string;
  systemPrompt: string;
  /** Hard cap on model rounds, mirroring qwen-code's agent loop. */
  maxRounds?: number;
  maxTokensPerRequest?: number;
  loopDetector?: LoopDetector;
  /** Opening user turn. Without it the model only sees the system prompt. */
  userPrompt?: string;
  signal?: AbortSignal;
  onAssistantMessage?: (content: string) => void;
  onToolResult?: (toolName: string, ok: boolean, output: string) => void;
}

export type EngineStopReason =
  | 'completed'
  | 'max_rounds'
  | 'cancelled'
  | 'loop_detected'
  | 'error';

export interface EngineResult {
  reason: EngineStopReason;
  finalMessage: string;
  rounds: number;
  toolCalls: number;
  messages: ChatMessage[];
  error?: string;
  loop?: LoopVerdict;
}

/**
 * Single-agent loop, ported in structure from qwen-code's agent loop
 * (packages/core/src/core/agent-loop.ts): send messages + tool declarations,
 * execute returned tool calls, append results, repeat until the model stops
 * calling tools or a stop condition fires.
 */
export async function runAgentLoop(options: EngineOptions): Promise<EngineResult> {
  const maxRounds = options.maxRounds ?? 40;
  const detector = options.loopDetector ?? new LoopDetector();
  const messages: ChatMessage[] = [{ role: 'system', content: options.systemPrompt }];
  if (options.userPrompt) messages.push({ role: 'user', content: options.userPrompt });
  let working = messages;
  let rounds = 0;
  let toolCalls = 0;
  let finalMessage = '';

  for (; rounds < maxRounds; rounds += 1) {
    if (options.signal?.aborted) {
      return { reason: 'cancelled', finalMessage, rounds, toolCalls, messages: working };
    }
    const condensed = await condense(working, { maxTokens: options.maxTokensPerRequest ?? 24_000 });
    working = condensed.messages;
    let response: CompletionResponse;
    try {
      response = await options.llm.complete({
        messages: working,
        tools: options.registry.declarations(),
        signal: options.signal,
        maxTokens: 8_192,
      });
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      return { reason: 'error', finalMessage, rounds, toolCalls, messages: working, error: message };
    }
    const content = response.content ?? '';
    if (content) {
      finalMessage = content;
      options.onAssistantMessage?.(content);
    }
    const contentVerdict = content ? detector.recordContent(content) : { looped: false };
    if (contentVerdict.looped) {
      return { reason: 'loop_detected', finalMessage, rounds, toolCalls, messages: working, loop: contentVerdict };
    }
    if (response.toolCalls.length === 0) {
      working.push({ role: 'assistant', content });
      return { reason: 'completed', finalMessage, rounds: rounds + 1, toolCalls, messages: working };
    }
    working.push({ role: 'assistant', content, tool_calls: response.toolCalls });
    for (const call of response.toolCalls) {
      toolCalls += 1;
      const args = parseArgs(call);
      const verdict = detector.recordToolCall(call.function.name, args);
      if (verdict.looped) {
        working.push(toolResultMessage(call, `Stopped: ${verdict.detail}`));
        return { reason: 'loop_detected', finalMessage, rounds: rounds + 1, toolCalls, messages: working, loop: verdict };
      }
      const outcome = await executeTool({
        toolName: call.function.name,
        args,
        registry: options.registry,
        approvals: options.approvals,
        workspaceRoot: options.workspaceRoot,
      });
      options.onToolResult?.(call.function.name, outcome.envelope.ok, outcome.envelope.output);
      working.push(toolResultMessage(call, outcome.envelope.output));
    }
  }
  return { reason: 'max_rounds', finalMessage, rounds, toolCalls, messages: working };
}

export function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Small models frequently emit malformed JSON; surface it as an empty
    // argument set so the tool returns a validation error the model can fix.
    return { __parse_error: call.function.arguments };
  }
}

function toolResultMessage(call: ToolCall, output: string): ChatMessage {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: call.function.name,
    content: output.slice(0, 12_000),
  };
}

export { Registry as ToolRegistryImpl, estimateTokens };
