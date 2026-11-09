import { Router } from 'express';
import { z } from 'zod';
import { finish, GatewayOptions, prepare, runChat } from '../core/gateway';
import { router as modelRouter } from '../core/router';
import { asyncHandler } from '../middleware/async';
import { requireAuth } from '../middleware/auth';
import type { ChatCompletionChunk, ChatCompletionRequest } from '../providers/types';

const contentSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
]);

/** Sentence extension: `"sentence": { "memory": true, "topic": "...", "conversation_id": "..." }`. */
const sentenceSchema = z
  .object({
    /** false = incognito: nothing is read from or written to the shared memory. */
    memory: z.boolean().default(true),
    topic: z.string().min(1).max(120).optional(),
    conversation_id: z.string().uuid().optional(),
  })
  .default({});

const bodySchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: contentSchema,
        name: z.string().optional(),
      }),
    )
    .min(1),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().max(32_768).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(8)]).optional(),
  sentence: sentenceSchema,
});

/** Flatten OpenAI "content parts" into plain text. */
function flatten(content: z.infer<typeof contentSchema>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}

export const chatRouter = Router();

chatRouter.post(
  '/chat/completions',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const body = bodySchema.parse(req.body);
    const request: ChatCompletionRequest = {
      model: body.model,
      stream: body.stream,
      temperature: body.temperature,
      top_p: body.top_p,
      max_tokens: body.max_tokens,
      stop: body.stop,
      messages: body.messages.map((m) => ({ role: m.role, content: flatten(m.content), name: m.name })),
    };
    const options: GatewayOptions = {
      memory: body.sentence.memory,
      topic: body.sentence.topic,
      conversationId: body.sentence.conversation_id,
    };
    res.locals.model = request.model;

    if (!request.stream) {
      const completion = await runChat(userId, request, options);
      res.locals.provider = completion.sentence?.provider;
      res.json(completion);
      return;
    }

    // Prepare memory, then pull the first chunk before sending headers so early failures
    // (bad model, missing key) still return a normal JSON error.
    const { request: prepared, ctx } = await prepare(userId, request, options);
    const iterator = modelRouter.chatStream(prepared)[Symbol.asyncIterator]();
    const first = await iterator.next();

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(ctx?.conversationId ? { 'X-Sentence-Conversation-Id': ctx.conversationId } : {}),
      ...(ctx?.topicId ? { 'X-Sentence-Topic-Id': ctx.topicId } : {}),
      'X-Sentence-Context-Items': String(ctx?.contextItems ?? 0),
    });
    res.flushHeaders();

    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) clientGone = true;
    });

    let text = '';
    let servedModel = request.model;
    try {
      let step = first;
      while (!step.done && !clientGone) {
        const chunk: ChatCompletionChunk = step.value;
        text += chunk.choices[0]?.delta?.content ?? '';
        servedModel = chunk.model || servedModel;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        step = await iterator.next();
      }
      if (clientGone) {
        await iterator.return?.(undefined);
      } else {
        res.write('data: [DONE]\n\n');
        // Only complete exchanges are remembered, never half-streamed ones.
        await finish(ctx, { text, provider: ctx?.provider ?? 'unknown', model: servedModel });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Stream failed';
      res.write(`data: ${JSON.stringify({ error: { message, type: 'api_error', code: 'stream_error' } })}\n\n`);
      res.write('data: [DONE]\n\n');
    } finally {
      res.end();
    }
  }),
);
