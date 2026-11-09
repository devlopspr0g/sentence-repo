import { config } from '../config';
import { HttpError } from '../lib/errors';
import { getSupabase, toPgVector } from '../lib/supabase';

export interface StoredMessage {
  id: string;
  topic_id: string | null;
  conversation_id: string | null;
  role: 'system' | 'user' | 'assistant' | 'tool';
  provider: string;
  model: string | null;
  content: string;
  created_at: string;
  similarity?: number;
}

/** What one model/app may do with the user's shared memory. */
export interface AccessPolicy {
  provider: string;
  /** false = this provider only ever sees what it wrote itself. */
  crossModel: boolean;
  canWrite: boolean;
  canReadTopic(topicId: string | null): boolean;
}

const dbError = (what: string, message: string): HttpError =>
  new HttpError(500, `${what}: ${message}`, 'api_error', 'memory_db_error');

/**
 * Load consent for (user, provider). Fails closed: any lookup error throws.
 * Precedence: topic grant > provider-wide grant > link permission.
 * A revoked link denies everything for that provider.
 */
export async function loadPolicy(userId: string, provider: string): Promise<AccessPolicy> {
  const sb = getSupabase();
  const [settings, link, grants] = await Promise.all([
    sb.from('memory_settings').select('cross_model_sharing').eq('user_id', userId).maybeSingle(),
    sb
      .from('model_links')
      .select('status, can_read, can_write')
      .eq('user_id', userId)
      .eq('provider', provider)
      .maybeSingle(),
    sb.from('grants').select('topic_id, allowed').eq('user_id', userId).eq('provider', provider),
  ]);
  if (settings.error) throw dbError('settings lookup failed', settings.error.message);
  if (link.error) throw dbError('link lookup failed', link.error.message);
  if (grants.error) throw dbError('grant lookup failed', grants.error.message);

  const active = !link.data || link.data.status === 'active';
  const baseRead = active && (link.data ? Boolean(link.data.can_read) : true);
  const canWrite = active && (link.data ? Boolean(link.data.can_write) : true);

  let providerWide: boolean | null = null;
  const topicRules = new Map<string, boolean>();
  for (const g of (grants.data ?? []) as Array<{ topic_id: string | null; allowed: boolean }>) {
    if (g.topic_id) topicRules.set(g.topic_id, g.allowed);
    else providerWide = g.allowed;
  }

  return {
    provider,
    crossModel: settings.data?.cross_model_sharing ?? true,
    canWrite,
    canReadTopic(topicId) {
      if (!active) return false;
      if (topicId && topicRules.has(topicId)) return topicRules.get(topicId) as boolean;
      if (providerWide !== null) return providerWide;
      return baseRead;
    },
  };
}

/** Keep only messages this provider is allowed to see. */
export function filterReadable(messages: StoredMessage[], policy: AccessPolicy): StoredMessage[] {
  return messages.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      policy.canReadTopic(m.topic_id) &&
      (policy.crossModel || m.provider === policy.provider),
  );
}

/** First use of a provider auto-creates an active, read+write link (the user can restrict it later). */
export async function ensureLink(userId: string, provider: string): Promise<void> {
  await getSupabase()
    .from('model_links')
    .upsert({ user_id: userId, provider }, { onConflict: 'user_id,provider', ignoreDuplicates: true });
}

export const deriveTopicName = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat || 'Untitled';
};

export async function findTopicByName(
  userId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await getSupabase()
    .from('topics')
    .select('id, name')
    .eq('user_id', userId)
    .eq('name', name)
    .maybeSingle();
  if (error) throw dbError('topic lookup failed', error.message);
  return (data as { id: string; name: string } | null) ?? null;
}

export async function getOrCreateTopic(
  userId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const existing = await findTopicByName(userId, name);
  if (existing) return existing;
  const { data, error } = await getSupabase()
    .from('topics')
    .insert({ user_id: userId, name })
    .select('id, name')
    .single();
  if (error || !data) {
    // Lost a creation race with a concurrent request: read the winner.
    const again = await findTopicByName(userId, name);
    if (again) return again;
    throw dbError('topic create failed', error?.message ?? 'no row returned');
  }
  return data as { id: string; name: string };
}

