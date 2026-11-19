// Integration tests against a real mock IMAP server over TLS.
//
// Covers the scenarios the brief requires that are not pure unit behaviour:
// three accounts, one broken server, wrong password, timeout, TLS failure,
// invalid UID, UIDVALIDITY protection, and multi-account independence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { loadAccounts } from '../src/config.js';
import { AccountPool, ACCOUNT_STATUS, toMailError } from '../src/accounts.js';
import { listFolders, searchMessages, getMessage, listRecent, dailySummaryData } from '../src/mail.js';
import { startMockServer, FIXTURES, writeAccountsFile } from './helpers/mock-server.js';

/** Create a temp dir and register it for cleanup. */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mail-imap-int-'));
}

/**
 * Build a pool whose client trusts the mock server certificate.
 *
 * @param {object} server
 * @param {string} dir
 * @param {object[]} accounts
 * @returns {AccountPool}
 */
function poolFor(server, dir, accounts) {
  const file = writeAccountsFile(dir, accounts);
  process.env.MAIL_IMAP_CA_FILE = path.join(server.tempDir, 'cert.pem');
  return new AccountPool(loadAccounts(file));
}

/** Read the free port of a closed listener, to get a guaranteed-refused port. */
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('three accounts are read independently', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, [
      { id: 'acc-one', port: server.port },
      { id: 'acc-two', port: server.port },
      { id: 'acc-three', port: server.port },
    ]);
    // The mock server shares one mailbox tree across logins; what matters here is
    // that each account is addressed separately and all three work.
    for (const id of ['acc-one', 'acc-two', 'acc-three']) {
      const result = await searchMessages(pool, id, {});
      assert.equal(result.account_id, id);
      assert.equal(result.messages.length, 1);
    }
    assert.equal(pool.list().length, 3);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a wrong password fails one account and leaves the others working', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, [
      { id: 'good', port: server.port },
      { id: 'bad-password', port: server.port, password: 'definitely-wrong' },
    ]);

    await assert.rejects(
      () => searchMessages(pool, 'bad-password', {}),
      (error) => {
        assert.equal(error.code, 'AUTH_FAILED');
        return true;
      },
    );
    assert.equal(pool.statusOf('bad-password').status, ACCOUNT_STATUS.AUTH_FAILED);
    // The error text must not echo the password.
    const state = pool.statusOf('bad-password');
    assert.equal(JSON.stringify(state).includes('definitely-wrong'), false);

    const good = await searchMessages(pool, 'good', {});
    assert.equal(good.messages.length, 1);
    assert.equal(pool.statusOf('good').status, ACCOUNT_STATUS.READY);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreachable server reports CONNECTION_FAILED, not a crash', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    const deadPort = await unusedPort();
    const pool = poolFor(server, dir, [{ id: 'dead', port: deadPort, host: '127.0.0.1' }]);
    await assert.rejects(
      () => listFolders(pool, 'dead'),
      (error) => {
        assert.equal(error.code, 'CONNECTION_FAILED');
        return true;
      },
    );
    assert.equal(pool.statusOf('dead').status, ACCOUNT_STATUS.CONNECTION_FAILED);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an untrusted certificate fails TLS verification instead of being ignored', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    // Deliberately do NOT point MAIL_IMAP_CA_FILE at the mock certificate.
    delete process.env.MAIL_IMAP_CA_FILE;
    const file = writeAccountsFile(dir, [{ id: 'untrusted', port: server.port, host: '127.0.0.1' }]);
    const pool = new AccountPool(loadAccounts(file));
    await assert.rejects(
      () => listFolders(pool, 'untrusted'),
      (error) => {
        assert.equal(error.code, 'TLS_FAILED');
        return true;
      },
    );
    assert.equal(pool.statusOf('untrusted').status, ACCOUNT_STATUS.CONNECTION_FAILED);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid UID is rejected before any IMAP call', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    const pool = poolFor(server, dir, [{ id: 'acc', port: server.port }]);
    for (const uid of [0, -1, 1.5, 'abc', 0x100000000]) {
      await assert.rejects(
        () => getMessage(pool, 'acc', { uid }),
        (error) => error.code === 'INVALID_ARGUMENT',
        `uid ${uid} must be rejected`,
      );
    }
    // A valid UID that does not exist is a different, honest error.
    await assert.rejects(
      () => getMessage(pool, 'acc', { uid: 999 }),
      (error) => error.code === 'MESSAGE_NOT_FOUND',
    );
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed UIDVALIDITY is refused instead of returning a different message', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, [{ id: 'acc', port: server.port }]);
    const first = await getMessage(pool, 'acc', { uid: 1 });
    assert.ok(first.uidvalidity, 'the result carries a uidvalidity');

    // The mailbox is renumbered underneath the caller.
    server.server.control.resetUidValidity('INBOX', { uids: 'shuffle' });

    await assert.rejects(
      () => getMessage(pool, 'acc', { uid: 1, uidvalidity: first.uidvalidity }),
      (error) => {
        assert.equal(error.code, 'UID_VALIDITY_CHANGED');
        return true;
      },
    );
    // Without the guard the same call succeeds against whatever now has that UID.
    const unguarded = await getMessage(pool, 'acc', { uid: 1 });
    assert.notEqual(unguarded.uidvalidity, first.uidvalidity);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('folder listing reports special-use and subscription hints', async () => {
  // The mock server's storage is keyed by namespace: top-level mailboxes live
  // under the root namespace, each entry a folder definition.
  const server = await startMockServer({
    storage: { INBOX: {}, '': { folders: { Sent: { 'special-use': '\\Sent' }, Archive: {} } } },
  });
  const dir = tempDir();
  try {
    const pool = poolFor(server, dir, [{ id: 'acc', port: server.port }]);
    const folders = await listFolders(pool, 'acc');
    const paths = folders.map((folder) => folder.path);
    assert.ok(paths.includes('INBOX'));
    assert.ok(paths.includes('Sent'));
    const sent = folders.find((folder) => folder.path === 'Sent');
    assert.equal(sent.special_use, '\\Sent');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search filters compile to IMAP criteria and cap the result count', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    for (let index = 0; index < 8; index += 1) {
      server.addMessage('INBOX', {
        raw: [
          'From: sender@example.com',
          'To: testuser@example.com',
          `Subject: Message number ${index}`,
          `Date: Tue, 18 Nov 2026 0${index % 10}:00:00 +0000`,
          `Message-ID: <n${index}@example.com>`,
          'Content-Type: text/plain; charset=utf-8',
          '',
          `Body ${index}`,
        ].join('\r\n'),
      });
    }
    const pool = poolFor(server, dir, [{ id: 'acc', port: server.port }]);

    const limited = await searchMessages(pool, 'acc', { limit: 3 });
    assert.equal(limited.returned, 3);
    assert.equal(limited.total_matched, 8);
    assert.equal(limited.truncated, true);
    assert.equal(limited.messages.length, 3);

    const bySubject = await searchMessages(pool, 'acc', { subject: 'number 5' });
    assert.equal(bySubject.messages.length, 1);
    assert.match(bySubject.messages[0].subject, /number 5/);

    const byFrom = await searchMessages(pool, 'acc', { from: 'sender@example.com' });
    assert.equal(byFrom.messages.length, 8);

    const noMatch = await searchMessages(pool, 'acc', { subject: 'nothing matches this' });
    assert.equal(noMatch.messages.length, 0);
    assert.equal(noMatch.total_matched, 0);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('results are ordered newest first even though UIDs ascend', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    // UID order and date order disagree on purpose.
    server.addMessage('INBOX', {
      raw: 'From: a@example.com\r\nSubject: Older but higher uid\r\nDate: Mon, 17 Nov 2026 09:00:00 +0000\r\nMessage-ID: <o@x>\r\n\r\nold\r\n',
    });
    server.addMessage('INBOX', {
      raw: 'From: a@example.com\r\nSubject: Newer but lower uid\r\nDate: Wed, 19 Nov 2026 09:00:00 +0000\r\nMessage-ID: <n@x>\r\n\r\nnew\r\n',
    });
    const pool = poolFor(server, dir, [{ id: 'acc', port: server.port }]);
    const result = await searchMessages(pool, 'acc', {});
    assert.equal(result.messages[0].subject, 'Newer but lower uid');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mail_list_recent returns a bounded window with the period it used', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, [{ id: 'acc', port: server.port }]);
    const recent = await listRecent(pool, 'acc', { days: 30 });
    assert.equal(recent.account_id, 'acc');
    assert.ok(recent.period.since);
    assert.ok(recent.period.until);
    assert.ok(Array.isArray(recent.messages));
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('daily summary data isolates a failing account and keeps the rest', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const deadPort = await unusedPort();
    const pool = poolFor(server, dir, [
      { id: 'alive', port: server.port },
      { id: 'dead', port: deadPort, host: '127.0.0.1' },
    ]);
    const summary = await dailySummaryData(pool, { days: 30 });
    assert.equal(summary.accounts.length, 1);
    assert.equal(summary.accounts[0].account_id, 'alive');
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].account_id, 'dead');
    assert.equal(summary.failures[0].code, 'CONNECTION_FAILED');
    // Every message carries a stable reference for reopening it.
    const message = summary.accounts[0].messages[0];
    assert.deepEqual(message.ref, {
      account_id: 'alive',
      mailbox: 'INBOX',
      uid: message.uid,
      uidvalidity: summary.accounts[0].uidvalidity,
    });
    assert.equal(typeof summary.totals.messages, 'number');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty pool reports zero accounts and refuses work with UNKNOWN_ACCOUNT', async () => {
  const pool = new AccountPool({ accounts: [], errors: [] });
  assert.equal(pool.isEmpty, true);
  assert.deepEqual(pool.list(), []);
  await assert.rejects(
    () => listFolders(pool, 'anything'),
    (error) => error.code === 'UNKNOWN_ACCOUNT',
  );
});

