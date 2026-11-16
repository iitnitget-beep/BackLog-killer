import type { ProviderConfig } from './types';

/**
 * Presets for the Settings screen. All of them speak the OpenAI
 * /chat/completions shape, so the user can also paste any custom gateway.
 */
export const PROVIDER_PRESETS: ProviderConfig[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'qwen/qwen3-coder:free',
    headers: { 'HTTP-Referer': 'https://github.com/iitnitget-beep/BackLog-killer', 'X-Title': 'ForgeX' },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'gemini',
    label: 'Google Gemini (OpenAI compat)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
  },
  {
    id: 'qwen',
    label: 'Qwen (DashScope)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3-coder-plus',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'qwen/qwen3-32b',
  },
  {
    id: 'ollama',
    label: 'Local (Ollama / LM Studio)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5-coder:7b',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    baseUrl: 'https://example.com/v1',
    defaultModel: 'model-name',
  },
];

export function findPreset(id: string): ProviderConfig | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}
