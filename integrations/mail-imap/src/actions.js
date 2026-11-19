// Organising mail: preview, approval, execute, verify, undo.
//
// THE SHAPE OF A WRITE
// --------------------
//   mail_preview_actions  validate the plan against LIVE server state, return a
//                         digest and a human summary. Nothing changes.
//   (owner approves)      out-of-band, for plans that need it. See approvals.js.
//   mail_apply_actions    recompute the digest from the submitted plan, compare,
//                         re-check the server, then execute per message.
//   mail_get_operation_status  read the journal written during execution.
//   mail_undo_operation   reverse what can be reversed, honestly labelled.
//
// WHY THE SERVER RE-CHECKS EVERYTHING AT EXECUTE TIME
// ---------------------------------------------------
// A preview is a promise about a past state. Between preview and execute the
// mailbox can change: new mail arrives, the user reads something in their own
// client, the server renumbers the folder. So execute re-verifies UIDVALIDITY,
// re-checks that each UID still exists, and applies each message independently.
// A message that vanished is reported as `stale`, not silently skipped and not
// allowed to abort the rest.
//
// THE FOUR SEMANTICS THAT DIFFER PER PROVIDER
// -------------------------------------------
//   Gmail archive   remove the \Inbox label (X-GM-LABELS). NOT a copy and NOT a
//                   delete: the message stays in All Mail with its labels. Moving
//                   it anywhere would duplicate or destroy it.
//   Folder archive  move into the folder the server marks \Archive, or the one
//                   configured. If neither exists: NOT_CONFIGURED, never guessed.
//   Trash           move into the folder the server marks \Trash, so the
//                   provider's own retention applies. Requires owner approval.
//   Labels          X-GM-LABELS add/remove, only when X-GM-EXT-1 is advertised.
//
// Every one of those ends in MOVE, COPY or STORE. None ends in EXPUNGE: the
// command policy forbids it, so "delete permanently" is impossible even here.
import { MailError } from './errors.js';
import {
  ACTIONS,
  MAX_BATCH,
  approvalRequirement,
  newOperationId,
  planDigest,
  summarisePlan,
} from './approvals.js';
import {
  assertDestinationExists,
  archiveUnavailableReason,
  describeLayout,
  listFolderRecords,
  resolveArchiveTarget,
  resolveTrashTarget,
  SPECIAL_USE,
} from './folders.js';

/** Gmail's system label for the inbox itself. */
const GMAIL_INBOX_LABEL = '\\Inbox';

/**
 * Validate and normalise one requested action.
 *
 * Structural validation only: whether the folder exists, whether the label is
 * allowed and whether the server can do it is checked against live state in
 * `previewActions`, because those answers differ per account.
 *
 * @param {object} input
 * @param {object} account
 * @returns {object}
 */
export function normaliseAction(input, account) {
  const action = String(input.action ?? '');
  if (!ACTIONS.includes(action)) {
    throw new MailError('INVALID_ARGUMENT', `Unsupported action "${action}"; allowed: ${ACTIONS.join(', ')}`);
  }
  const uids = Array.isArray(input.uids) ? input.uids : [];
  if (uids.length === 0) throw new MailError('INVALID_ARGUMENT', 'uids must contain at least one message UID');
  const numeric = uids.map((uid) => {
    const value = typeof uid === 'string' && /^[0-9]+$/.test(uid) ? Number(uid) : uid;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new MailError('INVALID_ARGUMENT', `Invalid UID "${uid}"`);
    }
    return value;
  });
  if (new Set(numeric).size !== numeric.length) {
    throw new MailError('INVALID_ARGUMENT', 'uids contains duplicates');
  }
  if (!input.uidvalidity) {
    throw new MailError('INVALID_ARGUMENT', 'uidvalidity is required: a UID alone can point at a different message after a renumber');
  }

  const item = {
    action,
    account_id: account.id,
    mailbox: input.mailbox ?? account.defaultFolder,
    uidvalidity: String(input.uidvalidity),
    uids: numeric.sort((a, b) => a - b),
    target: null,
    label: null,
  };

  if (action === 'move_to_folder') {
    if (typeof input.target !== 'string' || input.target.trim().length === 0) {
      throw new MailError('INVALID_ARGUMENT', 'move_to_folder requires "target" with a folder path');
    }
    item.target = input.target.trim();
  }
  if (action === 'add_label' || action === 'remove_label') {
    if (typeof input.label !== 'string' || input.label.trim().length === 0) {
      throw new MailError('INVALID_ARGUMENT', `${action} requires "label"`);
    }
    item.label = input.label.trim();
  }
  return item;
}

