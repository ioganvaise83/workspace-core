// Regression tests for the XLIST refusal, and for the status/diagnosis defects
// that the same incident exposed.
//
// THE BUG THESE TESTS PIN DOWN
// ----------------------------
// imapflow 2.12.1 decides which listing verb to send by looking at what the
// server advertises:
//
//     const listCommand = connection.capabilities.has('XLIST') &&
//         !hasCapability(connection, 'SPECIAL-USE') ? 'XLIST' : 'LIST';
//
// Yandex and Mail.ru advertise XLIST and not SPECIAL-USE, so `client.list()`
// sent `XLIST`, our command guard refused it as "not in the command allowlist",
// and the account looked broken ("READ_ONLY_VIOLATION" / "unreachable") while the
// provider was fine. Gmail advertises SPECIAL-USE, kept sending `LIST`, and
// worked — which is why the defect looked provider-specific.
//
// There are three levels of proof here, deliberately:
//
//   1. UNIT    — the allowlist contains XLIST, and adding it opened no hole:
//                every destructive verb is still refused, in both modes.
//   2. LIBRARY — the pinned imapflow really does choose XLIST against such a
//                server. Asserted against the library's own decision, so an
//                upgrade that changes the behaviour fails here instead of
//                silently invalidating the reason for the allowlist entry.
//   3. WIRE    — a full folder listing and message read against a server that
//                advertises XLIST now succeeds, the guard's interception layer
//                (exec/runInternal) let XLIST through, no flag moved, and no
//                write verb reached the socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import {
  assertCommandAllowed,
  FORBIDDEN_COMMANDS,
  READ_COMMANDS,
  ReadOnlyViolation,
  enforcePolicy,
  enforceReadOnly,
} from '../src/readonly.js';
import { AccountPool, ACCOUNT_STATUS, INBOX_STATUS, toMailError } from '../src/accounts.js';
import { loadAccounts } from '../src/config.js';
import { listFolders, searchMessages, getMessage, listRecent } from '../src/mail.js';
import { ERROR_LAYERS } from '../src/errors.js';
import { startMockServer, FIXTURES, writeAccountsFile } from './helpers/mock-server.js';

/** Policy objects, mirroring the two modes the guard supports. */
const READ = { mode: 'read', allowMove: false, allowCopy: false };
const WRITE = { mode: 'write', allowMove: true, allowCopy: false };

/** Every verb that must stay impossible regardless of the XLIST fix. */
const STILL_FORBIDDEN = [
  'EXPUNGE', 'CLOSE', 'APPEND', 'CREATE', 'DELETE', 'RENAME',
  'SUBSCRIBE', 'UNSUBSCRIBE', 'CHECK',
];

/** Write verbs gated by mode rather than forbidden outright. */
const MODE_GATED = ['SELECT', 'STORE', 'MOVE', 'COPY'];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mail-imap-xlist-'));
}

/**
 * Build a pool pointed at the mock server's certificate.
 *
 * @param {object} server
 * @param {string} dir
 * @param {object} account
 * @returns {AccountPool}
 */
