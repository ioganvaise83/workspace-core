// Tests for the write policy and the approval mechanism.
//
// These are the tests that matter most in this migration: they assert that the
// things which must never happen cannot happen, and that approval cannot be
// manufactured by the agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertCommandAllowed,
  FORBIDDEN_COMMANDS,
  inspectStore,
  ReadOnlyViolation,
  enforcePolicy,
  collectAtoms,
} from '../src/readonly.js';
import {
  ACTIONS,
  ApprovalStore,
  MAX_BATCH,
  approvalRequirement,
  canonicalItem,
  planDigest,
  summarisePlan,
} from '../src/approvals.js';

/** A policy object in write mode with MOVE available. */
const WRITE = { mode: 'write', allowMove: true, allowCopy: false };
/** A policy object in read mode. */
const READ = { mode: 'read', allowMove: false, allowCopy: false };

/** Build STORE attributes the way imapflow does. */
function storeAttrs(operation, flags) {
  return [{ type: 'SEQUENCE', value: '1:5' }, { type: 'ATOM', value: operation }, flags.map((flag) => ({ type: 'ATOM', value: flag }))];
}

test('EXPUNGE is refused in both modes, in every spelling', () => {
  for (const policy of [READ, WRITE]) {
    for (const command of ['EXPUNGE', 'UID EXPUNGE', 'expunge']) {
      assert.throws(() => assertCommandAllowed(command, [], policy), ReadOnlyViolation, `${command} must be refused`);
    }
  }
});

test('CLOSE and APPEND are refused in both modes', () => {
  for (const policy of [READ, WRITE]) {
    assert.throws(() => assertCommandAllowed('CLOSE', [], policy), ReadOnlyViolation);
    assert.throws(() => assertCommandAllowed('UID CLOSE', [], policy), ReadOnlyViolation);
    assert.throws(() => assertCommandAllowed('APPEND', [], policy), ReadOnlyViolation);
  }
});

test('STORE with \\Deleted is refused even in write mode', () => {
  // This is the subtle one: a \\Deleted flag is not itself a deletion, but the
  // user's own mail client would expunge it later. Refusing it is the only way to
  // guarantee this integration never causes mail to disappear.
  assert.throws(
    () => assertCommandAllowed('UID STORE', storeAttrs('+FLAGS', ['\\Deleted']), WRITE),
    /destructive and refused/,
  );
  assert.throws(
    () => assertCommandAllowed('STORE', storeAttrs('FLAGS', ['\\Deleted', '\\Seen']), WRITE),
    /destructive and refused/,
  );
});

test('STORE with \\Seen and \\Flagged is allowed in write mode', () => {
  assert.doesNotThrow(() => assertCommandAllowed('UID STORE', storeAttrs('+FLAGS', ['\\Seen']), WRITE));
  assert.doesNotThrow(() => assertCommandAllowed('UID STORE', storeAttrs('-FLAGS', ['\\Seen']), WRITE));
  assert.doesNotThrow(() => assertCommandAllowed('UID STORE', storeAttrs('+FLAGS', ['\\Flagged']), WRITE));
});

test('STORE with an unknown flag is refused', () => {
  assert.throws(() => assertCommandAllowed('UID STORE', storeAttrs('+FLAGS', ['$NotAThing']), WRITE), /not an organising flag/);
});

test('clearing all flags is refused: it would drop \\Seen silently', () => {
  assert.throws(() => assertCommandAllowed('UID STORE', storeAttrs('FLAGS', []), WRITE), /clearing all flags/);
});

test('X-GM-LABELS writes are allowed in write mode', () => {
  assert.doesNotThrow(() => assertCommandAllowed('UID STORE', storeAttrs('+X-GM-LABELS', ['Work']), WRITE));
  assert.doesNotThrow(() => assertCommandAllowed('UID STORE', storeAttrs('-X-GM-LABELS', ['\\Inbox']), WRITE));
});

test('a write command on a read session is refused', () => {
  for (const command of ['STORE', 'UID STORE', 'MOVE', 'UID MOVE', 'COPY', 'SELECT']) {
    assert.throws(() => assertCommandAllowed(command, storeAttrs('+FLAGS', ['\\Seen']), READ), ReadOnlyViolation, `${command}`);
  }
});

test('MOVE is refused when the server does not advertise it', () => {
  // Without MOVE, imapflow silently emulates it with COPY + \\Deleted + EXPUNGE.
  // Refusing here is what prevents that fallback from ever running.
  const noMove = { mode: 'write', allowMove: false, allowCopy: false };
  assert.throws(() => assertCommandAllowed('UID MOVE', [], noMove), /COPY\+EXPUNGE fallback is forbidden/);
});

test('COPY is refused unless an operation explicitly allows it', () => {
  assert.throws(() => assertCommandAllowed('UID COPY', [], WRITE), /only used inside an approved/);
  assert.doesNotThrow(() => assertCommandAllowed('UID COPY', [], { ...WRITE, allowCopy: true }));
});