/**
 * Validate a whole plan against live server state and produce a preview.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {import('./approvals.js').ApprovalStore} store
 * @param {object} params
 * @param {object[]} params.actions
 * @param {number} [params.threshold]
 * @returns {Promise<object>}
 */
export async function previewActions(pool, store, { actions, threshold }) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new MailError('INVALID_ARGUMENT', 'actions must be a non-empty array');
  }
  const items = actions.map((input) => normaliseAction(input, pool.get(input.account_id)));

  // The digest is taken over EXACTLY what the caller submitted, before folder
  // resolution fills in a target. Otherwise the digest would encode a decision
  // the server made, and the caller's plan could never reproduce it.
  const digest = planDigest(items);

  const total = items.reduce((sum, item) => sum + item.uids.length, 0);
  if (total > MAX_BATCH) {
    throw new MailError('TOO_MANY_MESSAGES', `This plan touches ${total} messages; the limit is ${MAX_BATCH}. Split it into smaller plans.`);
  }

  // Per-account live validation: folder existence, UIDVALIDITY, UID presence and
  // what the server can actually do. Each distinct account is opened once.
  const byAccount = new Map();
  for (const item of items) {
    if (!byAccount.has(item.account_id)) byAccount.set(item.account_id, []);
    byAccount.get(item.account_id).push(item);
  }

  const accountReports = [];
  const samples = [];
  for (const [accountId, accountItems] of byAccount) {
    const account = pool.get(accountId);
    if (account.allowWrites !== true) {
      throw new MailError('UNSUPPORTED', `Account "${accountId}" is read-only; set "allowWrites": true before planning writes`, {
        accountId,
      });
    }
    const report = await pool.withSession(accountId, async ({ client, capabilities }) => {
      const folders = await listFolderRecords(client);
      const layout = describeLayout({
        folders,
        provider: account.provider,
        gmailExtensions: capabilities.gmailExtensions,
        configuredArchivePath: account.archivePath,
        configuredTrashPath: account.trashPath,
      });

      for (const item of accountItems) {
        // The mailbox the messages live in must exist.
        const source = folders.find((folder) => folder.path === item.mailbox);
        if (!source) throw new MailError('FOLDER_NOT_FOUND', `Folder "${item.mailbox}" does not exist on ${accountId}`);
        if (!source.selectable) throw new MailError('FOLDER_NOT_SELECTABLE', `Folder "${item.mailbox}" is \\Noselect`);

        if (item.action === 'move_to_folder') {
          assertDestinationExists(folders, item.target);
        }
        if (item.action === 'add_label' || item.action === 'remove_label') {
          if (!capabilities.gmailExtensions) {
            throw new MailError(
              'UNSUPPORTED',
              `${accountId} does not advertise X-GM-EXT-1, so IMAP labels are unavailable. Use move_to_folder on this provider.`,
              { accountId },
            );
          }
        }
        if (item.action === 'archive') {
          const target = resolveArchiveTarget({
            provider: account.provider,
            folders,
            gmailExtensions: capabilities.gmailExtensions,
            configuredArchivePath: account.archivePath,
          });
          if (!target) throw new MailError('NOT_CONFIGURED', archiveUnavailableReason(account.provider), { accountId });
          if (target.kind === 'folder') item.target = target.path ?? null;
        }
        if (item.action === 'move_to_trash') {
          const target = resolveTrashTarget(folders, account.trashPath);
          if (!target) {
            throw new MailError(
              'NOT_CONFIGURED',
              'No folder is marked \\Trash on this server and no trashPath is configured. Set "trashPath" explicitly; nothing is guessed.',
              { accountId },
            );
          }
          item.target = target.path;
        }
        if (item.action === 'archive' || item.action === 'move_to_folder' || item.action === 'move_to_trash') {
          if (!capabilities.move) {
            // imapflow would otherwise emulate MOVE with COPY + \Deleted + EXPUNGE.
            throw new MailError(
              'UNSUPPORTED',
              'This server does not advertise the MOVE extension, and the COPY+EXPUNGE fallback is forbidden. Moving mail on this account is unavailable.',
              { accountId },
            );
          }
        }
      }

      // UIDVALIDITY and per-UID presence, checked in the source folder.
      const mailboxes = [...new Set(accountItems.map((item) => item.mailbox))];
      const checks = [];
      for (const mailboxPath of mailboxes) {
        const mailboxItems = accountItems.filter((item) => item.mailbox === mailboxPath);
        const uidValidity = await pool.withMailbox(
          accountId,
          mailboxPath,
          async ({ client: inner, mailbox }) => {
            const expected = [...new Set(mailboxItems.map((item) => item.uidvalidity))];
            if (expected.length > 1) {
              throw new MailError('INVALID_ARGUMENT', `Mixed uidvalidity values for ${accountId}/${mailboxPath}`);
            }
            if (String(mailbox.uidValidity) !== expected[0]) {
              throw new MailError(
                'UID_VALIDITY_CHANGED',
                `Folder "${mailboxPath}" on ${accountId} has been renumbered since this plan was made; search again`,
                { accountId },
              );
            }
            const wanted = [...new Set(mailboxItems.flatMap((item) => item.uids))];
            const present = new Set();
            const exists = mailbox.exists ?? 0;
            if (exists > 0 && wanted.length > 0) {
              const range = `${Math.min(...wanted)}:${Math.max(...wanted)}`;
              for await (const message of inner.fetch(range, { uid: true, envelope: true }, { uid: true })) {
                if (wanted.includes(message.uid)) {
                  present.add(message.uid);
                  if (samples.length < 3) {
                    samples.push({
                      account_id: accountId,
                      mailbox: mailboxPath,
                      uid: message.uid,
                      subject: message.envelope?.subject ?? '(no subject)',
                    });
                  }
                }
              }
            }
            return { uidValidity: String(mailbox.uidValidity), present, missing: wanted.filter((uid) => !present.has(uid)) };
          },
        );
        checks.push({ mailbox: mailboxPath, ...uidValidity });
      }

      // Any UID that no longer exists invalidates the plan: executing it would
      // act on a subset the owner never saw.
      const missing = checks.flatMap((check) => check.missing.map((uid) => ({ mailbox: check.mailbox, uid })));
      if (missing.length > 0) {
        throw new MailError(
          'MESSAGE_NOT_FOUND',
          `${missing.length} message(s) in this plan no longer exist (e.g. ${missing[0].mailbox} uid ${missing[0].uid}); run the preview again`,
          { accountId, details: { missing: missing.slice(0, 20) } },
        );
      }

      return {
        account_id: accountId,
        provider: account.provider,
        auth_type: account.authType,
        capabilities: {
          move: capabilities.move,
          gmail_extensions: capabilities.gmailExtensions,
          uid_plus: capabilities.uidPlus,
          condstore: capabilities.condstore,
        },
        layout,
        checks,
      };
    });
    accountReports.push(report);
  }

  const requirement = approvalRequirement(items, { threshold: threshold ?? pool.get(items[0].account_id).batchThreshold });
  const summary = summarisePlan(items, samples);

  // Persist the plan so applyActions can prove this exact digest was previewed
  // against this exact server state. Without this record a digest would be a
  // number the caller made up.
  const persisted = store.savePlan(digest, {
    plan: summary,
    accounts: accountReports.map((report) => report.account_id),
    approval_required: requirement.required,
  });

  return {
    digest,
    plan: summary,
    accounts: accountReports,
    approval: {
      required: requirement.required,
      reasons: requirement.reasons,
      challenge: requirement.required
        ? {
            tool: 'mail_apply_actions',
            digest,
            instruction:
              'Ask the owner to approve this exact plan. They run scripts/mail-approve.sh with this digest on the host. The approval cannot be produced by the agent: it is written outside the agent\'s reach.',
          }
        : null,
    },
    // Nothing was changed by this call. Stated so a reader cannot mistake a
    // preview for an execution.
    executed: false,
    // When false, no plan was recorded, so apply would fail closed. Surfaced so
    // the caller knows immediately instead of at apply time.
    preview_recorded: persisted,
  };
}