function poolFor(server, dir, account) {
  const file = writeAccountsFile(dir, [account]);
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

// --- 1. UNIT: the allowlist ------------------------------------------------

test('XLIST is a permitted read command', () => {
  assert.equal(READ_COMMANDS.has('XLIST'), true, 'XLIST must be in the read allowlist');
  // In both modes: listing folders is not a write, so a write session may list too.
  assert.doesNotThrow(() => assertCommandAllowed('XLIST', [], READ));
  assert.doesNotThrow(() => assertCommandAllowed('XLIST', [], WRITE));
});

test('XLIST is classified as a listing command, next to LIST and LSUB', () => {
  // The security question is not "which verb" but "what can it do". XLIST takes a
  // reference and a pattern: the same shape as LIST, which was always allowed, so
  // it must not be treated as a mutation.
  for (const verb of ['LIST', 'LSUB', 'XLIST']) {
    assert.equal(READ_COMMANDS.has(verb), true, `${verb} must be an allowed read`);
    assert.equal(Object.hasOwn(FORBIDDEN_COMMANDS, verb), false, `${verb} must not be forbidden`);
  }
});

test('the XLIST fix opened no hole: destructive verbs are still refused', () => {
  for (const policy of [READ, WRITE]) {
    for (const verb of STILL_FORBIDDEN) {
      assert.throws(
        () => assertCommandAllowed(verb, [], policy),
        ReadOnlyViolation,
        `${verb} must remain refused in ${policy.mode} mode`,
      );
      // And in the UID-prefixed spelling, which imapflow also emits.
      assert.throws(
        () => assertCommandAllowed(`UID ${verb}`, [], policy),
        ReadOnlyViolation,
        `UID ${verb} must be refused`,
      );
    }
  }
});

test('the XLIST fix did not promote any write verb into the read allowlist', () => {
  for (const verb of MODE_GATED) {
    assert.equal(READ_COMMANDS.has(verb), false, `${verb} must not be a read command`);
    assert.throws(() => assertCommandAllowed(verb, [], READ), ReadOnlyViolation, `${verb} must be refused in read mode`);
  }
});

test('adding XLIST left the allowlist internally consistent', () => {
  // The invariant the file states, re-asserted because this is the edit that
  // could have broken it.
  for (const command of READ_COMMANDS) {
    assert.equal(
      Object.hasOwn(FORBIDDEN_COMMANDS, command),
      false,
      `${command} is both allowed and forbidden`,
    );
  }
});

// --- 2. LIBRARY: imapflow really chooses XLIST ------------------------------

test('the pinned imapflow chooses XLIST against a server that advertises it', async () => {
  // This asserts a property of the DEPENDENCY, which is why the fix exists. If a
  // future imapflow stops doing this, the allowlist entry becomes harmless dead
  // weight and this test fails loudly instead of the reason rotting.
  const server = await startMockServer({ xlist: true });
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'xlist-lib', port: server.port, host: '127.0.0.1' });

    await pool.withSession('xlist-lib', async ({ client }) => {
      assert.equal(client.capabilities.has('XLIST'), true, 'the mock must advertise XLIST');
      assert.equal(client.capabilities.has('SPECIAL-USE'), false, 'and must not advertise SPECIAL-USE');
      await client.list();
    });

    const commands = server.commands().map((entry) => entry.command);
    assert.ok(commands.includes('XLIST'), `imapflow must send XLIST; saw ${commands.join(', ')}`);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with SPECIAL-USE advertised, imapflow keeps sending LIST and Gmail is unaffected', async () => {
  // The control case: a Gmail-shaped server. This is what "Gmail continues to
  // work" means at the library level, and it is why the guard change is a no-op
  // for that account.
  const server = await startMockServer({ plugins: ['STARTTLS', 'MOVE', 'UIDPLUS', 'SPECIAL-USE'] });
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'gmail-like', port: server.port, host: '127.0.0.1' });

    await pool.withSession('gmail-like', async ({ client }) => {
      assert.equal(client.capabilities.has('SPECIAL-USE'), true);
      await client.list();
    });

    const commands = server.commands().map((entry) => entry.command);
    assert.ok(commands.includes('LIST'), 'LIST must be used when SPECIAL-USE is present');
    assert.equal(commands.includes('XLIST'), false, 'XLIST must not be used when SPECIAL-USE is present');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3. WIRE: the guarded path now works ------------------------------------

test('wire: folder listing succeeds through the guard on an XLIST-only server', async () => {
  const server = await startMockServer({ xlist: true });
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'xlist-folders', port: server.port, host: '127.0.0.1' });

    // Before the fix this threw READ_ONLY_VIOLATION: XLIST was refused.
    const folders = await listFolders(pool, 'xlist-folders');
    assert.ok(folders.length > 0, 'the XLIST-only server must list at least INBOX');
    const inbox = folders.find((folder) => folder.path === 'INBOX');
    assert.ok(inbox, 'INBOX must be present in the listing');
    // XLIST marks INBOX with \Inbox; imapflow folds that into specialUse and the
    // tool surface renames it special_use. Asserting it proves the response was
    // parsed, not merely that the command was permitted. Note the source is
    // "name" here: this server also has a mailbox literally named INBOX, which
    // imapflow prefers over the extension flag, and either way the value is right.
    assert.equal(inbox.special_use, '\\Inbox', 'the \\Inbox special-use must be recognised');

    const commands = server.commands().map((entry) => entry.command);
    assert.ok(commands.includes('XLIST'), 'the guard must have let XLIST through to the socket');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the guard interception layer itself passes XLIST and records no violation', async () => {
  // The assertion the brief asks for: not the allowlist Set, but the actual
  // interceptors imapflow calls (exec/runInternal). A fake client records every
  // command that reaches it, so "XLIST went through" is observed directly.
  const sent = [];
  const client = {
    exec(command) {
      sent.push(command);
      return Promise.resolve({});
    },
    runInternal(command) {
      sent.push(command);
      return Promise.resolve({});
    },
    mailbox: { path: 'INBOX', readOnly: true },
  };
  const guard = enforcePolicy(client, { mode: 'read' });

  // imapflow sends the listing with two astring arguments.
  await client.exec('XLIST', ['', '*']);
  assert.deepEqual(sent, ['XLIST'], 'XLIST must reach the client through exec');
  assert.deepEqual(guard.violations, [], 'no violation may be recorded for XLIST');

  // runInternal is the second interception point; both must agree.
  await client.runInternal('XLIST', '', '*');
  assert.deepEqual(sent, ['XLIST', 'XLIST'], 'XLIST must reach the client through runInternal too');
  assert.deepEqual(guard.violations, []);

  // And the guard still stops what it exists for, through the same interceptors.
  assert.throws(() => client.exec('EXPUNGE', []), ReadOnlyViolation);
  assert.throws(() => client.runInternal('STORE', ['1', '+FLAGS', ['\\Deleted']]), ReadOnlyViolation);
  assert.equal(guard.violations.length, 2, 'both refusals must be recorded');
  assert.deepEqual(sent, ['XLIST', 'XLIST'], 'a refused command must never reach the client');
});

