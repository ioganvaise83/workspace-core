// Gmail IMAP OAuth (XOAUTH2).
//
// WHY THIS IS A SEPARATE CREDENTIAL FROM THE WORKING GMAIL MCP
// -----------------------------------------------------------
// The existing `gmail-mcp` uses the Gmail *API* with the `gmail.readonly` scope
// and stores its tokens under `~/.gmail-mcp`. Those tokens cannot authenticate
// IMAP: Google requires `https://mail.google.com/` for XOAUTH2 on IMAP, and a
// readonly token is refused.
//
// So this integration uses its own OAuth client material and its own refresh
// token, in its own directory. Nothing here reads, writes or migrates the existing
// Gmail API credentials, and the two integrations can be revoked independently.
//
// SCOPE CONSEQUENCE, STATED PLAINLY
// ---------------------------------
// `https://mail.google.com/` is a BROAD scope: it permits reading and modifying
// all mail, and it is the only scope that works with IMAP XOAUTH2. There is no
// narrower IMAP-compatible scope. Anyone approving this consent is granting that
// access, and the tool-level restrictions in this server are the only thing
// bounding it afterwards. The owner must decide that consciously; this file exists
// so the decision is explicit rather than buried in a setup step.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MailError } from './errors.js';

/** The only scope that works for Gmail IMAP XOAUTH2. */
export const GMAIL_IMAP_SCOPE = 'https://mail.google.com/';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Read the OAuth client (installed-app) material for Gmail IMAP.
 *
 * The file is a standard Google "installed app" JSON, as downloaded from the
 * Cloud console. It is read fresh each time so a rotated client needs no restart.
 *
 * @param {string} clientFile
 * @returns {{clientId: string, clientSecret: string}}
 */
export function readOAuthClient(clientFile) {
  let raw;
  try {
    raw = fs.readFileSync(clientFile, 'utf8');
  } catch {
    throw new MailError('NOT_CONFIGURED', 'Gmail IMAP OAuth client file is missing; see the integration README for the setup steps');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MailError('NOT_CONFIGURED', 'Gmail IMAP OAuth client file is not valid JSON');
  }
  // Google wraps installed-app credentials in one of these two keys.
  const section = parsed.installed ?? parsed.web ?? parsed;
  const clientId = section.client_id;
  const clientSecret = section.client_secret;
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
    throw new MailError('NOT_CONFIGURED', 'Gmail IMAP OAuth client file has no client_id/client_secret');
  }
  return { clientId, clientSecret };
}

/**
 * Read a stored token document.
 *
 * Shape kept deliberately close to Google's own so an owner can inspect it:
 * `{ refresh_token, access_token?, expiry_date?, scope? }`.
 *
 * @param {string} tokenFile
 * @returns {object|null}
 */
export function readTokenDocument(tokenFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write a token document atomically, keeping it owner-readable only.
 *
 * Atomic because a refresh writes while another tool call may be reading, and a
 * half-written token file would look like "not configured".
 *
 * @param {string} tokenFile
 * @param {object} document
 */
export function writeTokenDocument(tokenFile, document) {
  const dir = path.dirname(tokenFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${tokenFile}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, tokenFile);
}

/**
 * Exchange a refresh token for an access token.
 *
 * A single POST, no SDK: the fewer moving parts between a credential and the
 * network, the easier the flow is to audit.
 *
 * @param {{clientId: string, clientSecret: string}} client
 * @param {string} refreshToken
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{accessToken: string, expiresAt: number, scope: string|null}>}
 */
export async function refreshAccessToken(client, refreshToken, fetchImpl = fetch) {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  let response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      // A hung token endpoint must not hold a tool call open indefinitely.
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new MailError('CONNECTION_FAILED', 'Could not reach the Google token endpoint', { retryable: true });
  }
  if (!response.ok) {
    // Google distinguishes "expired or revoked" (invalid_grant) from other
    // problems. Only the code is surfaced: the body can echo the request.
    let errorCode = '';
    try {
      const parsed = await response.json();
      errorCode = typeof parsed.error === 'string' ? parsed.error : '';
    } catch {
      /* keep it empty */
    }
    if (errorCode === 'invalid_grant') {
      throw new MailError('AUTH_FAILED', 'The Gmail IMAP refresh token was revoked or expired; re-authorise on the host');
    }
    throw new MailError('AUTH_FAILED', 'Google refused the token refresh');
  }
  const parsed = await response.json();
  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    throw new MailError('AUTH_FAILED', 'Google returned no access token');
  }
  const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
  return {
    accessToken: parsed.access_token,
    // Renew five minutes early so a token cannot expire mid-handshake.
    expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
    scope: typeof parsed.scope === 'string' ? parsed.scope : null,
  };
}

/**
 * Obtain a usable access token for one Gmail IMAP account.
 *
 * Order: a still-valid cached access token, otherwise a refresh. The refreshed
 * document is written back so the next process start does not refresh again and so
 * the owner can see when it last happened.
 *
 * @param {object} params
 * @param {string} params.clientFile
 * @param {string} params.tokenFile
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<string>}
 */
export async function accessTokenFor({ clientFile, tokenFile, fetchImpl = fetch }) {
  const client = readOAuthClient(clientFile);
  const document = readTokenDocument(tokenFile);
  if (!document || typeof document.refresh_token !== 'string') {
    throw new MailError('NOT_CONFIGURED', 'No Gmail IMAP refresh token is stored; run the one-time authorisation on the host');
  }

  const scope = typeof document.scope === 'string' ? document.scope : '';
  if (scope.length > 0 && !scope.split(/\s+/).includes(GMAIL_IMAP_SCOPE)) {
    throw new MailError(
      'AUTH_FAILED',
      `The stored Gmail IMAP token was granted a different scope and cannot authenticate IMAP; re-authorise with ${GMAIL_IMAP_SCOPE}`,
    );
  }

  if (typeof document.access_token === 'string' && typeof document.expiry_date === 'number' && document.expiry_date > Date.now()) {
    return document.access_token;
  }

  const refreshed = await refreshAccessToken(client, document.refresh_token, fetchImpl);
  writeTokenDocument(tokenFile, {
    ...document,
    access_token: refreshed.accessToken,
    expiry_date: refreshed.expiresAt,
    scope: refreshed.scope ?? document.scope,
    last_refresh_at: new Date().toISOString(),
  });
  return refreshed.accessToken;
}

/**
 * Build the XOAUTH2 SASL string imapflow expects.
 *
 * imapflow accepts `auth.accessToken` and assembles this itself; the helper exists
 * so the format is testable and documented in one place.
 *
 * @param {string} user
 * @param {string} accessToken
 * @returns {string}
 */
export function xoauth2String(user, accessToken) {
  return `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`;
}