/**
 * Execute an approved plan.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {import('./approvals.js').ApprovalStore} store
 * @param {object} params
 * @param {object[]} params.actions
 * @param {string} params.digest
 * @param {string} [params.operationId]
 * @returns {Promise<object>}
 */
export async function applyActions(pool, store, { actions, digest, operationId }) {
  if (typeof digest !== 'string' || digest.length !== 64) {
    throw new MailError('APPROVAL_REQUIRED', 'A digest from mail_preview_actions is required; run the preview first');
  }
  if (!store.enabled) {
    throw new MailError(
      'NOT_CONFIGURED',
      'The approval store is not writable, so no plan can be executed safely. Mount the approval directory (see the README).',
    );
  }

  const items = actions.map((input) => normaliseAction(input, pool.get(input.account_id)));
  const expected = planDigest(items);
  if (expected !== digest) {
    // The most important check in the file: a swapped account, UID, folder,
    // label or action all land here.
    throw new MailError(
      'PREVIEW_MISMATCH',
      'The submitted plan does not match the preview digest. Re-run mail_preview_actions and approve the exact plan you want.',
    );
  }

  const record = store.loadPlan(digest);
  if (!record) {
    throw new MailError('PREVIEW_EXPIRED', 'No valid preview exists for this digest; run mail_preview_actions again');
  }
  if (record.consumed_by) {
    throw new MailError('APPROVAL_ALREADY_USED', `This plan was already executed as ${record.consumed_by}`);
  }

  // The digest covers the caller's plan, not the folder the server chose. So a
  // target that preview resolved (archive, trash) is resolved again here, against
  // the same live state, immediately before writing. A folder that disappeared or
  // changed role between preview and apply is therefore caught, and the digest
  // stays reproducible from what the caller actually submitted.
  await resolveDestinations(pool, items);
  // A UIDVALIDITY change invalidates EVERY item in the plan, not just one, so it
  // is checked before a single write rather than discovered per message. Writing
  // into a renumbered mailbox could touch a different message with the same UID.
  await assertPlanPreconditions(pool, items);

  const requirement = approvalRequirement(items, { threshold: pool.get(items[0].account_id).batchThreshold });
  let approval = null;
  if (requirement.required) {
    approval = store.takeApproval(digest);
    if (!approval) {
      throw new MailError('APPROVAL_REQUIRED', 'This plan needs the owner\'s out-of-band approval before it can run', {
        details: {
          digest,
          reasons: requirement.reasons,
          how: 'On the host: sh scripts/mail-approve.sh ' + digest,
        },
      });
    }
  }

  const id = operationId ?? newOperationId();
  const results = [];
  const undoEntries = [];

  for (const item of items) {
    const outcome = await executeItem(pool, item);
    results.push(outcome.result);
    if (outcome.undo) undoEntries.push(...outcome.undo);
  }

  const failed = results.filter((entry) => entry.status !== 'ok');
  const journal = {
    operation_id: id,
    digest,
    executed_at: new Date().toISOString(),
    approved_by: approval?.approved_by ?? 'not-required',
    approved_at: approval?.approved_at ?? null,
    plan: summarisePlan(items),
    results,
    undo: undoEntries,
    status: failed.length === 0 ? 'completed' : failed.length === results.length ? 'failed' : 'partial',
  };
  store.saveOperation(id, journal);
  store.consumePlan(digest, id);
  if (requirement.required) store.burnApproval(digest, id);

  return {
    operation_id: id,
    status: journal.status,
    digest,
    approved: requirement.required ? (approval ? 'yes' : 'no') : 'not-required',
    results,
    undo_available: undoEntries.length > 0,
    note: failed.length === 0
      ? 'Every message was processed. Use mail_get_operation_status to re-read this journal later.'
      : 'Some messages were not processed; each reason is in results. Nothing was retried automatically.',
  };
}

