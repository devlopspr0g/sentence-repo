import { createHash } from 'crypto';

/**
 * Parsers for the "export your data" files of ChatGPT and Claude (`conversations.json`),
 * turned into the items accepted by POST /v1/memory/messages.
 *
 * Pure functions (no network, no database) so they are easy to test. Ids are derived
 * deterministically, so importing the same file twice never creates duplicates.
 */

export type ImportSource = 'chatgpt' | 'claude';

export interface ImportMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string;
  created_at: string;
}

export interface ImportConversation {
  source: ImportSource;
  id: string;
  title: string;
  created_at: string;
  messages: ImportMessage[];
}

export interface SyncItem {
  client_id: string;
  conversation_id: string;
  model: string;
  provider: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  topic: string;
}

export const MAX_CONTENT_CHARS = 100_000;
const PROVIDER_OF: Record<ImportSource, string> = { chatgpt: 'openai', claude: 'anthropic' };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

/** Stable UUID (version-5 layout) derived from a seed, so re-imports hit the same conversation. */
export function deterministicUuid(seed: string): string {
  const h = sha1(seed);
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function isoFromSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const d = new Date(value * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isoFromString(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Make timestamps strictly increase so a conversation keeps its order after sorting. */
function enforceOrder(messages: ImportMessage[]): void {
  let prev = 0;
  for (const m of messages) {
    let t = new Date(m.created_at).getTime();
    if (t <= prev) t = prev + 1;
    m.created_at = new Date(t).toISOString();
    prev = t;
  }
}

// --- ChatGPT -----------------------------------------------------------------------------

function chatgptText(content: unknown): string {
  if (!isObject(content)) return '';
  const type = content.content_type;
  // Only plain chat text; skip code-interpreter output, browsing dumps, reasoning traces, images.
  if (type !== 'text' && type !== 'multimodal_text') return '';
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .filter((p): p is string => typeof p === 'string')
    .join('\n')
    .trim();
}

/** Walk from the conversation's current node back to the root: that is the branch the user saw. */
function chatgptChain(conv: Json, mapping: Record<string, Json>): Json[] {
  let cursor = asString(conv.current_node);

  if (!cursor || !mapping[cursor]) {
    // Fallback: the newest leaf of the tree.
    let best: { id: string; time: number } | null = null;
    for (const [id, node] of Object.entries(mapping)) {
      const children = Array.isArray(node.children) ? node.children : [];
      if (children.length > 0) continue;
      const message = isObject(node.message) ? node.message : null;
      const time = typeof message?.create_time === 'number' ? message.create_time : 0;
      if (!best || time >= best.time) best = { id, time };
    }
    cursor = best?.id ?? null;
  }

  const chain: Json[] = [];
  const seen = new Set<string>();
  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(mapping[cursor]);
    cursor = asString(mapping[cursor].parent);
  }
  return chain.reverse();
}

export function parseChatGPT(data: unknown): ImportConversation[] {
  if (!Array.isArray(data)) throw new Error('ChatGPT export must be a JSON array of conversations');
  const out: ImportConversation[] = [];

  for (const raw of data) {
    if (!isObject(raw) || !isObject(raw.mapping)) continue;
    const mapping = raw.mapping as Record<string, Json>;
    const title = asString(raw.title) ?? 'Imported ChatGPT conversation';
    const convCreated = isoFromSeconds(raw.create_time) ?? new Date(0).toISOString();
    const id =
      asString(raw.conversation_id) ?? asString(raw.id) ?? `${title}|${convCreated}`;
    const defaultModel = asString(raw.default_model_slug) ?? 'chatgpt';

    const messages: ImportMessage[] = [];
    for (const node of chatgptChain(raw, mapping)) {
      const message = isObject(node.message) ? node.message : null;
      if (!message) continue;
      const role = isObject(message.author) ? message.author.role : null;
      if (role !== 'user' && role !== 'assistant') continue;
      const metadata = isObject(message.metadata) ? message.metadata : {};
      if (metadata.is_visually_hidden_from_conversation === true) continue;
      const text = chatgptText(message.content);
      if (!text) continue;

      messages.push({
        id: asString(message.id) ?? asString(node.id) ?? `${messages.length}`,
        role,
        content: text.slice(0, MAX_CONTENT_CHARS),
        model: asString(metadata.model_slug) ?? defaultModel,
        created_at: isoFromSeconds(message.create_time) ?? convCreated,
      });
    }
    if (messages.length === 0) continue;
    enforceOrder(messages);
    out.push({ source: 'chatgpt', id, title, created_at: convCreated, messages });
  }
  return out;
}

// --- Claude ------------------------------------------------------------------------------

function claudeText(message: Json): string {
  const direct = asString(message.text);
  if (direct && direct.trim()) return direct.trim();
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((b): b is Json => isObject(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}

export function parseClaude(data: unknown): ImportConversation[] {
  if (!Array.isArray(data)) throw new Error('Claude export must be a JSON array of conversations');
  const out: ImportConversation[] = [];

  for (const raw of data) {
    if (!isObject(raw) || !Array.isArray(raw.chat_messages)) continue;
    const title = asString(raw.name) ?? 'Imported Claude conversation';
    const convCreated = isoFromString(raw.created_at) ?? new Date(0).toISOString();
    const id = asString(raw.uuid) ?? `${title}|${convCreated}`;

    const messages: ImportMessage[] = [];
    for (const item of raw.chat_messages) {
      if (!isObject(item)) continue;
      const sender = item.sender;
      const role = sender === 'human' ? 'user' : sender === 'assistant' ? 'assistant' : null;
      if (!role) continue;
      const text = claudeText(item);
      if (!text) continue;
      messages.push({
        id: asString(item.uuid) ?? `${messages.length}`,
        role,
        content: text.slice(0, MAX_CONTENT_CHARS),
        model: 'claude',
        created_at: isoFromString(item.created_at) ?? convCreated,
      });
    }
    if (messages.length === 0) continue;
    messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
    enforceOrder(messages);
    out.push({ source: 'claude', id, title, created_at: convCreated, messages });
  }
  return out;
}

// --- Shared ------------------------------------------------------------------------------

/** Guess the export type from its shape. */
export function detectSource(data: unknown): ImportSource {
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (!isObject(entry)) continue;
      if (isObject(entry.mapping)) return 'chatgpt';
      if (Array.isArray(entry.chat_messages)) return 'claude';
    }
  }
  throw new Error('Unrecognised export: expected ChatGPT or Claude conversations.json');
}

export function parseExport(data: unknown, source?: ImportSource): ImportConversation[] {
  const kind = source ?? detectSource(data);
  return kind === 'chatgpt' ? parseChatGPT(data) : parseClaude(data);
}

/**
 * Convert a conversation into /v1/memory/messages items.
 * `salt` keeps one person's imported conversation ids from colliding with another user's
 * (conversation ids are global); the CLI derives it from the API key.
 */
export function toSyncItems(conv: ImportConversation, salt: string): SyncItem[] {
  const conversationId = deterministicUuid(`${salt}|${conv.source}|${conv.id}`);
  const provider = PROVIDER_OF[conv.source];
  return conv.messages.map((m) => ({
    client_id: `imp-${sha1(`${salt}|${conv.source}|${conv.id}|${m.id}`)}`,
    conversation_id: conversationId,
    model: m.model,
    provider,
    role: m.role,
    content: m.content,
    created_at: m.created_at,
    topic: conv.title.slice(0, 120),
  }));
}
