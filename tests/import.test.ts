/**
 * Tests for the ChatGPT / Claude export parsers. Fixtures mirror the real export shapes.
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import {
  deterministicUuid,
  detectSource,
  parseChatGPT,
  parseClaude,
  parseExport,
  toSyncItems,
} from '../src/import/parsers';

let passed = 0;
const test = (name: string, fn: () => void): void => {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
};

const node = (
  id: string,
  parent: string | null,
  children: string[],
  message: unknown,
): Record<string, unknown> => ({ id, parent, children, message });

const msg = (
  id: string,
  role: string,
  parts: unknown[],
  time: number | null,
  extra: Record<string, unknown> = {},
  contentType = 'text',
): Record<string, unknown> => ({
  id,
  author: { role },
  create_time: time,
  content: { content_type: contentType, parts },
  metadata: extra,
});

// A ChatGPT conversation where the user regenerated an answer (branch a2 vs a2b); current_node = the branch seen.
const chatgptFixture = [
  {
    title: 'Churn analysis',
    create_time: 1762600000,
    conversation_id: '8f0a3c1e-1111-4222-8333-444455556666',
    default_model_slug: 'gpt-4o',
    current_node: 'a2b',
    mapping: {
      root: node('root', null, ['sys'], null),
      sys: node('sys', 'root', ['u1'], msg('sys', 'system', [''], 1762600001, { is_visually_hidden_from_conversation: true })),
      u1: node('u1', 'sys', ['a1'], msg('u1', 'user', ['Churn is 4.1% in Q3 vs 3.2% in Q2. Where do I look?'], 1762600010)),
      a1: node('a1', 'u1', ['t1'], msg('a1', 'assistant', ['Start with cohort retention.'], 1762600020, { model_slug: 'gpt-4o' })),
      t1: node('t1', 'a1', ['a2', 'a2b'], msg('t1', 'tool', ['browsing output'], 1762600025)),
      a2: node('a2', 't1', [], msg('a2', 'assistant', ['OLD regenerated answer'], 1762600030, { model_slug: 'gpt-4o' })),
      a2b: node('a2b', 't1', [], msg('a2b', 'assistant', ['Then segment by plan.', { asset_pointer: 'img' }], 1762600040, { model_slug: 'gpt-4o' }, 'multimodal_text')),
    },
  },
  {
    title: 'Only code output',
    create_time: 1762700000,
    id: 'c-2',
    current_node: 'x',
    mapping: {
      x: node('x', null, [], msg('x', 'assistant', ['print(1)'], 1762700001, {}, 'code')),
    },
  },
];

const claudeFixture = [
  {
    uuid: '11111111-2222-4333-8444-555555555555',
    name: 'Write the SQL',
    created_at: '2026-10-01T09:00:00.000000Z',
    chat_messages: [
      { uuid: 'm2', sender: 'assistant', text: '', content: [{ type: 'text', text: 'SELECT cohort, count(*) FROM users GROUP BY 1;' }], created_at: '2026-10-01T09:00:30.000000Z' },
      { uuid: 'm1', sender: 'human', text: 'Give me SQL for cohort counts', content: [], created_at: '2026-10-01T09:00:05.000000Z' },
      { uuid: 'm3', sender: 'human', text: '   ', content: [], created_at: '2026-10-01T09:01:00.000000Z' },
    ],
  },
];

test('chatgpt: follows the branch the user saw, skips hidden/tool/non-text, orders by time', () => {
  const [conv] = parseChatGPT(chatgptFixture);
  assert.equal(conv.title, 'Churn analysis');
  assert.deepEqual(
    conv.messages.map((m) => [m.role, m.content]),
    [
      ['user', 'Churn is 4.1% in Q3 vs 3.2% in Q2. Where do I look?'],
      ['assistant', 'Start with cohort retention.'],
      ['assistant', 'Then segment by plan.'],
    ],
  );
  assert.ok(!conv.messages.some((m) => m.content.includes('OLD regenerated')));
  assert.equal(conv.messages[1].model, 'gpt-4o');
});

test('chatgpt: conversations with no usable text are dropped', () => {
  assert.equal(parseChatGPT(chatgptFixture).length, 1);
});

test('chatgpt: falls back to the newest leaf when current_node is missing', () => {
  const copy = JSON.parse(JSON.stringify(chatgptFixture)) as Array<Record<string, unknown>>;
  delete copy[0].current_node;
  const [conv] = parseChatGPT(copy);
  assert.equal(conv.messages[conv.messages.length - 1].content, 'Then segment by plan.');
});

test('claude: maps human/assistant, reads content blocks, sorts, drops blank messages', () => {
  const [conv] = parseClaude(claudeFixture);
  assert.deepEqual(
    conv.messages.map((m) => [m.role, m.content]),
    [
      ['user', 'Give me SQL for cohort counts'],
      ['assistant', 'SELECT cohort, count(*) FROM users GROUP BY 1;'],
    ],
  );
  assert.equal(conv.messages[0].model, 'claude');
});

test('timestamps are strictly increasing within a conversation', () => {
  const same = [
    {
      uuid: '11111111-2222-4333-8444-000000000000',
      name: 't',
      created_at: '2026-10-01T09:00:00Z',
      chat_messages: [
        { uuid: 'a', sender: 'human', text: 'one', created_at: '2026-10-01T09:00:00Z' },
        { uuid: 'b', sender: 'assistant', text: 'two', created_at: '2026-10-01T09:00:00Z' },
      ],
    },
  ];
  const [conv] = parseClaude(same);
  assert.ok(conv.messages[0].created_at < conv.messages[1].created_at);
});

test('detectSource / parseExport pick the right parser; garbage is rejected', () => {
  assert.equal(detectSource(chatgptFixture), 'chatgpt');
  assert.equal(detectSource(claudeFixture), 'claude');
  assert.equal(parseExport(claudeFixture).length, 1);
  assert.throws(() => detectSource({ nope: true }));
  assert.throws(() => parseChatGPT({}));
});

test('sync items satisfy the server schema (uuid, iso date, id lengths, provider)', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const conv of [...parseChatGPT(chatgptFixture), ...parseClaude(claudeFixture)]) {
    for (const item of toSyncItems(conv, 'salt')) {
      assert.match(item.conversation_id, uuid);
      assert.ok(item.client_id.length > 0 && item.client_id.length <= 200);
      assert.equal(new Date(item.created_at).toISOString(), item.created_at);
      assert.ok(item.content.length > 0 && item.content.length <= 100_000);
      assert.ok(['openai', 'anthropic'].includes(item.provider));
      assert.ok(item.topic.length > 0 && item.topic.length <= 120);
    }
  }
});

test('ids are deterministic (safe re-import) and salted (no cross-user collisions)', () => {
  const [conv] = parseChatGPT(chatgptFixture);
  const a = toSyncItems(conv, 'user-a');
  const b = toSyncItems(conv, 'user-a');
  const c = toSyncItems(conv, 'user-b');
  assert.deepEqual(a, b);
  assert.notEqual(a[0].conversation_id, c[0].conversation_id);
  assert.notEqual(a[0].client_id, c[0].client_id);
  assert.equal(new Set(a.map((i) => i.client_id)).size, a.length, 'client ids are unique');
  assert.equal(deterministicUuid('x'), deterministicUuid('x'));
});

test('oversized messages are truncated to the server limit', () => {
  const big = [
    {
      uuid: '11111111-2222-4333-8444-999999999999',
      name: 'big',
      created_at: '2026-10-01T09:00:00Z',
      chat_messages: [{ uuid: 'a', sender: 'human', text: 'x'.repeat(250_000), created_at: '2026-10-01T09:00:00Z' }],
    },
  ];
  assert.equal(parseClaude(big)[0].messages[0].content.length, 100_000);
});

console.log(`\n${passed} import tests passed`);
