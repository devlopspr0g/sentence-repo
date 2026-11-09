/**
 * Import your ChatGPT or Claude history into Sentence's shared memory.
 *
 *   npm run import-export -- <file-or-folder>... [options]
 *
 * Options
 *   --source chatgpt|claude   Force the export type (default: detected from the file)
 *   --url <base url>          Sentence server (default: $SENTENCE_URL or http://localhost:3000)
 *   --key <sk-sent-...>       Sentence API key (default: $SENTENCE_API_KEY)
 *   --since YYYY-MM-DD        Only import messages on or after this date
 *   --dry-run                 Parse and report; send nothing
 *
 * How to get the files: ChatGPT: Settings > Data controls > Export data. Claude: Settings >
 * Privacy > Export data. Unzip the email attachment and pass conversations.json (or the folder).
 * Re-running is safe: every message has a stable id, so nothing is duplicated.
 */
import 'dotenv/config';
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  ImportConversation,
  ImportSource,
  parseExport,
  SyncItem,
  toSyncItems,
} from '../src/import/parsers';

const BATCH = 25;
const MAX_ATTEMPTS = 4;

interface Args {
  paths: string[];
  source?: ImportSource;
  url: string;
  key: string;
  since?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    paths: [],
    url: process.env.SENTENCE_URL ?? 'http://localhost:3000',
    key: process.env.SENTENCE_API_KEY ?? '',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--source') {
      const v = next();
      if (v !== 'chatgpt' && v !== 'claude') throw new Error('--source must be chatgpt or claude');
      args.source = v;
    } else if (a === '--url') args.url = next();
    else if (a === '--key') args.key = next();
    else if (a === '--since') {
      const v = next();
      if (Number.isNaN(new Date(v).getTime())) throw new Error('--since must be a date like 2025-01-31');
      args.since = new Date(v).toISOString();
    } else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else args.paths.push(a);
  }
  if (args.paths.length === 0) throw new Error('Give at least one conversations.json file or folder');
  if (!args.dryRun && !args.key) throw new Error('Missing API key: use --key or set SENTENCE_API_KEY');
  return args;
}

/** Expand folders into their conversations*.json files (newer ChatGPT exports are split). */
function collectFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      const found = readdirSync(p)
        .filter((f) => /^conversations.*\.json$/i.test(f))
        .sort()
        .map((f) => join(p, f));
      if (found.length === 0) throw new Error(`No conversations*.json found in ${p}`);
      files.push(...found);
    } else {
      files.push(p);
    }
  }
  return files;
}

interface BatchResult {
  synced: number;
  skipped: number;
  failed: number;
  errors: string[];
}

async function sendBatch(args: Args, items: SyncItem[]): Promise<BatchResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${args.url.replace(/\/$/, '')}/v1/memory/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.key}` },
        body: JSON.stringify({ items, skip_summaries: true }),
      });
      if (res.status === 401) throw new Error('The API key was rejected (401). Check --key.');
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) throw new RetryableError(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`Server answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as {
        synced: number;
        skipped: number;
        failed: number;
        results: Array<{ status: string; error?: string }>;
      };
      return {
        synced: body.synced,
        skipped: body.skipped,
        failed: body.failed,
        errors: body.results.filter((r) => r.status === 'failed').map((r) => r.error ?? 'unknown error'),
      };
    } catch (err) {
      const retryable = err instanceof RetryableError || err instanceof TypeError; // TypeError = network error
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      const wait = 1000 * 2 ** (attempt - 1);
      console.warn(`  retrying in ${wait / 1000}s (${err instanceof Error ? err.message : err})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

class RetryableError extends Error {}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Ties imported conversation ids to this key so two users importing the same file never collide.
  const salt = createHash('sha256').update(args.key || 'dry-run').digest('hex').slice(0, 16);

  const conversations: ImportConversation[] = [];
  for (const file of collectFiles(args.paths)) {
    const parsed = parseExport(JSON.parse(readFileSync(file, 'utf8')), args.source);
    console.log(`${file}: ${parsed.length} conversations (${parsed[0]?.source ?? 'empty'})`);
    conversations.push(...parsed);
  }

  let items: SyncItem[] = conversations.flatMap((c) => toSyncItems(c, salt));
  if (args.since) items = items.filter((i) => i.created_at >= (args.since as string));
  const threads = new Set(items.map((i) => i.conversation_id)).size;
  console.log(`\n${items.length} messages in ${threads} conversations ready to import.`);

  if (args.dryRun) {
    console.log('Dry run: nothing was sent.');
    return;
  }
  if (items.length === 0) return;

  const total: BatchResult = { synced: 0, skipped: 0, failed: 0, errors: [] };
  for (let i = 0; i < items.length; i += BATCH) {
    const result = await sendBatch(args, items.slice(i, i + BATCH));
    total.synced += result.synced;
    total.skipped += result.skipped;
    total.failed += result.failed;
    total.errors.push(...result.errors);
    const done = Math.min(i + BATCH, items.length);
    process.stdout.write(`\r  ${done}/${items.length} sent`);
  }
  console.log(
    `\n\nImported: ${total.synced} (re-sent messages are recognised and not duplicated)` +
      `  Blocked by your consent settings: ${total.skipped}  Failed: ${total.failed}`,
  );
  if (total.errors.length > 0) {
    console.log('First errors:');
    for (const e of [...new Set(total.errors)].slice(0, 5)) console.log(`  - ${e}`);
  }
  if (total.skipped > 0) {
    console.log('Some messages were skipped because writing is turned off for that provider (see /v1/links).');
  }
  console.log('Summaries for imported topics are written the next time you chat in each topic.');
}

main().catch((err: unknown) => {
  console.error(`\nError: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
