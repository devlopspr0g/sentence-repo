import { randomUUID } from 'crypto';
import type { ChatCompletionChunk, FinishReason } from './types';

export const completionId = (): string => `chatcmpl-${randomUUID().replace(/-/g, '')}`;
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export function makeChunk(
  id: string,
  created: number,
  model: string,
  delta: { role?: 'assistant'; content?: string },
  finishReason: FinishReason = null,
): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Split text into word-sized pieces, keeping trailing whitespace so joins are lossless. */
export function chunkWords(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

export function normalizeStop(stop: string | string[] | undefined): string[] {
  if (!stop) return [];
  return (Array.isArray(stop) ? stop : [stop]).filter((s) => s.length > 0);
}

/** Truncate text at the earliest occurrence of any stop sequence. */
export function applyStop(text: string, stop: string | string[] | undefined): string {
  let cut = text.length;
  for (const s of normalizeStop(stop)) {
    const idx = text.indexOf(s);
    if (idx !== -1 && idx < cut) cut = idx;
  }
  return text.slice(0, cut);
}

export const estimateTokens =(text: string): number => Math.max(1, Math.ceil(text.length / 4));
