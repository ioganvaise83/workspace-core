// APPROVAL MECHANISM
//
// THE PROBLEM BEING SOLVED
// ------------------------
// "Ask the user to confirm" is worthless if the agent is the one deciding whether
// the user confirmed. A tool that writes mail must be gated by something the
// agent cannot manufacture. Text in the conversation is not that thing.
//
// THE MECHANISM
// -------------
// 1. `mail_preview_actions` validates a plan against live server state and
//    returns a DIGEST: a SHA-256 over the exact, ordered, normalised plan —
//    account id, mailbox, UIDVALIDITY, every UID, the action, and its target.
// 2. The digest is stored server-side with a short expiry, together with the
//    account and the plan. The agent only receives the digest and a human
//    readable summary.
// 3. `mail_apply_actions` requires the digest. The server recomputes it from the
//    submitted plan and compares. Any substitution — a different account, one
//    swapped UID, a changed folder, a changed action — produces a different
//    digest and is refused.
// 4. APPROVAL is a separate secret the agent never sees. For plans that need
//    explicit confirmation (mass operations, trash, anything irreversible), the
//    server demands an approval code that only the owner can produce: they run
//    `scripts/mail-approve.sh <digest>` on the host, which writes a single-use
//    approval record into a directory that is NOT mounted into the harness.
//
// WHY THE OWNER'S PROOF CANNOT BE FORGED BY THE AGENT
// ---------------------------------------------------
// The approval file is created by a process the agent cannot run: the harness
// container has no access to the host, no docker socket, and no mount of that
// directory. The agent can therefore copy a digest and ask for it to be approved,
// but it cannot approve itself. That is the whole point, and it is why the
// "approval required" state is honest rather than theatre.
//
// WHAT THIS IS NOT
// ----------------
// It is not a sandbox against a malicious owner with host access, and it is not a
// substitute for the command policy: even a fully approved plan still cannot
// EXPUNGE, APPEND or delete permanently, because the policy forbids it earlier.
// Approval authorises a plan; the policy decides what a plan may contain.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MailError } from './errors.js';

/** Actions the system supports. This list is also the schema enum. */
export const ACTIONS = Object.freeze([
  'mark_read',
  'mark_unread',
  'archive',
  'move_to_folder',
  'add_label',
  'remove_label',
  'move_to_trash',
]);

/**
 * Actions that always require the owner's out-of-band approval, even for a single
 * message. Trash is here because it is the closest thing to deletion that exists
 * without EXPUNGE, and a provider's retention policy will eventually destroy it.
 */
export const ALWAYS_APPROVED = Object.freeze(new Set(['move_to_trash']));

/** Default plan lifetime. Long enough to read a summary, short enough to be safe. */
export const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;

/** An approval is single-use and shorter-lived than the plan. */
export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

/** Hard ceiling on one operation, before any approval is even considered. */
export const MAX_BATCH = 50;

/**
 * Canonical, order-independent form of one plan item.
 *
 * Every field that changes the effect is included, so a digest covers exactly
 * what will happen. UIDs are sorted and de-duplicated: two plans that touch the
 * same set are the same plan, and neither can smuggle an extra UID past review.
 *
 * @param {object} item
 * @returns {string}
 */
export function canonicalItem(item) {
  const uids = [...new Set(item.uids ?? [])].map(String).sort((a, b) => Number(a) - Number(b));
  return [
    item.action,
    item.account_id,
    item.mailbox,
    String(item.uidvalidity),
    uids.join(','),
    item.target ?? '',
    item.label ?? '',
  ].join('|');
}

/**
 * Digest of a whole plan.
 *
 * The version prefix means a future change to the canonical form cannot silently
 * reinterpret an old digest.
 *
 * @param {object[]} items normalised plan items
 * @returns {string} hex digest
 */
export function planDigest(items) {
  const canonical = items.map(canonicalItem).join('\n');
  return crypto.createHash('sha256').update(`mail-plan.v1\n${canonical}`, 'utf8').digest('hex');
}

/**
 * Whether a plan needs the owner's explicit, out-of-band approval.
 *
 * @param {object[]} items
 * @param {{batchThreshold?: number}} [options]
 * @returns {{required: boolean, reasons: string[]}}
 */
