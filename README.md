# Sentence

**Plaid for AI models.** One API in front of ChatGPT, Claude, Gemini, Groq, Together, OpenRouter, Mistral and any other OpenAI-compatible service, plus on-device models. Sentence keeps a shared memory of what the user asked each model and what it answered, so switching models never means starting over.

```
you ──► ChatGPT: "analyse our Q3 churn"            ┐
you ──► Claude:  "write the code for that analysis" ├─ Sentence passes Claude a short "whisper":
                                                    │  what you asked ChatGPT, what it said, and when
```

## How it works

| Piece | What it does |
|---|---|
| **Gateway** `POST /v1/chat/completions` | OpenAI-compatible. Picks the provider, injects the whisper as a system message, calls the model with the *user's own key*, then records the exchange. |
| **Center brain** (`messages`, `topics`, pgvector) | Every exchange is stored with model, role and time, embedded with `Xenova/all-MiniLM-L6-v2` (384-dim). Exchanges are grouped into topics, each with a rolling summary. |
| **Whisper** (`src/core/whisper.ts`) | Built from the topic's summary and latest exchanges, semantically similar exchanges, and for vague follow-ups ("continue") the last 48 h. Capped by `WHISPER_MAX_CHARS`. Marked as data, not instructions. |
| **Consent** | Cross-model sharing switch, per-model links (read/write/revoke), per-topic grants. Every read is filtered by these. |
| **Bring your own key** `POST /v1/keys` | Users connect the plans they pay for (API keys, AES-256-GCM at rest). |
| **Jobs** `POST /v1/jobs` | Several models on one task; each step sees earlier outputs. Needs `"multi_model": true`. |
| **Offline SDK** (`src/sdk/sentence-client.ts`) | IndexedDB holds documents and messages on the user's device, embeds locally, and syncs when online. |

### Important: API keys, not chat subscriptions
ChatGPT Plus, Claude Pro and Gemini Advanced do **not** include API access. To connect a model to Sentence a user needs that provider's API key (billed per token). Sentence can only remember conversations that pass through it (gateway, SDK, or an imported export).

## Setup

```bash
npm install
cp .env.example .env              # fill SUPABASE_*, PROVIDER_ENCRYPTION_KEY (openssl rand -hex 32)
# Supabase SQL editor: run supabase/migrations/01.sql then 02.sql
npm run create-key                # prints a user id and an sk-sent-... key (shown once)
npm run dev
npm test                          # pure-logic tests, no database needed
```

Try it:

```bash
H='-H "Authorization: Bearer sk-sent-..." -H "Content-Type: application/json"'
# 1. connect two models
curl -X POST localhost:3000/v1/keys $H -d '{"provider":"openai","api_key":"sk-..."}'
curl -X POST localhost:3000/v1/keys $H -d '{"provider":"anthropic","api_key":"sk-ant-..."}'
# 2. talk to the first
curl -X POST localhost:3000/v1/chat/completions $H -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Analyse churn: 4.1% in Q3, 3.2% in Q2"}]}'
# 3. continue with the second; it already knows
curl -X POST localhost:3000/v1/chat/completions $H -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"Write the Python for that analysis"}]}'
```

Response bodies carry `sentence: { provider, model, topic_id, conversation_id, context_items }`. Pass `"sentence": {"memory": false}` for an incognito call, or `"topic"` / `"conversation_id"` to steer where it is filed.

## API

All under `/v1`, `Authorization: Bearer sk-sent-...` (except `GET /health`).

| Endpoint | Purpose |
|---|---|
| `POST /chat/completions` | Chat with any model; streaming supported |
| `GET /models` | Models this user can reach (`provider/model` also works for OpenRouter, Mistral, DeepSeek, xAI, Fireworks, Perplexity, Cerebras, or any service you register with a `base_url`) |
| `POST /keys` `GET /keys` `DELETE /keys/:provider` | Bring-your-own-key |
| `POST /memory/messages` | SDK sync of the offline message queue |
| `POST /memory/context` | The whisper for any AI app: `{query, provider}` |
| `GET /memory/topics` `GET /memory/messages` | Browse memory |
| `GET /memory/export` | Download everything |
| `DELETE /memory/topics/:id` `DELETE /memory` | Delete a topic / all memory (body `{"confirm":"delete-all-memory"}`) |
| `GET/PUT /memory/settings` | Cross-model sharing on/off |
| `GET /links` `PUT /links/:provider` | Connect / restrict / revoke a model |
| `GET /grants` `PUT /grants` `DELETE /grants/:id` | Per-topic allow/deny per model |
| `POST /jobs` `GET /jobs` `GET /jobs/:id` | Multi-model jobs |
| `POST /embeddings` `POST /sync/batch` `POST /search` | Documents (v1): 384-dim embeddings, offline sync, cosine search |

Multi-model job example:

```json
POST /v1/jobs
{ "title": "Churn analysis", "multi_model": true,
  "steps": [
    { "model": "gpt-4o",            "instruction": "Analyse this data and list the findings: ..." },
    { "model": "claude-sonnet-4-5", "instruction": "Write the Python that reproduces the analysis." } ] }
```

## Privacy and security notes
- Memory is stored **readable** in Supabase so the server can search it and serve any device. Use row isolation, keep the service-role key server-side, and offer export/delete (provided). An end-to-end-encrypted tier would move search onto the device and is not built.
- The model the user picks still receives the whisper in its prompt, so that provider sees it.
- With `ALLOW_SERVER_KEYS=true` a user without their own key can use the operator's keys. Set it to `false` when hosting for other people.
- User-supplied `base_url`s must be public https; localhost/private ranges are rejected. This checks the hostname only, not DNS rebinding.
- Jobs run inside the server process; a restart marks unfinished jobs failed.
- Whisper text is untrusted by design (it contains model output): it is fenced, labelled as reference data, and cannot close its own tag.

## Not built yet
Frontend, MCP connector for native ChatGPT/Claude apps, import of chat exports, end-to-end-encrypted tier, request rate limiting, automated integration tests against a live Supabase.
