import { Router } from 'express';
import { z } from 'zod';
import { searchDocuments } from '../core/vectorSearch';
import { asyncHandler } from '../middleware/async';
import { requireAuth } from '../middleware/auth';

const bodySchema = z
  .object({
    query: z.string().min(1).optional(),
    embedding: z.array(z.number()).optional(),
    limit: z.number().int().min(1).max(50).default(5),
    threshold: z.number().min(-1).max(1).default(0),
  })
  .refine((b) => b.query !== undefined || b.embedding !== undefined, {
    message: 'Provide "query" or "embedding"',
  });

export const searchRouter = Router();

searchRouter.post(
  '/search',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const body = bodySchema.parse(req.body);
    res.locals.model = 'local-all-minilm-l6-v2';
    res.locals.provider = 'local';

    const hits = await searchDocuments({
      userId,
      query: body.query,
      embedding: body.embedding,
      limit: body.limit,
      threshold: body.threshold,
    });

    res.json({ object: 'list', data: hits });
  }),
);
