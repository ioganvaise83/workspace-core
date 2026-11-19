// Error vocabulary shared by every module.
//
// Kept in its own file so that the folder, action and approval layers can raise a
// MailError without importing the connection pool (which imports them). One
// definition of "what a failure looks like" also means the MCP layer has exactly
// one place to map errors to tool results.
import { ReadOnlyViolation } from './readonly.js';

/** Stable tool-facing error codes. Diagnostics and tests branch on these. */
export const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  UNKNOWN_ACCOUNT: 'UNKNOWN_ACCOUNT',
  AUTH_FAILED: 'AUTH_FAILED',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  CONNECTION_TIMEOUT: 'CONNECTION_TIMEOUT',
  TLS_FAILED: 'TLS_FAILED',
  TIMEOUT: 'TIMEOUT',
  MAILBOX_NOT_FOUND: 'MAILBOX_NOT_FOUND',
  FOLDER_NOT_FOUND: 'FOLDER_NOT_FOUND',
  FOLDER_NOT_SELECTABLE: 'FOLDER_NOT_SELECTABLE',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  UID_VALIDITY_CHANGED: 'UID_VALIDITY_CHANGED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNSUPPORTED: 'UNSUPPORTED',
  READ_ONLY_VIOLATION: 'READ_ONLY_VIOLATION',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_INVALID: 'APPROVAL_INVALID',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_ALREADY_USED: 'APPROVAL_ALREADY_USED',
  PREVIEW_MISMATCH: 'PREVIEW_MISMATCH',
  PREVIEW_EXPIRED: 'PREVIEW_EXPIRED',
  PARTIAL_FAILURE: 'PARTIAL_FAILURE',
  TOO_MANY_MESSAGES: 'TOO_MANY_MESSAGES',
  UNDO_UNAVAILABLE: 'UNDO_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
  IMAP_ERROR: 'IMAP_ERROR',
});

/**
 * Which layer of the stack refused or broke, reported alongside the error code.
 *
 * The code says WHAT failed (`AUTH_FAILED`, `CONNECTION_FAILED`, ...); the layer
 * says WHERE, which is what a diagnosis needs and what a generic "unreachable"
 * hides. `ENOTFOUND` and `ECONNREFUSED` both map to `CONNECTION_FAILED`, but one
 * is name resolution and the other is a socket, and the fix differs completely:
 * check the login/hostname versus check the port and the server.
 *
 * Deliberately a closed set, so a tool result can never smuggle free-form text
 * (and therefore never a server banner or a credential) into the diagnosis.
 */
export const ERROR_LAYERS = Object.freeze({
  DNS: 'dns',
  TCP: 'tcp',
  TLS: 'tls',
  AUTH: 'auth',
  TIMEOUT: 'timeout',
  COMMAND_POLICY: 'command_policy',
  PROTOCOL: 'protocol',
});

/** Raised for any expected, categorised failure. */
export class MailError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message human-readable, never containing a secret
   * @param {{accountId?: string, retryable?: boolean, details?: object}} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'MailError';
    this.code = code;
    this.accountId = meta.accountId ?? null;
    this.retryable = meta.retryable === true;
    // Structured extras a tool result may carry (e.g. the approval challenge).
    this.details = meta.details ?? null;
  }
}

/**
 * Map an imapflow/node error to a stable code without leaking credentials.
 *
 * Deliberately narrow: an unrecognised error becomes a generic IMAP_ERROR rather
 * than echoing a message that might contain a login or a protocol dump.
 *
 * @param {unknown} error
 * @param {string} accountId
 * @returns {MailError}
 */