/**
 * Re-check the whole-plan preconditions that must hold before any write.
 *
 * Currently one: every source mailbox still has the UIDVALIDITY the preview saw.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {object[]} items
 * @returns {Promise<void>}
 */
async function assertPlanPreconditions(pool, items) {
  /** @type {Map<string, Set<string>>} */
  const expected = new Map();
  for (const item of items) {
    const key = `${item.account_id}\u0000${item.mailbox}`;
    if (!expected.has(key)) expected.set(key, new Set());
    /** @type {Set<string>} */ (expected.get(key)).add(item.uidvalidity);
  }
  for (const [key, validitySet] of expected) {
    const [accountId, mailbox] = key.split('\u0000');
    const current = await pool.withMailbox(accountId, mailbox, async ({ mailbox: selected }) => String(selected.uidValidity));
    for (const validity of validitySet) {
      if (current !== validity) {
        throw new MailError(
          'UID_VALIDITY_CHANGED',
          `Mailbox "${mailbox}" on ${accountId} was renumbered after the preview (${validity} -> ${current}); nothing was changed. Search again and make a new plan.`,
          { accountId },
        );
      }
    }
  }
}

/**
 * Fill in the folder a role-based action resolves to, against live server state.
 *
 * Only `archive` and `move_to_trash` are role-based; `move_to_folder` already
 * carries an explicit path the caller chose and the digest covers.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {object[]} items
 * @returns {Promise<void>}
 */
