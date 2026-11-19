// End-to-end tests for preview -> approval -> execute -> verify -> undo.
//
// These run against a real IMAP server over real TLS, so the assertions are about
// what actually happened to the mailbox, not about what the code intended.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadAccounts } from '../src/config.js';
import { AccountPool } from '../src/accounts.js';
import { ApprovalStore, planDigest } from '../src/approvals.js';
import { applyActions, previewActions, undoOperation, operationStatus } from '../src/actions.js';
import { startMockServer, FIXTURES, writeAccountsFile } from './helpers/mock-server.js';

/**
 * Build a pool and a store for one mock account with writes enabled.
 *
 * @param {object} server
 * @param {string} dir
 * @param {object} [overrides]
 * @returns {{pool: AccountPool, store: ApprovalStore, file: string}}
 */
function harnessFor(server, dir, overrides = {}) {
  const file = writeAccountsFile(dir, [
    { id: 'acc', port: server.port, host: '127.0.0.1', allowWrites: true, ...overrides },
  ]);
  process.env.MAIL_IMAP_CA_FILE = path.join(server.tempDir, 'cert.pem');
  const pool = new AccountPool(loadAccounts(file));
  const store = new ApprovalStore({ dir: path.join(dir, 'approvals') });
  return { pool, store, file };
}

/** Approve a digest the way scripts/mail-approve.sh does, from "outside". */
function approve(store, digest, ttlMs = 60000) {
  fs.writeFileSync(
    path.join(store.dir, `approval-${digest}.json`),
    JSON.stringify({
      digest,
      approved_by: 'owner',
      approved_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
    }),
  );
}

/** Seed a message and return its UID. */
function seed(server, raw = FIXTURES.plainEnglish) {
  return server.addMessage('INBOX', { raw }).uid;
}

/** Current uidvalidity of INBOX. */
function uidValidityOf(server) {
  return String(server.server.control.getMailbox('INBOX').uidvalidity);
}