export function toMailError(error, accountId) {
  if (error instanceof MailError) return error;
  if (error instanceof ReadOnlyViolation) {
    return new MailError(ERROR_CODES.READ_ONLY_VIOLATION, error.message, {
      accountId,
      // A refusal by OUR guard is neither a server fault nor a network fault.
      // Saying so explicitly is what stops a bug in the command policy from
      // being diagnosed as "the provider is down" — exactly the misdiagnosis
      // that the XLIST refusal produced.
      details: { layer: ERROR_LAYERS.COMMAND_POLICY, command: error.command },
    });
  }
  const record = error && typeof error === 'object' ? /** @type {Record<string, any>} */ (error) : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const serverResponse = typeof record.responseText === 'string' ? record.responseText : '';
  const message = typeof record.message === 'string' ? record.message : 'unknown IMAP error';

  // Classification is ordered: the most specific layer wins. A TLS error also
  // carries a socket-level code on some Node versions, and an auth failure can
  // arrive as a rejected command, so the checks below are deliberately in the
  // order DNS/TCP -> TLS -> AUTH -> TIMEOUT, and the layer is reported with the
  // code rather than folded into one vague "unreachable".
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new MailError(ERROR_CODES.CONNECTION_FAILED, 'IMAP host name could not be resolved', {
      accountId,
      retryable: true,
      details: { layer: ERROR_LAYERS.DNS, syscall_code: code },
    });
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new MailError(ERROR_CODES.CONNECTION_FAILED, 'IMAP server refused or dropped the TCP connection', {
      accountId,
      retryable: true,
      details: { layer: ERROR_LAYERS.TCP, syscall_code: code },
    });
  }
  if (
    typeof code === 'string' &&
    (code.startsWith('ERR_TLS') ||
      code === 'CERT_HAS_EXPIRED' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      code === 'ERR_SSL_WRONG_VERSION_NUMBER' ||
      code === 'EPROTO')
  ) {
    return new MailError(ERROR_CODES.TLS_FAILED, 'TLS verification failed; the certificate is not trusted', {
      accountId,
      details: { layer: ERROR_LAYERS.TLS, syscall_code: code },
    });
  }
  if (code === 'AUTHENTICATIONFAILED' || /authenticationfail|invalid credentials|login failed/i.test(`${code} ${serverResponse} ${message}`)) {
    return new MailError(ERROR_CODES.AUTH_FAILED, 'IMAP authentication was refused by the server', {
      accountId,
      // Not retryable as-is: the same credential will be refused again. The owner
      // has to change something (app password, IMAP toggle) before a retry helps.
      retryable: false,
      details: { layer: ERROR_LAYERS.AUTH },
    });
  }
  if (code === 'CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === 'Timeout' || code === 'GreetingTimeout') {
    return new MailError(ERROR_CODES.CONNECTION_TIMEOUT, 'IMAP server did not answer in time', {
      accountId,
      retryable: true,
      details: { layer: ERROR_LAYERS.TIMEOUT, syscall_code: code },
    });
  }
  if (code === 'EConnectionClosed' || code === 'NoConnection') {
    return new MailError(ERROR_CODES.CONNECTION_FAILED, 'IMAP server closed the connection', {
      accountId,
      retryable: true,
      details: { layer: ERROR_LAYERS.TCP, syscall_code: code },
    });
  }
  // imapflow signals a missing mailbox with `mailboxMissing: true` after it has
  // confirmed the absence with LIST, and leaves `code` undefined. Relying on the
  // code or on the message text alone therefore missed it and produced a generic
  // IMAP_ERROR, which told the caller nothing and the owner even less.
  if (
    record.mailboxMissing === true ||
    code === 'MailboxMissing' ||
    /mailbox does not exist|nonexistent|mailbox not found/i.test(`${message} ${serverResponse}`)
  ) {
    return new MailError(ERROR_CODES.MAILBOX_NOT_FOUND, 'The requested mailbox does not exist for this account', {
      accountId,
      details: { layer: ERROR_LAYERS.PROTOCOL },
    });
  }
  if (code === 'NoMailboxSelected') {
    return new MailError(ERROR_CODES.INTERNAL, 'No mailbox is selected', { accountId });
  }
  return new MailError(ERROR_CODES.IMAP_ERROR, 'The IMAP server rejected the operation', {
    accountId,
    details: { layer: ERROR_LAYERS.PROTOCOL },
  });
}

/**
 * Describe a failure in the terms a diagnosis needs.
 *
 * @param {unknown} error raw error, before or after mapping
 * @param {string} accountId
 * @returns {{code: string, layer: string|null, retryable: boolean}}
 */
export function describeFailure(error, accountId) {
  const mapped = toMailError(error, accountId);
  return {
    code: mapped.code,
    layer: mapped.details && typeof mapped.details.layer === 'string' ? mapped.details.layer : null,
    retryable: mapped.retryable === true,
  };
}