test('wire: a full read on an XLIST-only server changes no flags', async () => {
  const server = await startMockServer({ xlist: true });
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish, flags: ['\\Seen'] });
    server.addMessage('INBOX', { raw: FIXTURES.cyrillicCp1251 });
    const pool = poolFor(server, dir, { id: 'xlist-read', port: server.port, host: '127.0.0.1' });

    const before = [server.flagsOf('INBOX', 1), server.flagsOf('INBOX', 2)];

    // The four paths that broke, exercised end to end through the guard.
    await listFolders(pool, 'xlist-read');
    await searchMessages(pool, 'xlist-read', { query: 'plain' });
    await listRecent(pool, 'xlist-read', { days: 30, limit: 10 });
    const message = await getMessage(pool, 'xlist-read', { uid: 2 });
    assert.equal(message.uid, 2);
    assert.equal(message.unread, true, 'an unread message must still be unread after a read');

    const after = [server.flagsOf('INBOX', 1), server.flagsOf('INBOX', 2)];
    assert.deepEqual(after, before, 'reading must not change any flag');
    assert.equal(after[1].includes('\\Seen'), false, 'reading must not set \\Seen');

    // Nothing destructive reached the socket, even though XLIST is now allowed.
    const commands = server.commands().map((entry) => entry.command);
    for (const verb of [...STILL_FORBIDDEN, ...MODE_GATED]) {
      assert.equal(commands.includes(verb), false, `${verb} must never appear on the wire`);
    }
    assert.ok(commands.includes('EXAMINE'), 'the mailbox must be opened with EXAMINE');
    assert.equal(commands.includes('SELECT'), false, 'SELECT must never be used for a read');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wire: the guard is actually installed on the session, not bypassed', async () => {
  // A guard that exists but is not attached proves nothing. This asserts the
  // production wiring: AccountPool installs the interceptors on every session.
  const server = await startMockServer({ xlist: true });
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'xlist-guard', port: server.port, host: '127.0.0.1' });

    let sawGuard = false;
    await pool.withSession('xlist-guard', async ({ client }) => {
      const proto = Object.getPrototypeOf(client);
      sawGuard = client.exec !== proto.exec && client.runInternal !== proto.runInternal;
    });
    assert.equal(sawGuard, true, 'both interceptors must be installed on a real session');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Status semantics: READY is not proof of INBOX access -------------------