test('mailbox creation and mutation are refused', () => {
  for (const command of ['CREATE', 'DELETE', 'RENAME', 'SUBSCRIBE', 'UNSUBSCRIBE']) {
    assert.throws(() => assertCommandAllowed(command, [], WRITE), ReadOnlyViolation, `${command}`);
  }
});

test('every FORBIDDEN_COMMANDS entry is actually refused', () => {
  for (const command of Object.keys(FORBIDDEN_COMMANDS)) {
    assert.throws(
      () => assertCommandAllowed(command, [], WRITE),
      ReadOnlyViolation,
      `${command} is documented as forbidden but was allowed`,
    );
  }
});

test('a UID-prefixed write is judged by its base command', () => {
  // The prefix must not become a way to smuggle a write past the allowlist.
  assert.throws(() => assertCommandAllowed('UID STORE', storeAttrs('+FLAGS', ['\\Deleted']), READ), ReadOnlyViolation);
  assert.throws(() => assertCommandAllowed('UID UID STORE', storeAttrs('+FLAGS', ['\\Seen']), WRITE), ReadOnlyViolation);
});

test('the guard refuses at exec time and records the violation', () => {
  const sent = [];
  const client = {
    exec(command, attributes) {
      sent.push(command);
      return Promise.resolve({});
    },
    runInternal(command) {
      sent.push(command);
      return Promise.resolve({});
    },
  };
  const guard = enforcePolicy(client, WRITE);
  assert.throws(() => client.exec('EXPUNGE', []), ReadOnlyViolation);
  assert.equal(sent.length, 0, 'nothing may reach the socket');
  assert.match(guard.violations[0], /EXPUNGE/);

  // Promoting policy unlocks an organising write.
  client.exec('UID STORE', storeAttrs('+FLAGS', ['\\Seen']));
  assert.deepEqual(sent, ['UID STORE']);
});

test('the guard resolves a read-only open without treating it as a write', () => {
  const sent = [];
  const client = {
    exec() {
      return Promise.resolve({});
    },
    runInternal(command) {
      sent.push(command);
      return Promise.resolve({});
    },
  };
  enforcePolicy(client, READ);
  // mailboxOpen(readOnly: true) arrives as SELECT + {readOnly:true}.
  client.runInternal('SELECT', 'INBOX', { readOnly: true });
  assert.deepEqual(sent, ['SELECT']);
  // A writable open is a write and must be refused on a read session.
  assert.throws(() => client.runInternal('SELECT', 'INBOX', { readOnly: false }), ReadOnlyViolation);
});

test('inspectStore extracts the operation and flags', () => {
  const parsed = inspectStore(storeAttrs('+FLAGS.SILENT', ['\\Seen', '\\Flagged']));
  assert.equal(parsed.operation, '+FLAGS.SILENT');
  assert.deepEqual(parsed.flags, ['\\Seen', '\\Flagged']);
});

test('collectAtoms walks nested attribute trees', () => {
  const atoms = collectAtoms([
    [{ type: 'ATOM', value: 'UNCHANGEDSINCE' }, { type: 'ATOM', value: '42' }],
    { type: 'ATOM', value: '+FLAGS', section: [{ type: 'ATOM', value: '\\Seen' }] },
  ]);
  assert.deepEqual(atoms, ['UNCHANGEDSINCE', '42', '+FLAGS', '\\Seen']);
});

// --- Approval mechanism -----------------------------------------------------

test('the digest covers account, mailbox, uidvalidity, UIDs, action and target', () => {
  const base = { action: 'move_to_folder', account_id: 'a', mailbox: 'INBOX', uidvalidity: '1', uids: [5, 6], target: 'Work', label: '' };
  const digest = planDigest([base]);

  const mutations = {
    account: { ...base, account_id: 'b' },
    mailbox: { ...base, mailbox: 'Archive' },
    uidvalidity: { ...base, uidvalidity: '2' },
    uids: { ...base, uids: [5, 7] },
    extraUid: { ...base, uids: [5, 6, 9] },
    action: { ...base, action: 'archive' },
    target: { ...base, target: 'Personal' },
    label: { ...base, label: 'Work' },
  };
  for (const [name, mutated] of Object.entries(mutations)) {
    assert.notEqual(planDigest([mutated]), digest, `changing ${name} must change the digest`);
  }
});

test('UID order and duplicates do not change the digest', () => {
  const a = { action: 'mark_read', account_id: 'a', mailbox: 'INBOX', uidvalidity: '1', uids: [9, 2, 5], target: null, label: null };
  const b = { ...a, uids: [2, 5, 9] };
  assert.equal(planDigest([a]), planDigest([b]));
  assert.equal(canonicalItem({ ...a, uids: [5, 5, 2] }), canonicalItem({ ...a, uids: [2, 5] }));
});

test('the plan digest changes when items are reordered or added', () => {
  const one = { action: 'mark_read', account_id: 'a', mailbox: 'INBOX', uidvalidity: '1', uids: [1], target: null, label: null };
  const two = { ...one, uids: [2] };
  assert.notEqual(planDigest([one, two]), planDigest([two, one]));
  assert.notEqual(planDigest([one]), planDigest([one, two]));
});

