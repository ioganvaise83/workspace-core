// MCP protocol tests: the tool surface, argument handling and secret hygiene.
//
// These drive the real server through the real MCP client, so they cover what
// the harness will actually see: the tool list, the schemas, the error shape and
// the auth boundary. They do not start the HTTP listener; `server.test.js` does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRequire } from 'node:module';

import { loadAccounts } from '../src/config.js';
import { AccountPool } from '../src/accounts.js';
import { toolList, resolveToolCall, TOOL_DEFINITIONS } from '../src/tools.js';
import { startMockServer, FIXTURES, writeAccountsFile } from './helpers/mock-server.js';

const dshRequire = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/package.json');

/** Names that must never appear as a tool, from the brief's denial list. */
const FORBIDDEN_TOOLS = [
  'send_email', 'reply_email', 'forward_email', 'delete_email', 'move_email',
  'mark_as_read', 'mark_as_unread', 'create_draft', 'modify_labels', 'create_folder',
  'append_message',
];

/** The Gmail integration's read-only tool names, as registered today. */
const GMAIL_TOOLS = [
  'search_emails', 'read_email', 'get_thread', 'list_inbox_threads',
  'get_inbox_with_threads', 'list_email_labels', 'download_attachment',
];

/**
 * Connect a client to a freshly built server instance.
 *
 * @param {() => Promise<object>} [buildPool]
 * @returns {Promise<{client: Client, close: () => Promise<void>}>}
 */
async function connect(buildPool) {
  const module = await import('../src/index.js');
  if (buildPool) module.setPool(await buildPool());
  const server = module.createServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientSide);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/**
 * Build a pool backed by one mock account.
 *
 * @param {object} server
 * @param {string[]} ids
 * @returns {AccountPool}
 */
function poolFor(server, ids = ['test-account']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-imap-mcp-'));
  const file = writeAccountsFile(dir, ids.map((id) => ({ id, port: server.port, host: '127.0.0.1' })));
  process.env.MAIL_IMAP_CA_FILE = path.join(server.tempDir, 'cert.pem');
  return new AccountPool(loadAccounts(file));
}

test('the tool list is exactly the agreed surface', async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'mail_apply_actions',
      'mail_get_account_status',
      'mail_get_attachment_metadata',
      'mail_get_conversation',
      'mail_get_daily_summary_data',
      'mail_get_message',
      'mail_get_operation_status',
      'mail_list_accounts',
      'mail_list_folders',
      'mail_list_labels',
      'mail_list_recent',
      'mail_preview_actions',
      'mail_search',
      'mail_undo_operation',
    ]);
  } finally {
    await close();
  }
});

test('no correspondence or destruction tool is exposed', async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    for (const forbidden of FORBIDDEN_TOOLS) {
      assert.equal(names.has(forbidden), false, `${forbidden} must not exist`);
    }
    // Organising verbs are allowed now; correspondence and destruction are not.
    for (const name of names) {
      assert.equal(/send|reply|forward|draft|append|delete_permanently|expunge|purge|empty_trash/i.test(name), false, `${name} looks like a correspondence or destruction tool`);
    }
    // The action enum is a closed list, and it must contain no destructive verb.
    const { ACTIONS } = await import('../src/approvals.js');
    assert.deepEqual([...ACTIONS].sort(), [
      'add_label', 'archive', 'mark_read', 'mark_unread',
      'move_to_folder', 'move_to_trash', 'remove_label',
    ]);
    for (const action of ACTIONS) {
      assert.equal(/delete|expunge|send|draft|reply|forward/i.test(action), false, `${action} must not be an allowed action`);
    }
  } finally {
    await close();
  }
});

test('every tool declares an honest readOnlyHint', async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    // Write-capable tools must NOT claim to be read-only; reads must.
    const writeTools = new Set(['mail_apply_actions', 'mail_undo_operation']);
    for (const tool of tools) {
      const expected = !writeTools.has(tool.name);
      assert.equal(
        tool.annotations?.readOnlyHint,
        expected,
        `${tool.name} should have readOnlyHint=${expected}`,
      );
    }
    for (const name of writeTools) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.equal(tool.annotations?.destructiveHint, true, `${name} must be marked destructive`);
    }
  } finally {
    await close();
  }
});

test('the mail_ namespace cannot collide with the Gmail tool names', async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    for (const gmailTool of GMAIL_TOOLS) {
      assert.equal(names.has(gmailTool), false, `${gmailTool} would collide with the Gmail server`);
    }
    // Every tool is namespaced, which is what keeps mcp__mail-imap__* distinct
    // from mcp__gmail__* in the harness.
    for (const name of names) {
      assert.ok(name.startsWith('mail_'), `${name} must use the mail_ prefix`);
    }
  } finally {
    await close();
  }
});

