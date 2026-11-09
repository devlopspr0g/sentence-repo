import { Router } from 'express';
import { z } from 'zod';
import { config, EMBEDDING_DIM } from '../config';
import { EmbeddingService } from '../core/embeddings';
import { HttpError } from '../lib/errors';
import { asyncHandler } from '../middleware/async';
import { localAdapter } from '../providers/local.adapter';

const MODEL_ID = 'local-all-minilm-l6-v2';
const ACCEPTED_MODELS = new Set([MODEL_ID, 'Xenova/all-MiniLM-L6-v2']);

const bodySchema = z
  .object({
    model: z.string().optional(),
    input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /** Validate-only mode: one vector or a list of vectors computed elsewhere (e.g. the browser SDK). */
    embedding: z.union([z.array(z.number()), z.array(z.array(z.number()))]).optional(),
    encoding_format: z.enum(['float', 'base64']).optional(),
  })
  .refine((b) => b.input !== undefined || b.embedding !== undefined, {
    message: 'Provide "input" to generate embeddings or "embedding" to validate them',
  });

const toBase64 = (vector: number[]): string => Buffer.from(new Float32Array(vector).buffer).toString('base64');

export const embeddingsRouter = Router();

embeddingsRouter.post(
  '/embeddings',
  asyncHandler(async (req, res) => {
    const body = bodySchema.parse(req.body);

    if (body.model && !ACCEPTED_MODELS.has(body.model)) {
      throw new HttpError(
        400,
        `Unsupported embedding model "${body.model}". Sentence uses a single 384-dim model: "${MODEL_ID}".`,
        'invalid_request_error',
        'unsupported_embedding_model',
      );
    }
    res.locals.model = MODEL_ID;
    res.locals.provider = 'local';

    let vectors: number[][];
    let promptTokens = 0;

    if (body.embedding !== undefined) {
      const candidates = (
        Array.isArray(body.embedding[0]) ? body.embedding : [body.embedding]
      ) as number[][];
      candidates.forEach((candidate, index) => {
        const size = candidate.length;
        if (!EmbeddingService.isValidEmbedding(candidate)) {
          throw new HttpError(
            422,
            `embedding[${index}] must be exactly ${EMBEDDING_DIM} finite numbers (got ${size})`,
            'invalid_request_error',
            'invalid_embedding_dimensions',
          );
        }
      });
      vectors = candidates;
    } else {
      const inputs = Array.isArray(body.input) ? body.input : [body.input as string];
      if (inputs.length > config.maxEmbeddingInputs) {
        throw new HttpError(
          400,
          `Too many inputs (max ${config.maxEmbeddingInputs})`,
          'invalid_request_error',
          'too_many_inputs',
        );
      }
      const result = await localAdapter.embeddings({ model: MODEL_ID, input: inputs });
      vectors = result.data.map((d) => d.embedding);
      promptTokens = result.usage.prompt_tokens;
    }

    const base64 = body.encoding_format === 'base64';
    res.json({
      object: 'list',
      data: vectors.map((embedding, index) => ({
        object: 'embedding',
        index,
        embedding: base64 ? toBase64(embedding) : embedding,
      })),
      model: MODEL_ID,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    });
  }),
);
