// Tests for Gmail IMAP XOAUTH2 and the four-account configuration.
//
// The XOAUTH2 path is the one part of this migration that cannot be exercised
// against a real provider offline, so it is covered at three levels: the SASL
// string format, the token refresh exchange (with a stubbed token endpoint), and a
// real IMAP AUTHENTICATE XOAUTH2 handshake against the mock server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GMAIL_IMAP_SCOPE,
  accessTokenFor,
  readOAuthClient,
  refreshAccessToken,
  xoauth2String,
  readTokenDocument,
} from '../src/oauth.js';
import { loadAccounts } from '../src/config.js';
import { AccountPool } from '../src/accounts.js';
import { listFolders, searchMessages } from '../src/mail.js';
import { startMockServer, FIXTURES, writeAccountsFile } from './helpers/mock-server.js';

/** @returns {string} */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mail-imap-oauth-'));
}

/**
 * Write Google-shaped client and token documents.
 *
 * @param {string} dir
 * @param {{scope?: string, withAccessToken?: boolean}} [options]
 * @returns {{clientFile: string, tokenFile: string}}
 */
function writeOAuthFiles(dir, options = {}) {
  const clientFile = path.join(dir, 'gmail-imap-client.json');
  fs.writeFileSync(
    clientFile,
    JSON.stringify({
      installed: {
        client_id: 'test-client-id.apps.googleusercontent.com',
        client_secret: 'test-client-secret',
        redirect_uris: ['http://localhost'],
      },
    }),
  );
  const tokenFile = path.join(dir, 'gmail-imap-token.json');
  const document = {
    refresh_token: 'test-refresh-token',
    scope: options.scope ?? `openid ${GMAIL_IMAP_SCOPE}`,
    token_type: 'Bearer',
  };
  if (options.withAccessToken) {
    document.access_token = 'cached-access-token';
    document.expiry_date = Date.now() + 3600_000;
  }
  fs.writeFileSync(tokenFile, JSON.stringify(document));
  return { clientFile, tokenFile };
}

test('the XOAUTH2 SASL string has the exact format Google requires', () => {
  const value = xoauth2String('user@gmail.com', 'ya29.token');
  assert.equal(value, 'user=user@gmail.com\u0001auth=Bearer ya29.token\u0001\u0001');
  // The three parts are separated by SOH and the string ends with two of them.
  const parts = value.split('\u0001');
  assert.equal(parts[0], 'user=user@gmail.com');
  assert.equal(parts[1], 'auth=Bearer ya29.token');
  assert.equal(parts[2], '');
  assert.equal(parts[3], '');
});

