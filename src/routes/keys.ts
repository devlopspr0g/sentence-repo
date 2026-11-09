import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { encryptSecret } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { getSupabase } from '../lib/supabase';
import { assertSafeBaseUrl } from '../lib/url';
import { asyncHandler } from '../middleware/async';
import { requireAuth } from '../middleware/auth';
import { invalidateCredentials } from '../providers/credentials';
import { KNOWN_PROVIDERS, PROVIDER_PRESETS } from '../providers/presets';

/** Bring-your-own-key: users connect the AI plans they pay for. Keys are stored encrypted. */
export const keysRouter = Router();

const providerName = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{2,40}$/, 'provider must be 2-40 letters, digits, "_" or "-"')
  .transform((s) => s.toLowerCase());

const putBody = z.object({
  provider: providerName,
  api_key: z.string().min(8).max(500),
  /** Needed only for providers that are not built in or in the preset list. */
  base_url: z.string().url().max(300).optional(),
});

keysRouter.post(
  '/keys',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    if (!config.providerEncryptionKey) {
      throw new HttpError(
        503,
        'Key storage is disabled: the server has no PROVIDER_ENCRYPTION_KEY',
        'api_error',
        'key_storage_disabled',
      );
    }
    const body = putBody.parse(req.body);
    if (body.provider === 'local' || body.provider === 'auto' || body.provider === 'sentence') {
      throw new HttpError(400, `"${body.provider}" is reserved`, 'invalid_request_error', 'reserved_provider');
    }

    const known =
      (KNOWN_PROVIDERS as readonly string[]).includes(body.provider) || body.provider in PROVIDER_PRESETS;
    if (!known && !body.base_url) {
      throw new HttpError(
        400,
        `"${body.provider}" is not a built-in provider, so "base_url" (public https, OpenAI-compatible) is required`,
        'invalid_request_error',
        'base_url_required',
      );
    }
    const baseUrl = body.base_url ? assertSafeBaseUrl(body.base_url) : null;

    const { error } = await getSupabase()
      .from('user_provider_keys')
      .upsert(
        {
          user_id: userId,
          provider: body.provider,
          api_key_encrypted: encryptSecret(body.api_key, config.providerEncryptionKey),
          key_last4: body.api_key.slice(-4),
          base_url: baseUrl,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,provider' },
      );
    if (error) throw new HttpError(500, 'Could not save key', 'api_error', 'key_save_failed');
    invalidateCredentials(userId, body.provider);

    res.status(201).json({
      provider: body.provider,
      key_last4: body.api_key.slice(-4),
      base_url: baseUrl,
      usage: known && !body.base_url ? 'use the provider\'s normal model ids' : `use "${body.provider}/<model>"`,
    });
  }),
);

keysRouter.get(
  '/keys',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const { data, error } = await getSupabase()
      .from('user_provider_keys')
      .select('provider, key_last4, base_url, created_at, updated_at')
      .eq('user_id', userId)
      .order('provider', { ascending: true });
    if (error) throw new HttpError(500, 'Could not list keys', 'api_error', 'key_list_failed');
    res.json({ object: 'list', data: data ?? [] });
  }),
);

keysRouter.delete(
  '/keys/:provider',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const provider = providerName.parse(req.params.provider);
    const { error } = await getSupabase()
      .from('user_provider_keys')
      .delete()
      .eq('user_id', userId)
      .eq('provider', provider);
    if (error) throw new HttpError(500, 'Could not delete key', 'api_error', 'key_delete_failed');
    invalidateCredentials(userId, provider);
    res.json({ deleted: true, provider });
  }),
);
