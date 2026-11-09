import { DBSchema, IDBPDatabase, openDB } from 'idb';

/** Must match the server: Xenova/all-MiniLM-L6-v2, mean pooling, normalised, 384 dims. */
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

const DB_NAME = 'sentence_db';
const DB_VERSION = 2;
const MAX_ATTEMPTS = 5;

export type QueueStatus = 'pending' | 'failed';

export interface QueueItem {
  /** Client-generated id; also the server-side idempotency key. */
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  status: QueueStatus;
  attempts: number;
  last_error?: string;
  created_at: string;
}

export interface StoredDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  synced: boolean;
  server_id?: string;
  created_at: string;
}

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'pending' | 'synced' | 'failed';

/** One question or answer, kept on the user's device first and synced to the center brain later. */
export interface LocalMessage {
  id: string;
  conversation_id: string;
  model: string;
  provider: string;
  role: MessageRole;
  content: string;
  embedding: number[];
  topic?: string;
  status: MessageStatus;
  attempts: number;
  last_error?: string;
  created_at: string;
}

export interface ChatOptions {
  /** e.g. "gpt-4o", "claude-sonnet-4-5", "gemini-2.5-flash", "groq/...", "mistral/..." or "auto". */
  model: string;
  prompt?: string;
  /** Full message list instead of `prompt` (the last user message is what gets remembered). */
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Reuse to continue a thread, including with a different model. */
  conversationId?: string;
  /** Name the topic this belongs to (otherwise it is detected from meaning). */
  topic?: string;
  /** false = incognito: nothing is read from or written to shared memory. Default true. */
  memory?: boolean;
}

export interface ChatResult {
  answer: string;
  conversationId: string;
  /** Raw OpenAI-style response, including the `sentence` routing/memory metadata. */
  response: unknown;
}

interface SentenceDB extends DBSchema {
  messages: {
    key: string;
    value: LocalMessage;
    indexes: { by_status: MessageStatus; by_conversation: string };
  };
  queue: {
    key: string;
    value: QueueItem;
    indexes: { by_status: QueueStatus };
  };
  documents: {
    key: string;
    value: StoredDocument;
  };
}

export type Embedder = (text: string) => Promise<number[]>;

export interface SentenceClientOptions {
  /** e.g. "https://api.example.com" (no trailing /v1). */
  baseUrl: string;
  /** Bearer key, `sk-sent-...`. */
  apiKey: string;
  /** Max items per /v1/sync/batch request (server cap is 100). */
  batchSize?: number;
  /** Override the embedder (e.g. a service-worker bridge). Defaults to in-browser transformers.js. */
  embedder?: Embedder;
  /** Sync automatically when the browser comes back online. Default true. */
  autoSync?: boolean;
  fetch?: typeof fetch;
}

export interface SyncResult {
  synced: number;
  failed: number;
  remaining: number;
}

interface ServerSyncResponse {
  synced: number;
  failed: number;
  results: Array<{
    client_id: string;
    status: 'synced' | 'failed';
    document_id?: string;
    error?: string;
  }>;
}

export class SentenceSyncError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'SentenceSyncError';
  }
}

/** Provider label for a model id; the server applies the user's consent settings per provider. */
function inferProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith('local-')) return 'local';
  if (m.includes('/')) return m.split('/')[0];
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gemini')) return 'gemini';
  if (/^(gpt-|chatgpt-|o[134])/.test(m)) return 'openai';
  if (/^(llama|mixtral|gemma)/.test(m)) return 'groq';
  return 'unknown';
}

