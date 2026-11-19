// Per-account IMAP connections with independent failure states.
//
// INVARIANTS
// ----------
// * One broken account never affects another. Every operation is scoped to a
//   single account, and a failure is recorded on that account only.
// * Nothing is opened until a tool actually needs it. The process starts, and
//   the harness boots, with zero reachable servers.
// * Every mailbox is opened with `readOnly: true` (EXAMINE) under a mailbox
//   lock, and the session is wrapped by `enforceReadOnly` before its first
//   command. See readonly.js for why both layers exist.
// * The password never appears in a log line, an error message or a tool
//   result. Errors are mapped to a small set of codes here.
import fs from 'node:fs';
import { ImapFlow } from 'imapflow';
import { enforcePolicy, assertSelectedReadOnly } from './readonly.js';
import { accessTokenFor } from './oauth.js';
import { MailError, toMailError } from './errors.js';
import { sessionCapabilities } from './folders.js';

// Re-exported so existing import sites keep working after the split.
export { MailError, toMailError };

/**
 * Optional extra CA bundle for outbound IMAP TLS.
 *
 * Two legitimate uses: a corporate TLS-inspecting proxy, and the test suite's
 * ephemeral certificate. This ADDS a trust root; it never disables verification
 * (`rejectUnauthorized` stays true in `clientOptionsFor`). NODE_EXTRA_CA_CERTS
 * cannot be used for this because Node reads it once at process start, before a
 * mounted file might be arranged, so the file is read explicitly here.
 *
 * Read lazily so a test can point it at a fresh certificate per run.
 *
 * @returns {Buffer[]|undefined}
 */
export function extraCaCertificates() {
  const file = process.env.MAIL_IMAP_CA_FILE;
  if (!file) return undefined;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return undefined;
    return [fs.readFileSync(file)];
  } catch {
    // A missing CA file must not crash the process; the connection will fail
    // with a TLS error that diagnostics report as TLS_FAILED.
    return undefined;
  }
}

/** Account-level connection states, as the brief requires. */
export const ACCOUNT_STATUS = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  AUTH_FAILED: 'AUTH_FAILED',
  READY: 'READY',
  DISABLED: 'DISABLED',
});

/**
 * Whether mailbox access was actually PROVEN, kept separate from READY.
 *
 * READY means one thing only: a TCP+TLS session was established and the server
 * accepted the credentials. It says nothing about whether a mailbox can be
 * opened, because the folder listing and the EXAMINE happen after that point and
 * can still fail — for instance on a command-policy refusal, which is our own
 * bug and not the provider's fault.
 *
 * Reporting the two as one field was the defect behind the misleading account
 * list: a Yandex account showed READY while every INBOX call failed. Callers now
 * get `inbox_status` and must not treat `connection_status: READY` as proof that
 * mail is readable.
 */
export const INBOX_STATUS = Object.freeze({
  /** EXAMINE succeeded; the mailbox is genuinely readable. */
  VERIFIED: 'VERIFIED',
  /** No mailbox was opened in this process yet. Not a failure, not a proof. */
  NOT_CHECKED: 'NOT_CHECKED',
  /** A session is up but opening the mailbox failed; `error` says why. */
  FAILED: 'FAILED',
});

/**
 * Build the ImapFlow options for one account.
 *
 * TLS verification is never disabled. `rejectUnauthorized` is not set to false
 * anywhere in this integration, and the trusted store comes from the system or
 * from an explicitly mounted CA (`NODE_EXTRA_CA_CERTS`), never from a flag.
 *
 * @param {object} account
 * @returns {import('imapflow').ImapFlowOptions}
 */
