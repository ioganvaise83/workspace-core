// Tests for the read-only boundary.
//
// Two kinds of assertion, deliberately separated:
//
//   1. UNIT  — the command guard refuses every write verb and every non-PEEK
//              body fetch, without a socket.
//   2. WIRE  — against a real IMAP server, the exact command stream contains no
//              write command, the mailbox is opened with EXAMINE, and the flags
//              of a message are byte-identical before and after a full read.
//
// The second kind is what makes "read-only" a fact rather than a claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { enforceReadOnly, findUnpeekedBodySection, ReadOnlyViolation, ALLOWED_COMMANDS, DENIED_COMMANDS, assertSelectedReadOnly } from '../src/readonly.js';
import { AccountPool } from '../src/accounts.js';
import { getMessage, searchMessages, listFolders } from '../src/mail.js';
import { startMockServer, FIXTURES, writeAccountsFile } from './helpers/mock-server.js';
import { loadAccounts } from '../src/config.js';
import os from 'node:os';
import path from 'node:path';

/** A fake client that records the commands it is asked to send. */
function fakeClient() {
  const sent = [];
  return {
    sent,
    exec(command, attributes) {
      sent.push(command);
      return Promise.resolve({});
    },
    runInternal(command) {
      sent.push(command);
      return Promise.resolve({});
    },
    mailbox: { path: 'INBOX', readOnly: true },
  };
}

const WRITE_COMMANDS = [
  'SELECT', 'STORE', 'APPEND', 'COPY', 'MOVE', 'EXPUNGE', 'CLOSE',
  'CREATE', 'DELETE', 'RENAME', 'SUBSCRIBE', 'UNSUBSCRIBE',
];

test('every forbidden write command is refused by the guard', () => {
  for (const command of WRITE_COMMANDS) {
    const client = fakeClient();
    enforceReadOnly(client);
    assert.throws(
      () => client.exec(command, []),
      (error) => error instanceof ReadOnlyViolation && error.command === command,
      `${command} must be refused`,
    );
    assert.deepEqual(client.sent, [], `${command} must not reach the socket`);
  }
});

test('the permanently forbidden verbs stay forbidden in every mode', async () => {
  // The new task permits organising, but never these. This is the contract.
  const { FORBIDDEN_COMMANDS } = await import('../src/readonly.js');
  for (const verb of ['EXPUNGE', 'CLOSE', 'APPEND', 'CREATE', 'DELETE', 'RENAME']) {
    assert.ok(Object.hasOwn(FORBIDDEN_COMMANDS, verb), `${verb} must be documented as forbidden`);
    assert.equal(ALLOWED_COMMANDS.has(verb), false, `${verb} must not be in the read allowlist`);
  }
  // STORE/MOVE/COPY are no longer blanket-denied; they are gated by write mode
  // and inspected per command (see the write-policy tests).
  const writeGuard = await import('../src/readonly.js');
  assert.equal(writeGuard.WRITE_COMMANDS.has('STORE'), true);
});

test('the allowlist contains no command that can change mailbox state', () => {
  for (const command of ALLOWED_COMMANDS) {
    assert.equal(command in DENIED_COMMANDS, false, `${command} is both allowed and denied`);
  }
  // SELECT opens read-write, so it must never be allowed.
  assert.equal(ALLOWED_COMMANDS.has('SELECT'), false);
});

test('read commands are permitted and reach the client', async () => {
  const client = fakeClient();
  enforceReadOnly(client);
  for (const command of ['EXAMINE', 'FETCH', 'SEARCH', 'LIST', 'STATUS', 'NOOP', 'LOGOUT']) {
    await client.exec(command, []);
  }
  assert.deepEqual(client.sent, ['EXAMINE', 'FETCH', 'SEARCH', 'LIST', 'STATUS', 'NOOP', 'LOGOUT']);
});

test('a FETCH without PEEK is refused, and the guard names the atom', () => {
  const client = fakeClient();
  enforceReadOnly(client);
  const unpeeked = [{ type: 'ATOM', value: 'BODY', section: [] }];
  assert.throws(() => client.exec('FETCH', unpeeked), /body section without PEEK/);
  assert.deepEqual(client.sent, []);
});

