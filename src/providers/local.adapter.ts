import { EMBEDDING_DIM, EMBEDDING_MODEL_REPO } from '../config';
import { EmbeddingService } from '../core/embeddings';
import { LocalManager, LocalPipeline } from '../core/localManager';
import { HttpError } from '../lib/errors';
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  IAdapter,
  ModelInfo,
  TranscriptionRequest,
  TranscriptionResponse,
} from './types';
import {
  applyStop,
  chunkWords,
  completionId,
  estimateTokens,
  makeChunk,
  nowSeconds,
} from './util';

interface LocalModelSpec {
  repo: string;
  type: 'chat' | 'embedding' | 'audio';
}

export const LOCAL_MODELS: Record<string, LocalModelSpec> = {
  'local-all-minilm-l6-v2': { repo: EMBEDDING_MODEL_REPO, type: 'embedding' },
  'local-whisper-tiny': { repo: 'Xenova/whisper-tiny', type: 'audio' },
  'local-qwen2-0.5b-instruct': { repo: 'Xenova/Qwen2-0.5B-Instruct', type: 'chat' },
};

const DEFAULT_MAX_NEW_TOKENS = 256;

function countTokens(pipe: LocalPipeline, text: string): number {
  try {
    if (pipe.tokenizer) return pipe.tokenizer.encode(text).length;
  } catch {
    // fall through to estimate
  }
  return estimateTokens(text);
}

function extractGeneratedText(output: any): string {
  const first = Array.isArray(output) ? output[0] : output;
  const generated = first?.generated_text;
  if (typeof generated === 'string') return generated;
  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1];
    if (last && typeof last.content === 'string') return last.content;
  }
  return '';
}

export class LocalAdapter implements IAdapter {
  readonly name = 'local';
  private readonly manager = LocalManager.getInstance();
  private readonly embedder = EmbeddingService.getInstance();

  supports(model: string): boolean {
    return model.startsWith('local-');
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  listModels(): ModelInfo[] {
    return [
      {
        id: 'local-all-minilm-l6-v2',
        type: 'embedding',
        source: 'transformers.js',
        provider: 'local',
        capabilities: { dimensions: EMBEDDING_DIM, pooling: 'mean', normalize: true },
      },
      {
        id: 'local-whisper-tiny',
        type: 'audio',
        source: 'transformers.js',
        provider: 'local',
        capabilities: { transcription: true },
      },
      {
        id: 'local-qwen2-0.5b-instruct',
        type: 'chat',
        source: 'transformers.js',
        provider: 'local',
        capabilities: { streaming: true, simulated_streaming: true },
      },
    ];
  }

  private spec(model: string, expected: LocalModelSpec['type']): LocalModelSpec {
    const spec = LOCAL_MODELS[model];
    if (!spec) {
      throw new HttpError(404, `Unknown local model "${model}"`, 'invalid_request_error', 'model_not_found');
    }
    if (spec.type !== expected) {
      throw new HttpError(
        400,
        `Model "${model}" is a ${spec.type} model and cannot be used for ${expected}`,
        'invalid_request_error',
        'model_type_mismatch',
      );
    }
    return spec;
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const spec = this.spec(request.model, 'chat');

    let generator: LocalPipeline;
    try {
      generator = await this.manager.getTextGenerator(spec.repo);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new HttpError(
        503,
        `Local engine for "${request.model}" is unavailable: ${reason}`,
        'api_error',
        'local_engine_unavailable',
      );
    }

    const maxNewTokens = request.max_tokens ?? DEFAULT_MAX_NEW_TOKENS;
    const temperature = request.temperature ?? 0.7;
    const options: Record<string, unknown> = {
      max_new_tokens: maxNewTokens,
      return_full_text: false,
      do_sample: temperature > 0,
    };
    if (temperature > 0) options.temperature = temperature;
    if (request.top_p !== undefined) options.top_p = request.top_p;

    const messages = request.messages.map((m) => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: m.content,
    }));

    let raw: string;
    try {
      raw = extractGeneratedText(await generator(messages, options));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new HttpError(500, `Local generation failed: ${reason}`, 'api_error', 'local_generation_failed');
    }

    const content = applyStop(raw, request.stop).trim();
    const promptTokens = countTokens(generator, messages.map((m) => m.content).join('\n'));
    const completionTokens = countTokens(generator, content);

    return {
      id: completionId(),
      object: 'chat.completion',
      created: nowSeconds(),
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: completionTokens >= maxNewTokens ? 'length' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      sentence: { provider: 'local', model: request.model, fallback: false },
    };
  }

  /** Word-chunked stream in the OpenAI `chat.completion.chunk` format. */
  async *chatStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    const full = await this.chat({ ...request, stream: false });
    const { id, created, model } = full;
    const choice = full.choices[0];

    yield makeChunk(id, created, model, { role: 'assistant', content: '' });
    for (const piece of chunkWords(choice.message.content)) {
      yield makeChunk(id, created, model, { content: piece });
    }
    yield makeChunk(id, created, model, {}, choice.finish_reason);
  }

  async embeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    this.spec(request.model, 'embedding');
    const inputs = Array.isArray(request.input) ? request.input : [request.input];
    const vectors = await this.embedder.generateEmbeddings(inputs);
    const tokens = inputs.reduce((sum, text) => sum + estimateTokens(text), 0);
    return {
      object: 'list',
      data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
      model: request.model,
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    };
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse> {
    const spec = this.spec(request.model, 'audio');
    let recognizer: LocalPipeline;
    try {
      recognizer = await this.manager.getSpeechRecognizer(spec.repo);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new HttpError(
        503,
        `Local engine for "${request.model}" is unavailable: ${reason}`,
        'api_error',
        'local_engine_unavailable',
      );
    }
    const options: Record<string, unknown> = { task: 'transcribe', chunk_length_s: 30 };
    if (request.language) options.language = request.language;
    const result = await recognizer(request.audio, options);
    const text = Array.isArray(result) ? result[0]?.text : result?.text;
    return { text: typeof text === 'string' ? text.trim() : '' };
  }
}

export const localAdapter = new LocalAdapter();
