import { HttpError, upstreamError } from '../lib/errors';
import { readSSE } from '../lib/sse';
import { getCredentials, hasCredentials } from './credentials';
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  FinishReason,
  IAdapter,
  ModelInfo,
} from './types';
import { completionId, makeChunk, normalizeStop, nowSeconds } from './util';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

function mapStopReason(reason: string | null | undefined): FinishReason {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'refusal') return 'content_filter';
  return reason ? 'stop' : null;
}

export class AnthropicAdapter implements IAdapter {
  readonly name = 'anthropic';

  supports(model: string): boolean {
    const m = model.toLowerCase();
    return m.startsWith('claude') || m.startsWith('anthropic/');
  }

  isAvailable(userId?: string): Promise<boolean> {
    return hasCredentials(this.name, userId);
  }

  listModels(): ModelInfo[] {
    return ['claude-sonnet-4-5', 'claude-haiku-4-5'].map((id) => ({
      id,
      type: 'chat' as const,
      source: 'cloud' as const,
      provider: this.name,
      capabilities: { streaming: true },
    }));
  }

  private upstreamModel(model: string): string {
    return model.toLowerCase().startsWith('anthropic/') ? model.slice('anthropic/'.length) : model;
  }

  private buildBody(request: ChatCompletionRequest, stream: boolean): string {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages: AnthropicMessage[] = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

    if (messages.length === 0) {
      throw new HttpError(400, 'At least one non-system message is required', 'invalid_request_error', 'invalid_messages');
    }

    const body: Record<string, unknown> = {
      model: this.upstreamModel(request.model),
      messages,
      max_tokens: request.max_tokens ?? DEFAULT_MAX_TOKENS,
      stream,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = Math.min(request.temperature, 1);
    if (request.top_p !== undefined) body.top_p = request.top_p;
    const stops = normalizeStop(request.stop);
    if (stops.length) body.stop_sequences = stops;
    return JSON.stringify(body);
  }

  private async post(request: ChatCompletionRequest, stream: boolean): Promise<Response> {
    const { apiKey, baseUrl } = await getCredentials(this.name, request.userId);
    let res: Response;
    try {
      res = await fetch(`${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: this.buildBody(request, stream),
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `Could not reach provider "anthropic": ${reason}`, 'upstream_error', 'upstream_unreachable');
    }
    if (!res.ok) throw await upstreamError(this.name, res);
    return res;
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const res = await this.post(request, false);
    const json = (await res.json()) as {
      id: string;
      model: string;
      content: Array<{ type: string; text?: string }>;
      stop_reason: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = json.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const promptTokens = json.usage?.input_tokens ?? 0;
    const completionTokens = json.usage?.output_tokens ?? 0;
    return {
      id: json.id ? `chatcmpl-${json.id}` : completionId(),
      object: 'chat.completion',
      created: nowSeconds(),
      model: json.model ?? request.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: mapStopReason(json.stop_reason) ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      sentence: { provider: this.name, model: this.upstreamModel(request.model), fallback: false },
    };
  }

  async *chatStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.post(request, true);
    const id = completionId();
    const created = nowSeconds();
    const model = this.upstreamModel(request.model);
    let finish: FinishReason = 'stop';

    yield makeChunk(id, created, model, { role: 'assistant', content: '' });

    for await (const msg of readSSE(res)) {
      let event: any;
      try {
        event = JSON.parse(msg.data);
      } catch {
        continue;
      }
      switch (event.type) {
        case 'content_block_delta':
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            yield makeChunk(id, created, model, { content: event.delta.text as string });
          }
          break;
        case 'message_delta':
          finish = mapStopReason(event.delta?.stop_reason) ?? finish;
          break;
        case 'error':
          throw new HttpError(
            502,
            `Upstream provider "anthropic" stream error: ${event.error?.message ?? 'unknown'}`,
            'upstream_error',
            'upstream_stream_error',
          );
        case 'message_stop':
          yield makeChunk(id, created, model, {}, finish);
          return;
        default:
          break;
      }
    }
    yield makeChunk(id, created, model, {}, finish);
  }
}

export const anthropicAdapter = new AnthropicAdapter();
