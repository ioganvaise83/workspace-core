// HTTP transport tests: authentication, health, limits and log hygiene.
//
// These exercise the same listener the container runs, because the transport
// details (401 before IMAP work, body cap, method handling) are exactly where a
// read-only server can accidentally become an open one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { loadAccounts } from '../src/config.js';
import { AccountPool } from '../src/accounts.js';
import { handleMcp } from '../src/index.js';
import { startMockServer, FIXTURES, writeAccountsFile, captureOutput } from './helpers/mock-server.js';

const TOKEN = 'a'.repeat(64);

/**
 * Start a bare HTTP listener around `handleMcp`.
 *
 * @param {string|null} token
 * @returns {Promise<{url: string, close: () => Promise<void>, log: () => string}>}
 */
async function startHttpServer(token = TOKEN) {
  let log = '';
  const server = http.createServer((req, res) => {
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    res.write = (chunk, ...rest) => {
      log += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return originalWrite(chunk, ...rest);
    };
    res.end = (chunk, ...rest) => {
      if (chunk) log += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return originalEnd(chunk, ...rest);
    };
    handleMcp(req, res, token).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    log: () => log,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Minimal JSON-RPC POST helper. */
async function post(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, headers: response.headers };
}

test('/healthz answers without a token and reports no mail content', async () => {
  const server = await startHttpServer();
  try {
    const response = await fetch(`${server.url}/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.server, 'mail-imap');
    assert.equal(typeof body.accounts, 'number');
    // Health says nothing about mailboxes, and must not leak account details.
    assert.equal(JSON.stringify(body).includes('@'), false);
  } finally {
    await server.close();
  }
});

test('an MCP request without a token is refused with 401', async () => {
  const server = await startHttpServer();
  try {
    const response = await post(`${server.url}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(response.status, 401);
    assert.equal(JSON.parse(response.text).error, 'unauthorized');
  } finally {
    await server.close();
  }
});

test('a wrong token is refused, and the refusal says nothing about the right one', async () => {
  const server = await startHttpServer();
  try {
    const wrong = await post(`${server.url}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      authorization: `Bearer ${'b'.repeat(64)}`,
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.text.includes(TOKEN), false);
  } finally {
    await server.close();
  }
});

test('a correctly authenticated MCP client can list tools over HTTP', async () => {
  const server = await startHttpServer();
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: 'http-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 14);
      assert.ok(tools.every((tool) => tool.name.startsWith('mail_')));
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    await server.close();
  }
});

test('the HTTP endpoint works end to end against a mock mailbox', async () => {
  const mail = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-imap-http-'));
  const httpServer = await startHttpServer();
  try {
    mail.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const file = writeAccountsFile(dir, [{ id: 'acc', port: mail.port, host: '127.0.0.1' }]);
    process.env.MAIL_IMAP_CA_FILE = path.join(mail.tempDir, 'cert.pem');
    const module = await import('../src/index.js');
    module.setPool(new AccountPool(loadAccounts(file)));

    const transport = new StreamableHTTPClientTransport(new URL(`${httpServer.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: 'http-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'mail_search', arguments: { account_id: 'acc' } });
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.messages.length, 1);
      assert.equal(payload.messages[0].subject, 'Plain english subject');
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await httpServer.close();
    await mail.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET and DELETE are not accepted on the MCP endpoint', async () => {
  const server = await startHttpServer();
  try {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await fetch(`${server.url}/mcp`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(response.status, 405, `${method} must not be served`);
    }
  } finally {
    await server.close();
  }
});

test('an unknown path is 404, not a redirect to the MCP endpoint', async () => {
  const server = await startHttpServer();
  try {
    const response = await fetch(`${server.url}/anything`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test('a body over the size limit is refused with 413', async () => {
  const server = await startHttpServer();
  try {
    const huge = '{"jsonrpc":"2.0","id":1,"method":"tools/list","pad":"' + 'x'.repeat(2 * 1024 * 1024) + '"}';
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: huge,
    });
    assert.equal(response.status, 413);
  } finally {
    await server.close();
  }
});

test('malformed JSON is a JSON-RPC parse error, not a 500', async () => {
  const server = await startHttpServer();
  try {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: 'not json at all',
    });
    assert.equal(response.status, 400);
    const body = JSON.parse(await response.text());
    assert.equal(body.error.code, -32700);
  } finally {
    await server.close();
  }
});

test('the password never appears in log output or tool results', async () => {
  const secret = 'super-secret-app-password';
  // The mock server accepts exactly this password, so the successful path runs
  // with a real secret value in play rather than a placeholder.
  const mail = await startMockServer({ password: secret });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-imap-logs-'));
  try {
    mail.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const file = writeAccountsFile(dir, [{ id: 'acc', port: mail.port, host: '127.0.0.1', password: secret }]);
    process.env.MAIL_IMAP_CA_FILE = path.join(mail.tempDir, 'cert.pem');
    const module = await import('../src/index.js');
    const pool = new AccountPool(loadAccounts(file));
    module.setPool(pool);

    const { output } = await captureOutput(async () => {
      const server = module.createServer();
      const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: 'log-test', version: '0.0.0' }, { capabilities: {} });
      await client.connect(clientSide);
      await client.callTool({ name: 'mail_search', arguments: { account_id: 'acc' } });
      // A failing call too: errors are the usual leak path.
      await client.callTool({ name: 'mail_search', arguments: { account_id: 'missing' } });
      await client.close();
      await server.close();
    });

    assert.equal(output.includes(secret), false, 'the password must never be logged');
    assert.equal(output.includes('testpass'), false);
    assert.ok(output.includes('tool_ok'), 'the test must be observing real log output');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await mail.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two servers with the same account id do not share state', async () => {
  const mail = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-imap-iso-'));
  try {
    mail.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const file = writeAccountsFile(dir, [{ id: 'acc', port: mail.port, host: '127.0.0.1' }]);
    process.env.MAIL_IMAP_CA_FILE = path.join(mail.tempDir, 'cert.pem');
    const first = new AccountPool(loadAccounts(file));
    const second = new AccountPool(loadAccounts(file));
    first.recordStatus('acc', 'READY', null, 1);
    assert.equal(first.statusOf('acc').status, 'READY');
    assert.equal(second.statusOf('acc').status, 'NOT_CONFIGURED');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await mail.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
