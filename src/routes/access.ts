import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../lib/errors';
import { getSupabase } from '../lib/supabase';
import { asyncHandler } from '../middleware/async';
import { requireAuth } from '../middleware/auth';

/**
 * Consent controls. Defaults are permissive within a user's own account (their models share
 * memory), and the user can tighten: turn cross-model sharing off, revoke or restrict a model,
 * or allow/deny a model per topic.
 */
export const accessRouter = Router();

const dbFail = (what: string, message: string): HttpError =>
  new HttpError(500, `${what}: ${message}`, 'api_error', 'access_db_error');

const providerName = z
  .string()
  .min(1)
  .max(60)
  .transform((s) => s.toLowerCase());

// Global switch -------------------------------------------------------------------------
accessRouter.get(
  '/memory/settings',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const { data, error } = await getSupabase()
      .from('memory_settings')
      .select('cross_model_sharing')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw dbFail('settings lookup failed', error.message);
    res.json({ cross_model_sharing: data?.cross_model_sharing ?? true });
  }),
);

accessRouter.put(
  '/memory/settings',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const body = z.object({ cross_model_sharing: z.boolean() }).parse(req.body);
    const { error } = await getSupabase()
      .from('memory_settings')
      .upsert(
        { user_id: userId, cross_model_sharing: body.cross_model_sharing, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      );
    if (error) throw dbFail('settings update failed', error.message);
    res.json({ cross_model_sharing: body.cross_model_sharing });
  }),
);

// Model links -----------------------------------------------------------------------------
accessRouter.get(
  '/links',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const { data, error } = await getSupabase()
      .from('model_links')
      .select('provider, status, can_read, can_write, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) throw dbFail('link list failed', error.message);
    res.json({ object: 'list', data: data ?? [] });
  }),
);

accessRouter.put(
  '/links/:provider',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const provider = providerName.parse(req.params.provider);
    const body = z
      .object({
        status: z.enum(['active', 'revoked']).optional(),
        can_read: z.boolean().optional(),
        can_write: z.boolean().optional(),
      })
      .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field' })
      .parse(req.body);
    const { data, error } = await getSupabase()
      .from('model_links')
      .upsert({ user_id: userId, provider, ...body }, { onConflict: 'user_id,provider' })
      .select('provider, status, can_read, can_write')
      .single();
    if (error) throw dbFail('link update failed', error.message);
    res.json(data);
  }),
);

// Per-topic grants ----------------------------------------------------------------------------
accessRouter.get(
  '/grants',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const { data, error } = await getSupabase()
      .from('grants')
      .select('id, provider, topic_id, allowed, created_at')
      .eq('user_id', userId);
    if (error) throw dbFail('grant list failed', error.message);
    res.json({ object: 'list', data: data ?? [] });
  }),
);

accessRouter.put(
  '/grants',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const body = z
      .object({
        provider: providerName,
        /** Omit for a rule covering every topic of this provider. */
        topic_id: z.string().uuid().optional(),
        allowed: z.boolean(),
      })
      .parse(req.body);
    const sb = getSupabase();

    if (body.topic_id) {
      const { data: topic } = await sb
        .from('topics')
        .select('id')
        .eq('id', body.topic_id)
        .eq('user_id', userId)
        .maybeSingle();
      if (!topic) throw new HttpError(404, 'Topic not found', 'invalid_request_error', 'topic_not_found');
    }

    let lookup = sb.from('grants').select('id').eq('user_id', userId).eq('provider', body.provider);
    lookup = body.topic_id ? lookup.eq('topic_id', body.topic_id) : lookup.is('topic_id', null);
    const { data: existing, error: lookupError } = await lookup.maybeSingle();
    if (lookupError) throw dbFail('grant lookup failed', lookupError.message);

    const write = existing
      ? sb.from('grants').update({ allowed: body.allowed }).eq('id', existing.id as string).eq('user_id', userId)
      : sb.from('grants').insert({
          user_id: userId,
          provider: body.provider,
          topic_id: body.topic_id ?? null,
          allowed: body.allowed,
        });
    const { data, error } = await write.select('id, provider, topic_id, allowed').single();
    if (error) throw dbFail('grant write failed', error.message);
    res.json(data);
  }),
);

accessRouter.delete(
  '/grants/:id',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const id = z.string().uuid().parse(req.params.id);
    const { error } = await getSupabase().from('grants').delete().eq('id', id).eq('user_id', userId);
    if (error) throw dbFail('grant delete failed', error.message);
    res.json({ deleted: true, id });
  }),
);