test('trash always requires approval, even for one message', () => {
  const requirement = approvalRequirement([{ action: 'move_to_trash', account_id: 'a', uids: [1] }], { threshold: 100 });
  assert.equal(requirement.required, true);
  assert.match(requirement.reasons.join(' '), /trash/);
});

test('a large batch requires approval', () => {
  const requirement = approvalRequirement([{ action: 'mark_read', account_id: 'a', uids: Array.from({ length: 10 }, (_, i) => i + 1) }], { threshold: 5 });
  assert.equal(requirement.required, true);
  assert.match(requirement.reasons.join(' '), /exceed the batch threshold/);
});

test('a cross-account plan requires approval', () => {
  const requirement = approvalRequirement(
    [
      { action: 'mark_read', account_id: 'a', uids: [1] },
      { action: 'mark_read', account_id: 'b', uids: [2] },
    ],
    { threshold: 100 },
  );
  assert.equal(requirement.required, true);
});

test('a small single-account organising plan needs no approval', () => {
  const requirement = approvalRequirement([{ action: 'mark_read', account_id: 'a', uids: [1, 2] }], { threshold: 5 });
  assert.equal(requirement.required, false);
  assert.deepEqual(requirement.reasons, []);
});

test('the action list contains no correspondence or destruction verb', () => {
  for (const action of ACTIONS) {
    assert.equal(/send|draft|reply|forward|delete|expunge/i.test(action), false, `${action} must not exist`);
  }
});

test('the batch ceiling is enforced in the plan model', () => {
  assert.equal(MAX_BATCH, 50);
});

test('the approval store persists, expires and burns single-use approvals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-approvals-'));
  try {
    const store = new ApprovalStore({ dir, previewTtlMs: 60000, approvalTtlMs: 60000 });
    const digest = 'b'.repeat(64);

    assert.equal(store.loadPlan(digest), null, 'no plan before one is saved');
    store.savePlan(digest, { plan: { total_messages: 1 } });
    assert.ok(store.loadPlan(digest), 'plan is readable after save');

    // No approval yet.
    assert.equal(store.takeApproval(digest), null);

    // Simulate what scripts/mail-approve.sh writes on the host.
    fs.writeFileSync(
      path.join(dir, `approval-${digest}.json`),
      JSON.stringify({
        digest,
        approved_by: 'owner',
        approved_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    const approval = store.takeApproval(digest);
    assert.equal(approval.approved_by, 'owner');

    // After burning, a replay is refused.
    store.burnApproval(digest, 'op_test');
    assert.throws(() => store.takeApproval(digest), /already used/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an expired approval is refused, not silently accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-approvals-exp-'));
  try {
    const store = new ApprovalStore({ dir });
    const digest = 'c'.repeat(64);
    fs.writeFileSync(
      path.join(dir, `approval-${digest}.json`),
      JSON.stringify({ digest, approved_by: 'owner', expires_at: new Date(Date.now() - 1000).toISOString() }),
    );
    assert.throws(() => store.takeApproval(digest), /expired/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an expired preview is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-preview-exp-'));
  try {
    const store = new ApprovalStore({ dir });
    const digest = 'd'.repeat(64);
    store.savePlan(digest, { plan: {} });
    // Rewrite with a past expiry to simulate the passage of time.
    const file = path.join(dir, `plan-${digest}.json`);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.expires_at = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(record));
    assert.throws(() => store.loadPlan(digest), /expired/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('approvals and journals are per-digest files, so one plan cannot read another', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-approvals-iso-'));
  try {
    const store = new ApprovalStore({ dir });
    const first = 'e'.repeat(64);
    const second = 'f'.repeat(64);
    store.savePlan(first, { plan: { which: 'first' } });
    store.savePlan(second, { plan: { which: 'second' } });
    assert.equal(store.loadPlan(first).plan.which, 'first');
    assert.equal(store.loadPlan(second).plan.which, 'second');
    // An approval for one digest is not visible to another.
    fs.writeFileSync(path.join(dir, `approval-${first}.json`), JSON.stringify({ digest: first, approved_by: 'o', expires_at: new Date(Date.now() + 1000).toISOString() }));
    assert.equal(store.takeApproval(second), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a disabled store reports that it cannot accept plans instead of pretending', () => {
  const store = new ApprovalStore({ dir: null });
  assert.equal(store.enabled, false);
  assert.equal(store.savePlan('a'.repeat(64), {}), false);
  assert.equal(store.loadPlan('a'.repeat(64)), null);
});

test('the plan summary counts per account and per action', () => {
  const summary = summarisePlan([
    { action: 'mark_read', account_id: 'a', mailbox: 'INBOX', uids: [1, 2] },
    { action: 'archive', account_id: 'b', mailbox: 'INBOX', uids: [3] },
  ]);
  assert.equal(summary.total_messages, 3);
  assert.equal(summary.accounts.length, 2);
  assert.deepEqual(summary.accounts.find((entry) => entry.account_id === 'a').messages, 2);
});