function validateEmbedding(vector: ArrayLike<number>): number[] {
  const out = Array.from(vector);
  if (out.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${out.length}`);
  }
  if (!out.every((n) => Number.isFinite(n))) throw new Error('Embedding contains non-finite values');
  return out;
}

function cosine(a: number[], b: number[]): number {
  // Vectors are L2-normalised, so the dot product is the cosine similarity.
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

export class SentenceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly batchSize: number;
  private readonly fetchImpl: typeof fetch;
  private readonly customEmbedder?: Embedder;
  private dbPromise: Promise<IDBPDatabase<SentenceDB>> | null = null;
  private extractor: Promise<(text: string, opts: unknown) => Promise<{ data: ArrayLike<number> }>> | null = null;
  private syncing: Promise<SyncResult> | null = null;
  private syncingMessages: Promise<SyncResult> | null = null;

  constructor(options: SentenceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.batchSize = Math.min(Math.max(options.batchSize ?? 50, 1), 100);
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.customEmbedder = options.embedder;

    if ((options.autoSync ?? true) && typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        void this.syncAll().catch(() => undefined);
      });
    }
  }

  // --- storage -------------------------------------------------------------

  private db(): Promise<IDBPDatabase<SentenceDB>> {
    const existing = this.dbPromise;
    if (existing) return existing;
    const opened = openDB<SentenceDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const queue = db.createObjectStore('queue', { keyPath: 'id' });
          queue.createIndex('by_status', 'status');
          db.createObjectStore('documents', { keyPath: 'id' });
        }
        if (oldVersion < 2) {
          const messages = db.createObjectStore('messages', { keyPath: 'id' });
          messages.createIndex('by_status', 'status');
          messages.createIndex('by_conversation', 'conversation_id');
        }
      },
    });
    this.dbPromise = opened;
    return opened;
  }

  // --- embeddings ----------------------------------------------------------

  /** Generate a normalised 384-dim embedding locally (no network after the model is cached). */
  async embed(text: string): Promise<number[]> {
    if (this.customEmbedder) return validateEmbedding(await this.customEmbedder(text));

    if (!this.extractor) {
      this.extractor = (async () => {
        const tf: any = await import('@huggingface/transformers');
        return tf.pipeline('feature-extraction', EMBEDDING_MODEL, { quantized: true, dtype: 'q8' });
      })().catch((err: unknown) => {
        this.extractor = null;
        throw err;
      });
    }
    const extractor = await this.extractor;
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return validateEmbedding(output.data);
  }

  // --- documents & queue ---------------------------------------------------

  /**
   * Embed locally, store the document, queue it for sync, and sync right away when online.
   * Never throws because of a network problem: the item simply stays queued.
   */
  async addDocument(content: string, metadata: Record<string, unknown> = {}): Promise<StoredDocument> {
    const text = content.trim();
    if (!text) throw new Error('Document content must not be empty');

    const embedding = await this.embed(text);
    const id = crypto.randomUUID();
    const created_at = new Date().toISOString();

    const doc: StoredDocument = { id, content: text, embedding, metadata, synced: false, created_at };
    const item: QueueItem = {
      id,
      content: text,
      embedding,
      metadata,
      status: 'pending',
      attempts: 0,
      created_at,
    };

    const db = await this.db();
    const tx = db.transaction(['documents', 'queue'], 'readwrite');
    await Promise.all([tx.objectStore('documents').put(doc), tx.objectStore('queue').put(item), tx.done]);

    if (typeof navigator !== 'undefined' && navigator.onLine) {
      void this.sync().catch(() => undefined);
    }
    return doc;
  }

  async getDocuments(): Promise<StoredDocument[]> {
    return (await this.db()).getAll('documents');
  }

  async pendingCount(): Promise<number> {
    const db = await this.db();
    const [pending, failed] = await Promise.all([
      db.countFromIndex('queue', 'by_status', 'pending'),
      db.countFromIndex('queue', 'by_status', 'failed'),
    ]);
    return pending + failed;
  }

  /** Cosine search over locally stored documents; works fully offline. */
  async searchLocal(query: string, limit = 5): Promise<Array<StoredDocument & { similarity: number }>> {
    const queryVector = await this.embed(query);
    const docs = await this.getDocuments();
    return docs
      .map((d) => ({ ...d, similarity: cosine(queryVector, d.embedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  // --- sync ----------------------------------------------------------------

  /** Push queued items to /v1/sync/batch. Concurrent calls share one in-flight sync. */
  sync(): Promise<SyncResult> {
    if (!this.syncing) {
      this.syncing = this.runSync().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  private async runSync(): Promise<SyncResult> {
    const db = await this.db();
    let synced = 0;
    let failed = 0;

    for (;;) {
      const [pending, retry] = await Promise.all([
        db.getAllFromIndex('queue', 'by_status', 'pending'),
        db.getAllFromIndex('queue', 'by_status', 'failed'),
      ]);
      const batch = [...pending, ...retry.filter((i) => i.attempts < MAX_ATTEMPTS)].slice(0, this.batchSize);
      if (batch.length === 0) break;

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/v1/sync/batch`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            items: batch.map((i) => ({
              client_id: i.id,
              content: i.content,
              embedding: i.embedding,
              metadata: i.metadata,
              created_at: i.created_at,
            })),
          }),
        });
      } catch (err) {
        // Network failure: leave everything queued for the next attempt.
        throw new SentenceSyncError(err instanceof Error ? err.message : 'Network error during sync');
      }

      if (response.status !== 200) {
        throw new SentenceSyncError(`Sync failed with HTTP ${response.status}`, response.status);
      }

      const payload = (await response.json()) as ServerSyncResponse;
      const byId = new Map(payload.results.map((r) => [r.client_id, r]));

      const tx = db.transaction(['queue', 'documents'], 'readwrite');
      let progressed = false;
      for (const item of batch) {
        const result = byId.get(item.id);
        if (result?.status === 'synced') {
          await tx.objectStore('queue').delete(item.id);
          const doc = await tx.objectStore('documents').get(item.id);
          if (doc) await tx.objectStore('documents').put({ ...doc, synced: true, server_id: result.document_id });
          synced += 1;
          progressed = true;
        } else {
          await tx.objectStore('queue').put({
            ...item,
            status: 'failed',
            attempts: item.attempts + 1,
            last_error: result?.error ?? 'No result returned for item',
          });
          failed += 1;
        }
      }
      await tx.done;

      // Stop if nothing moved forward so failed items are not hammered in a tight loop.
      if (!progressed) break;
    }

    return { synced, failed, remaining: await this.pendingCount() };
  }

  // --- shared memory ("center brain") ----------------------------------------

  /** Start a new thread; reuse the id in `chat()` to continue it with any model. */
  newConversation(): string {
    return crypto.randomUUID();
  }

  /** Save one message on this device first; it is pushed to the server when online. */
  async recordMessage(
    input: {
      conversationId: string;
      model: string;
      provider?: string;
      role: MessageRole;
      content: string;
      topic?: string;
      createdAt?: string;
    },
    triggerSync = true,
    status: MessageStatus = 'pending',
  ): Promise<LocalMessage> {
    const content = input.content.trim();
    if (!content) throw new Error('Message content must not be empty');
    const message: LocalMessage = {
      id: crypto.randomUUID(),
      conversation_id: input.conversationId,
      model: input.model,
      provider: input.provider ?? inferProvider(input.model),
      role: input.role,
      content,
      embedding: await this.embed(content),
      topic: input.topic,
      status,
      attempts: 0,
      created_at: input.createdAt ?? new Date().toISOString(),
    };
    await (await this.db()).put('messages', message);
    if (triggerSync && typeof navigator !== 'undefined' && navigator.onLine) {
      void this.syncMessages().catch(() => undefined);
    }
    return message;
  }

  /**
   * Ask any model through Sentence. The server injects what the user already discussed with
   * their other models, and this device keeps its own copy of the exchange.
   */
  async chat(options: ChatOptions): Promise<ChatResult> {
    const messages = options.messages ?? [{ role: 'user' as const, content: options.prompt ?? '' }];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser || !lastUser.content.trim()) {
      throw new Error('chat() needs a prompt or at least one user message');
    }
    const memory = options.memory ?? true;

    // Make sure the server already knows earlier exchanges before it builds the context.
    if (memory) await this.syncMessages().catch(() => undefined);

    const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: options.model,
        messages,
        // The server remembers the exchange (consent permitting); a known thread id continues it.
        sentence: { memory, topic: options.topic, conversation_id: memory ? options.conversationId : undefined },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new SentenceSyncError(`Chat failed with HTTP ${res.status}: ${detail}`.slice(0, 500), res.status);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      sentence?: { provider?: string; model?: string; conversation_id?: string };
    };
    const answer = json.choices?.[0]?.message?.content ?? '';
    const conversationId = json.sentence?.conversation_id ?? options.conversationId ?? this.newConversation();

    if (memory && answer) {
      // Keep this device's own copy. The server already stored the exchange, so mark it synced.
      try {
        const model = json.sentence?.model ?? options.model;
        const provider = json.sentence?.provider ?? inferProvider(options.model);
        const now = Date.now();
        await this.recordMessage(
          { conversationId, model, provider, role: 'user', content: lastUser.content, topic: options.topic, createdAt: new Date(now).toISOString() },
          false,
          'synced',
        );
        await this.recordMessage(
          { conversationId, model, provider, role: 'assistant', content: answer, topic: options.topic, createdAt: new Date(now + 1).toISOString() },
          false,
          'synced',
        );
      } catch {
        // A failed local copy must never turn a successful answer into an error.
      }
    }

    return { answer, conversationId, response: json };
  }

  /** Push queued messages to /v1/memory/messages. Concurrent calls share one in-flight sync. */
  syncMessages(): Promise<SyncResult> {
    if (!this.syncingMessages) {
      this.syncingMessages = this.runMessageSync().finally(() => {
        this.syncingMessages = null;
      });
    }
    return this.syncingMessages;
  }

  /** Sync documents and messages. */
  async syncAll(): Promise<{ documents: SyncResult; messages: SyncResult }> {
    const [documents, messages] = await Promise.all([this.sync(), this.syncMessages()]);
    return { documents, messages };
  }

  private async runMessageSync(): Promise<SyncResult> {
    const db = await this.db();
    let synced = 0;
    let failed = 0;

    for (;;) {
      const [pending, retry] = await Promise.all([
        db.getAllFromIndex('messages', 'by_status', 'pending'),
        db.getAllFromIndex('messages', 'by_status', 'failed'),
      ]);
      const batch = [...pending, ...retry.filter((m) => m.attempts < MAX_ATTEMPTS)]
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, this.batchSize);
      if (batch.length === 0) break;

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/v1/memory/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            items: batch.map((m) => ({
              client_id: m.id,
              conversation_id: m.conversation_id,
              model: m.model,
              provider: m.provider,
              role: m.role,
              content: m.content,
              embedding: m.embedding,
              topic: m.topic,
              created_at: m.created_at,
            })),
          }),
        });
      } catch (err) {
        throw new SentenceSyncError(err instanceof Error ? err.message : 'Network error during sync');
      }
      if (response.status !== 200) {
        throw new SentenceSyncError(`Message sync failed with HTTP ${response.status}`, response.status);
      }

      const payload = (await response.json()) as {
        results: Array<{ client_id: string; status: 'synced' | 'skipped' | 'failed'; error?: string }>;
      };
      const byId = new Map(payload.results.map((r) => [r.client_id, r]));

      // The local copy stays (this device is the user's own record); only its status changes.
      const tx = db.transaction('messages', 'readwrite');
      let progressed = false;
      for (const m of batch) {
        const result = byId.get(m.id);
        if (result && (result.status === 'synced' || result.status === 'skipped')) {
          await tx.store.put({ ...m, status: 'synced' });
          if (result.status === 'synced') synced += 1;
          progressed = true;
        } else {
          await tx.store.put({
            ...m,
            status: 'failed',
            attempts: m.attempts + 1,
            last_error: result?.error ?? 'No result returned for item',
          });
          failed += 1;
        }
      }
      await tx.done;
      if (!progressed) break;
    }

    const db2 = await this.db();
    const remaining =
      (await db2.countFromIndex('messages', 'by_status', 'pending')) +
      (await db2.countFromIndex('messages', 'by_status', 'failed'));
    return { synced, failed, remaining };
  }

  /** Everything this device remembers, e.g. for a "download my data" button. */
  async exportLocal(): Promise<{ documents: StoredDocument[]; messages: LocalMessage[] }> {
    const db = await this.db();
    const [documents, messages] = await Promise.all([db.getAll('documents'), db.getAll('messages')]);
    return {
      documents,
      messages: messages.map((m) => ({ ...m, embedding: [] })),
    };
  }

  /** Server-side whisper for another AI app: what the user did with their other models. */
  async context(query: string, provider: string, conversationId?: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/memory/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query, provider, conversation_id: conversationId }),
    });
    if (!res.ok) throw new SentenceSyncError(`Context lookup failed with HTTP ${res.status}`, res.status);
    return ((await res.json()) as { text: string }).text;
  }

  // --- remote search -------------------------------------------------------

  /** Server-side cosine search using a locally computed query embedding. */
  async search(query: string, limit = 5, threshold = 0): Promise<unknown[]> {
    const embedding = await this.embed(query);
    const res = await this.fetchImpl(`${this.baseUrl}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ embedding, limit, threshold }),
    });
    if (!res.ok) throw new SentenceSyncError(`Search failed with HTTP ${res.status}`, res.status);
    const json = (await res.json()) as { data: unknown[] };
    return json.data;
  }
}
