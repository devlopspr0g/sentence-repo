-- Sentence v2: the "center brain" (cross-model memory), consent controls,
-- per-user provider keys and multi-model jobs.
-- Every embedding is still Xenova/all-MiniLM-L6-v2 => vector(384).

-- Topics: one rolling summary per subject the user works on ---------------------
create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  summary text not null default '',
  summarized_message_count integer not null default 0,
  summary_updated_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists topics_user_name_idx on public.topics (user_id, name);

-- Conversations: a thread with one or more models --------------------------------
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  topic_id uuid references public.topics (id) on delete set null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversations_user_idx on public.conversations (user_id, updated_at desc);

-- Jobs: several models working on one task (only with the user's permission) ----
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null,
  topic_id uuid references public.topics (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  multi_model boolean not null default false,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists jobs_user_idx on public.jobs (user_id, created_at desc);

create table if not exists public.job_steps (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  idx integer not null,
  model text not null,
  instruction text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  output text,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  unique (job_id, idx)
);

-- Messages: who was asked what, which model answered, and when ---------------------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  topic_id uuid references public.topics (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  job_id uuid references public.jobs (id) on delete set null,
  client_id text,
  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  provider text not null default 'unknown',
  model text,
  content text not null,
  embedding vector(384),                        -- null only if the embedder was unavailable
  source text not null default 'gateway'
    check (source in ('gateway', 'sdk', 'connector', 'job', 'import')),
  created_at timestamptz not null default now(),
  unique (user_id, client_id)                   -- idempotent sync (NULL client_ids never collide)
);
create index if not exists messages_topic_idx on public.messages (user_id, topic_id, created_at desc);
create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at);
create index if not exists messages_recent_idx on public.messages (user_id, created_at desc);
create index if not exists messages_embedding_hnsw_idx
  on public.messages using hnsw (embedding vector_cosine_ops);

-- Consent: global switch, per-model links, per-topic grants -----------------------
create table if not exists public.memory_settings (
  user_id uuid primary key,
  cross_model_sharing boolean not null default true,   -- false = each model only sees its own history
  updated_at timestamptz not null default now()
);

create table if not exists public.model_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  can_read boolean not null default true,
  can_write boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, provider)
);

create table if not exists public.grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,
  topic_id uuid references public.topics (id) on delete cascade,   -- null = provider-wide
  allowed boolean not null,
  created_at timestamptz not null default now()
);
create unique index if not exists grants_unique_idx
  on public.grants (user_id, provider, coalesce(topic_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Per-user provider keys (AES-256-GCM with PROVIDER_ENCRYPTION_KEY) ----------------
create table if not exists public.user_provider_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,
  api_key_encrypted text not null,
  key_last4 text not null default '',
  base_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

-- Semantic recall over messages (cosine) --------------------------------------------
create or replace function public.match_messages(
  query_embedding vector(384),
  filter_user_id uuid,
  match_count integer default 8,
  match_threshold double precision default 0.0,
  include_topic_ids uuid[] default null
)
returns table (
  id uuid,
  topic_id uuid,
  conversation_id uuid,
  role text,
  provider text,
  model text,
  content text,
  created_at timestamptz,
  similarity double precision
)
language sql stable
as $$
  select
    m.id, m.topic_id, m.conversation_id, m.role, m.provider, m.model, m.content, m.created_at,
    1 - (m.embedding <=> query_embedding) as similarity
  from public.messages m
  where m.user_id = filter_user_id
    and m.embedding is not null
    and (include_topic_ids is null or m.topic_id = any (include_topic_ids))
    and 1 - (m.embedding <=> query_embedding) >= match_threshold
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

-- Hardening for v1: a null user filter must never return every user's documents.
create or replace function public.match_documents(
  query_embedding vector(384),
  match_count integer default 5,
  match_threshold double precision default 0.0,
  filter_user_id uuid default null
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  created_at timestamptz,
  similarity double precision
)
language sql stable
as $$
  select
    d.id, d.content, d.metadata, d.created_at,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where d.user_id = filter_user_id
    and 1 - (d.embedding <=> query_embedding) >= match_threshold
  order by d.embedding <=> query_embedding
  limit match_count;
$$;

alter table public.topics enable row level security;
alter table public.conversations enable row level security;
alter table public.jobs enable row level security;
alter table public.job_steps enable row level security;
alter table public.messages enable row level security;
alter table public.memory_settings enable row level security;
alter table public.model_links enable row level security;
alter table public.grants enable row level security;
alter table public.user_provider_keys enable row level security;
