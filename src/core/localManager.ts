import { config } from '../config';
import { dynamicImport } from '../lib/esm';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';

/** Minimal shape shared by transformers.js pipelines. */
export type LocalPipeline = ((input: any, options?: any) => Promise<any>) & {
  dispose?: () => Promise<void>;
  tokenizer?: { encode: (text: string) => ArrayLike<number> };
};

type LoadedEntry = Promise<LocalPipeline>;

/**
 * Owns local transformers.js pipelines.
 * - Text-generation models are held in an LRU capped at `maxResidentTextModels` (2)
 *   so a request for a third model evicts and disposes the least recently used one.
 * - The speech model is a lazily-loaded singleton.
 */
export class LocalManager {
  private static instance: LocalManager | null = null;

  /** Map iteration order is insertion order; re-inserting on access gives LRU semantics. */
  private readonly textModels = new Map<string, LoadedEntry>();
  private readonly speechModels = new Map<string, LoadedEntry>();

  static getInstance(): LocalManager {
    if (!LocalManager.instance) LocalManager.instance = new LocalManager();
    return LocalManager.instance;
  }

  private constructor() {}

  residentTextModels(): string[] {
    return [...this.textModels.keys()];
  }

  async getTextGenerator(repo: string): Promise<LocalPipeline> {
    const existing = this.textModels.get(repo);
    if (existing) {
      this.textModels.delete(repo);
      this.textModels.set(repo, existing); // mark most recently used
      return existing;
    }

    while (this.textModels.size >= config.maxResidentTextModels) {
      const oldest = this.textModels.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.textModels.get(oldest);
      this.textModels.delete(oldest);
      await this.dispose(evicted);
    }

    const loading = this.load('text-generation', repo);
    this.textModels.set(repo, loading);
    loading.catch(() => this.textModels.delete(repo));
    return loading;
  }

  async getSpeechRecognizer(repo: string): Promise<LocalPipeline> {
    const existing = this.speechModels.get(repo);
    if (existing) return existing;
    const loading = this.load('automatic-speech-recognition', repo);
    this.speechModels.set(repo, loading);
    loading.catch(() => this.speechModels.delete(repo));
    return loading;
  }

  private async load(task: string, repo: string): LoadedEntry {
    const tf = await dynamicImport('@huggingface/transformers');
    tf.env.cacheDir = config.localModelCacheDir;
    const pipe = (await tf.pipeline(task, repo, { dtype: 'q8' })) as LocalPipeline;
    void this.recordLoad(repo, task);
    return pipe;
  }

  private async dispose(entry: LoadedEntry | undefined): Promise<void> {
    if (!entry) return;
    try {
      const pipe = await entry;
      await pipe.dispose?.();
    } catch {
      // a failed load has nothing to dispose
    }
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.textModels.values(), ...this.speechModels.values()];
    this.textModels.clear();
    this.speechModels.clear();
    await Promise.all(entries.map((e) => this.dispose(e)));
  }

  /** Best-effort bookkeeping in local_models_cache; never blocks or fails a request. */
  private async recordLoad(repo: string, task: string): Promise<void> {
    if (!isSupabaseConfigured()) return;
    try {
      await getSupabase()
        .from('local_models_cache')
        .upsert(
          {
            model_id: repo,
            hf_repo: repo,
            task,
            last_loaded_at: new Date().toISOString(),
          },
          { onConflict: 'model_id' },
        );
    } catch {
      // ignore
    }
  }
}

export const localManager = LocalManager.getInstance();
