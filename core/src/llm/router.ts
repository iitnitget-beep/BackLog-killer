import type { LlmClient, CompletionRequest, CompletionResponse, ProviderConfig } from './types';

export interface ProviderEntry {
  config: ProviderConfig;
  apiKey: string;
  models?: string[];
}

export interface RouterEvent {
  type: 'attempt' | 'fallback' | 'success' | 'exhausted';
  provider: string;
  model?: string;
  detail?: string;
}

export interface RouterOptions {
  entries: ProviderEntry[];
  /** Injected factory so tests can avoid real HTTP. */
  factory: (entry: ProviderEntry, model: string) => LlmClient;
  onEvent?: (event: RouterEvent) => void;
  /** Attempts per provider before falling back. */
  attemptsPerProvider?: number;
}

/**
 * Provider fallback (spec §4): on a rate limit, a 5xx or a network error we
 * retry the same provider once, then move to the next configured provider.
 * Auth errors are surfaced immediately because another provider would not fix
 * a bad key.
 */
export class ProviderRouter {
  private index = 0;
  private readonly events: RouterEvent[] = [];

  constructor(private readonly options: RouterOptions) {}

  history(): RouterEvent[] {
    return [...this.events];
  }

  get activeProvider(): string | undefined {
    return this.options.entries[this.index]?.config.id;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const entries = this.options.entries;
    if (entries.length === 0) throw new Error('no model provider configured');
    const attemptsPerProvider = this.options.attemptsPerProvider ?? 2;
    const errors: string[] = [];
    for (let offset = 0; offset < entries.length; offset += 1) {
      const entry = entries[(this.index + offset) % entries.length];
      const models = entry.models?.length ? entry.models : [entry.config.defaultModel];
      for (const model of models) {
        const client = this.options.factory(entry, model);
        for (let attempt = 0; attempt < attemptsPerProvider; attempt += 1) {
          try {
            this.emit({ type: 'attempt', provider: entry.config.id, model, detail: `attempt ${attempt + 1}` });
            const response = await client.complete(request);
            this.index = (this.index + offset) % entries.length;
            this.emit({ type: 'success', provider: entry.config.id, model });
            return response;
          } catch (error) {
            const err = error as { retryable?: boolean; message?: string; status?: number };
            errors.push(`${entry.config.id}/${model}: ${err.message ?? String(error)}`);
            const retryable = err.retryable !== false;
            this.emit({
              type: 'fallback',
              provider: entry.config.id,
              model,
              detail: `${err.status ?? 'n/a'} retryable=${retryable}`,
            });
            if (!retryable) break;
          }
        }
      }
    }
    this.emit({ type: 'exhausted', provider: 'none', detail: errors.join(' | ').slice(0, 1000) });
    throw new Error(`all providers failed: ${errors.slice(0, 4).join(' | ')}`);
  }

  private emit(event: RouterEvent): void {
    this.events.push(event);
    this.options.onEvent?.(event);
  }
}
