import 'dotenv/config';

/** Immutable embedding contract: every vector in Sentence is Xenova/all-MiniLM-L6-v2, 384-dim. */
export const EMBEDDING_MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: toInt(process.env.PORT, 3000),
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  providerEncryptionKey: process.env.PROVIDER_ENCRYPTION_KEY ?? '',
  providerEnvKeys: {
    openai: process.env.OPENAI_API_KEY ?? '',
    anthropic: process.env.ANTHROPIC_API_KEY ?? '',
    gemini: process.env.GEMINI_API_KEY ?? '',
    groq: process.env.GROQ_API_KEY ?? '',
    together: process.env.TOGETHER_API_KEY ?? '',
  } as Record<string, string>,
  autoPrimaryModel: process.env.AUTO_PRIMARY_MODEL ?? 'gpt-4o-mini',
  autoFallbackModel: 'local-qwen2-0.5b-instruct',
  localModelCacheDir: process.env.LOCAL_MODEL_CACHE_DIR ?? './.cache/models',
  maxResidentTextModels: 2,
  maxSyncBatch: 100,
  maxEmbeddingInputs: 128,
  /** Model used to write rolling topic summaries ("auto" = primary cloud model, local fallback). */
  summaryModel: process.env.SUMMARY_MODEL ?? 'auto',
  summaryEveryMessages: toInt(process.env.SUMMARY_EVERY_MESSAGES, 6),
  whisperMaxChars: toInt(process.env.WHISPER_MAX_CHARS, 4000),
  whisperTimelineHours: toInt(process.env.WHISPER_TIMELINE_HOURS, 48),
  /** Minimum cosine similarity for a new message to join an existing topic. */
  topicMatchThreshold: 0.5,
  /** When false, users must bring their own provider keys (no fallback to server keys). */
  allowServerKeys: (process.env.ALLOW_SERVER_KEYS ?? 'true').toLowerCase() === 'true',
  preloadEmbeddings: (process.env.PRELOAD_EMBEDDINGS ?? 'false').toLowerCase() === 'true',
} as const;