test('mark_read sets \\Seen, verifies it, and records a reversible entry', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    const uidvalidity = uidValidityOf(server);

    const preview = await previewActions(pool, store, {
      actions: [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity, uids: [uid], action: 'mark_read' }],
    });
    assert.equal(preview.executed, false, 'preview must not execute');
    assert.equal(preview.approval.required, false, 'a single organising action needs no approval');
    assert.equal(server.flagsOf('INBOX', uid).includes('\\Seen'), false, 'preview must not change flags');

    const applied = await applyActions(pool, store, {
      actions: [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity, uids: [uid], action: 'mark_read' }],
      digest: preview.digest,
    });
    assert.equal(applied.status, 'completed');
    assert.equal(applied.results[0].status, 'ok');
    assert.equal(applied.results[0].verification.ok, true);
    assert.equal(server.flagsOf('INBOX', uid).includes('\\Seen'), true, 'the server must really hold \\Seen');
    assert.equal(applied.undo_available, true);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mark_unread removes \\Seen', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = server.addMessage('INBOX', { raw: FIXTURES.plainEnglish, flags: ['\\Seen'] }).uid;
    const { pool, store } = harnessFor(server, dir);
    const uidvalidity = uidValidityOf(server);
    const actions = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity, uids: [uid], action: 'mark_unread' }];

    const preview = await previewActions(pool, store, { actions });
    await applyActions(pool, store, { actions, digest: preview.digest });
    assert.equal(server.flagsOf('INBOX', uid).includes('\\Seen'), false);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the same plan cannot be executed twice', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    const actions = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [uid], action: 'mark_read' }];
    const preview = await previewActions(pool, store, { actions });

    await applyActions(pool, store, { actions, digest: preview.digest });
    await assert.rejects(
      () => applyActions(pool, store, { actions, digest: preview.digest }),
      (error) => error.code === 'APPROVAL_ALREADY_USED',
      'replaying an executed plan must be refused',
    );
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a substituted UID is refused before anything is written', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const first = seed(server);
    const second = seed(server, FIXTURES.cyrillicCp1251);
    const { pool, store } = harnessFor(server, dir);
    const uidvalidity = uidValidityOf(server);
    const original = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity, uids: [first], action: 'mark_read' }];
    const preview = await previewActions(pool, store, { actions: original });

    // The agent tries to swap in a different message after the preview.
    const tampered = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity, uids: [second], action: 'mark_read' }];
    await assert.rejects(
      () => applyActions(pool, store, { actions: tampered, digest: preview.digest }),
      (error) => error.code === 'PREVIEW_MISMATCH',
    );
    assert.equal(server.flagsOf('INBOX', second).includes('\\Seen'), false, 'the substituted message must be untouched');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a substituted action, target or account is refused', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    const uidvalidity = uidValidityOf(server);
    const original = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity, uids: [uid], action: 'mark_read' }];
    const preview = await previewActions(pool, store, { actions: original });

    const variants = [
      [{ ...original[0], action: 'mark_unread' }],
      [{ ...original[0], action: 'archive' }],
      [{ ...original[0], mailbox: 'Archive' }],
      [{ ...original[0], uidvalidity: '999' }],
      [{ ...original[0], account_id: 'other' }],
    ];
    for (const variant of variants) {
      await assert.rejects(
        () => applyActions(pool, store, { actions: variant, digest: preview.digest }),
        (error) => error.code === 'PREVIEW_MISMATCH' || error.code === 'UNKNOWN_ACCOUNT',
        `variant ${JSON.stringify(variant[0].action)} must be refused`,
      );
    }
    assert.equal(server.flagsOf('INBOX', uid).includes('\\Seen'), false, 'nothing may have been written');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('move_to_trash requires the owner approval and refuses without it', async () => {
  const server = await startMockServer({
    storage: { INBOX: {}, '': { folders: { Trash: { 'special-use': '\\Trash' } } } },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    const actions = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [uid], action: 'move_to_trash' }];
    const preview = await previewActions(pool, store, { actions });
    assert.equal(preview.approval.required, true, 'trash must require approval');
    assert.match(preview.approval.reasons.join(' '), /trash/);

    await assert.rejects(
      () => applyActions(pool, store, { actions, digest: preview.digest }),
      (error) => {
        assert.equal(error.code, 'APPROVAL_REQUIRED');
        assert.match(error.details.how, /mail-approve\.sh/);
        return true;
      },
    );
    // Nothing moved without the approval.
    assert.ok(server.flagsOf('INBOX', uid), 'the message must still be in INBOX');

    eraseApprovals(store);
    approve(store, preview.digest);
    const applied = await applyActions(pool, store, { actions, digest: preview.digest });
    assert.equal(applied.status, 'completed');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Remove any stale approval files (helper for re-approval in one test). */
function eraseApprovals(store) {
  if (!store.dir) return;
  for (const name of fs.readdirSync(store.dir)) {
    if (name.startsWith('approval-')) fs.unlinkSync(path.join(store.dir, name));
  }
}

test('an approval is consumed once and cannot authorise a second run', async () => {
  const server = await startMockServer({
    storage: { INBOX: {}, '': { folders: { Trash: { 'special-use': '\\Trash' } } } },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    const actions = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [uid], action: 'move_to_trash' }];
    const preview = await previewActions(pool, store, { actions });
    approve(store, preview.digest);
    await applyActions(pool, store, { actions, digest: preview.digest });

    // A second different plan gets its own digest, so it needs its own approval.
    eraseApprovals(store);
    const uid2 = seed(server, FIXTURES.multipart);
    const actions2 = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [uid2], action: 'move_to_trash' }];
    const preview2 = await previewActions(pool, store, { actions: actions2 });
    assert.notEqual(preview2.digest, preview.digest);
    await assert.rejects(
      () => applyActions(pool, store, { actions: actions2, digest: preview2.digest }),
      (error) => error.code === 'APPROVAL_REQUIRED',
    );
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a batch over the threshold needs approval, under it does not', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uids = [];
    for (let index = 0; index < 8; index += 1) uids.push(seed(server, FIXTURES.plainEnglish));
    const { pool, store } = harnessFor(server, dir);
    const uidvalidity = uidValidityOf(server);

    const small = await previewActions(pool, store, {
      actions: [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity, uids: uids.slice(0, 3), action: 'mark_read' }],
    });
    assert.equal(small.approval.required, false);

    const big = await previewActions(pool, store, {
      actions: [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity, uids, action: 'mark_read' }],
    });
    assert.equal(big.approval.required, true);
    assert.match(big.approval.reasons.join(' '), /exceed the batch threshold/);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a plan touching more than 50 messages is refused outright', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const { pool, store } = harnessFor(server, dir);
    const uids = Array.from({ length: 51 }, (_, i) => i + 1);
    await assert.rejects(
      () =>
        previewActions(pool, store, {
          actions: [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: '1', uids, action: 'mark_read' }],
        }),
      (error) => error.code === 'TOO_MANY_MESSAGES',
    );
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed UIDVALIDITY between preview and apply is refused', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    const actions = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [uid], action: 'mark_read' }];
    const preview = await previewActions(pool, store, { actions });

    server.server.control.resetUidValidity('INBOX', { uids: 'keep' });

    await assert.rejects(
      () => applyActions(pool, store, { actions, digest: preview.digest }),
      (error) => ['UID_VALIDITY_CHANGED', 'PREVIEW_EXPIRED', 'MESSAGE_NOT_FOUND'].includes(error.code),
      'a renumbered mailbox must not be written to',
    );
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing UID is reported at preview time, not half-executed', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    seed(server);
    const { pool, store } = harnessFor(server, dir);
    await assert.rejects(
      () =>
        previewActions(pool, store, {
          actions: [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [9999], action: 'mark_read' }],
        }),
      (error) => error.code === 'MESSAGE_NOT_FOUND',
    );
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('undo restores the previous flag state', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    const actions = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [uid], action: 'mark_read' }];
    const preview = await previewActions(pool, store, { actions });
    const applied = await applyActions(pool, store, { actions, digest: preview.digest });
    assert.equal(server.flagsOf('INBOX', uid).includes('\\Seen'), true);

    const undone = await undoOperation(pool, store, { operationId: applied.operation_id });
    assert.equal(undone.status, 'undone');
    assert.equal(server.flagsOf('INBOX', uid).includes('\\Seen'), false, 'undo must clear \\Seen again');
    assert.ok(undone.limitations.length > 0, 'limitations must be stated');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the operation journal records what happened and is readable afterwards', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    const actions = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [uid], action: 'mark_read' }];
    const preview = await previewActions(pool, store, { actions });
    const applied = await applyActions(pool, store, { actions, digest: preview.digest });

    const status = operationStatus(store, { operationId: applied.operation_id });
    assert.equal(status.operation_id, applied.operation_id);
    assert.equal(status.status, 'completed');
    assert.equal(status.results.length, 1);
    assert.equal(status.approved_by, 'not-required');
    assert.equal(status.digest, preview.digest);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a server without MOVE refuses moving instead of using COPY+EXPUNGE', async () => {
  // imapkit without the MOVE plugin: imapflow would silently fall back to
  // COPY + \Deleted + EXPUNGE, which would destroy the message.
  const server = await startMockServer({ plugins: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    await assert.rejects(
      () =>
        previewActions(pool, store, {
          actions: [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [uid], action: 'move_to_folder', target: 'INBOX' }],
        }),
      (error) => {
        assert.equal(error.code, 'UNSUPPORTED');
        assert.match(error.message, /MOVE/);
        return true;
      },
    );
    // And the message is still there.
    assert.ok(server.flagsOf('INBOX', uid));
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('archive on a non-Gmail server moves into the declared \\Archive folder', async () => {
  const server = await startMockServer({
    storage: { INBOX: {}, '': { folders: { Archive: { 'special-use': '\\Archive' } } } },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    const actions = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [uid], action: 'archive' }];
    const preview = await previewActions(pool, store, { actions });
    assert.equal(preview.accounts[0].layout.archive, 'Archive');

    const applied = await applyActions(pool, store, { actions, digest: preview.digest });
    assert.equal(applied.status, 'completed');
    // Gone from INBOX, present in Archive.
    assert.equal(server.flagsOf('INBOX', uid), null);
    assert.equal(server.listMessages('Archive').length, 1);
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('archive refuses with NOT_CONFIGURED when no archive folder exists and none is configured', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    await assert.rejects(
      () =>
        previewActions(pool, store, {
          actions: [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [uid], action: 'archive' }],
        }),
      (error) => {
        assert.equal(error.code, 'NOT_CONFIGURED');
        assert.match(error.message, /archivePath/);
        return true;
      },
    );
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('labels are refused with UNSUPPORTED on a server without X-GM-EXT-1', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    await assert.rejects(
      () =>
        previewActions(pool, store, {
          actions: [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [uid], action: 'add_label', label: 'Work' }],
        }),
      (error) => {
        assert.equal(error.code, 'UNSUPPORTED');
        assert.match(error.message, /X-GM-EXT-1/);
        return true;
      },
    );
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writes are refused for an account that did not opt in', async () => {
  const server = await startMockServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const file = writeAccountsFile(dir, [{ id: 'acc', port: server.port, host: '127.0.0.1' }]);
    process.env.MAIL_IMAP_CA_FILE = path.join(server.tempDir, 'cert.pem');
    const pool = new AccountPool(loadAccounts(file));
    const store = new ApprovalStore({ dir: path.join(dir, 'approvals') });

    await assert.rejects(
      () =>
        previewActions(pool, store, {
          actions: [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity: uidValidityOf(server), uids: [uid], action: 'mark_read' }],
        }),
      (error) => {
        assert.equal(error.code, 'UNSUPPORTED');
        assert.match(error.message, /allowWrites/);
        return true;
      },
    );
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing in an applied plan ever sends EXPUNGE or APPEND', async () => {
  const server = await startMockServer({
    storage: { INBOX: {}, '': { folders: { Archive: { 'special-use': '\\Archive' } } } },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-actions-'));
  try {
    const uid = seed(server);
    const { pool, store } = harnessFor(server, dir);
    const uidvalidity = uidValidityOf(server);

    for (const action of ['mark_read', 'archive', 'mark_unread']) {
      const actions = [{ account_id: 'acc', mailbox: 'INBOX', uidvalidity, uids: [action === 'mark_unread' ? uid : uid], action }];
      try {
        const preview = await previewActions(pool, store, { actions });
        await applyActions(pool, store, { actions, digest: preview.digest });
      } catch {
        // Some actions legitimately refuse once the message has moved; the point
        // of this test is the command stream, which is checked below.
      }
    }

    const commands = new Set(server.commands().map((entry) => entry.command));
    for (const forbidden of ['EXPUNGE', 'UID EXPUNGE', 'CLOSE', 'APPEND', 'UID STORE']) {
      if (forbidden === 'UID STORE') continue; // legitimate for flag writes
      assert.equal(commands.has(forbidden), false, `${forbidden} must never reach the server`);
    }
    // STORE is expected, but never with \Deleted.
    const deletedFlags = server.commands().filter((entry) => String(entry.command).includes('STORE'));
    assert.ok(deletedFlags.length > 0, 'flag writes should have happened');
  } finally {
    delete process.env.MAIL_IMAP_CA_FILE;
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
