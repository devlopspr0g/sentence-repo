/** Providers with a built-in adapter. */
export const KNOWN_PROVIDERS = ['openai', 'anthropic', 'gemini', 'groq', 'together'] as const;

/**
 * OpenAI-compatible providers reachable with just an API key.
 * Use them as `<provider>/<upstream-model>`, e.g. `openrouter/anthropic/claude-3.5-sonnet`
 * or `mistral/mistral-large-latest`. Any other OpenAI-compatible service works too:
 * store its key together with a public https `base_url` via POST /v1/keys.
 */
export const PROVIDER_PRESETS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  xai: 'https://api.x.ai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  perplexity: 'https://api.perplexity.ai',
  cerebras: 'https://api.cerebras.ai/v1',
};
