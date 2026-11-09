import { createApp } from './app';
import { config } from './config';
import { embeddingService } from './core/embeddings';
import { failOrphanedJobs } from './core/jobs';
import { localManager } from './core/localManager';
import { isSupabaseConfigured } from './lib/supabase';

async function main(): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.warn('[sentence] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: /v1 routes will return 503');
  }

  if (config.preloadEmbeddings) {
    console.log('[sentence] preloading Xenova/all-MiniLM-L6-v2 ...');
    await embeddingService.init();
  }

  if (isSupabaseConfigured()) {
    await failOrphanedJobs().catch((err: unknown) =>
      console.warn('[sentence] could not clean up unfinished jobs:', err instanceof Error ? err.message : err),
    );
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[sentence] listening on http://localhost:${config.port}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[sentence] ${signal} received, shutting down`);
    server.close(() => {
      void localManager.disposeAll().finally(() => process.exit(0));
    });
    const forceExit = setTimeout(() => process.exit(1), 10_000) as unknown as { unref?: () => void };
    forceExit.unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[sentence] fatal startup error', err);
  process.exit(1);
});
