import { config } from '../config';
import { getSupabase, toPgVector } from '../lib/supabase';
import { AccessPolicy, filterReadable, StoredMessage } from './memory';
import { formatWhisper } from './whisperFormat';

const COLUMNS = 'id, topic_id, conversation_id, role, provider, model, content, created_at';
const RECENT_IN_TOPIC = 12;
const SEMANTIC_HITS = 6;
const SEMANTIC_THRESHOLD = 0.4;
const TIMELINE_LIMIT = 8;

export interface WhisperRequest {
  userId: string;
  policy: AccessPolicy;
  topicId: string | null;
  queryEmbedding: number[] | null;
  /** The live conversation already carries its own history, so it is left out. */
  excludeConversationId: string | null;
}

export interface Whisper {
  text: string;
  items: number;
}

/**
 * Build the "whisper": a system message telling the next model what the user was doing
 * with other models. Sources, in order of relevance:
 *   1. the topic's rolling summary and its latest exchanges,
 *   2. semantically similar exchanges from any topic,
 *   3. when neither exists (a vague follow-up like "continue"), the user's most recent
 *      exchanges from the last WHISPER_TIMELINE_HOURS.
 * Everything is filtered through the caller's consent policy before it can be included.
 * Returns null when there is nothing this provider may see.
 */
export async function buildWhisper(req: WhisperRequest): Promise<Whisper | null> {
  const sb = getSupabase();
  const topicReadable = req.topicId !== null && req.policy.canReadTopic(req.topicId);

  let topicMessages: StoredMessage[] = [];
  let topicName: string | null = null;
  let summary: string | null = null;

  if (req.topicId && topicReadable) {
    const [topic, recent] = await Promise.all([
      sb.from('topics').select('name, summary').eq('id', req.topicId).eq('user_id', req.userId).maybeSingle(),
      sb
        .from('messages')
        .select(COLUMNS)
        .eq('user_id', req.userId)
        .eq('topic_id', req.topicId)
        .in('role', ['user', 'assistant'])
        .order('created_at', { ascending: false })
        .limit(RECENT_IN_TOPIC),
    ]);
    if (topic.data) {
      topicName = (topic.data.name as string) ?? null;
      summary = (topic.data.summary as string) ?? null;
    }
    topicMessages = (recent.data ?? []) as StoredMessage[];
  }

  let semantic: StoredMessage[] = [];
  if (req.queryEmbedding) {
    const { data } = await sb.rpc('match_messages', {
      query_embedding: toPgVector(req.queryEmbedding),
      filter_user_id: req.userId,
      match_count: SEMANTIC_HITS,
      match_threshold: SEMANTIC_THRESHOLD,
      include_topic_ids: null,
    });
    semantic = (data ?? []) as StoredMessage[];
  }

  const live = (m: StoredMessage): boolean =>
    !req.excludeConversationId || m.conversation_id !== req.excludeConversationId;
  topicMessages = topicMessages.filter(live);
  semantic = semantic.filter(live);

  let timeline: StoredMessage[] = [];
  if (topicMessages.length === 0 && semantic.length === 0) {
    const since = new Date(Date.now() - config.whisperTimelineHours * 3_600_000).toISOString();
    const { data } = await sb
      .from('messages')
      .select(COLUMNS)
      .eq('user_id', req.userId)
      .in('role', ['user', 'assistant'])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(TIMELINE_LIMIT);
    timeline = ((data ?? []) as StoredMessage[]).filter(live);
  }

  const seen = new Set<string>();
  const merged: StoredMessage[] = [];
  for (const m of [...topicMessages, ...semantic, ...timeline]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
  }

  const readable = filterReadable(merged, req.policy).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  const out = formatWhisper({
    topicName: topicReadable ? topicName : null,
    summary: topicReadable ? summary : null,
    messages: readable.map((m) => ({
      id: m.id,
      model: m.model ?? m.provider,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
    })),
    maxChars: config.whisperMaxChars,
  });

  return out.text ? { text: out.text, items: out.ids.length + (out.summaryIncluded ? 1 : 0) } : null;
}
