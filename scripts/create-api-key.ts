/**
 * Create a Sentence API key (shown once; only its SHA-256 hash is stored).
 *
 *   npm run create-key -- [user-uuid] [key-name]
 *
 * With no user id a new one is generated. The user id is the identity that owns memory,
 * grants and provider keys, so reuse the same id for all of one person's keys.
 */
import { randomBytes, randomUUID } from 'crypto';
import { sha256Hex } from '../src/lib/crypto';
import { getSupabase } from '../src/lib/supabase';

async function main(): Promise<void> {
  const [userArg, nameArg] = process.argv.slice(2);
  const userId = userArg ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error('user id must be a UUID');
  }
  const key = `sk-sent-${randomBytes(24).toString('hex')}`;

  const { error } = await getSupabase().from('api_keys').insert({
    user_id: userId,
    key_hash: sha256Hex(key),
    key_prefix: key.slice(0, 16),
    name: nameArg ?? 'default',
  });
  if (error) throw new Error(`Could not store key: ${error.message}`);

  console.log(`user id : ${userId}`);
  console.log(`api key : ${key}`);
  console.log('Store this key now; it cannot be shown again.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
