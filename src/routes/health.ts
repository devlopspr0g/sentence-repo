import { Router } from 'express';
import { EMBEDDING_DIM, EMBEDDING_MODEL_REPO } from '../config';
import { embeddingService } from '../core/embeddings';
import { localManager } from '../core/localManager';
import { isSupabaseConfigured } from '../lib/supabase';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.round(process.uptime()),
    supabase_configured: isSupabaseConfigured(),
    embeddings: {
      model: EMBEDDING_MODEL_REPO,
      dimensions: EMBEDDING_DIM,
      loaded: embeddingService.isLoaded(),
    },
    local_models: { resident_text_models: localManager.residentTextModels() },
  });
});