test('a configuration error surfaces as a DISABLED account, not a crash', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        accounts: [{ id: 'broken', provider: 'yandex', user: 'a@yandex.ru', passwordFile: 'missing.secret' }],
      }),
    );
    const pool = new AccountPool(loadAccounts(file));
    assert.equal(pool.list().length, 0);
    assert.equal(pool.statusOf('broken').status, ACCOUNT_STATUS.DISABLED);
    assert.match(pool.statusOf('broken').error, /not readable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('error mapping never leaks the password or a raw protocol dump', () => {
  // An arbitrary failure keeps its generic code and never echoes the input.
  const mapped = toMailError(new Error('mailbox operation failed for user x with pass hunter2'), 'acc');
  const serialised = JSON.stringify({ message: mapped.message, code: mapped.code });
  assert.equal(serialised.includes('hunter2'), false);
  assert.equal(mapped.code, 'IMAP_ERROR');

  // A LOGIN rejection is recognised and classified, still without the secret.
  const loginFailure = toMailError(new Error('LOGIN failed'), 'acc');
  assert.equal(loginFailure.code, 'AUTH_FAILED');
  assert.equal(loginFailure.message.includes('hunter2'), false);

  const auth = toMailError(Object.assign(new Error('nope'), { code: 'AUTHENTICATIONFAILED', responseText: 'hunter2' }), 'acc');
  assert.equal(auth.code, 'AUTH_FAILED');
  assert.equal(JSON.stringify(auth.message).includes('hunter2'), false);
});

test('the mock server only ever sees read commands across a full session', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.withAttachment });
    const pool = poolFor(server, dir, [{ id: 'acc', port: server.port }]);
    await listFolders(pool, 'acc');
    await searchMessages(pool, 'acc', { query: 'attached' });
    await getMessage(pool, 'acc', { uid: 1 });
    await listRecent(pool, 'acc', { days: 7 });
    const observed = new Set(server.commands().map((entry) => entry.command));
    for (const forbidden of ['SELECT', 'STORE', 'APPEND', 'COPY', 'MOVE', 'EXPUNGE', 'CLOSE', 'CREATE', 'DELETE', 'RENAME']) {
      assert.equal(observed.has(forbidden), false, `${forbidden} must never be sent`);
    }
    assert.ok(observed.has('EXAMINE'));
    // And the message is still unread.
    assert.equal(server.flagsOf('INBOX', 1).includes('\\Seen'), false);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
