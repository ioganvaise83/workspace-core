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
    return new MailError(ERROR_CODES.READ_ONLY_VIOLATION, error.message, { accountId });
  }
  const record = error && typeof error === 'object' ? /** @type {Record<string, any>} */ (error) : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const serverResponse = typeof record.responseText === 'string' ? record.responseText : '';
  const message = typeof record.message === 'string' ? record.message : 'unknown IMAP error';

  if (code === 'AUTHENTICATIONFAILED' || /authenticationfail|invalid credentials|login failed/i.test(`${code} ${serverResponse} ${message}`)) {
    return new MailError(ERROR_CODES.AUTH_FAILED, 'IMAP authentication was refused by the server', { accountId });
  }
  if (code === 'CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === 'Timeout') {
    return new MailError(ERROR_CODES.CONNECTION_TIMEOUT, 'IMAP server did not answer in time', { accountId, retryable: true });
  }
  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'EAI_AGAIN' ||
    code === 'EConnectionClosed' ||
    code === 'NoConnection'
  ) {
    return new MailError(ERROR_CODES.CONNECTION_FAILED, 'IMAP server is unreachable', { accountId, retryable: true });
  }
  if (
    typeof code === 'string' &&
    (code.startsWith('ERR_TLS') ||
      code === 'CERT_HAS_EXPIRED' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  ) {
    return new MailError(ERROR_CODES.TLS_FAILED, 'TLS verification failed; the certificate is not trusted', { accountId });
  }
  if (code === 'MailboxMissing' || /mailbox does not exist|nonexistent/i.test(message)) {
    return new MailError(ERROR_CODES.MAILBOX_NOT_FOUND, 'The requested mailbox does not exist for this account', { accountId });
  }
  if (code === 'NoMailboxSelected') {
    return new MailError(ERROR_CODES.INTERNAL, 'No mailbox is selected', { accountId });
  }
  return new MailError(ERROR_CODES.IMAP_ERROR, 'The IMAP server rejected the operation', { accountId });
}