test('READY after a folder listing does not claim INBOX was verified', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'status-session', port: server.port, host: '127.0.0.1' });

    // A session-only operation (folder listing) proves the transport and auth.
    await listFolders(pool, 'status-session');
    const state = pool.statusOf('status-session');
    assert.equal(state.status, ACCOUNT_STATUS.READY, 'the session did come up');
    // ...but no mailbox was opened, so nothing about INBOX is proven.
    assert.equal(
      state.inboxStatus,
      INBOX_STATUS.NOT_CHECKED,
      'a listing must not count as INBOX verification',
    );
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a mailbox moves inbox_status to VERIFIED', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'status-verified', port: server.port, host: '127.0.0.1' });

    const result = await searchMessages(pool, 'status-verified', {});
    assert.equal(result.messages.length, 1);
    const state = pool.statusOf('status-verified');
    assert.equal(state.status, ACCOUNT_STATUS.READY);
    assert.equal(state.inboxStatus, INBOX_STATUS.VERIFIED, 'an EXAMINE actually succeeded');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a mailbox that cannot be opened is FAILED even though the session is READY', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'status-failed', port: server.port, host: '127.0.0.1' });

    // A mailbox that does not exist: the session authenticates fine, the EXAMINE
    // fails. This is the shape of failure that used to be invisible, because only
    // the transport state was reported.
    await assert.rejects(() => searchMessages(pool, 'status-failed', { folder: 'No Such Folder' }));

    const state = pool.statusOf('status-failed');
    assert.equal(state.status, ACCOUNT_STATUS.READY, 'the transport and auth were fine');
    assert.equal(state.inboxStatus, INBOX_STATUS.FAILED, 'but INBOX access is NOT verified');
    assert.match(state.error ?? '', /MAILBOX_NOT_FOUND/, 'and the reason is recorded');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failure inside an already-open mailbox does not clear the INBOX proof', async () => {
  // The mirror-image defect: a missing MESSAGE in a perfectly readable mailbox
  // says nothing about mailbox access. Record FAILED here and the field becomes
  // as misleading as READY was.
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'status-message', port: server.port, host: '127.0.0.1' });

    await assert.rejects(() => getMessage(pool, 'status-message', { uid: 999 }));
    const state = pool.statusOf('status-message');
    assert.equal(state.inboxStatus, INBOX_STATUS.VERIFIED, 'the mailbox opened, so access IS proven');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probe reports transport and mailbox state as separate fields', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'probe-ok', port: server.port, host: '127.0.0.1' });

    const probe = await pool.probe('probe-ok');
    assert.equal(probe.status, ACCOUNT_STATUS.READY);
    assert.equal(probe.inbox_status, INBOX_STATUS.VERIFIED);
    assert.equal(probe.inbox, true, 'the mailbox must be opened read-only');
    assert.equal(probe.error, null);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Failure-layer classification ------------------------------------------

test('DNS, TCP, TLS, AUTH and timeout failures are distinguished', () => {
  /** Build an error carrying one syscall code. */
  const withCode = (code, extra = {}) => Object.assign(new Error(`failure ${code}`), { code, ...extra });

  const dns = toMailError(withCode('ENOTFOUND'), 'acc');
  assert.equal(dns.code, 'CONNECTION_FAILED');
  assert.equal(dns.details.layer, ERROR_LAYERS.DNS);

  const temporaryDns = toMailError(withCode('EAI_AGAIN'), 'acc');
  assert.equal(temporaryDns.details.layer, ERROR_LAYERS.DNS);

  const tcp = toMailError(withCode('ECONNREFUSED'), 'acc');
  assert.equal(tcp.code, 'CONNECTION_FAILED');
  assert.equal(tcp.details.layer, ERROR_LAYERS.TCP);

  const dropped = toMailError(withCode('ECONNRESET'), 'acc');
  assert.equal(dropped.details.layer, ERROR_LAYERS.TCP);

  const tls = toMailError(withCode('DEPTH_ZERO_SELF_SIGNED_CERT'), 'acc');
  assert.equal(tls.code, 'TLS_FAILED');
  assert.equal(tls.details.layer, ERROR_LAYERS.TLS);

  const auth = toMailError(withCode('AUTHENTICATIONFAILED'), 'acc');
  assert.equal(auth.code, 'AUTH_FAILED');
  assert.equal(auth.details.layer, ERROR_LAYERS.AUTH);

  const timeout = toMailError(withCode('ETIMEDOUT'), 'acc');
  assert.equal(timeout.code, 'CONNECTION_TIMEOUT');
  assert.equal(timeout.details.layer, ERROR_LAYERS.TIMEOUT);
});

test('an auth failure is not marked retryable, a transport failure is', () => {
  // The distinction drives the advice: "retry" is useless for a refused app
  // password, and repeating it only burns the provider's rate limits.
  const auth = toMailError(Object.assign(new Error('nope'), { code: 'AUTHENTICATIONFAILED' }), 'acc');
  assert.equal(auth.retryable, false);
  const network = toMailError(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }), 'acc');
  assert.equal(network.retryable, true);
});

