import { HttpError } from '../lib/errors';
import { getSupabase, toPgVector } from '../lib/supabase';
import { EmbeddingService, embeddingService } from './embeddings';

export interface SearchOptions {
  userId: string;
  /** Natural-language query; embedded server-side with the 384-dim model. */
  query?: string;
  /** Pre-computed 384-dim query vector (alternative to `query`). */
  embedding?: number[];
  limit?: number;
  threshold?: number;
}

export interface SearchHit {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  similarity: number;
}

/** Cosine similarity search over `documents` (`embedding <=> query_embedding`). */
export async function searchDocuments(options: SearchOptions): Promise<SearchHit[]> {
  let vector: number[];
  if (options.embedding) {
    if (!EmbeddingService.isValidEmbedding(options.embedding)) {
      throw new HttpError(
        422,
        'Query embedding must be exactly 384 finite numbers (Xenova/all-MiniLM-L6-v2)',
        'invalid_request_error',
        'invalid_embedding_dimensions',
      );
    }
    vector = options.embedding;
  } else if (options.query) {
    vector = await embeddingService.generateEmbedding(options.query);
  } else {
    throw new HttpError(400, 'Provide "query" or "embedding"', 'invalid_request_error', 'missing_query');
  }

  const { data, error } = await getSupabase().rpc('match_documents', {
    query_embedding: toPgVector(vector),
    match_count: options.limit ?? 5,
    match_threshold: options.threshold ?? 0,
    filter_user_id: options.userId,
  });

  if (error) {
    throw new HttpError(500, `Vector search failed: ${error.message}`, 'api_error', 'search_failed');
  }
  return (data ?? []) as SearchHit[];
}
