import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';
import { HttpError } from './errors';

let client: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
}

/** Service-role client (server only; never expose this key to browsers). */
export function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new HttpError(
      503,
      'Supabase is not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)',
      'api_error',
      'supabase_not_configured',
    );
  }
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** pgvector accepts the text form `[0.1,0.2,...]`. */
export const toPgVector = (vector: number[]): string => `[${vector.join(',')}]`;