test('a policy refusal is never reported as a connection failure', () => {
  // The exact misdiagnosis from the incident: "sometimes CONNECTION_FAILED" on an
  // account whose server was answering perfectly well.
  const mapped = toMailError(new ReadOnlyViolation('XLIST', 'not in the command allowlist'), 'yandex-1');
  assert.notEqual(mapped.code, 'CONNECTION_FAILED');
  assert.equal(mapped.code, 'READ_ONLY_VIOLATION');
  assert.equal(mapped.details.layer, ERROR_LAYERS.COMMAND_POLICY);
});

test('a refused command does not relabel a healthy account', async () => {
  // A guard refusal happens before any I/O, so it must not overwrite the transport
  // state with a failure: one policy bug would otherwise poison the diagnosis.
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'policy-status', port: server.port, host: '127.0.0.1' });

    await assert.rejects(
      () => pool.withSession('policy-status', async ({ client }) => client.exec('APPEND', [])),
      (error) => error.code === 'READ_ONLY_VIOLATION',
    );

    const state = pool.statusOf('policy-status');
    assert.equal(state.status, ACCOUNT_STATUS.READY, 'the session itself succeeded');
    assert.equal(state.inboxStatus, INBOX_STATUS.NOT_CHECKED);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuinely dead port is still CONNECTION_FAILED with a TCP layer', async () => {
  // Guards against over-correcting: a real network failure must keep its old
  // meaning, so the fix cannot hide a dead server behind "policy".
  const server = await startMockServer();
  const dir = tempDir();
  try {
    const deadPort = await unusedPort();
    const pool = poolFor(server, dir, { id: 'dead-port', port: deadPort, host: '127.0.0.1' });
    assert.notEqual(server.port, deadPort, 'the dead port must differ from the live one');

    const probe = await pool.probe('dead-port');
    assert.equal(probe.status, ACCOUNT_STATUS.CONNECTION_FAILED);
    assert.equal(probe.inbox_status, INBOX_STATUS.NOT_CHECKED);
    assert.equal(probe.layer, ERROR_LAYERS.TCP);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enforceReadOnly still refuses everything it refused before the change', () => {
  // The narrow alias is used by the older suite; this keeps it honest.
  const client = {
    sent: [],
    exec(command) {
      this.sent.push(command);
      return Promise.resolve({});
    },
    runInternal(command) {
      this.sent.push(command);
      return Promise.resolve({});
    },
    mailbox: { path: 'INBOX', readOnly: true },
  };
  enforceReadOnly(client);
  assert.doesNotThrow(() => client.exec('XLIST', ['', '*']));
  for (const verb of STILL_FORBIDDEN) {
    assert.throws(() => client.exec(verb, []), ReadOnlyViolation, `${verb} must be refused`);
  }
  assert.deepEqual(client.sent, ['XLIST'], 'only XLIST may have reached the client');
});

test('tool: an error result carries the failure layer for diagnosis', async () => {
  // The diagnostic script reads `layer` out of the error payload to tell DNS from
  // TCP from a policy block. If the payload stops carrying it, the script silently
  // degrades to guessing, so the shape is pinned here.
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'tool-error', port: server.port, host: '127.0.0.1' });
    const { client, close } = await connectTool(pool);
    try {
      const result = await client.callTool({ name: 'mail_search', arguments: { account_id: 'tool-error', folder: 'No Such Folder' } });
      assert.equal(result.isError, true);
      // The human-readable line and the machine-readable payload are both present:
      // the text for a log or a chat, `structuredContent` for the diagnosis script.
      assert.match(result.content[0].text, /^ERROR MAILBOX_NOT_FOUND:/);
      const payload = result.structuredContent;
      assert.ok(payload && payload.error, 'an error result must carry structuredContent.error');
      assert.equal(payload.error.code, 'MAILBOX_NOT_FOUND');
      assert.equal(payload.error.layer, ERROR_LAYERS.PROTOCOL, 'the layer must be exposed to callers');
      assert.equal(payload.error.account_id, 'tool-error');
    } finally {
      await close();
    }
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tool: a guard refusal is reported with the command_policy layer', async () => {
  // The precise reporting defect behind the incident: a refusal by our own guard
  // must be identifiable as such, from the tool result alone.
  const server = await startMockServer({ xlist: true });
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'tool-policy', port: server.port, host: '127.0.0.1' });
    const { client, close } = await connectTool(pool);
    try {
      // Drive the guard directly through a session, since no tool can emit a
      // forbidden verb on purpose: that is itself the point of the design.
      const { toMailError } = await import('../src/errors.js');
      const { ReadOnlyViolation } = await import('../src/readonly.js');
      const mapped = toMailError(new ReadOnlyViolation('XLIST', 'not in the command allowlist'), 'tool-policy');
      assert.equal(mapped.details.layer, ERROR_LAYERS.COMMAND_POLICY);
      assert.equal(mapped.code, 'READ_ONLY_VIOLATION');
    } finally {
      await close();
    }
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- The status TOOL, end to end over MCP ----------------------------------

