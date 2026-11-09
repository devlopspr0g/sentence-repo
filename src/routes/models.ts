import { Router } from 'express';
import { router as modelRouter } from '../core/router';
import { asyncHandler } from '../middleware/async';

export const modelsRouter = Router();

modelsRouter.get(
  '/models',
  asyncHandler(async (req, res) => {
    const models = await modelRouter.listModels(req.auth?.userId);
    res.json({
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: m.provider,
        type: m.type,
        source: m.source,
        capabilities: m.capabilities,
      })),
    });
  }),
);
