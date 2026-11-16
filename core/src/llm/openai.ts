import type { Platform } from '../platform/types';
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  LlmClient,
  ProviderConfig,
  ToolDeclaration,
} from './types';

export interface OpenAiClientOptions {
  platform: Platform;
  config: ProviderConfig;
  apiKey: string;
  model?: string;
  /** Injected for tests. */
  fetchImpl?: (request: import('../platform/types').HttpRequest) => Promise<import('../platform/types').HttpResponse>;
}

function toWireMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    const wire: Record<string, unknown> = { role: message.role, content: message.content ?? '' };
    if (message.tool_calls?.length) wire['tool_calls'] = message.tool_calls;
    if (message.tool_call_id) wire['tool_call_id'] = message.tool_call_id;
    if (message.name) wire['name'] = message.name;
    return wire;
  });
}

function toWireTools(tools?: ToolDeclaration[]): Record<string, unknown>[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** Retry-After aware error classification used by the fallback router. */
export function classifyStatus(status: number): { retryable: boolean; kind: string } {
  if (status === 401 || status === 403) return { retryable: false, kind: 'auth' };
  if (status === 404) return { retryable: false, kind: 'not_found' };
  if (status === 429) return { retryable: true, kind: 'rate_limit' };
  if (status >= 500) return { retryable: true, kind: 'server' };
  if (status === 408) return { retryable: true, kind: 'timeout' };
  return { retryable: false, kind: 'client' };
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly providerId: string;
  readonly model: string;

  constructor(private readonly options: OpenAiClientOptions) {
    this.providerId = options.config.id;
    this.model = options.model ?? options.config.defaultModel;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const { platform, config, apiKey } = this.options;
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(request.messages),
      temperature: request.temperature ?? 0.2,
    };
    if (request.maxTokens) body['max_tokens'] = request.maxTokens;
    const tools = toWireTools(request.tools);
    if (tools) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
      // Some gateways stream by default; we want a single response object.
      body['stream'] = false;
    }
    const fetchImpl = this.options.fetchImpl ?? ((r) => platform.http(r));
    const response = await fetchImpl({
      url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(body),
      timeoutMs: 180_000,
    });
    if (response.status < 200 || response.status >= 300) {
      const meta = classifyStatus(response.status);
      const error = new Error(
        `${config.id} returned ${response.status} (${meta.kind}): ${response.body.slice(0, 400)}`,
      ) as import('./types').LlmError;
      error.status = response.status;
      error.retryable = meta.retryable;
      error.provider = config.id;
      throw error;
    }
    const parsed = JSON.parse(response.body) as {
      choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const choice = parsed.choices?.[0];
    if (!choice) throw new Error(`${config.id} returned no choices`);
    return {
      content: choice.message?.content ?? '',
      toolCalls: (choice.message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.function.name, arguments: call.function.arguments },
      })),
      finishReason: choice.finish_reason ?? 'stop',
      usage: {
        promptTokens: parsed.usage?.prompt_tokens ?? 0,
        completionTokens: parsed.usage?.completion_tokens ?? 0,
      },
      provider: config.id,
      model: parsed.model ?? this.model,
    };
  }
}