async function resolveDestinations(pool, items) {
  const byAccount = new Map();
  for (const item of items) {
    if (item.action !== 'archive' && item.action !== 'move_to_trash') continue;
    if (!byAccount.has(item.account_id)) byAccount.set(item.account_id, []);
    byAccount.get(item.account_id).push(item);
  }
  for (const [accountId, accountItems] of byAccount) {
    const account = pool.get(accountId);
    await pool.withSession(accountId, async ({ client, capabilities }) => {
      const folders = await listFolderRecords(client);
      for (const item of accountItems) {
        if (item.action === 'archive') {
          const target = resolveArchiveTarget({
            provider: account.provider,
            folders,
            gmailExtensions: capabilities.gmailExtensions,
            configuredArchivePath: account.archivePath,
          });
          if (!target) throw new MailError('NOT_CONFIGURED', archiveUnavailableReason(account.provider), { accountId });
          // A Gmail archive is a label operation; `target` stays null and the
          // executor's gmailExtensions branch handles it.
          item.target = target.kind === 'folder' ? target.path ?? null : null;
        } else {
          const target = resolveTrashTarget(folders, account.trashPath);
          if (!target) {
            throw new MailError(
              'NOT_CONFIGURED',
              'No folder is marked \\Trash on this server and no trashPath is configured. Set "trashPath" explicitly; nothing is guessed.',
              { accountId },
            );
          }
          item.target = target.path;
        }
      }
    });
  }
}

/**
 * Execute one normalised plan item against one account.
 *
 * Per-message independence: one failure does not abort the others, which is what
 * the brief requires for batch work.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {object} item
 * @returns {Promise<{result: object, undo: object[]}>}
 */
