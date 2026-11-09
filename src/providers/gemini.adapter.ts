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

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function mapFinish(reason: string | undefined): FinishReason {
  if (!reason) return null;
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  return 'content_filter';
}

const textOf = (r: GeminiResponse): string =>
  (r.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');

export class GeminiAdapter implements IAdapter {
  readonly name = 'gemini';

  supports(model: string): boolean {
    const m = model.toLowerCase();
    return m.startsWith('gemini') || m.startsWith('google/') || m.startsWith('gemini/');
  }

  isAvailable(userId?: string): Promise<boolean> {
    return hasCredentials(this.name, userId);
  }

  listModels(): ModelInfo[] {
    return ['gemini-2.5-flash', 'gemini-2.5-pro'].map((id) => ({
      id,
      type: 'chat' as const,
      source: 'cloud' as const,
      provider: this.name,
      capabilities: { streaming: true },
    }));
  }

  private upstreamModel(model: string): string {
    return model.replace(/^(google|gemini)\//i, '');
  }

  private buildBody(request: ChatCompletionRequest): string {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
    if (contents.length === 0) {
      throw new HttpError(400, 'At least one non-system message is required', 'invalid_request_error', 'invalid_messages');
    }

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.top_p !== undefined) generationConfig.topP = request.top_p;
    if (request.max_tokens !== undefined) generationConfig.maxOutputTokens = request.max_tokens;
    const stops = normalizeStop(request.stop);
    if (stops.length) generationConfig.stopSequences = stops;

    const body: Record<string, unknown> = { contents, generationConfig };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return JSON.stringify(body);
  }

  private async post(request: ChatCompletionRequest, stream: boolean): Promise<Response> {
    const { apiKey, baseUrl } = await getCredentials(this.name, request.userId);
    const model = this.upstreamModel(request.model);
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:${method}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: this.buildBody(request),
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `Could not reach provider "gemini": ${reason}`, 'upstream_error', 'upstream_unreachable');
    }
    if (!res.ok) throw await upstreamError(this.name, res);
    return res;
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const res = await this.post(request, false);
    const json = (await res.json()) as GeminiResponse;
    const promptTokens = json.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = json.usageMetadata?.candidatesTokenCount ?? 0;
    const model = this.upstreamModel(request.model);
    return {
      id: completionId(),
      object: 'chat.completion',
      created: nowSeconds(),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: textOf(json) },
          finish_reason: mapFinish(json.candidates?.[0]?.finishReason) ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      sentence: { provider: this.name, model, fallback: false },
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
      let json: GeminiResponse;
      try {
        json = JSON.parse(msg.data) as GeminiResponse;
      } catch {
        continue;
      }
      const text = textOf(json);
      if (text) yield makeChunk(id, created, model, { content: text });
      finish = mapFinish(json.candidates?.[0]?.finishReason) ?? finish;
    }
    yield makeChunk(id, created, model, {}, finish);
  }
}

export const geminiAdapter = new GeminiAdapter();