/** Nearest existing topic (by message similarity) that this provider may read; otherwise null. */
export async function findTopicSemantic(
  userId: string,
  embedding: number[],
  policy: AccessPolicy,
): Promise<string | null> {
  const { data, error } = await getSupabase().rpc('match_messages', {
    query_embedding: toPgVector(embedding),
    filter_user_id: userId,
    match_count: 8,
    match_threshold: config.topicMatchThreshold,
    include_topic_ids: null,
  });
  if (error) throw dbError('topic match failed', error.message);
  for (const row of (data ?? []) as StoredMessage[]) {
    if (!row.topic_id || !policy.canReadTopic(row.topic_id)) continue;
    if (!policy.crossModel && row.provider !== policy.provider) continue;
    return row.topic_id;
  }
  return null;
}

/** Return the conversation only if it belongs to the user. */
export async function getConversation(
  userId: string,
  conversationId: string,
): Promise<{ id: string; topic_id: string | null } | null> {
  const { data, error } = await getSupabase()
    .from('conversations')
    .select('id, topic_id')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw dbError('conversation lookup failed', error.message);
  return (data as { id: string; topic_id: string | null } | null) ?? null;
}

export async function createConversation(
  userId: string,
  topicId: string | null,
  title: string,
): Promise<string> {
  const { data, error } = await getSupabase()
    .from('conversations')
    .insert({ user_id: userId, topic_id: topicId, title: title.slice(0, 120) })
    .select('id')
    .single();
  if (error || !data) throw dbError('conversation create failed', error?.message ?? 'no row returned');
  return (data as { id: string }).id;
}

export interface NewMessage {
  role: 'user' | 'assistant';
  content: string;
  embedding: number[] | null;
  clientId?: string;
  createdAt?: string;
}

export interface InsertContext {
  userId: string;
  topicId: string;
  conversationId: string;
  provider: string;
  model: string | null;
  source: 'gateway' | 'sdk' | 'connector' | 'job' | 'import';
  jobId?: string | null;
}

/** Insert messages; rows whose (user, client_id) already exist are skipped. Returns inserted count. */
export async function insertMessages(ctx: InsertContext, messages: NewMessage[]): Promise<number> {
  if (messages.length === 0) return 0;
  const rows = messages.map((m) => ({
    user_id: ctx.userId,
    topic_id: ctx.topicId,
    conversation_id: ctx.conversationId,
    job_id: ctx.jobId ?? null,
    client_id: m.clientId ?? null,
    role: m.role,
    provider: ctx.provider,
    model: ctx.model,
    content: m.content,
    embedding: m.embedding ? toPgVector(m.embedding) : null,
    source: ctx.source,
    ...(m.createdAt ? { created_at: m.createdAt } : {}),
  }));
  const { data, error } = await getSupabase()
    .from('messages')
    .upsert(rows, { onConflict: 'user_id,client_id', ignoreDuplicates: true })
    .select('id');
  if (error) throw dbError('message insert failed', error.message);
  return (data ?? []).length;
}

/**
 * Return the user's conversation with this client-chosen id, creating it when new.
 * An id that already belongs to someone else reads as "not found" (no information leak).
 */
export async function ensureConversation(
  userId: string,
  id: string,
  topicId: string | null,
  title: string,
): Promise<{ id: string; topic_id: string | null }> {
  const existing = await getConversation(userId, id);
  if (existing) return existing;
  const { data, error } = await getSupabase()
    .from('conversations')
    .insert({ id, user_id: userId, topic_id: topicId, title: title.slice(0, 120) })
    .select('id, topic_id')
    .single();
  if (error || !data) {
    throw new HttpError(404, 'Conversation not found', 'invalid_request_error', 'conversation_not_found');
  }
  return data as { id: string; topic_id: string | null };
}

export async function setConversationTopic(
  userId: string,
  conversationId: string,
  topicId: string,
): Promise<void> {
  const { error } = await getSupabase()
    .from('conversations')
    .update({ topic_id: topicId, updated_at: new Date().toISOString() })
    .eq('id', conversationId)
    .eq('user_id', userId);
  if (error) throw dbError('conversation update failed', error.message);
}