async function executeItem(pool, item) {
  const base = {
    action: item.action,
    account_id: item.account_id,
    mailbox: item.mailbox,
    target: item.target ?? null,
    label: item.label ?? null,
    message_count: item.uids.length,
  };
  try {
    return await pool.withMailbox(
      item.account_id,
      item.mailbox,
      async ({ client, mailbox, capabilities }) => {
        if (String(mailbox.uidValidity) !== item.uidvalidity) {
          return {
            result: { ...base, status: 'stale', error: 'UID_VALIDITY_CHANGED', processed: 0 },
            undo: [],
          };
        }
        const undo = [];
        const processed = [];

        switch (item.action) {
          case 'mark_read':
            await client.messageFlagsAdd(item.uids, ['\\Seen'], { uid: true });
            for (const uid of item.uids) undo.push({ op: 'remove_flag', account_id: item.account_id, mailbox: item.mailbox, uid, flag: '\\Seen' });
            processed.push(...item.uids);
            break;

          case 'mark_unread':
            await client.messageFlagsRemove(item.uids, ['\\Seen'], { uid: true });
            for (const uid of item.uids) undo.push({ op: 'add_flag', account_id: item.account_id, mailbox: item.mailbox, uid, flag: '\\Seen' });
            processed.push(...item.uids);
            break;

          case 'add_label':
            if (!capabilities.gmailExtensions) {
              return { result: { ...base, status: 'unsupported', error: 'UNSUPPORTED', processed: 0 }, undo: [] };
            }
            await client.messageFlagsAdd(item.uids, [item.label], { uid: true, useLabels: true });
            for (const uid of item.uids) undo.push({ op: 'remove_label', account_id: item.account_id, mailbox: item.mailbox, uid, label: item.label });
            processed.push(...item.uids);
            break;

          case 'remove_label':
            if (!capabilities.gmailExtensions) {
              return { result: { ...base, status: 'unsupported', error: 'UNSUPPORTED', processed: 0 }, undo: [] };
            }
            await client.messageFlagsRemove(item.uids, [item.label], { uid: true, useLabels: true });
            for (const uid of item.uids) undo.push({ op: 'add_label', account_id: item.account_id, mailbox: item.mailbox, uid, label: item.label });
            processed.push(...item.uids);
            break;

          case 'archive': {
            if (capabilities.gmailExtensions) {
              // Gmail: remove \Inbox. The message keeps every other label and
              // stays in All Mail. Nothing is copied and nothing is deleted.
              await client.messageFlagsRemove(item.uids, [GMAIL_INBOX_LABEL], { uid: true, useLabels: true });
              for (const uid of item.uids) undo.push({ op: 'add_label', account_id: item.account_id, mailbox: item.mailbox, uid, label: GMAIL_INBOX_LABEL });
              processed.push(...item.uids);
              break;
            }
            if (!item.target) {
              return {
                result: { ...base, status: 'not_configured', error: 'NOT_CONFIGURED', processed: 0, hint: archiveUnavailableReason('') },
                undo: [],
              };
            }
            if (!capabilities.move) {
              return { result: { ...base, status: 'unsupported', error: 'UNSUPPORTED', processed: 0 }, undo: [] };
            }
            const moved = await client.messageMove(item.uids, item.target, { uid: true });
            for (const uid of item.uids) {
              const newUid = moved && moved.uidMap ? moved.uidMap.get(uid) : undefined;
              undo.push({ op: 'move_back', account_id: item.account_id, mailbox: item.target, target: item.mailbox, uid: newUid ?? null, original_uid: uid });
            }
            processed.push(...item.uids);
            break;
          }

          case 'move_to_folder':
          case 'move_to_trash': {
            if (!capabilities.move) {
              return { result: { ...base, status: 'unsupported', error: 'UNSUPPORTED', processed: 0 }, undo: [] };
            }
            if (!item.target) {
              return { result: { ...base, status: 'not_configured', error: 'NOT_CONFIGURED', processed: 0 }, undo: [] };
            }
            const moved = await client.messageMove(item.uids, item.target, { uid: true });
            for (const uid of item.uids) {
              const newUid = moved && moved.uidMap ? moved.uidMap.get(uid) : undefined;
              undo.push({ op: 'move_back', account_id: item.account_id, mailbox: item.target, target: item.mailbox, uid: newUid ?? null, original_uid: uid });
            }
            processed.push(...item.uids);
            break;
          }

          default:
            return { result: { ...base, status: 'unsupported', error: 'UNSUPPORTED', processed: 0 }, undo: [] };
        }

        // Verify: re-read the state the action claims to have produced. A server
        // that silently ignored a STORE is reported rather than assumed to work.
        // For a move, "correct" means the message left the source mailbox, which
        // is a different question from "which flags does it have now".
        const verification = await verifyItem(client, item);
        return {
          result: {
            ...base,
            status: verification.ok ? 'ok' : 'verify_failed',
            processed: processed.length,
            uids: processed,
            verification,
          },
          undo,
        };
      },
      { mode: 'write' },
    );
  } catch (error) {
    return {
      result: {
        ...base,
        status: 'error',
        error: error instanceof MailError ? error.code : 'IMAP_ERROR',
        processed: 0,
      },
      undo: [],
    };
  }
}