export function approvalRequirement(items, options = {}) {
  const batchThreshold = options.batchThreshold ?? 5;
  const reasons = [];
  const total = items.reduce((sum, item) => sum + (item.uids?.length ?? 0), 0);

  for (const item of items) {
    if (ALWAYS_APPROVED.has(item.action)) {
      reasons.push(`${item.action} is never executed without the owner's approval`);
    }
  }
  if (total > batchThreshold) {
    reasons.push(`${total} messages exceed the batch threshold of ${batchThreshold}`);
  }
  if (items.length > 1 && new Set(items.map((item) => item.account_id)).size > 1) {
    reasons.push('the plan spans more than one account');
  }
  return { required: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/**
 * File-backed store for plans, approvals and the operation journal.
 *
 * Deliberately plain JSON files:
 *  - they survive a container restart, which an in-memory map would not, and a
 *    plan that outlives its process is worse than no plan;
 *  - they are readable by the owner with `cat`, so nothing about the mechanism is
 *    hidden from the person who has to trust it.
 *
 * The directory must be writable by this container and NOT mounted into the
 * harness. `scripts/mail-approve.sh` writes approvals there from the host.
 */
export class ApprovalStore {
  /**
   * @param {{dir: string|null, previewTtlMs?: number, approvalTtlMs?: number, logger?: (level: string, event: string, fields?: object) => void}} options
   */
  constructor(options) {
    this.dir = options.dir ?? null;
    this.previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.log = options.logger ?? (() => {});
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      } catch {
        // A read-only or missing volume degrades to "plans cannot be stored",
        // which every write tool reports honestly instead of pretending.
        this.log('warn', 'approval_store_unavailable', { dir: this.dir });
      }
    }
  }

  /** Whether plans can be persisted at all. */
  get enabled() {
    return this.dir !== null && fs.existsSync(this.dir);
  }

  /** @param {string} name */
  #file(name) {
    return path.join(/** @type {string} */ (this.dir), name);
  }

  /**
   * @param {string} digest
   * @param {object} record
   */
  savePlan(digest, record) {
    if (!this.enabled) return false;
    const payload = { ...record, digest, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + this.previewTtlMs).toISOString() };
    this.#write(this.#file(`plan-${digest}.json`), payload);
    return true;
  }

  /**
   * @param {string} digest
   * @returns {object|null}
   */
  loadPlan(digest) {
    if (!this.enabled) return null;
    const record = this.#read(this.#file(`plan-${digest}.json`));
    if (!record) return null;
    if (Date.parse(record.expires_at) < Date.now()) {
      this.#remove(this.#file(`plan-${digest}.json`));
      throw new MailError('PREVIEW_EXPIRED', 'This preview has expired; run mail_preview_actions again');
    }
    return record;
  }

  /**
   * Mark a plan as executed so it cannot be replayed.
   *
   * @param {string} digest
   * @param {string} operationId
   */
  consumePlan(digest, operationId) {
    if (!this.enabled) return;
    const file = this.#file(`plan-${digest}.json`);
    const record = this.#read(file);
    if (!record) return;
    record.consumed_by = operationId;
    record.consumed_at = new Date().toISOString();
    this.#write(file, record);
  }

  /**
   * Read an owner approval for a digest, consuming it.
   *
   * @param {string} digest
   * @returns {{approved_by: string, approved_at: string} | null}
   */
  takeApproval(digest) {
    if (!this.enabled) return null;
    const file = this.#file(`approval-${digest}.json`);
    const record = this.#read(file);
    if (!record) return null;
    if (Date.parse(record.expires_at) < Date.now()) {
      this.#remove(file);
      throw new MailError('APPROVAL_EXPIRED', 'The owner approval for this plan expired; request a new one');
    }
    if (record.used_by) {
      throw new MailError('APPROVAL_ALREADY_USED', 'This approval was already used for an execution and cannot be replayed');
    }
    return { approved_by: record.approved_by ?? 'owner', approved_at: record.approved_at ?? null };
  }

  /**
   * Burn an approval after a successful execution.
   *
   * @param {string} digest
   * @param {string} operationId
   */
  burnApproval(digest, operationId) {
    if (!this.enabled) return;
    const file = this.#file(`approval-${digest}.json`);
    const record = this.#read(file);
    if (!record) return;
    record.used_by = operationId;
    record.used_at = new Date().toISOString();
    this.#write(file, record);
  }

  /**
   * Append to the operation journal. One file per operation, so a reader can see
   * the whole history without parsing a shared log.
   *
   * @param {string} operationId
   * @param {object} record
   */
  saveOperation(operationId, record) {
    if (!this.enabled) return;
    this.#write(this.#file(`operation-${operationId}.json`), record);
  }

  /**
   * @param {string} operationId
   * @returns {object|null}
   */
  loadOperation(operationId) {
    if (!this.enabled) return null;
    return this.#read(this.#file(`operation-${operationId}.json`));
  }

  /** @param {string} file @param {object} value */
  #write(file, value) {
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /**
   * @param {string} file
   * @returns {object|null}
   */
  #read(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** @param {string} file */
  #remove(file) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Random, unguessable operation id. Used for journaling and idempotency: the same
 * plan re-applied with the same id must not run twice.
 *
 * @returns {string}
 */
export function newOperationId() {
  return `op_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Human-readable plan summary for the confirmation step.
 *
 * Counts per account and per action, because that is what a person needs in order
 * to say yes or no. Message subjects are included only for single-message plans:
 * a list of 40 subjects is noise, and subject text is untrusted content.
 *
 * @param {object[]} items
 * @param {object[]} [samples]
 * @returns {object}
 */
export function summarisePlan(items, samples = []) {
  /** @type {Record<string, {action: string, messages: number}>} */
  const byAccount = {};
  let total = 0;
  for (const item of items) {
    const key = item.account_id;
    const entry = byAccount[key] ?? { action: item.action, messages: 0 };
    entry.messages += item.uids?.length ?? 0;
    byAccount[key] = entry;
    total += item.uids?.length ?? 0;
  }
  return {
    total_messages: total,
    accounts: Object.entries(byAccount).map(([account_id, value]) => ({ account_id, ...value })),
    items: items.map((item) => ({
      action: item.action,
      account_id: item.account_id,
      mailbox: item.mailbox,
      target: item.target ?? null,
      label: item.label ?? null,
      message_count: item.uids?.length ?? 0,
      uids: item.uids ?? [],
    })),
    samples,
  };
}
