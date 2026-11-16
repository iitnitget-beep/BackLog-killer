import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleClient, classifyStatus } from '../src/llm/openai';
import { ProviderRouter, type ProviderEntry } from '../src/llm/router';
import { PROVIDER_PRESETS, findPreset } from '../src/llm/providers';
import { GitHubDeviceFlow } from '../src/github/oauth';
import { createMemoryPlatform } from '../src/platform/memory';
import type { CompletionRequest } from '../src/llm/types';
import type { HttpResponse } from '../src/platform/types';

const MESSAGES: CompletionRequest = { messages: [{ role: 'user', content: 'hi' }] };

function ok(body: unknown): HttpResponse {
  return { status: 200, headers: {}, body: JSON.stringify(body) };
}

function completion(content: string) {
  return {
    choices: [{ message: { content, tool_calls: [] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
    model: 'test-model',
  };
}

function clientWith(responses: HttpResponse[]) {
  let index = 0;
  const requests: unknown[] = [];
  const platform = createMemoryPlatform();
  const client = new OpenAiCompatibleClient({
    platform,
    config: { id: 'test', label: 'Test', baseUrl: 'https://api.test/v1', defaultModel: 'test-model' },
    apiKey: 'sk-test',
    fetchImpl: async (request) => {
      requests.push(JSON.parse(request.body ?? '{}'));
      return responses[Math.min(index++, responses.length - 1)];
    },
  });
  return { client, requests };
}

describe('openai-compatible client', () => {
  it('posts an OpenAI chat completion and parses the reply', async () => {
    const { client, requests } = clientWith([ok(completion('hello'))]);
    const response = await client.complete(MESSAGES);
    expect(response.content).toBe('hello');
    expect(response.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
    expect((requests[0] as { model: string }).model).toBe('test-model');
  });

  it('sends tool declarations in the function-calling shape', async () => {
    const { client, requests } = clientWith([ok(completion('x'))]);
    await client.complete({
      ...MESSAGES,
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }],
    });
    const body = requests[0] as { tools: { type: string; function: { name: string } }[]; tool_choice: string };
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.name).toBe('read_file');
    expect(body.tool_choice).toBe('auto');
  });

  it('parses tool calls', async () => {
    const { client } = clientWith([
      ok({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.kt"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        model: 'm',
      }),
    ]);
    const response = await client.complete(MESSAGES);
    expect(response.toolCalls[0].function.name).toBe('read_file');
    expect(response.finishReason).toBe('tool_calls');
  });

  it('classifies errors so the router knows what is worth retrying', async () => {
    expect(classifyStatus(429)).toEqual({ retryable: true, kind: 'rate_limit' });
    expect(classifyStatus(500).retryable).toBe(true);
    expect(classifyStatus(401).retryable).toBe(false);
    expect(classifyStatus(400).retryable).toBe(false);
  });

  it('throws a typed, retryable error on 429', async () => {
    const { client } = clientWith([{ status: 429, headers: {}, body: 'slow down' }]);
    await expect(client.complete(MESSAGES)).rejects.toMatchObject({ status: 429, retryable: true });
  });

  it('marks auth failures as not retryable', async () => {
    const { client } = clientWith([{ status: 401, headers: {}, body: 'bad key' }]);
    await expect(client.complete(MESSAGES)).rejects.toMatchObject({ status: 401, retryable: false });
  });
});

describe('provider router', () => {
  function entry(id: string, models?: string[]): ProviderEntry {
    return { config: { id, label: id, baseUrl: `https://${id}.test/v1`, defaultModel: `${id}-model` }, apiKey: 'k', models };
  }

  function router(entries: ProviderEntry[], failures: Record<string, number>) {
    const attempts: string[] = [];
    const events: string[] = [];
    const r = new ProviderRouter({
      entries,
      onEvent: (event) => events.push(`${event.type}:${event.provider}`),
      factory: (e, model) => ({
        providerId: e.config.id,
        model,
        complete: async () => {
          attempts.push(`${e.config.id}:${model}`);
          const remaining = failures[e.config.id] ?? 0;
          if (remaining > 0) {
            failures[e.config.id] = remaining - 1;
            throw Object.assign(new Error('rate limited'), { retryable: true, status: 429 });
          }
          return {
            content: `from ${e.config.id}`,
            toolCalls: [],
            finishReason: 'stop',
            usage: { promptTokens: 0, completionTokens: 0 },
            provider: e.config.id,
            model,
          };
        },
      }),
    });
    return { router: r, attempts, events };
  }

  it('uses the first provider when it works', async () => {
    const { router: r, attempts } = router([entry('a'), entry('b')], {});
    expect((await r.complete(MESSAGES)).content).toBe('from a');
    expect(attempts).toEqual(['a:a-model']);
  });

  it('retries once then falls back to the next provider', async () => {
    const { router: r, attempts } = router([entry('a'), entry('b')], { a: 5 });
    const response = await r.complete(MESSAGES);
    expect(response.content).toBe('from b');
    expect(attempts).toEqual(['a:a-model', 'a:a-model', 'b:b-model']);
  });

  it('does not retry an auth failure, it falls through immediately', async () => {
    const attempts: string[] = [];
    const r = new ProviderRouter({
      entries: [entry('a'), entry('b')],
      factory: (e, model) => ({
        providerId: e.config.id,
        model,
        complete: async () => {
          attempts.push(e.config.id);
          if (e.config.id === 'a') throw Object.assign(new Error('bad key'), { retryable: false, status: 401 });
          return {
            content: 'ok',
            toolCalls: [],
            finishReason: 'stop',
            usage: { promptTokens: 0, completionTokens: 0 },
            provider: 'b',
            model,
          };
        },
      }),
    });
    await r.complete(MESSAGES);
    expect(attempts).toEqual(['a', 'b']);
  });

  it('tries every model in a provider entry before moving on', async () => {
    const { router: r, attempts } = router([entry('a', ['fast', 'strong'])], { a: 2 });
    const response = await r.complete(MESSAGES);
    expect(response.content).toBe('from a');
    expect(attempts).toEqual(['a:fast', 'a:fast', 'a:strong']);
  });

  it('throws when every provider fails and records exhaustion', async () => {
    const { router: r, events } = router([entry('a')], { a: 99 });
    await expect(r.complete(MESSAGES)).rejects.toThrow(/all providers failed/);
    expect(events).toContain('exhausted:none');
  });

  it('throws when nothing is configured', async () => {
    const r = new ProviderRouter({ entries: [], factory: () => ({}) as never });
    await expect(r.complete(MESSAGES)).rejects.toThrow(/no model provider configured/);
  });
});

describe('provider presets', () => {
  it('every preset has the fields the client needs', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      expect(preset.defaultModel.length).toBeGreaterThan(0);
      expect(preset.id.length).toBeGreaterThan(0);
    }
  });

  it('finds a preset by id and returns undefined otherwise', () => {
    expect(findPreset('openrouter')?.label).toBe('OpenRouter');
    expect(findPreset('nope')).toBeUndefined();
  });
});

