import type { RequestHandler } from 'express';
import { sha256Hex } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { getSupabase } from '../lib/supabase';
import { asyncHandler } from './async';

export interface AuthContext {
  userId: string;
  apiKeyId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** Authenticate `Authorization: Bearer sk-sent-...` against the hashed api_keys table. */
export const authenticate: RequestHandler = asyncHandler(async (req, _res, next) => {
  const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
  if (!match) {
    throw new HttpError(401, 'Missing API key. Send "Authorization: Bearer sk-sent-..."', 'authentication_error', 'missing_api_key');
  }
  const key = match[1];
  if (!key.startsWith('sk-sent-')) {
    throw new HttpError(401, 'Invalid API key format', 'authentication_error', 'invalid_api_key');
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, user_id, is_active')
    .eq('key_hash', sha256Hex(key))
    .maybeSingle();

  if (error) {
    throw new HttpError(500, 'Could not verify API key', 'api_error', 'auth_lookup_failed');
  }
  if (!data || !data.is_active) {
    throw new HttpError(401, 'Invalid or revoked API key', 'authentication_error', 'invalid_api_key');
  }

  req.auth = { userId: data.user_id as string, apiKeyId: data.id as string };

  // Fire-and-forget usage stamp.
  void Promise.resolve(
    supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id),
  ).catch(() => undefined);

  next();
});

export function requireAuth(req: Express.Request): AuthContext {
  if (!req.auth) throw new HttpError(401, 'Not authenticated', 'authentication_error', 'unauthenticated');
  return req.auth;
}
