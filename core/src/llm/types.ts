/** OpenAI-compatible chat types. Every supported provider speaks this shape. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDeclaration[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Label used only for logging/telemetry. */
  agent?: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface CompletionResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Usage;
  provider: string;
  model: string;
}

export interface LlmError extends Error {
  status?: number;
  retryable?: boolean;
  provider?: string;
}

export interface ProviderConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKeyEnvVar?: string;
  defaultModel: string;
  /** Extra headers some gateways require (e.g. OpenRouter attribution). */
  headers?: Record<string, string>;
}

export interface LlmClient {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  readonly providerId: string;
  readonly model: string;
}
