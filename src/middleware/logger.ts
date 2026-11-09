import type { RequestHandler } from 'express';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';

/** Best-effort request log into request_logs; never affects the response. */
export const requestLogger: RequestHandler = (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (!isSupabaseConfigured() || !req.originalUrl.startsWith('/v1')) return;
    const row = {
      user_id: req.auth?.userId ?? null,
      endpoint: `${req.method} ${req.baseUrl}${req.path}`,
      model: (res.locals.model as string | undefined) ?? null,
      provider: (res.locals.provider as string | undefined) ?? null,
      status_code: res.statusCode,
      latency_ms: Date.now() - started,
      error: res.statusCode >= 400 ? ((res.locals.errorMessage as string | undefined) ?? null) : null,
    };
    void Promise.resolve(getSupabase().from('request_logs').insert(row)).catch(() => undefined);
  });
  next();
};
