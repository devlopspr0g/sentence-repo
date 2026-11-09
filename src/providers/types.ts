export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  /** Internal, set by the server after authentication (never read from the client body). */
  userId?: string;
  /** Internal, set when the call is a step of a multi-model job. */
  jobId?: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type FinishReason = 'stop' | 'length' | 'content_filter' | null;

/** Non-standard extension describing how Sentence routed the call. */
export interface RouteInfo {
  provider: string;
  model: string;
  fallback: boolean;
  /** Memory metadata added by the gateway. */
  topic_id?: string;
  conversation_id?: string;
  context_items?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: FinishReason;
  }>;
  usage: Usage;
  sentence?: RouteInfo;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: 'assistant'; content?: string };
    finish_reason: FinishReason;
  }>;
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
}

export interface EmbeddingResponse {
  object: 'list';
  data: Array<{ object: 'embedding'; index: number; embedding: number[] }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

export interface TranscriptionRequest {
  model: string;
  /** 16 kHz mono PCM samples, or a URL/path readable by transformers.js. */
  audio: Float32Array | string;
  language?: string;
}

export interface TranscriptionResponse {
  text: string;
}

export type ModelType = 'chat' | 'embedding' | 'image' | 'audio';
export type ModelSource = 'cloud' | 'transformers.js' | 'local-engine';

export interface ModelInfo {
  id: string;
  type: ModelType;
  source: ModelSource;
  provider: string;
  capabilities: Record<string, unknown>;
}

export interface IAdapter {
  readonly name: string;
  /** Whether this adapter owns the given model id. */
  supports(model: string): boolean;
  /** Whether the adapter can currently serve requests (credentials present, etc.). */
  isAvailable(userId?: string): Promise<boolean>;
  listModels(): ModelInfo[];
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  chatStream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk>;
  embeddings?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  transcribe?(request: TranscriptionRequest): Promise<TranscriptionResponse>;
}
