import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import { errorHandler, notFound } from './middleware/error';
import { authenticate } from './middleware/auth';
import { requestLogger } from './middleware/logger';
import { accessRouter } from './routes/access';
import { chatRouter } from './routes/chat';
import { embeddingsRouter } from './routes/embeddings';
import { healthRouter } from './routes/health';
import { jobsRouter } from './routes/jobs';
import { keysRouter } from './routes/keys';
import { memoryRouter } from './routes/memory';
import { modelsRouter } from './routes/models';
import { searchRouter } from './routes/search';
import { syncRouter } from './routes/sync';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Public
  app.use(healthRouter);

  // Authenticated OpenAI-compatible API
  app.use('/v1', authenticate, requestLogger);
  app.use('/v1', chatRouter);
  app.use('/v1', embeddingsRouter);
  app.use('/v1', syncRouter);
  app.use('/v1', searchRouter);
  app.use('/v1', modelsRouter);
  app.use('/v1', memoryRouter);
  app.use('/v1', accessRouter);
  app.use('/v1', keysRouter);
  app.use('/v1', jobsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