test('tool schemas use only the keywords the harness accepts', () => {
  const { assertSupportedJsonSchema } = dshRequire('@deepseek-ai/dsh-tools');
  for (const tool of toolList()) {
    assert.doesNotThrow(
      () => assertSupportedJsonSchema(tool.inputSchema),
      `${tool.name} schema must pass the harness validator`,
    );
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test('an empty configuration still serves the full tool list', async () => {
  const { client, close } = await connect(async () => new AccountPool({ accounts: [], errors: [] }));
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 14);
    const result = await client.callTool({ name: 'mail_list_accounts', arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.accounts.length, 0);
    assert.equal(payload.configured, 0);
    assert.match(payload.notice, /No IMAP accounts are configured/);
  } finally {
    await close();
  }
});

test('mail_list_accounts reports status and capabilities without secrets', async () => {
  const server = await startMockServer();
  try {
    const { client, close } = await connect(async () => poolFor(server, ['yandex-a', 'yandex-b']));
    try {
      const result = await client.callTool({ name: 'mail_list_accounts', arguments: {} });
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.accounts.length, 2);
      for (const account of payload.accounts) {
        assert.equal(typeof account.account_id, 'string');
        assert.equal(account.provider, 'custom');
        assert.equal(account.capabilities.send, false);
        assert.equal(account.capabilities.modify_flags, false);
        assert.equal(account.capabilities.mark_as_read, false);
        assert.equal(JSON.stringify(account).includes('testpass'), false);
      }
      // The unknown befor the first call, then READY after a real operation.
      assert.equal(payload.accounts[0].connection_status, 'NOT_CONFIGURED');
      await client.callTool({ name: 'mail_search', arguments: { account_id: 'yandex-a' } });
      const again = JSON.parse((await client.callTool({ name: 'mail_list_accounts', arguments: {} })).content[0].text);
      assert.equal(again.accounts.find((a) => a.account_id === 'yandex-a').connection_status, 'READY');
    } finally {
      await close();
    }
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
  }
});

test('an unknown argument is rejected instead of being ignored', async () => {
  const { client, close } = await connect(async () => new AccountPool({ accounts: [], errors: [] }));
  try {
    const result = await client.callTool({
      name: 'mail_search',
      arguments: { account_id: 'x', folder_name: 'INBOX' },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unknown argument/);
  } finally {
    await close();
  }
});

test('a missing required argument is rejected with the field named', async () => {
  const { client, close } = await connect(async () => new AccountPool({ accounts: [], errors: [] }));
  try {
    const result = await client.callTool({ name: 'mail_get_message', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /account_id/);
  } finally {
    await close();
  }
});

test('an unknown account is a clean error, not a crash', async () => {
  const { client, close } = await connect(async () => new AccountPool({ accounts: [], errors: [] }));
  try {
    const result = await client.callTool({ name: 'mail_search', arguments: { account_id: 'nope' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /UNKNOWN_ACCOUNT/);
  } finally {
    await close();
  }
});

test('an unknown tool name is refused', async () => {
  const { client, close } = await connect();
  try {
    const result = await client.callTool({ name: 'send_email', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not available/);
  } finally {
    await close();
  }
});

test('a full search then read round trip works through MCP', async () => {
  const server = await startMockServer();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.cyrillicCp1251 });
    const { client, close } = await connect(async () => poolFor(server, ['acc']));
    try {
      const search = await client.callTool({ name: 'mail_search', arguments: { account_id: 'acc' } });
      const found = JSON.parse(search.content[0].text);
      assert.equal(found.messages.length, 1);
      assert.equal(found.messages[0].subject, 'Привет мир');

      const read = await client.callTool({
        name: 'mail_get_message',
        arguments: {
          account_id: 'acc',
          uid: found.messages[0].uid,
          uidvalidity: found.uidvalidity,
        },
      });
      const message = JSON.parse(read.content[0].text);
      assert.equal(message.subject, 'Привет мир');
      assert.equal(message.body.trim(), 'Привет мир');
      // Reading through MCP did not change the flag on the server.
      assert.equal(server.flagsOf('INBOX', 1).includes('\\Seen'), false);
    } finally {
      await close();
    }
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
  }
});

test('attachment metadata is returned without content', async () => {
  const server = await startMockServer();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.withExecutableAttachment });
    const { client, close } = await connect(async () => poolFor(server, ['acc']));
    try {
      const result = await client.callTool({
        name: 'mail_get_attachment_metadata',
        arguments: { account_id: 'acc', uid: 1 },
      });
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.attachments.length, 1);
      assert.equal(payload.attachments[0].filename, 'invoice.exe');
      assert.equal(payload.attachments[0].executable, true);
      assert.equal(JSON.stringify(payload).includes('TVqQAAMAAAAE'), false);
    } finally {
      await close();
    }
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
  }
});

test('tool definitions are the single source of truth for names', () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate tool names');
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
    assert.equal(typeof tool.validate, 'function');
  }
});

test('argument validation rejects wrong types without calling IMAP', () => {
  assert.throws(() => resolveToolCall('mail_search', { account_id: 5 }), /must be a string/);
  assert.throws(() => resolveToolCall('mail_search', { account_id: 'a', limit: 'many' }), /must be an integer/);
  assert.throws(() => resolveToolCall('mail_search', { account_id: 'a', unread_only: 'yes' }), /must be a boolean/);
  assert.throws(() => resolveToolCall('mail_get_message', { account_id: 'a', uid: -3 }), /between 1 and 4294967295/);
  assert.throws(() => resolveToolCall('mail_get_daily_summary_data', { account_ids: 'not-an-array' }), /array of strings/);
  // Integer strings are accepted, because model output is often stringly typed.
  assert.equal(resolveToolCall('mail_get_message', { account_id: 'a', uid: '42' }).args.uid, 42);
});