describe('github device flow', () => {
  function flowWith(responses: HttpResponse[]) {
    let index = 0;
    const platform = createMemoryPlatform({
      httpHandler: () => responses[Math.min(index++, responses.length - 1)],
    });
    return new GitHubDeviceFlow(platform, 'client-123');
  }

  it('starts a device flow and exposes the user code', async () => {
    const flow = flowWith([
      ok({ device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }),
    ]);
    const started = await flow.start();
    expect(started.userCode).toBe('ABCD-1234');
    expect(started.deviceCode).toBe('dev-1');
    expect(started.interval).toBe(5);
  });

  it('maps every poll outcome the UI has to handle', async () => {
    const cases: [unknown, string][] = [
      [{ error: 'authorization_pending' }, 'pending'],
      [{ error: 'slow_down' }, 'slow_down'],
      [{ error: 'expired_token' }, 'expired'],
      [{ error: 'access_denied' }, 'denied'],
      [{ error: 'weird' }, 'error'],
      [{ access_token: 'gho_abc', scope: 'repo' }, 'authorized'],
    ];
    for (const [body, expected] of cases) {
      const flow = flowWith([ok(body)]);
      const result = await flow.poll('dev-1');
      expect(result.status).toBe(expected);
    }
  });

  it('returns the token on success', async () => {
    const flow = flowWith([ok({ access_token: 'gho_abc', scope: 'repo workflow' })]);
    const result = await flow.poll('dev-1');
    expect(result.token).toBe('gho_abc');
    expect(result.scope).toBe('repo workflow');
  });

  it('distinguishes a transport failure from a pending poll', async () => {
    const flow = flowWith([{ status: 500, headers: {}, body: 'boom' }]);
    await expect(flow.start()).rejects.toThrow(/device flow start failed/);
  });
});