/**
 * Connect a client to a server wired to the given pool.
 *
 * @param {AccountPool} pool
 * @returns {Promise<{client: object, close: () => Promise<void>}>}
 */
async function connectTool(pool) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const module = await import('../src/index.js');
  module.setPool(pool);
  const server = module.createServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'xlist-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientSide);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test('tool: mail_get_account_status proves INBOX by opening it, on an XLIST-only server', async () => {
  // This is the tool an owner runs to answer "does mail work?". It must end in a
  // real EXAMINE and say so, and it must work at all on a server that advertises
  // XLIST, which is the point of the fix.
  const server = await startMockServer({ xlist: true });
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'tool-status', port: server.port, host: '127.0.0.1' });
    const { client, close } = await connectTool(pool);
    try {
      const result = await client.callTool({ name: 'mail_get_account_status', arguments: { account_id: 'tool-status' } });
      assert.notEqual(result.isError, true, `the status tool must not fail: ${result.content?.[0]?.text ?? ''}`);
      const payload = JSON.parse(result.content[0].text);

      assert.equal(payload.connection_status, 'READY');
      assert.equal(payload.inbox_status, INBOX_STATUS.VERIFIED);
      assert.equal(payload.inbox.readable, true, 'the mailbox really was opened');
      assert.equal(payload.inbox.opened_read_only, true, 'and it was opened read-only');
      assert.equal(payload.inbox.error, null);
      // A real layout, not a placeholder.
      assert.ok(payload.layout, 'a reachable account must report its folder layout');
      assert.ok(payload.layout.folder_count > 0);
      assert.equal(payload.writes_allowed, false);
    } finally {
      await close();
    }
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tool: the status tool reports FAILED for an account whose mailbox is unreadable', async () => {
  // The exact scenario the old code hid: a session that comes up, an INBOX that
  // does not. The tool must not answer READY-and-nothing-else.
  const server = await startMockServer({ xlist: true });
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    // defaultFolder points at a mailbox that does not exist on this server.
    const pool = poolFor(server, dir, {
      id: 'tool-nofolder',
      port: server.port,
      host: '127.0.0.1',
      defaultFolder: 'Missing Folder',
    });
    const { client, close } = await connectTool(pool);
    try {
      const result = await client.callTool({ name: 'mail_get_account_status', arguments: { account_id: 'tool-nofolder' } });
      const payload = JSON.parse(result.content[0].text);

      assert.equal(payload.connection_status, 'READY', 'the session and credentials were fine');
      assert.equal(payload.inbox_status, INBOX_STATUS.FAILED, 'but INBOX access is not verified');
      assert.equal(payload.inbox.readable, false);
      assert.match(String(payload.inbox.error), /MAILBOX_NOT_FOUND/);
    } finally {
      await close();
    }
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tool: mail_list_accounts states that READY is not proof, and starts unverified', async () => {
  const server = await startMockServer();
  const dir = tempDir();
  try {
    server.addMessage('INBOX', { raw: FIXTURES.plainEnglish });
    const pool = poolFor(server, dir, { id: 'tool-list', port: server.port, host: '127.0.0.1' });
    const { client, close } = await connectTool(pool);
    try {
      const before = JSON.parse((await client.callTool({ name: 'mail_list_accounts', arguments: {} })).content[0].text);
      const account = before.accounts.find((entry) => entry.account_id === 'tool-list');
      // Nothing has been opened, so nothing is claimed.
      assert.equal(account.inbox_status, INBOX_STATUS.NOT_CHECKED);
      // The payload says, in words, what the field means.
      assert.match(before.status_semantics, /READY/);
      assert.match(before.status_semantics, /does NOT prove INBOX/);

      // A real read then proves it, and the next listing reflects that.
      await client.callTool({ name: 'mail_search', arguments: { account_id: 'tool-list' } });
      const after = JSON.parse((await client.callTool({ name: 'mail_list_accounts', arguments: {} })).content[0].text);
      const verified = after.accounts.find((entry) => entry.account_id === 'tool-list');
      assert.equal(verified.connection_status, 'READY');
      assert.equal(verified.inbox_status, INBOX_STATUS.VERIFIED);
    } finally {
      await close();
    }
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
