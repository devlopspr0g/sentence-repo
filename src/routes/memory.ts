import { Router } from 'express';
import { z } from 'zod';
import { EmbeddingService, embeddingService } from '../core/embeddings';
import {
  AccessPolicy,
  deriveTopicName,
  ensureConversation,
  ensureLink,
  findTopicSemantic,
  getConversation,
  getOrCreateTopic,
  insertMessages,
  loadPolicy,
  setConversationTopic,
} from '../core/memory';
import { router as modelRouter } from '../core/router';
import { scheduleSummary } from '../core/summaries';
import { buildWhisper } from '../core/whisper';
import { config } from '../config';
import { HttpError } from '../lib/errors';
import { getSupabase } from '../lib/supabase';
import { asyncHandler } from '../middleware/async';
import { requireAuth } from '../middleware/auth';

export const memoryRouter = Router();

const safeEmbed = async (text: string): Promise<number[] | null> => {
  try {
    return await embeddingService.generateEmbedding(text.slice(0, 2000));
  } catch {
    return null;
  }
};

const dbFail = (what: string, message: string): HttpError =>
  new HttpError(500, `${what}: ${message}`, 'api_error', 'memory_db_error');

// --- SDK sync: IndexedDB message queue -> Supabase ---------------------------------

const syncItem = z.object({
  client_id: z.string().min(1).max(200),
  conversation_id: z.string().uuid(),
  model: z.string().min(1).max(200),
  provider: z.string().min(1).max(60).optional(),
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(100_000),
  embedding: z.array(z.number()).optional(),
  created_at: z.string().datetime().optional(),
  topic: z.string().min(1).max(120).optional(),
});

interface SyncResult {
  client_id: string;
  status: 'synced' | 'skipped' | 'failed';
  error?: string;
}

memoryRouter.post(
  '/memory/messages',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const { items } = z
      .object({ items: z.array(syncItem).min(1).max(config.maxSyncBatch) })
      .parse(req.body);

    // Oldest first, so a conversation's first message decides its topic.
    const ordered = [...items].sort(
      (a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime(),
    );

    const policies = new Map<string, AccessPolicy>();
    const conversations = new Map<string, { id: string; topic_id: string | null }>();
    const touchedTopics = new Set<string>();
    const results: SyncResult[] = [];

    for (const item of ordered) {
      try {
        const provider = (item.provider ?? (await modelRouter.providerName(item.model))).toLowerCase();
        let policy = policies.get(provider);
        if (!policy) {
          if (provider !== 'unknown') await ensureLink(userId, provider);
          policy = await loadPolicy(userId, provider);
          policies.set(provider, policy);
        }
        if (!policy.canWrite) {
          results.push({ client_id: item.client_id, status: 'skipped' });
          continue;
        }

        const vector = EmbeddingService.isValidEmbedding(item.embedding)
          ? item.embedding
          : await safeEmbed(item.content);

        let conversation = conversations.get(item.conversation_id);
        if (!conversation) {
          conversation = await ensureConversation(
            userId,
            item.conversation_id,
            null,
            deriveTopicName(item.content),
          );
          conversations.set(item.conversation_id, conversation);
        }

        if (!conversation.topic_id) {
          let topicId: string | null = null;
          if (item.topic) topicId = (await getOrCreateTopic(userId, item.topic)).id;
          if (!topicId && vector) topicId = await findTopicSemantic(userId, vector, policy);
          if (!topicId) topicId = (await getOrCreateTopic(userId, deriveTopicName(item.content))).id;
          await setConversationTopic(userId, conversation.id, topicId);
          conversation.topic_id = topicId;
        }
        const topicId = conversation.topic_id as string;

        await insertMessages(
          { userId, topicId, conversationId: conversation.id, provider, model: item.model, source: 'sdk' },
          [{ role: item.role, content: item.content, embedding: vector, clientId: item.client_id, createdAt: item.created_at }],
        );
        touchedTopics.add(topicId);
        results.push({ client_id: item.client_id, status: 'synced' });
      } catch (err) {
        results.push({
          client_id: item.client_id,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    for (const topicId of touchedTopics) scheduleSummary(userId, topicId);

    const synced = results.filter((r) => r.status === 'synced').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    res.json({ object: 'memory.sync', synced, skipped, failed: results.length - synced - skipped, results });
  }),
);

// --- Context ("whisper") for any AI app -----------------------------------------------

const contextBody = z.object({
  query: z.string().min(1).max(20_000),
  /** The model/app asking, so the user's consent settings for it apply. */
  provider: z.string().min(1).max(60).default('unknown'),
  topic_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
});

memoryRouter.post(
  '/memory/context',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const body = contextBody.parse(req.body);
    const policy = await loadPolicy(userId, body.provider.toLowerCase());
    const vector = await safeEmbed(body.query);

    let topicId: string | null = body.topic_id ?? null;
    if (!topicId && body.conversation_id) {
      topicId = (await getConversation(userId, body.conversation_id))?.topic_id ?? null;
    }
    if (!topicId && vector) topicId = await findTopicSemantic(userId, vector, policy);

    const whisper = await buildWhisper({
      userId,
      policy,
      topicId,
      queryEmbedding: vector,
      excludeConversationId: body.conversation_id ?? null,
    });
    res.json({
      object: 'memory.context',
      topic_id: topicId,
      text: whisper?.text ?? '',
      items: whisper?.items ?? 0,
    });
  }),
);

// --- Browse, export, delete --------------------------------------------------------------

memoryRouter.get(
  '/memory/topics',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const { data, error } = await getSupabase()
      .from('topics')
      .select('id, name, summary, summary_updated_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw dbFail('topic list failed', error.message);
    res.json({ object: 'list', data: data ?? [] });
  }),
);