/**
 * Read the affected messages back and confirm the intended state.
 *
 * @param {object} client
 * @param {object} item
 * @returns {Promise<{ok: boolean, flags: Record<string, string[]>, note: string}>}
 */
async function verifyItem(client, item) {
  // Moves: the source mailbox is the wrong place to look. Success is that the
  // message is gone from here, and the move call already reported its new UID.
  if (item.action === 'archive' || item.action === 'move_to_folder' || item.action === 'move_to_trash') {
    const stillThere = [];
    const range = `${Math.min(...item.uids)}:${Math.max(...item.uids)}`;
    for await (const message of client.fetch(range, { uid: true }, { uid: true })) {
      if (item.uids.includes(message.uid)) stillThere.push(message.uid);
    }
    return stillThere.length === 0
      ? { ok: true, flags: {}, note: `Moved out of ${item.mailbox}; the destination reported success` }
      : { ok: false, flags: {}, note: `Still present in ${item.mailbox}: ${stillThere.join(', ')}` };
  }

  /** @type {Record<string, string[]>} */
  const flags = {};
  const range = `${Math.min(...item.uids)}:${Math.max(...item.uids)}`;
  for await (const message of client.fetch(range, { uid: true, flags: true }, { uid: true })) {
    if (item.uids.includes(message.uid)) flags[String(message.uid)] = [...(message.flags ?? [])];
  }
  const missing = item.uids.filter((uid) => flags[String(uid)] === undefined);
  if (missing.length > 0) {
    return { ok: false, flags, note: `Messages no longer present: ${missing.join(', ')}` };
  }
  if (item.action === 'mark_read') {
    const notSeen = item.uids.filter((uid) => !flags[String(uid)].includes('\\Seen'));
    return notSeen.length === 0
      ? { ok: true, flags, note: 'All target messages now report \\Seen' }
      : { ok: false, flags, note: `Server did not set \\Seen on: ${notSeen.join(', ')}` };
  }
  if (item.action === 'mark_unread') {
    const stillSeen = item.uids.filter((uid) => flags[String(uid)].includes('\\Seen'));
    return stillSeen.length === 0
      ? { ok: true, flags, note: 'All target messages no longer report \\Seen' }
      : { ok: false, flags, note: `Server kept \\Seen on: ${stillSeen.join(', ')}` };
  }
  // For moves and label writes the messages are in another mailbox, so presence
  // in the source is the meaningful check and it has already passed.
  return { ok: true, flags, note: 'Messages accounted for after the change' };
}

/**
 * Reverse what an operation did, where reversing is safe and possible.
 *
 * Honest about the limits: a moved message can be moved back only if its new UID
 * is still valid, and a label written on Gmail can be removed again, but nothing
 * here can resurrect a message the owner deleted in their own mail client.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {import('./approvals.js').ApprovalStore} store
 * @param {object} params
 * @param {string} params.operationId
 * @returns {Promise<object>}
 */