export function clientOptionsFor(account, accessToken = null) {
  // XOAUTH2 and password auth differ in exactly one field. Everything else — TLS,
  // timeouts, logging — is identical, which is what "one IMAP engine" means here.
  const auth = account.authType === 'xoauth2'
    ? { user: account.user, accessToken }
    : { user: account.user, pass: account.password };
  return {
    host: account.host,
    port: account.port,
    secure: true,
    auth,
    // servername is the host, so SNI and certificate matching are correct even
    // when the host is an IP literal.
    servername: /^[0-9.]+$/.test(account.host) ? undefined : account.host,
    tls: {
      // Explicitly true: a future edit that flips this is a security change and
      // should fail review, not silently weaken the connection.
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      // Optional additional trust root. Verification stays on.
      ...(extraCaCertificates() ? { ca: extraCaCertificates() } : {}),
    },
    connectionTimeout: account.connectionTimeoutMs,
    greetingTimeout: Math.min(account.connectionTimeoutMs, 16000),
    socketTimeout: account.socketTimeoutMs,
    // This server never reacts to new mail; IDLE would only hold the session open
    // and add a second code path that can touch the mailbox.
    disableAutoIdle: true,
    // Compression is allowed (it is transport-only) but not required.
    disableCompression: false,
    // The library's own logger writes command traces at trace level; keep it off
    // so no protocol payload can reach the container log.
    logger: false,
    emitLogs: false,
    // A mailbox lock left held is a bug; warn (to the disabled logger) rather
    // than letting a stuck session block the account forever.
    maxLockHoldTime: 60000,
  };
}

/**
 * The status record of an account that has not been touched yet.
 *
 * `inboxStatus` starts at NOT_CHECKED rather than at anything that could be
 * mistaken for success: nothing has been opened, so nothing is proven.
 *
 * @returns {{status: string, error: string|null, checkedAt: string|null, latencyMs: number|null, inboxStatus: string, layer: string|null}}
 */
function blankStatus() {
  return {
    status: ACCOUNT_STATUS.NOT_CONFIGURED,
    error: null,
    checkedAt: null,
    latencyMs: null,
    inboxStatus: INBOX_STATUS.NOT_CHECKED,
    layer: null,
  };
}

/**
 * The failure layer recorded on a mapped error, if it carries one.
 *
 * @param {MailError} mapped
 * @returns {string|null}
 */
function layerOf(mapped) {
  return mapped.details && typeof mapped.details.layer === 'string' ? mapped.details.layer : null;
}

/**
 * Owns the set of configured accounts and their live connections.
 *
 * A connection is opened per operation and closed immediately after it, because
 * a read-only tool call is short-lived and a persistent socket per account is
 * more state to keep correct. imapflow reconnects nothing on its own here; a
 * later call simply reconnects.
 */
export class AccountPool {
  /**
   * @param {{accounts: object[], errors: {id: string, message: string}[]}} config
   */
  constructor(config) {
    /** @type {Map<string, object>} */
    this.accounts = new Map(config.accounts.map((account) => [account.id, account]));
    /** @type {{id: string, message: string}[]} */
    this.configErrors = config.errors ?? [];
    /** @type {Map<string, {status: string, error: string|null, checkedAt: string|null, latencyMs: number|null, inboxStatus: string, layer: string|null}>} */
    this.status = new Map();
    for (const id of this.accounts.keys()) {
      this.status.set(id, blankStatus());
    }
    for (const error of this.configErrors) {
      if (!this.status.has(error.id)) {
        this.status.set(error.id, { ...blankStatus(), status: ACCOUNT_STATUS.DISABLED, error: error.message, inboxStatus: INBOX_STATUS.NOT_CHECKED });
      }
    }
    /** @type {string[]} every read-only violation observed, for diagnostics */
    this.violations = [];
  }

  /** @returns {object[]} */
  list() {
    return [...this.accounts.values()];
  }

  /** @returns {boolean} */
  get isEmpty() {
    return this.accounts.size === 0;
  }

