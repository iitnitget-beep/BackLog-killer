/**
 * Loop detection, ported in spirit from qwen-code's loopDetectionService.ts
 * (Apache-2.0): a repeated identical tool call is almost always a stuck model.
 * Thresholds match theirs (5 identical tool calls, 10 identical content
 * chunks). See NOTICE.md.
 */
export const TOOL_CALL_LOOP_THRESHOLD = 5;
export const CONTENT_LOOP_THRESHOLD = 10;

export type LoopStopReason = 'tool_call_loop' | 'content_loop';

export interface LoopVerdict {
  looped: boolean;
  reason?: LoopStopReason;
  detail?: string;
}

/** Stable fingerprint of a tool call, independent of JSON key order. */
export function fingerprint(toolName: string, args: Record<string, unknown>): string {
  const normalise = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalise);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalise(v)]),
      );
    }
    return value;
  };
  return `${toolName}:${JSON.stringify(normalise(args))}`;
}

export class LoopDetector {
  private readonly recentCalls: string[] = [];
  private readonly recentContent: string[] = [];

  constructor(
    private readonly toolThreshold = TOOL_CALL_LOOP_THRESHOLD,
    private readonly contentThreshold = CONTENT_LOOP_THRESHOLD,
  ) {}

  recordToolCall(toolName: string, args: Record<string, unknown>): LoopVerdict {
    const fp = fingerprint(toolName, args);
    this.recentCalls.push(fp);
    if (this.recentCalls.length > this.toolThreshold * 2) this.recentCalls.shift();
    const tail = this.recentCalls.slice(-this.toolThreshold);
    if (tail.length === this.toolThreshold && tail.every((entry) => entry === fp)) {
      return {
        looped: true,
        reason: 'tool_call_loop',
        detail: `${toolName} called ${this.toolThreshold} times with identical arguments`,
      };
    }
    return { looped: false };
  }

  recordContent(content: string): LoopVerdict {
    const normalised = content.replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!normalised) return { looped: false };
    this.recentContent.push(normalised);
    if (this.recentContent.length > this.contentThreshold * 2) this.recentContent.shift();
    const tail = this.recentContent.slice(-this.contentThreshold);
    if (tail.length === this.contentThreshold && tail.every((entry) => entry === normalised)) {
      return {
        looped: true,
        reason: 'content_loop',
        detail: `model repeated the same message ${this.contentThreshold} times`,
      };
    }
    return { looped: false };
  }

  reset(): void {
    this.recentCalls.length = 0;
    this.recentContent.length = 0;
  }
}
