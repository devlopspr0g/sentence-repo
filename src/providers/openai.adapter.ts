import { HttpError, upstreamError } from '../lib/errors';
import { readSSE } from '../lib/sse';
import { getCredentials, hasCredentials } from './credentials';
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  IAdapter,
  ModelInfo,
} from './types';

interface CompatOptions {
  name: string;
  defaultBaseUrl: string;
  /** Model-id prefixes this provider owns, e.g. ['gpt-', 'o1']. */
  prefixes: string[];
  models: string[];
}

/**
 * Adapter for any OpenAI-compatible `/chat/completions` API
 * (OpenAI, Groq, Together, ...). Requests and responses already use the
 * OpenAI shape, so this mostly forwards with credentials and prefix handling.
 */
export class OpenAICompatibleAdapter implements IAdapter {
  readonly name: string;
  private readonly defaultBaseUrl: string;
  private readonly prefixes: string[];
  private readonly models: string[];

  constructor(options: CompatOptions) {
    this.name = options.name;
    this.defaultBaseUrl = options.defaultBaseUrl;
    this.prefixes = [`${options.name}/`, ...options.prefixes];
    this.models = options.models;
  }

  supports(model: string): boolean {
    const m = model.toLowerCase();
    return this.prefixes.some((p) => m.startsWith(p));
  }

  isAvailable(userId?: string): Promise<boolean> {
    return hasCredentials(this.name, userId);
  }

  listModels(): ModelInfo[] {
    return this.models.map((id) => ({
      id,
      type: 'chat',
      source: 'cloud',
      provider: this.name,
      capabilities: { streaming: true },
    }));
  }

  private upstreamModel(model: string): string {
    const prefix = `${this.name}/`;
    return model.toLowerCase().startsWith(prefix) ? model.slice(prefix.length) : model;
  }

  private buildBody(request: ChatCompletionRequest, model: string, stream: boolean): string {
    const body: Record<string, unknown> = { model, messages: request.messages, stream };
    const reasoning = this.name === 'openai' && /^o\d/.test(model);
    if (!reasoning && request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.max_tokens !== undefined) {
      body[reasoning ? 'max_completion_tokens' : 'max_tokens'] = request.max_tokens;
    }
    if (request.stop !== undefined) body.stop = request.stop;
    return JSON.stringify(body);
  }

  private async post(request: ChatCompletionRequest, stream: boolean): Promise<Response> {
    const { apiKey, baseUrl } = await getCredentials(this.name, request.userId);
    const model = this.upstreamModel(request.model);
    const base = baseUrl ?? this.defaultBaseUrl;
    if (!base) {
      throw new HttpError(
        400,
        `Provider "${this.name}" needs a base_url; set one with POST /v1/keys`,
        'invalid_request_error',
        'missing_base_url',
      );
    }
    const url = `${base.replace(/\/$/, '')}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(stream ? { Accept: 'text/event-stream' } : {}),
        },
        body: this.buildBody(request, model, stream),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `Could not reach provider "${this.name}": ${reason}`, 'upstream_error', 'upstream_unreachable');
    }
    if (!res.ok) throw await upstreamError(this.name, res);
    return res;
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const res = await this.post(request, false);
    const json = (await res.json()) as ChatCompletionResponse;
    return {
      ...json,
      sentence: { provider: this.name, model: this.upstreamModel(request.model), fallback: false },
    };
  }

  async *chatStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.post(request, true);
    for await (const msg of readSSE(res)) {
      if (msg.data === '[DONE]') return;
      try {
        yield JSON.parse(msg.data) as ChatCompletionChunk;
      } catch {
        // ignore keep-alive or malformed fragments
      }
    }
  }
}

export const openaiAdapter = new OpenAICompatibleAdapter({
  name: 'openai',
  defaultBaseUrl: 'https://api.openai.com/v1',
  prefixes: ['gpt-', 'chatgpt-', 'o1', 'o3', 'o4'],
  models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
});

export const groqAdapter = new OpenAICompatibleAdapter({
  name: 'groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  prefixes: ['llama-', 'llama3', 'mixtral-', 'gemma'],
  models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
});

export const togetherAdapter = new OpenAICompatibleAdapter({
  name: 'together',
  defaultBaseUrl: 'https://api.together.xyz/v1',
  prefixes: [],
  models: ['together/meta-llama/Llama-3.3-70B-Instruct-Turbo'],
});
