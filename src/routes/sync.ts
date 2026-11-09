import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { EmbeddingService, embeddingService } from '../core/embeddings';
import { getSupabase, toPgVector } from '../lib/supabase';
import { asyncHandler } from '../middleware/async';
import { requireAuth } from '../middleware/auth';

const itemSchema = z.object({
  client_id: z.string().min(1).max(200),
  content: z.string().min(1).max(100_000),
  /** Client-computed vector; re-embedded server-side when it is not exactly 384 finite numbers. */
  embedding: z.array(z.number()).optional(),
  metadata: z.record(z.unknown()).optional(),
  created_at: z.string().optional(),
});

const bodySchema = z.object({
  items: z.array(itemSchema).min(1).max(config.maxSyncBatch),
});

interface ItemResult {
  client_id: string;
  status: 'synced' | 'failed';
  document_id?: string;
  re_embedded?: boolean;
  duplicate?: boolean;
  error?: string;
}

export const syncRouter = Router();

syncRouter.post(
  '/sync/batch',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const { items } = bodySchema.parse(req.body);
    const supabase = getSupabase();
    const results: ItemResult[] = [];

    for (const item of items) {
      try {
        // Idempotency: skip anything already synced for this client_id.
        const { data: existing } = await supabase
          .from('embedding_queue')
          .select('status')
          .eq('user_id', userId)
          .eq('client_id', item.client_id)
          .maybeSingle();
        if (existing?.status === 'synced') {
          results.push({ client_id: item.client_id, status: 'synced', duplicate: true });
          continue;
        }

        // Enforce the 384-dim contract: accept valid vectors, otherwise re-embed.
        let vector: number[];
        let reEmbedded = false;
        if (EmbeddingService.isValidEmbedding(item.embedding)) {
          vector = item.embedding;
        } else {
          vector = await embeddingService.generateEmbedding(item.content);
          reEmbedded = true;
        }

        const { data: doc, error: docError } = await supabase
          .from('documents')
          .insert({
            user_id: userId,
            content: item.content,
            embedding: toPgVector(vector),
            metadata: { ...(item.metadata ?? {}), client_id: item.client_id },
            ...(item.created_at ? { created_at: item.created_at } : {}),
          })
          .select('id')
          .single();
        if (docError || !doc) throw new Error(docError?.message ?? 'document insert failed');

        const { error: queueError } = await supabase.from('embedding_queue').upsert(
          {
            client_id: item.client_id,
            user_id: userId,
            content: item.content,
            embedding: toPgVector(vector),
            status: 'synced',
            synced_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,client_id' },
        );
        if (queueError) throw new Error(queueError.message);

        results.push({
          client_id: item.client_id,
          status: 'synced',
          document_id: doc.id as string,
          re_embedded: reEmbedded,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ client_id: item.client_id, status: 'failed', error: message });
        await Promise.resolve(
          supabase.from('embedding_queue').upsert(
            {
              client_id: item.client_id,
              user_id: userId,
              content: item.content,
              status: 'failed',
            },
            { onConflict: 'user_id,client_id' },
          ),
        ).catch(() => undefined);
      }
    }

    const synced = results.filter((r) => r.status === 'synced').length;
    const failed = results.length - synced;

    await Promise.resolve(
      supabase.from('sync_logs').insert({
        user_id: userId,
        received: items.length,
        accepted: synced,
        rejected: failed,
        details: results.filter((r) => r.status === 'failed'),
      }),
    ).catch(() => undefined);

    res.status(200).json({ object: 'sync.result', synced, failed, results });
  }),
);
