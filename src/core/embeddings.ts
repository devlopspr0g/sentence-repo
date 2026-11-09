import { config, EMBEDDING_DIM, EMBEDDING_MODEL_REPO } from '../config';
import { dynamicImport } from '../lib/esm';

type Extractor = (
  input: string | string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: ArrayLike<number>; dims: number[] }>;

/**
 * Singleton server-side embedding engine.
 * Model: Xenova/all-MiniLM-L6-v2, mean pooling, L2-normalised, exactly 384 dims.
 */
export class EmbeddingService {
  private static instance: EmbeddingService | null = null;
  private extractor: Promise<Extractor> | null = null;
  private loaded = false;

  static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) EmbeddingService.instance = new EmbeddingService();
    return EmbeddingService.instance;
  }

  private constructor() {}

  isLoaded(): boolean {
    return this.loaded;
  }

  /** Load the model (idempotent; concurrent callers share one load). */
  async init(): Promise<void> {
    await this.getExtractor();
  }

  private getExtractor(): Promise<Extractor> {
    if (!this.extractor) {
      this.extractor = (async () => {
        const tf = await dynamicImport('@huggingface/transformers');
        tf.env.cacheDir = config.localModelCacheDir;
        // `quantized: true` is the spec'd option; `dtype: 'q8'` is its v3 equivalent.
        const pipe = (await tf.pipeline('feature-extraction', EMBEDDING_MODEL_REPO, {
          quantized: true,
          dtype: 'q8',
        })) as Extractor;
        this.loaded = true;
        return pipe;
      })().catch((err: unknown) => {
        this.extractor = null; // allow retry after a failed load
        throw err;
      });
    }
    return this.extractor;
  }

  /** Returns a normalised vector of exactly 384 numbers. */
  async generateEmbedding(text: string): Promise<number[]> {
    const extractor = await this.getExtractor();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data as ArrayLike<number>);
    EmbeddingService.assertDimensions(vector);
    return vector;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const text of texts) vectors.push(await this.generateEmbedding(text));
    return vectors;
  }

  /** True when `value` is an array of exactly 384 finite numbers. */
  static isValidEmbedding(value: unknown): value is number[] {
    return (
      Array.isArray(value) &&
      value.length === EMBEDDING_DIM &&
      value.every((n) => typeof n === 'number' && Number.isFinite(n))
    );
  }

  /** Throws if the vector is not exactly 384 finite numbers. */
  static assertDimensions(vector: number[]): void {
    if (vector.length !== EMBEDDING_DIM) {
      throw new Error(
        `Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${vector.length}`,
      );
    }
    if (!vector.every((n) => Number.isFinite(n))) {
      throw new Error('Embedding contains non-finite values');
    }
  }
}

export const embeddingService = EmbeddingService.getInstance();
