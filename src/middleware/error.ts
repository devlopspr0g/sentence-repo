import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors';

export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, `Route ${req.method} ${req.path} not found`, 'invalid_request_error', 'route_not_found'));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let http: HttpError;

  if (err instanceof HttpError) {
    http = err;
  } else if (err instanceof ZodError) {
    const detail = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    http = new HttpError(400, `Invalid request: ${detail}`, 'invalid_request_error', 'validation_error');
  } else if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
    http = new HttpError(400, 'Request body is not valid JSON', 'invalid_request_error', 'invalid_json');
  } else if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.too.large') {
    http = new HttpError(413, 'Request body too large', 'invalid_request_error', 'payload_too_large');
  } else {
    console.error('[error]', err);
    http = new HttpError(500, 'Internal server error', 'api_error', 'internal_error');
  }

  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(http.status).json(http.toJSON());
};
