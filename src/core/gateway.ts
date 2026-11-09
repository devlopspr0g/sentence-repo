import { isSupabaseConfigured } from '../lib/supabase';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../providers/types';
import { embeddingService } from './embeddings';
import {
  AccessPolicy,
  createConversation,
  deriveTopicName,
  ensureLink,
  findTopicByName,
  findTopicSemantic,
  getConversation,
  getOrCreateTopic,
  insertMessages,
  loadPolicy,
} from './memory';
import { router } from './router';
import { scheduleSummary } from './summaries';
import { buildWhisper } from './whisper';

export interface GatewayOptions {
  /** false = pass-through: nothing read from or written to memory. */
  memory: boolean;
  topic?: string;
  conversationId?: string;
  jobId?: string;
}

export interface MemoryContext {
  userId: string;
  provider: string;
  policy: AccessPolicy;
  topicId: string | null;
  conversationId: string | null;
  userText: string;
  userEmbedding: number[] | null;
  startedAt: string;
  contextItems: number;
  jobId?: string;
}

export interface Prepared {
  request: ChatCompletionRequest;
  ctx: MemoryContext | null;
}

export interface Reply {
  text: string;
  provider: string;
  model: string;
}

const safeEmbed = async (text: string): Promise<number[] | null> => {
  try {
    return await embeddingService.generateEmbedding(text.slice(0, 2000));
  } catch (err) {
    console.warn('[memory] embedding unavailable:', err instanceof Error ? err.message : err);
    return null;
  }
};

/**
 * Attach shared memory to a chat request: decide topic/conversation, inject the whisper.
 * Memory is best-effort and consent-gated: any failure falls back to a plain pass-through call.
 */
export async function prepare(
  userId: string,
  request: ChatCompletionRequest,
  opts: GatewayOptions,
): Promise<Prepared> {
  const plain: ChatCompletionRequest = { ...request, userId, jobId: opts.jobId };
  if (!opts.memory || !isSupabaseConfigured()) return { request: plain, ctx: null };

  try {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser || !lastUser.content.trim()) return { request: plain, ctx: null };

    const provider = await router.providerName(request.model);
    if (provider !== 'unknown') await ensureLink(userId, provider);
    const policy = await loadPolicy(userId, provider);
    const userEmbedding = await safeEmbed(lastUser.content);

    let topicId: string | null = null;
    let conversationId: string | null = null;

    if (opts.conversationId) {
      const conversation = await getConversation(userId, opts.conversationId);
      if (conversation) {
        conversationId = conversation.id;
        topicId = conversation.topic_id;
      }
    }
    if (!topicId && opts.topic) topicId = (await findTopicByName(userId, opts.topic))?.id ?? null;
    if (!topicId && userEmbedding) topicId = await findTopicSemantic(userId, userEmbedding, policy);

    if (policy.canWrite) {
      if (!topicId) {
        topicId = (await getOrCreateTopic(userId, opts.topic ?? deriveTopicName(lastUser.content))).id;
      }
      if (!conversationId) {
        conversationId = await createConversation(userId, topicId, deriveTopicName(lastUser.content));
      }
    }

    const whisper = await buildWhisper({
      userId,
      policy,
      topicId,
      queryEmbedding: userEmbedding,
      excludeConversationId: conversationId,
    });

    const injected: ChatCompletionRequest = whisper
      ? { ...plain, messages: [{ role: 'system', content: whisper.text }, ...request.messages] }
      : plain;

    return {
      request: injected,
      ctx: {
        userId,
        provider,
        policy,
        topicId,
        conversationId,
        userText: lastUser.content,
        userEmbedding,
        startedAt: new Date().toISOString(),
        contextItems: whisper?.items ?? 0,
        jobId: opts.jobId,
      },
    };
  } catch (err) {
    console.warn('[memory] disabled for this request:', err instanceof Error ? err.message : err);
    return { request: plain, ctx: null };
  }
}

/** Record the exchange (question + answer) after the model has replied. Never throws. */
export async function finish(ctx: MemoryContext | null, reply: Reply): Promise<void> {
  if (!ctx || !ctx.policy.canWrite || !ctx.topicId || !ctx.conversationId) return;
  if (!reply.text.trim()) return;
  try {
    const assistantEmbedding = await safeEmbed(reply.text);
    await insertMessages(
      {
        userId: ctx.userId,
        topicId: ctx.topicId,
        conversationId: ctx.conversationId,
        provider: reply.provider,
        model: reply.model,
        source: ctx.jobId ? 'job' : 'gateway',
        jobId: ctx.jobId,
      },
      [
        { role: 'user', content: ctx.userText, embedding: ctx.userEmbedding, createdAt: ctx.startedAt },
        { role: 'assistant', content: reply.text, embedding: assistantEmbedding },
      ],
    );
    scheduleSummary(ctx.userId, ctx.topicId);
  } catch (err) {
    console.warn('[memory] could not record exchange:', err instanceof Error ? err.message : err);
  }
}

/** Non-streaming chat with memory: used by the chat route and by multi-model jobs. */
export async function runChat(
  userId: string,
  request: ChatCompletionRequest,
  opts: GatewayOptions,
): Promise<ChatCompletionResponse> {
  const { request: prepared, ctx } = await prepare(userId, request, opts);
  const completion = await router.chat(prepared);
  await finish(ctx, {
    text: completion.choices[0]?.message.content ?? '',
    provider: completion.sentence?.provider ?? ctx?.provider ?? 'unknown',
    model: completion.sentence?.model ?? completion.model,
  });
  return {
    ...completion,
    sentence: {
      provider: completion.sentence?.provider ?? 'unknown',
      model: completion.sentence?.model ?? completion.model,
      fallback: completion.sentence?.fallback ?? false,
      ...(ctx?.topicId ? { topic_id: ctx.topicId } : {}),
      ...(ctx?.conversationId ? { conversation_id: ctx.conversationId } : {}),
      context_items: ctx?.contextItems ?? 0,
    },
  };
}