  /**
   * @param {string} accountId
   * @returns {object}
   * @throws {MailError} when the account is unknown
   */
  get(accountId) {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new MailError('UNKNOWN_ACCOUNT', `No configured account with id "${accountId}"`, { accountId });
    }
    return account;
  }

  /**
   * @param {string} accountId
   * @returns {{status: string, error: string|null, checkedAt: string|null, latencyMs: number|null, inboxStatus: string, layer: string|null}}
   */
  statusOf(accountId) {
    return this.status.get(accountId) ?? {
      ...blankStatus(),
      error: 'account is not configured',
    };
  }

  /**
   * Record the transport/auth outcome of a session attempt.
   *
   * `inboxStatus` is deliberately NOT set here: establishing a session proves
   * nothing about a mailbox. It is set by `recordInboxStatus` when an EXAMINE
   * actually succeeds or fails.
   *
   * @param {string} accountId
   * @param {string} status
   * @param {string|null} error
   * @param {number|null} latencyMs
   * @param {{layer?: string|null}} [extra]
   */
  recordStatus(accountId, status, error, latencyMs, extra = {}) {
    const previous = this.status.get(accountId) ?? blankStatus();
    this.status.set(accountId, {
      ...previous,
      status,
      error,
      checkedAt: new Date().toISOString(),
      latencyMs,
      layer: extra.layer ?? null,
      // A failed transport attempt invalidates any earlier mailbox proof; a
      // successful one does not create one.
      inboxStatus: status === ACCOUNT_STATUS.READY ? previous.inboxStatus : INBOX_STATUS.NOT_CHECKED,
    });
  }

  /**
   * Record whether a mailbox was actually opened for this account.
   *
   * @param {string} accountId
   * @param {string} inboxStatus one of INBOX_STATUS
   * @param {string|null} [error]
   */
  recordInboxStatus(accountId, inboxStatus, error = null) {
    const previous = this.status.get(accountId) ?? blankStatus();
    this.status.set(accountId, {
      ...previous,
      inboxStatus,
      // Never let a mailbox failure be hidden behind a READY transport state.
      error: inboxStatus === INBOX_STATUS.FAILED ? error : previous.error,
    });
  }

  /**
   * Open a guarded connection to one account.
   *
   * The caller MUST close it. Passing a `run` callback is the supported form:
   * it guarantees `logout()` in a `finally`, even when the operation throws.
   *
   * @template T
   * @param {string} accountId
   * @param {(client: ImapFlow, account: object) => Promise<T>} run
   * @returns {Promise<T>}
   */
  async withConnection(accountId, run, options = {}) {
    const account = this.get(accountId);
    if (options.mode === 'write' && account.allowWrites !== true) {
      throw new MailError('UNSUPPORTED', 'This account is configured read-only; set "allowWrites": true for it to organise mail', {
        accountId,
      });
    }
    const started = Date.now();
    // A Gmail IMAP session needs a fresh access token before the handshake; a
    // password account needs nothing. Both then share every other option.
    const accessToken = account.authType === 'xoauth2'
      ? await accessTokenFor({ clientFile: account.oauth.clientFile, tokenFile: account.oauth.tokenFile })
      : null;
    const client = new ImapFlow(clientOptionsFor(account, accessToken));
    const guard = enforcePolicy(client, {
      mode: options.mode === 'write' ? 'write' : 'read',
      allowMove: false,
      allowCopy: false,
    });
    this.violations.push(...guard.violations);

    let connected = false;
    try {
      await client.connect();
      connected = true;
      this.recordStatus(accountId, ACCOUNT_STATUS.READY, null, Date.now() - started);
      const result = await run(client, account, guard);
      this.violations.push(...guard.violations);
      return result;
    } catch (error) {
      const mapped = toMailError(error, accountId);
      this.violations.push(...guard.violations);
      // The recorded state follows the LAYER that failed, not a guess. A policy
      // refusal is our own bug: labelling it CONNECTION_FAILED (as the generic
      // branch used to) sent the owner looking at the provider for a fault that
      // was in this process.
      if (mapped.code === 'AUTH_FAILED') {
        this.recordStatus(accountId, ACCOUNT_STATUS.AUTH_FAILED, 'authentication refused by the server', Date.now() - started, {
          layer: layerOf(mapped),
        });
      } else if (mapped.code === 'CONNECTION_FAILED' || mapped.code === 'CONNECTION_TIMEOUT' || mapped.code === 'TLS_FAILED') {
        this.recordStatus(accountId, ACCOUNT_STATUS.CONNECTION_FAILED, mapped.message, Date.now() - started, {
          layer: layerOf(mapped),
        });
      }
      throw mapped;
    } finally {
      if (connected) {
        // logout() ends the session cleanly. It is wrapped because a server that
        // already dropped the socket would otherwise turn a successful read into
        // a failure on the way out.
        try {
          await client.logout();
        } catch {
          try {
            client.close();
          } catch {
            /* the socket is gone; nothing left to release */
          }
        }
      } else {
        try {
          client.close();
        } catch {
          /* never connected */
        }
      }
    }
  }

  /**
   * Run a read-only operation inside one mailbox, under a read-only lock.
   *
   * The lock is released in `finally`, and the selected mailbox is verified to
   * be read-only before the callback runs. If the lock had to switch mailboxes,
   * the next call re-opens with EXAMINE; `UNSELECT` is used by the library when
   * available, never `CLOSE` (which would expunge).
   *
   * @template T
   * @param {string} accountId
   * @param {string} mailbox path to EXAMINE
   * @param {(context: {client: ImapFlow, account: object, mailbox: object}) => Promise<T>} run
   * @returns {Promise<T>}
   */
  async withMailbox(accountId, mailbox, run, options = {}) {
    const writeMode = options.mode === 'write';
    return this.withConnection(
      accountId,
      async (client, account, guard) => {
        // A write needs a writable select; a read stays on EXAMINE so nothing can
        // change as a side effect of looking. `allowMove` comes from the server's
        // own capability, and it is what stops imapflow from silently emulating
        // MOVE with COPY + \Deleted + EXPUNGE.
        if (writeMode && guard) {
          const caps = sessionCapabilities(client, account);
          guard.setPolicy({ mode: 'write', allowMove: caps.move, allowCopy: options.allowCopy === true });
        }
        let lock;
        try {
          lock = await client.getMailboxLock(mailbox, {
            readOnly: !writeMode,
            description: `mail-imap ${writeMode ? 'write' : 'read'}: ${account.id}`,
            acquireTimeout: account.connectionTimeoutMs,
          });
        } catch (error) {
          // The lock is where EXAMINE/SELECT happens, so a refusal here IS a
          // statement about mailbox access, and it is recorded as such.
          const mapped = toMailError(error, accountId);
          this.recordInboxStatus(accountId, INBOX_STATUS.FAILED, `${mapped.code}${layerOf(mapped) ? ` (${layerOf(mapped)})` : ''}`);
          throw mapped;
        }
        try {
          if (!writeMode) assertSelectedReadOnly(client);
          const selected = client.mailbox;
          // The mailbox really is open here: only now is INBOX access proven.
          this.recordInboxStatus(accountId, INBOX_STATUS.VERIFIED);
          return await run({ client, account, mailbox: selected, capabilities: sessionCapabilities(client, account) });
        } catch (error) {
          // A failure AFTER the mailbox opened (a missing message, a SEARCH the
          // server rejected) is not evidence that INBOX is unreadable, so it must
          // not overwrite VERIFIED. Failing to distinguish these two was the same
          // class of mistake as reporting READY as proven access.
          throw toMailError(error, accountId);
        } finally {
          lock.release();
        }
      },
      { mode: writeMode ? 'write' : 'read' },
    );
  }

  /**
   * Open a session without selecting a mailbox, to list folders and capabilities.
   *
   * @param {string} accountId
   * @param {(context: {client: object, account: object, capabilities: object}) => Promise<T>} run
   * @returns {Promise<T>}
   * @template T
   */
  async withSession(accountId, run) {
    return this.withConnection(accountId, async (client, account) =>
      run({ client, account, capabilities: sessionCapabilities(client, account) }),
    );
  }

  /**
   * Cheap liveness check for diagnostics: connect, authenticate, EXAMINE INBOX.
   *
   * It does not fetch a message and does not modify flags; the deeper checks
   * live in the diagnostic script, which drives real tool calls.
   *
   * The returned `status` is the TRANSPORT state and `inbox_status` the MAILBOX
   * state; they are reported separately so "the session came up" can never be
   * read as "the mailbox is readable".
   *
   * @param {string} accountId
   * @returns {Promise<{status: string, inbox_status: string, inbox: boolean, uidValidity: string|null, error: string|null, layer: string|null}>}
   */
  async probe(accountId) {
    const account = this.get(accountId);
    try {
      return await this.withMailbox(accountId, account.defaultFolder, async ({ client }) => {
        const box = client.mailbox;
        const state = this.statusOf(accountId);
        return {
          status: ACCOUNT_STATUS.READY,
          inbox_status: INBOX_STATUS.VERIFIED,
          inbox: box.readOnly === true,
          uidValidity: box.uidValidity === undefined ? null : String(box.uidValidity),
          error: null,
          layer: state.layer,
        };
      });
    } catch (error) {
      const mapped = toMailError(error, accountId);
      const state = this.statusOf(accountId);
      // The connection layer already recorded the transport-level state, so it is
      // reported as-is. A mailbox failure keeps `status` at READY when the session
      // itself was fine, and says so through `inbox_status` instead.
      return {
        status: state.status,
        inbox_status: state.inboxStatus,
        inbox: false,
        uidValidity: null,
        error: mapped.code,
        layer: layerOf(mapped) ?? state.layer,
      };
    }
  }
}