const listQuery = z.object({
  topic_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

memoryRouter.get(
  '/memory/messages',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const q = listQuery.parse(req.query);
    let query = getSupabase()
      .from('messages')
      .select('id, topic_id, conversation_id, role, provider, model, content, source, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(q.limit);
    if (q.topic_id) query = query.eq('topic_id', q.topic_id);
    if (q.conversation_id) query = query.eq('conversation_id', q.conversation_id);
    const { data, error } = await query;
    if (error) throw dbFail('message list failed', error.message);
    res.json({ object: 'list', data: data ?? [] });
  }),
);

async function fetchAll(table: string, columns: string, userId: string): Promise<unknown[]> {
  const PAGE = 1000;
  const out: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getSupabase()
      .from(table)
      .select(columns)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw dbFail(`export of ${table} failed`, error.message);
    const rows = (data ?? []) as unknown[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** One-click export of everything Sentence holds about the user's memory. */
memoryRouter.get(
  '/memory/export',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const [topics, conversations, messages, grants, links] = await Promise.all([
      fetchAll('topics', 'id, name, summary, created_at', userId),
      fetchAll('conversations', 'id, topic_id, title, created_at', userId),
      fetchAll('messages', 'id, topic_id, conversation_id, role, provider, model, content, source, created_at', userId),
      fetchAll('grants', 'id, provider, topic_id, allowed, created_at', userId),
      fetchAll('model_links', 'provider, status, can_read, can_write, created_at', userId),
    ]);
    res
      .set('Content-Disposition', 'attachment; filename="sentence-export.json"')
      .json({ exported_at: new Date().toISOString(), topics, conversations, messages, grants, links });
  }),
);

memoryRouter.delete(
  '/memory/topics/:id',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const id = z.string().uuid().parse(req.params.id);
    // Messages and grants of the topic are removed by ON DELETE CASCADE.
    const { error } = await getSupabase().from('topics').delete().eq('id', id).eq('user_id', userId);
    if (error) throw dbFail('topic delete failed', error.message);
    res.json({ deleted: true, id });
  }),
);

/** Wipe all shared memory (messages, conversations, topics). Requires an explicit confirmation. */
memoryRouter.delete(
  '/memory',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    z.object({ confirm: z.literal('delete-all-memory') }).parse(req.body);
    const sb = getSupabase();
    for (const table of ['messages', 'conversations', 'topics'] as const) {
      const { error } = await sb.from(table).delete().eq('user_id', userId);
      if (error) throw dbFail(`${table} delete failed`, error.message);
    }
    res.json({ deleted: true });
  }),
);
