import { config } from '../config';
import { HttpError } from '../lib/errors';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';
import { anthropicAdapter } from '../providers/anthropic.adapter';
import { geminiAdapter } from '../providers/gemini.adapter';
import { localAdapter } from '../providers/local.adapter';
import {
  groqAdapter,
  OpenAICompatibleAdapter,
  openaiAdapter,
  togetherAdapter,
} from '../providers/openai.adapter';
import { PROVIDER_PRESETS } from '../providers/presets';
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  IAdapter,
  ModelInfo,
} from '../providers/types';

const REGISTRY_TTL_MS = 60_000;

interface RegistryHit {
  source: string | null;
  providerName: string | null;
  expires: number;
}

export class ModelRouter {
  private readonly cloud: IAdapter[];
  private readonly registryCache = new Map<string, RegistryHit>();
  private readonly dynamic = new Map<string, IAdapter>();

  /**
   * Adapter for any other OpenAI-compatible service, addressed as `<provider>/<model>`.
   * Presets (openrouter, mistral, deepseek, ...) have a built-in URL; any other name needs
   * the user to store a key with a public https `base_url` (POST /v1/keys).
   */
  private dynamicAdapter(provider: string): IAdapter {
    let adapter = this.dynamic.get(provider);
    if (!adapter) {
      adapter = new OpenAICompatibleAdapter({
        name: provider,
        defaultBaseUrl: PROVIDER_PRESETS[provider] ?? '',
        prefixes: [],
        models: [],
      });
      this.dynamic.set(provider, adapter);
    }
    return adapter;
  }

  constructor(
    cloudAdapters: IAdapter[] = [
      openaiAdapter,
      anthropicAdapter,
      geminiAdapter,
      groqAdapter,
      togetherAdapter,
    ],
  ) {
    this.cloud = cloudAdapters;
  }

  /** Look up a model in models_registry (best-effort; null when absent or DB unavailable). */
  private async registryLookup(model: string): Promise<RegistryHit | null> {
    const cached = this.registryCache.get(model);
    if (cached && cached.expires > Date.now()) return cached;
    if (!isSupabaseConfigured()) return null;
    try {
      const { data } = await getSupabase()
        .from('models_registry')
        .select('source, providers(name)')
        .eq('model_id', model)
        .maybeSingle();
      if (!data) return null;
      const providers = (data as { providers?: { name?: string } | Array<{ name?: string }> | null })
        .providers;
      const providerName = Array.isArray(providers) ? providers[0]?.name : providers?.name;
      const hit: RegistryHit = {
        source: (data as { source?: string | null }).source ?? null,
        providerName: providerName ?? null,
        expires: Date.now() + REGISTRY_TTL_MS,
      };
      this.registryCache.set(model, hit);
      return hit;
    } catch {
      return null;
    }
  }

  /** Pick the adapter that owns `model`. */
  async resolve(model: string): Promise<IAdapter> {
    // 1. local-* ids always go straight to the local adapter.
    if (localAdapter.supports(model)) return localAdapter;

    // 2. Known provider prefixes.
    const byPrefix = this.cloud.find((a) => a.supports(model));
    if (byPrefix) return byPrefix;

    // 3. models_registry (source === 'transformers.js' routes local; otherwise by provider name).
    const hit = await this.registryLookup(model);
    if (hit) {
      if (hit.source === 'transformers.js') return localAdapter;
      const byName = this.cloud.find((a) => a.name === hit.providerName);
      if (byName) return byName;
    }

    // 4. `<provider>/<model>` for any OpenAI-compatible service. A missing key surfaces
    //    as a clear 503 ("add yours with POST /v1/keys") when the call is made.
    const slash = model.indexOf('/');
    if (slash > 0) {
      const provider = model.slice(0, slash).toLowerCase();
      if (/^[a-z0-9_-]{2,40}$/.test(provider)) return this.dynamicAdapter(provider);
    }

    throw new HttpError(
      404,
      `Model "${model}" was not found. Use a provider-prefixed id (e.g. "groq/..."), a "local-*" model, or "auto".`,
      'invalid_request_error',
      'model_not_found',
    );
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (request.model !== 'auto') {
      const adapter = await this.resolve(request.model);
      return adapter.chat(request);
    }

    try {
      const adapter = await this.resolve(config.autoPrimaryModel);
      return await adapter.chat({ ...request, model: config.autoPrimaryModel });
    } catch (primaryError) {
      const reason = primaryError instanceof Error ? primaryError.message : String(primaryError);
      console.warn(`[router] auto: primary "${config.autoPrimaryModel}" failed (${reason}); using local fallback`);
      const response = await localAdapter.chat({ ...request, model: config.autoFallbackModel });
      return {
        ...response,
        sentence: { provider: 'local', model: config.autoFallbackModel, fallback: true },
      };
    }
  }

  async *chatStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    if (request.model !== 'auto') {
      const adapter = await this.resolve(request.model);
      yield* adapter.chatStream(request);
      return;
    }

    // Auto: only fall back if the primary fails before any chunk reaches the client.
    let started = false;
    try {
      const adapter = await this.resolve(config.autoPrimaryModel);
      const iterator = adapter
        .chatStream({ ...request, model: config.autoPrimaryModel })
        [Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        started = true;
        yield next.value;
      }
    } catch (primaryError) {
      if (started) throw primaryError;
      const reason = primaryError instanceof Error ? primaryError.message : String(primaryError);
      console.warn(`[router] auto(stream): primary failed (${reason}); using local fallback`);
    }
    yield* localAdapter.chatStream({ ...request, model: config.autoFallbackModel });
  }

  /** Provider name that will serve `model` ("auto" reports its primary cloud model's provider). */
  async providerName(model: string): Promise<string> {
    try {
      return (await this.resolve(model === 'auto' ? config.autoPrimaryModel : model)).name;
    } catch {
      return 'unknown';
    }
  }

  /** Models visible to a user: local always, cloud only when credentials exist for them. */
  async listModels(userId?: string): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [
      {
        id: 'auto',
        type: 'chat',
        source: 'cloud',
        provider: 'sentence',
        capabilities: { fallback: config.autoFallbackModel, primary: config.autoPrimaryModel },
      },
      ...localAdapter.listModels(),
    ];
    const availability = await Promise.all(this.cloud.map((a) => a.isAvailable(userId)));
    this.cloud.forEach((adapter, i) => {
      if (availability[i]) models.push(...adapter.listModels());
    });
    return models;
  }
}

export const router = new ModelRouter();
