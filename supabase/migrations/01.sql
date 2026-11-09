-- Sentence core schema. All embeddings are Xenova/all-MiniLM-L6-v2 => exactly 384 dimensions.

create extension if not exists vector;
create extension if not exists pgcrypto;

-- Documents ---------------------------------------------------------------
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  content text not null,
  embedding vector(384) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists documents_user_idx on public.documents (user_id);
create index if not exists documents_embedding_hnsw_idx
  on public.documents using hnsw (embedding vector_cosine_ops);

-- Offline sync queue ------------------------------------------------------
create table if not exists public.embedding_queue (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  user_id uuid not null,
  content text not null,
  embedding vector(384),
  status text not null default 'pending' check (status in ('pending', 'synced', 'failed')),
  created_at timestamptz not null default now(),
  synced_at timestamptz,
  unique (user_id, client_id)
);

create index if not exists embedding_queue_status_idx on public.embedding_queue (status);

-- API keys ----------------------------------------------------------------
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  key_hash text not null unique,           -- sha256 hex of the full key
  key_prefix text not null,                -- e.g. sk-sent-ab12
  name text not null default 'default',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists api_keys_user_idx on public.api_keys (user_id);

-- Providers ---------------------------------------------------------------
create table if not exists public.providers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  api_key_encrypted text,
  base_url text,
  is_active boolean not null default true,
  priority integer not null default 100,
  models jsonb not null default '[]'::jsonb,
  type text not null default 'cloud' check (type in ('cloud', 'local'))
);

-- Models registry ---------------------------------------------------------
create table if not exists public.models_registry (
  id uuid primary key default gen_random_uuid(),
  model_id text not null unique,
  provider_id uuid references public.providers (id) on delete set null,
  type text not null check (type in ('chat', 'embedding', 'image', 'audio')),
  capabilities jsonb not null default '{}'::jsonb,
  source text not null check (source in ('cloud', 'transformers.js', 'local-engine'))
);

create index if not exists models_registry_provider_idx on public.models_registry (provider_id);

-- Local model cache bookkeeping -------------------------------------------
create table if not exists public.local_models_cache (
  id uuid primary key default gen_random_uuid(),
  model_id text not null unique,
  hf_repo text not null,
  task text not null,
  size_bytes bigint,
  last_loaded_at timestamptz,
  load_count integer not null default 0
);

-- Logs --------------------------------------------------------------------
create table if not exists public.request_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  endpoint text not null,
  model text,
  provider text,
  status_code integer,
  latency_ms integer,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists request_logs_user_idx on public.request_logs (user_id, created_at desc);

create table if not exists public.sync_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  received integer not null default 0,
  accepted integer not null default 0,
  rejected integer not null default 0,
  details jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- Seed registry for local models -------------------------------------------
insert into public.providers (name, type, priority, is_active)
values ('local', 'local', 1000, true)
on conflict (name) do nothing;

insert into public.models_registry (model_id, provider_id, type, capabilities, source)
select m.model_id, p.id, m.type, m.capabilities::jsonb, 'transformers.js'
from public.providers p
cross join (values
  ('local-all-minilm-l6-v2', 'embedding', '{"dimensions":384}'),
  ('local-whisper-tiny', 'audio', '{"transcription":true}'),
  ('local-qwen2-0.5b-instruct', 'chat', '{"streaming":true}')
) as m(model_id, type, capabilities)
where p.name = 'local'
on conflict (model_id) do nothing;

-- Cosine similarity search -------------------------------------------------
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
    d.id,
    d.content,
    d.metadata,
    d.created_at,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where (filter_user_id is null or d.user_id = filter_user_id)
    and 1 - (d.embedding <=> query_embedding) >= match_threshold
  order by d.embedding <=> query_embedding
  limit match_count;
$$;

-- Row level security: server uses the service role; block direct client access.
alter table public.documents enable row level security;
alter table public.embedding_queue enable row level security;
alter table public.api_keys enable row level security;
alter table public.providers enable row level security;
alter table public.models_registry enable row level security;
alter table public.local_models_cache enable row level security;
alter table public.request_logs enable row level security;
alter table public.sync_logs enable row level security;
