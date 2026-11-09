import { config } from '../config';
import { decryptSecret } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';

export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string;
}

const TTL_MS = 60_000;
const cache = new Map<string, { value: ProviderCredentials; expires: number }>();

const cacheKey = (userId: string | undefined, provider: string): string => `${userId ?? 'server'}:${provider}`;

/** Drop a cached credential after the user adds, changes or removes a key. */
export function invalidateCredentials(userId: string, provider: string): void {
  cache.delete(cacheKey(userId, provider));
}

async function userKey(userId: string, provider: string): Promise<ProviderCredentials | null> {
  if (!isSupabaseConfigured() || !config.providerEncryptionKey) return null;
  try {
    const { data } = await getSupabase()
      .from('user_provider_keys')
      .select('api_key_encrypted, base_url')
      .eq('user_id', userId)
      .eq('provider', provider)
      .maybeSingle();
    if (!data) return null;
    return {
      apiKey: decryptSecret(data.api_key_encrypted as string, config.providerEncryptionKey),
      baseUrl: (data.base_url as string | null) ?? undefined,
    };
  } catch {
    return null;
  }
}

type DbLookup =
  | { state: 'found'; creds: ProviderCredentials }
  | { state: 'disabled' }
  | { state: 'missing' };

async function serverDatabaseKey(provider: string): Promise<DbLookup> {
  if (!isSupabaseConfigured()) return { state: 'missing' };
  try {
    const { data, error } = await getSupabase()
      .from('providers')
      .select('api_key_encrypted, base_url, is_active')
      .eq('name', provider)
      .maybeSingle();
    if (error || !data) return { state: 'missing' };
    if (!data.is_active) return { state: 'disabled' };
    if (!data.api_key_encrypted) return { state: 'missing' };
    const apiKey = decryptSecret(data.api_key_encrypted as string, config.providerEncryptionKey);
    return {
      state: 'found',
      creds: { apiKey, baseUrl: (data.base_url as string | null) ?? undefined },
    };
  } catch {
    return { state: 'missing' };
  }
}

/**
 * Resolve credentials for a request:
 *  1. the calling user's own key (user_provider_keys),
 *  2. then the operator's `providers` row and environment keys, but only when there is no
 *     user (internal calls) or ALLOW_SERVER_KEYS is true.
 */
export async function getCredentials(provider: string, userId?: string): Promise<ProviderCredentials> {
  const key = cacheKey(userId, provider);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  if (userId) {
    const own = await userKey(userId, provider);
    if (own) {
      cache.set(key, { value: own, expires: Date.now() + TTL_MS });
      return own;
    }
    if (!config.allowServerKeys) {
      throw new HttpError(
        503,
        `No API key for "${provider}". Add yours with POST /v1/keys.`,
        'api_error',
        'provider_not_configured',
      );
    }
  }

  const db = await serverDatabaseKey(provider);
  if (db.state === 'disabled') {
    throw new HttpError(503, `Provider "${provider}" is disabled`, 'api_error', 'provider_disabled');
  }

  let creds: ProviderCredentials | null = db.state === 'found' ? db.creds : null;
  if (!creds) {
    const envKey = config.providerEnvKeys[provider];
    if (envKey) creds = { apiKey: envKey };
  }
  if (!creds) {
    throw new HttpError(
      503,
      `Provider "${provider}" has no API key configured. Add yours with POST /v1/keys.`,
      'api_error',
      'provider_not_configured',
    );
  }

  cache.set(key, { value: creds, expires: Date.now() + TTL_MS });
  return creds;
}

export async function hasCredentials(provider: string, userId?: string): Promise<boolean> {
  try {
    await getCredentials(provider, userId);
    return true;
  } catch {
    return false;
  }
}
