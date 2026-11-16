import type { ChatMessage } from '../llm/types';

export interface CondenseOptions {
  /** Above this estimated token count we condense. */
  maxTokens?: number;
  /** Number of most recent messages always preserved verbatim. */
  keepRecent?: number;
  /** Rough chars-per-token for the cheap estimator. */
  charsPerToken?: number;
  summarizer?: (messages: ChatMessage[]) => Promise<string>;
}

export interface CondenseResult {
  messages: ChatMessage[];
  condensed: boolean;
  summary?: string;
  droppedMessages: number;
}

/** Cheap, dependency-free token estimate (English/code ~4 chars per token). */
export function estimateTokens(messages: ChatMessage[], charsPerToken = 4): number {
  let chars = 0;
  for (const message of messages) {
    chars += (message.content ?? '').length;
    chars += message.tool_calls?.reduce((sum, call) => sum + call.function.arguments.length + 40, 0) ?? 0;
    chars += 8;
  }
  return Math.ceil(chars / charsPerToken);
}

/** Deterministic offline summary used when no model is available. */
export function fallbackSummary(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = (message.content ?? '').trim();
      if (text) lines.push(`- assistant: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      for (const call of message.tool_calls ?? []) {
        lines.push(`- called ${call.function.name}(${call.function.arguments.slice(0, 120)})`);
      }
    } else if (message.role === 'tool') {
      lines.push(`- ${message.name ?? 'tool'} result: ${(message.content ?? '').slice(0, 160).replace(/\s+/g, ' ')}`);
    }
  }
  return lines.slice(-40).join('\n');
}

/**
 * OpenHands-style context condenser: when history grows past the budget, older
 * turns are summarised into one system message while recent turns stay intact.
 * Tool-call/tool-result pairs are never split, otherwise the provider rejects
 * the request.
 */
export async function condense(messages: ChatMessage[], options: CondenseOptions = {}): Promise<CondenseResult> {
  const maxTokens = options.maxTokens ?? 24_000;
  const keepRecent = options.keepRecent ?? 12;
  const charsPerToken = options.charsPerToken ?? 4;
  if (estimateTokens(messages, charsPerToken) <= maxTokens) {
    return { messages, condensed: false, droppedMessages: 0 };
  }
  const pinned = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  // Walk back to a safe boundary: never start the recent window on a tool result.
  let split = Math.max(0, rest.length - keepRecent);
  while (split > 0 && rest[split]?.role === 'tool') split -= 1;
  const older = rest.slice(0, split);
  const recent = rest.slice(split);
  if (older.length === 0) {
    return { messages, condensed: false, droppedMessages: 0 };
  }
  let summary: string;
  if (options.summarizer) {
    summary = await options.summarizer(older);
  } else {
    summary = fallbackSummary(older);
  }
  const summaryMessage: ChatMessage = {
    role: 'system',
    content: `Summary of earlier work in this run (older messages were condensed to save context):\n${summary}`,
  };
  return {
    messages: [...pinned, summaryMessage, ...recent],
    condensed: true,
    summary,
    droppedMessages: older.length,
  };
}