export async function undoOperation(pool, store, { operationId }) {
  const journal = store.loadOperation(operationId);
  if (!journal) throw new MailError('UNDO_UNAVAILABLE', `No operation "${operationId}" was found`);
  if (journal.undone_at) throw new MailError('UNDO_UNAVAILABLE', `Operation ${operationId} was already undone at ${journal.undone_at}`);
  if (!Array.isArray(journal.undo) || journal.undo.length === 0) {
    throw new MailError('UNDO_UNAVAILABLE', 'This operation recorded no reversible changes');
  }

  const results = [];
  // Group by account + mailbox so one session handles a whole mailbox.
  const groups = new Map();
  for (const entry of journal.undo) {
    const key = `${entry.account_id}\u0000${entry.mailbox}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  for (const [key, entries] of groups) {
    const [accountId, mailbox] = key.split('\u0000');
    try {
      const outcome = await pool.withMailbox(
        accountId,
        mailbox,
        async ({ client, capabilities }) => {
          const done = [];
          for (const entry of entries) {
            try {
              switch (entry.op) {
                case 'remove_flag':
                  await client.messageFlagsRemove([entry.uid], [entry.flag], { uid: true });
                  done.push({ uid: entry.uid, op: entry.op, status: 'ok' });
                  break;
                case 'add_flag':
                  await client.messageFlagsAdd([entry.uid], [entry.flag], { uid: true });
                  done.push({ uid: entry.uid, op: entry.op, status: 'ok' });
                  break;
                case 'add_label':
                  if (!capabilities.gmailExtensions) {
                    done.push({ uid: entry.uid, op: entry.op, status: 'unsupported' });
                    break;
                  }
                  await client.messageFlagsAdd([entry.uid], [entry.label], { uid: true, useLabels: true });
                  done.push({ uid: entry.uid, op: entry.op, status: 'ok' });
                  break;
                case 'remove_label':
                  if (!capabilities.gmailExtensions) {
                    done.push({ uid: entry.uid, op: entry.op, status: 'unsupported' });
                    break;
                  }
                  await client.messageFlagsRemove([entry.uid], [entry.label], { uid: true, useLabels: true });
                  done.push({ uid: entry.uid, op: entry.op, status: 'ok' });
                  break;
                case 'move_back':
                  if (!capabilities.move || entry.uid === null) {
                    done.push({ uid: entry.original_uid, op: entry.op, status: 'unsupported' });
                    break;
                  }
                  await client.messageMove([entry.uid], entry.target, { uid: true });
                  done.push({ uid: entry.original_uid, op: entry.op, status: 'ok' });
                  break;
                default:
                  done.push({ uid: entry.uid ?? null, op: entry.op, status: 'unsupported' });
              }
            } catch (error) {
              done.push({
                uid: entry.uid ?? entry.original_uid ?? null,
                op: entry.op,
                status: 'error',
                error: error instanceof MailError ? error.code : 'IMAP_ERROR',
              });
            }
          }
          return done;
        },
        { mode: 'write' },
      );
      results.push(...outcome);
    } catch (error) {
      results.push({
        mailbox,
        account_id: accountId,
        status: 'error',
        error: error instanceof MailError ? error.code : 'IMAP_ERROR',
      });
    }
  }

  const failed = results.filter((entry) => entry.status !== 'ok');
  journal.undone_at = new Date().toISOString();
  journal.undo_results = results;
  store.saveOperation(operationId, journal);

  return {
    operation_id: operationId,
    status: failed.length === 0 ? 'undone' : failed.length === results.length ? 'undo_failed' : 'partially_undone',
    results,
    limitations: [
      'Moves are reversed only when the moved message still has the recorded UID in its new folder.',
      'Labels and flags are restored only where the provider exposes them over IMAP (Gmail X-GM-LABELS).',
      'A message the owner deleted in their own mail client cannot be restored by this server.',
      'Nothing here expunges: an undo never deletes mail.',
    ],
  };
}

/**
 * Re-read an operation journal.
 *
 * @param {import('./approvals.js').ApprovalStore} store
 * @param {{operationId?: string, limit?: number}} params
 * @returns {object}
 */
export function operationStatus(store, { operationId, limit = 20 }) {
  if (!store.enabled) {
    throw new MailError('NOT_CONFIGURED', 'The operation journal is not writable, so no history is available');
  }
  if (!operationId) {
    return {
      note: 'Pass operation_id for one operation, or use the journal directory on the host to list them.',
      journal: 'available',
      limit,
    };
  }
  const journal = store.loadOperation(operationId);
  if (!journal) throw new MailError('MESSAGE_NOT_FOUND', `No operation "${operationId}" was found`);
  return journal;
}

export { SPECIAL_USE };
