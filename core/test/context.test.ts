import { describe, expect, it } from 'vitest';
import { condense, estimateTokens, fallbackSummary } from '../src/context/condenser';
import type { ChatMessage } from '../src/llm/types';

function history(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: 'system prompt' }];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ role: 'user', content: `request ${i}` });
    messages.push({
      role: 'assistant',
      content: `working on ${i}`,
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: `{"path":"f${i}.kt"}` } }],
    });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, name: 'read_file', content: 'x'.repeat(2000) });
  }
  return messages;
}

describe('condenser', () => {
  it('leaves short histories untouched', async () => {
    const messages = history(2);
    const result = await condense(messages, { maxTokens: 100_000 });
    expect(result.condensed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it('condenses long histories, keeps the system prompt and recent turns', async () => {
    const messages = history(50);
    const result = await condense(messages, { maxTokens: 2_000, keepRecent: 6 });
    expect(result.condensed).toBe(true);
    expect(result.messages[0].content).toBe('system prompt');
    expect(result.messages[1].content).toContain('condensed');
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.droppedMessages).toBeGreaterThan(0);
  });

  it('never starts the recent window on a tool result', async () => {
    const messages = history(40);
    const result = await condense(messages, { maxTokens: 1_000, keepRecent: 5 });
    const firstNonSystem = result.messages.findIndex((m, i) => i > 1 && m.role !== 'system');
    expect(result.messages[firstNonSystem].role).not.toBe('tool');
  });

  it('uses a provided summarizer', async () => {
    const result = await condense(history(40), {
      maxTokens: 1_000,
      keepRecent: 4,
      summarizer: async () => 'CUSTOM SUMMARY',
    });
    expect(result.summary).toBe('CUSTOM SUMMARY');
    expect(result.messages[1].content).toContain('CUSTOM SUMMARY');
  });

  it('estimates tokens monotonically', () => {
    expect(estimateTokens(history(1))).toBeLessThan(estimateTokens(history(5)));
  });

  it('builds a deterministic offline summary', () => {
    const summary = fallbackSummary(history(3));
    expect(summary).toContain('called read_file');
    expect(summary).toContain('read_file result');
  });
});
