import { Router } from 'express';
import { z } from 'zod';
import { createJob } from '../core/jobs';
import { HttpError } from '../lib/errors';
import { getSupabase } from '../lib/supabase';
import { asyncHandler } from '../middleware/async';
import { requireAuth } from '../middleware/auth';

/**
 * Multi-model jobs: e.g. step 1 "gpt-4o" analyses the data, step 2 "claude-sonnet-4-5"
 * writes the code for that analysis. Each step sees the earlier steps' outputs, and every
 * exchange lands in the shared memory under the job's topic.
 */
export const jobsRouter = Router();

const createBody = z.object({
  title: z.string().min(1).max(120),
  topic: z.string().min(1).max(120).optional(),
  /** Explicit permission to involve more than one AI provider in this job. */
  multi_model: z.boolean().default(false),
  steps: z
    .array(
      z.object({
        model: z.string().min(1).max(200),
        instruction: z.string().min(1).max(20_000),
      }),
    )
    .min(1)
    .max(10),
});

jobsRouter.post(
  '/jobs',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const body = createBody.parse(req.body);
    const job = await createJob(userId, {
      title: body.title,
      topic: body.topic,
      multiModel: body.multi_model,
      steps: body.steps,
    });
    res.status(202).json({ id: job.id, status: 'queued', poll: `/v1/jobs/${job.id}` });
  }),
);

jobsRouter.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const { data, error } = await getSupabase()
      .from('jobs')
      .select('id, title, status, multi_model, topic_id, error, created_at, finished_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new HttpError(500, 'Could not list jobs', 'api_error', 'job_list_failed');
    res.json({ object: 'list', data: data ?? [] });
  }),
);

jobsRouter.get(
  '/jobs/:id',
  asyncHandler(async (req, res) => {
    const { userId } = requireAuth(req);
    const id = z.string().uuid().parse(req.params.id);
    const sb = getSupabase();
    const { data: job, error } = await sb
      .from('jobs')
      .select('id, title, status, multi_model, topic_id, conversation_id, error, created_at, finished_at')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new HttpError(500, 'Could not load job', 'api_error', 'job_load_failed');
    if (!job) throw new HttpError(404, 'Job not found', 'invalid_request_error', 'job_not_found');
    const { data: steps } = await sb
      .from('job_steps')
      .select('idx, model, instruction, status, output, error, started_at, finished_at')
      .eq('job_id', id)
      .order('idx', { ascending: true });
    res.json({ ...job, steps: steps ?? [] });
  }),
);