test('the OAuth client file is read from the installed / web / bare shapes', () => {
  const dir = tempDir();
  try {
    for (const shape of ['installed', 'web', 'bare']) {
      const file = path.join(dir, `${shape}.json`);
      const payload = { client_id: 'id', client_secret: 'secret' };
      fs.writeFileSync(file, JSON.stringify(shape === 'bare' ? payload : { [shape]: payload }));
      const client = readOAuthClient(file);
      assert.equal(client.clientId, 'id');
      assert.equal(client.clientSecret, 'secret');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or malformed OAuth client file is NOT_CONFIGURED, not a crash', () => {
  const dir = tempDir();
  try {
    assert.throws(() => readOAuthClient(path.join(dir, 'absent.json')), (error) => error.code === 'NOT_CONFIGURED');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, 'not json');
    assert.throws(() => readOAuthClient(bad), (error) => error.code === 'NOT_CONFIGURED');
    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, JSON.stringify({ installed: {} }));
    assert.throws(() => readOAuthClient(empty), (error) => error.code === 'NOT_CONFIGURED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a cached access token is reused without hitting the network', async () => {
  const dir = tempDir();
  try {
    const { clientFile, tokenFile } = writeOAuthFiles(dir, { withAccessToken: true });
    let called = 0;
    const token = await accessTokenFor({
      clientFile,
      tokenFile,
      fetchImpl: async () => {
        called += 1;
        throw new Error('must not be called');
      },
    });
    assert.equal(token, 'cached-access-token');
    assert.equal(called, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an expired access token is refreshed and persisted', async () => {
  const dir = tempDir();
  try {
    const { clientFile, tokenFile } = writeOAuthFiles(dir);
    const token = await accessTokenFor({
      clientFile,
      tokenFile,
      fetchImpl: async (url, init) => {
        assert.equal(url, 'https://oauth2.googleapis.com/token');
        assert.match(String(init.body), /grant_type=refresh_token/);
        // The refresh token must be sent, and the client secret must not leak into
        // any log: this assertion is about the request body only.
        assert.match(String(init.body), /refresh_token=test-refresh-token/);
        return new Response(
          JSON.stringify({ access_token: 'fresh-access-token', expires_in: 3600, scope: GMAIL_IMAP_SCOPE }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    assert.equal(token, 'fresh-access-token');

    const persisted = readTokenDocument(tokenFile);
    assert.equal(persisted.access_token, 'fresh-access-token');
    assert.ok(persisted.expiry_date > Date.now(), 'expiry must be in the future');
    assert.ok(persisted.last_refresh_at, 'the refresh must be recorded');
    // The refresh token survives the rotation untouched.
    assert.equal(persisted.refresh_token, 'test-refresh-token');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a revoked refresh token is reported as AUTH_FAILED with a fix', async () => {
  const dir = tempDir();
  try {
    const { clientFile, tokenFile } = writeOAuthFiles(dir);
    await assert.rejects(
      () =>
        accessTokenFor({
          clientFile,
          tokenFile,
          fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
        }),
      (error) => {
        assert.equal(error.code, 'AUTH_FAILED');
        assert.match(error.message, /re-authorise|revoked|expired/i);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a token granted the wrong scope is refused with an explanation', async () => {
  const dir = tempDir();
  try {
    // The exact mistake a user migrating from the Gmail API integration would make.
    const { clientFile, tokenFile } = writeOAuthFiles(dir, { scope: 'https://www.googleapis.com/auth/gmail.readonly' });
    await assert.rejects(
      () => accessTokenFor({ clientFile, tokenFile, fetchImpl: async () => new Response('{}', { status: 200 }) }),
      (error) => {
        assert.equal(error.code, 'AUTH_FAILED');
        assert.match(error.message, /scope/);
        assert.match(error.message, /mail\.google\.com/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing refresh token is NOT_CONFIGURED, not a silent anonymous session', async () => {
  const dir = tempDir();
  try {
    const { clientFile, tokenFile } = writeOAuthFiles(dir);
    fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'x', expiry_date: Date.now() + 1000 }));
    await assert.rejects(
      () => accessTokenFor({ clientFile, tokenFile, fetchImpl: async () => new Response('{}', { status: 200 }) }),
      (error) => error.code === 'NOT_CONFIGURED',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a token endpoint that hangs does not hang the caller forever', async () => {
  const dir = tempDir();
  try {
    const { clientFile, tokenFile } = writeOAuthFiles(dir);
    await assert.rejects(
      () =>
        accessTokenFor({
          clientFile,
          tokenFile,
          fetchImpl: async () => {
            throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
          },
        }),
      (error) => error.code === 'CONNECTION_FAILED',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshAccessToken rejects a response with no access token', async () => {
  await assert.rejects(
    () => refreshAccessToken({ clientId: 'a', clientSecret: 'b' }, 'refresh', async () => new Response('{}', { status: 200 })),
    (error) => error.code === 'AUTH_FAILED',
  );
});

test('XOAUTH2 authenticates against a real IMAP server', async () => {
  // The mock server supports AUTHENTICATE XOAUTH2 with a fixed test token.
  // The mock server accepts exactly this access token over AUTHENTICATE XOAUTH2.
  const ACCESS_TOKEN = 'ya29.mock-access-token-for-tests';
  const server = await startMockServer({ plugins: ['STARTTLS', 'MOVE', 'UIDPLUS', 'SASL-IR', 'XOAUTH2'], accessToken: ACCESS_TOKEN });
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const { clientFile, tokenFile } = writeOAuthFiles(dir, { withAccessToken: true });
    // Point the cached token at the value the server will accept.
    const document = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    document.access_token = ACCESS_TOKEN;
    fs.writeFileSync(tokenFile, JSON.stringify(document));
    const accountsFile = path.join(dir, 'accounts.json');
    fs.writeFileSync(
      accountsFile,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'gmail-personal',
            provider: 'gmail',
            user: 'testuser',
            host: '127.0.0.1',
            port: server.port,
            oauth: { clientFile, tokenFile },
            allowWrites: true,
          },
        ],
      }),
    );
    process.env.MAIL_IMAP_CA_FILE = path.join(server.tempDir, 'cert.pem');
    const pool = new AccountPool(loadAccounts(accountsFile));
    const folders = await listFolders(pool, 'gmail-personal');
    assert.ok(folders.length > 0, 'XOAUTH2 session must be able to LIST');
    const found = await searchMessages(pool, 'gmail-personal', {});
    assert.equal(found.messages.length, 1);
    assert.equal(pool.statusOf('gmail-personal').status, 'READY');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('four accounts configure independently, including Gmail over OAuth', () => {
  const dir = tempDir();
  try {
    const { clientFile, tokenFile } = writeOAuthFiles(dir);
    for (const id of ['yandex-1', 'yandex-2', 'mailru-1']) {
      fs.writeFileSync(path.join(dir, `${id}.secret`), `app-password-${id}\n`);
    }
    const accountsFile = path.join(dir, 'accounts.json');
    fs.writeFileSync(
      accountsFile,
      JSON.stringify({
        version: 1,
        accounts: [
          { id: 'gmail-personal', provider: 'gmail', user: 'a@gmail.com', oauth: { clientFile, tokenFile }, allowWrites: true },
          { id: 'yandex-1', provider: 'yandex', user: 'b@yandex.ru', passwordFile: 'yandex-1.secret', allowWrites: true },
          { id: 'yandex-2', provider: 'yandex', user: 'c@yandex.ru', passwordFile: 'yandex-2.secret', allowWrites: false },
          { id: 'mailru-1', provider: 'mailru', user: 'd@mail.ru', passwordFile: 'mailru-1.secret' },
        ],
      }),
    );
    const { accounts, errors } = loadAccounts(accountsFile);
    assert.deepEqual(errors, []);
    assert.equal(accounts.length, 4);

    const byId = new Map(accounts.map((account) => [account.id, account]));
    assert.equal(byId.get('gmail-personal').authType, 'xoauth2');
    assert.equal(byId.get('gmail-personal').host, 'imap.gmail.com');
    assert.equal(byId.get('yandex-1').authType, 'password');
    assert.equal(byId.get('yandex-1').host, 'imap.yandex.ru');
    assert.equal(byId.get('mailru-1').host, 'imap.mail.ru');

    // Write permission is opt-in per account, not inherited.
    assert.equal(byId.get('gmail-personal').allowWrites, true);
    assert.equal(byId.get('yandex-1').allowWrites, true);
    assert.equal(byId.get('yandex-2').allowWrites, false);
    assert.equal(byId.get('mailru-1').allowWrites, false);

    // No credential is enumerable, in any of the four.
    for (const account of accounts) {
      const serialised = JSON.stringify(account);
      assert.equal(serialised.includes('app-password'), false, `${account.id} leaked a password`);
      assert.equal(serialised.includes('client_secret'), false, `${account.id} leaked a client secret`);
      assert.equal(serialised.includes('refresh_token'), false, `${account.id} leaked a refresh token`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one broken account among four does not stop the others', async () => {
  // The mock server accepts exactly this access token over AUTHENTICATE XOAUTH2.
  const ACCESS_TOKEN = 'ya29.mock-access-token-for-tests';
  const server = await startMockServer({ plugins: ['STARTTLS', 'MOVE', 'UIDPLUS', 'SASL-IR', 'XOAUTH2'], accessToken: ACCESS_TOKEN });
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const { clientFile, tokenFile } = writeOAuthFiles(dir, { withAccessToken: true });
    // Point the cached token at the value the server will accept.
    const document = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    document.access_token = ACCESS_TOKEN;
    fs.writeFileSync(tokenFile, JSON.stringify(document));
    fs.writeFileSync(path.join(dir, 'good.secret'), `${server.password}\n`);
    const accountsFile = path.join(dir, 'accounts.json');
    fs.writeFileSync(
      accountsFile,
      JSON.stringify({
        version: 1,
        accounts: [
          { id: 'gmail-personal', provider: 'gmail', user: 'testuser', host: '127.0.0.1', port: server.port, oauth: { clientFile, tokenFile } },
          { id: 'yandex-1', provider: 'custom', user: 'testuser', host: '127.0.0.1', port: server.port, passwordFile: 'good.secret' },
          // A secret that does not exist: this account is disabled, the rest live.
          { id: 'yandex-2', provider: 'yandex', user: 'c@yandex.ru', passwordFile: 'missing.secret' },
        ],
      }),
    );
    process.env.MAIL_IMAP_CA_FILE = path.join(server.tempDir, 'cert.pem');
    const pool = new AccountPool(loadAccounts(accountsFile));
    assert.equal(pool.list().length, 2, 'the broken account must not load');
    assert.equal(pool.statusOf('yandex-2').status, 'DISABLED');

    // Both healthy accounts work, through different auth mechanisms.
    for (const id of ['gmail-personal', 'yandex-1']) {
      const found = await searchMessages(pool, id, {});
      assert.equal(found.messages.length, 1, `${id} must read mail`);
    }
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fifth account needs only configuration, no code', () => {
  // The requirement stated as an assertion: the loader accepts any number of
  // accounts sharing one schema, and nothing in it is keyed to a specific id.
  const dir = tempDir();
  try {
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      fs.writeFileSync(path.join(dir, `${id}.secret`), `pw-${id}\n`);
    }
    const accounts = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => ({
      id,
      provider: 'yandex',
      user: `${id}@yandex.ru`,
      passwordFile: `${id}.secret`,
    }));
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts }));
    const loaded = loadAccounts(file);
    assert.equal(loaded.accounts.length, 5);
    assert.deepEqual(loaded.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an xoauth2 account that also carries a password is rejected', () => {
  const dir = tempDir();
  try {
    const { clientFile, tokenFile } = writeOAuthFiles(dir);
    fs.writeFileSync(path.join(dir, 'x.secret'), 'pw\n');
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'mixed',
            provider: 'gmail',
            user: 'a@gmail.com',
            oauth: { clientFile, tokenFile },
            passwordFile: 'x.secret',
          },
        ],
      }),
    );
    const { accounts, errors } = loadAccounts(file);
    assert.equal(accounts.length, 0, 'a mixed credential account must be refused');
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /must not also carry a password/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an xoauth2 account without oauth paths is rejected with a clear message', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, accounts: [{ id: 'broken', provider: 'gmail', user: 'a@gmail.com', authType: 'xoauth2' }] }),
    );
    const { accounts, errors } = loadAccounts(file);
    assert.equal(accounts.length, 0);
    assert.match(errors[0].message, /oauth\.clientFile/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