test('RFC822 and RFC822.TEXT are refused: they imply \\Seen', () => {
  for (const atom of ['RFC822', 'RFC822.TEXT', 'RFC822.HEADER', 'BODY[TEXT]', 'BINARY[]']) {
    assert.ok(findUnpeekedBodySection([{ type: 'ATOM', value: atom }]), `${atom} must be flagged`);
  }
});

test('PEEK forms are accepted', () => {
  for (const atom of ['BODY.PEEK[]', 'BODY.PEEK[HEADER]', 'BODY.PEEK[1]', 'BINARY.PEEK[1]']) {
    assert.equal(findUnpeekedBodySection([{ type: 'ATOM', value: atom, section: [] }]), null, `${atom} must pass`);
  }
});

test('non-body FETCH items are unaffected by the PEEK check', () => {
  const items = [
    { type: 'ATOM', value: 'UID' },
    { type: 'ATOM', value: 'FLAGS' },
    { type: 'ATOM', value: 'ENVELOPE' },
    { type: 'ATOM', value: 'RFC822.SIZE' },
  ];
  assert.equal(findUnpeekedBodySection(items), null);
});

test('the guard covers runInternal, so a library-internal path cannot bypass it', () => {
  const client = fakeClient();
  enforceReadOnly(client);
  assert.throws(() => client.runInternal('STORE'), ReadOnlyViolation);
  assert.deepEqual(client.sent, []);
});

test('a selected mailbox is asserted read-only', () => {
  assert.throws(() => assertSelectedReadOnly({ mailbox: { path: 'INBOX', readOnly: false } }), ReadOnlyViolation);
  assert.throws(() => assertSelectedReadOnly({ mailbox: false }), ReadOnlyViolation);
  assert.doesNotThrow(() => assertSelectedReadOnly({ mailbox: { path: 'INBOX', readOnly: true } }));
});

// --- Wire-level assertions --------------------------------------------------

/**
 * Build a pool for one mock account and point the client at the mock CA.
 *
 * The certificate is trusted through MAIL_IMAP_CA_FILE, which ADDS a root and
 * leaves verification enabled — the same mechanism a corporate TLS-inspecting
 * proxy needs. Disabling verification would make these tests prove nothing.
 *
 * @param {object} server mock harness
 * @param {string} dir temp dir for the accounts file
 * @param {string} id account id
 * @returns {AccountPool}
 */
function poolForMock(server, dir, id) {
  const file = writeAccountsFile(dir, [{ id, port: server.port, host: '127.0.0.1' }]);
  process.env.MAIL_IMAP_CA_FILE = path.join(server.tempDir, 'cert.pem');
  return new AccountPool(loadAccounts(file));
}

test('wire: a full message read issues only read commands and never changes flags', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-imap-ro-'));
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish, flags: ['\\Seen'] });
    server.addMessage('INBOX', { raw: FIXTURES.cyrillicCp1251 });
    const pool = poolForMock(server, dir, 'wire');

    const before = [server.flagsOf('INBOX', 1), server.flagsOf('INBOX', 2)];

    const message = await getMessage(pool, 'wire', { uid: 2 });
    assert.equal(message.uid, 2);

    const after = [server.flagsOf('INBOX', 1), server.flagsOf('INBOX', 2)];
    assert.deepEqual(after, before, 'reading must not change flags');

    // The unread message is still unread on the server.
    assert.equal(after[1].includes('\\Seen'), false, 'reading must not set \\Seen');

    const commands = server.commands().map((entry) => entry.command);
    for (const write of WRITE_COMMANDS) {
      assert.equal(commands.includes(write), false, `${write} must never appear on the wire`);
    }
    assert.ok(commands.includes('EXAMINE'), 'the mailbox must be opened with EXAMINE');
    assert.equal(commands.includes('SELECT'), false, 'SELECT must never be used');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wire: search and folder listing also never write', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-imap-ro2-'));
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolForMock(server, dir, 'wire2');

    const before = server.flagsOf('INBOX', 1);
    await listFolders(pool, 'wire2');
    await searchMessages(pool, 'wire2', { query: 'plain' });
    const after = server.flagsOf('INBOX', 1);

    assert.deepEqual(after, before);
    const commands = server.commands().map((entry) => entry.command);
    for (const write of WRITE_COMMANDS) {
      assert.equal(commands.includes(write), false, `${write} must never appear on the wire`);
    }
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
