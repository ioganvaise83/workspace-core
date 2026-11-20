'use strict';

/**
 * Identity-aware gateway for one DeepSeek Harness instance.
 *
 * Position in the chain:
 *
 *   browser -> nginx (TLS, auth_request) -> oauth2-proxy -> nginx -> THIS -> DSH
 *
 * Why this component exists
 * -------------------------
 * DSH authenticates browsers with a cookie it signs with a secret stored in
 * `$DSH_HOME/.credentials.yaml` (`client-connection/browser-session`). It also
 * prints a per-process launch token at startup. Handing that launch token to
 * every visitor would give every visitor the same session — precisely the thing
 * we must not do (docs/security/decisions.md, ADR-7).
 *
 * This gateway holds the same signing secret, but only ever mints a cookie for a
 * caller that has already been authenticated by oauth2-proxy AND matched the
 * allowlist. The launch token is never used, printed, or transmitted.
 *
 * Security properties it must keep
 * --------------------------------
 * 1. It listens only on a private address; nginx is its only expected peer.
 * 2. It refuses to run without an explicit authority allowlist.
 * 3. A client-supplied `dsh-auth-*` cookie is always dropped and replaced. The
 *    gateway decides the session; the client never does.
 * 4. Identity comes only from headers that nginx sets after `auth_request`.
 *    Incoming `X-Auth-Request-*` from the client are ignored because nginx clears
 *    them at the edge; this service additionally requires a shared header that
 *    nginx sets, so a direct caller cannot forge identity.
 * 5. The authority is taken from `Host` and must match an exact allowlist entry,
 *    so a forged Host can never produce a cookie for someone else's authority.
 * 6. Nothing secret is logged: no tokens, no secrets, no cookie values.
 *
 * Configuration (environment, all required unless noted):
 *   DSH_UPSTREAM          e.g. http://harness:3080
 *   GATEWAY_LISTEN_HOST   default 0.0.0.0 inside the container network
 *   GATEWAY_LISTEN_PORT   default 8080
 *   GATEWAY_ALLOWED_AUTHORITIES  comma-separated exact `host` or `host:port`
 *   GATEWAY_ALLOWED_SUBJECTS     comma-separated stable OIDC `sub` values
 *   GATEWAY_COOKIE_SECRET_FILE   path to the 32-byte base64url signing secret
 *   GATEWAY_PROXY_SHARED_SECRET_FILE  path to a file with the nginx shared secret
 *   GATEWAY_COOKIE_MAX_AGE_SECONDS    default 86400 (must be <= DSH cookieMaxAgeDays)
 *   GATEWAY_ISSUER        optional; recorded in logs for traceability only
 *
 * Zero runtime dependencies: node:http, node:crypto, node:fs only.
 */

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DSH_AUTH_PREFIX = 'dsh-auth-';
const DEFAULT_MAX_AGE_SECONDS = 86400;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function fail(message) {
  process.stderr.write(`gateway: fatal: ${message}\n`);
  process.exit(78); // EX_CONFIG
}

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') fail(`missing required environment variable ${name}`);
  return value.trim();
}

/**
 * Read a secret file.
 *
 * Two kinds of secret are read here and they must not be conflated:
 *  - the DSH cookie signing secret, which IS a base64url encoding of exactly 32
 *    raw bytes and must be canonical, because two spellings of one secret would
 *    silently mean different HMAC keys;
 *  - the nginx shared secret, which is an opaque string this process only ever
 *    compares byte for byte. Requiring it to be base64url would reject perfectly
 *    good random values (base64 with `+` or `/`, or a passphrase) and force
 *    operators to weaken their secret generators.
 *
 * `expectedBytes` therefore controls the interpretation: when set, the value must
 * be canonical base64url decoding to exactly that length.
 */
function readSecretFile(name, expectedBytes) {
  const path = requireEnv(name);
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8').trim();
  } catch (error) {
    fail(`cannot read ${name} (${path}): ${error.message}`);
  }
  if (raw.length === 0) fail(`${name} (${path}) is empty`);

  if (expectedBytes === undefined) {
    // Opaque comparison secret: enforce only what the comparison needs.
    if (raw.length < 32) fail(`${name} (${path}) must be at least 32 characters, got ${raw.length}`);
    return { bytes: undefined, text: raw };
  }

  const decoded = decodeBase64Url(raw);
  if (decoded === undefined) fail(`${name} (${path}) is not valid base64url`);
  if (decoded.byteLength !== expectedBytes) {
    fail(`${name} (${path}) must decode to ${expectedBytes} bytes, got ${decoded.byteLength}`);
  }
  return { bytes: decoded, text: raw };
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(padded, 'base64');
  // Reject non-canonical encodings so two spellings never mean one secret.
  return encodeBase64Url(decoded) === value ? decoded : undefined;
}

function encodeBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function parseList(value, label) {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (items.length === 0) fail(`${label} must list at least one entry`);
  return items;
}

function loadConfig() {
  const config = {
    upstream: new URL(requireEnv('DSH_UPSTREAM')),
    listenHost: process.env.GATEWAY_LISTEN_HOST?.trim() || '0.0.0.0',
    listenPort: Number(process.env.GATEWAY_LISTEN_PORT ?? 8080),
    allowedAuthorities: parseList(requireEnv('GATEWAY_ALLOWED_AUTHORITIES'), 'GATEWAY_ALLOWED_AUTHORITIES'),
    allowedSubjects: parseList(requireEnv('GATEWAY_ALLOWED_SUBJECTS'), 'GATEWAY_ALLOWED_SUBJECTS'),
    cookieSecret: readSecretFile('GATEWAY_COOKIE_SECRET_FILE', 32).bytes,
    proxySharedSecret: readSecretFile('GATEWAY_PROXY_SHARED_SECRET_FILE', undefined).text,
    cookieMaxAgeSeconds: Number(process.env.GATEWAY_COOKIE_MAX_AGE_SECONDS ?? DEFAULT_MAX_AGE_SECONDS),
    issuer: process.env.GATEWAY_ISSUER?.trim() || '(unspecified)',
  };

  if (config.upstream.protocol !== 'http:' && config.upstream.protocol !== 'https:') {
    fail('DSH_UPSTREAM must be an http(s) URL');
  }
  if (!Number.isInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535) {
    fail('GATEWAY_LISTEN_PORT must be an integer between 1 and 65535');
  }
  if (!Number.isInteger(config.cookieMaxAgeSeconds) || config.cookieMaxAgeSeconds < 60) {
    fail('GATEWAY_COOKIE_MAX_AGE_SECONDS must be an integer of at least 60');
  }
  // DSH rejects a cookie whose lifetime exceeds its own cookieMaxAgeDays; keeping
  // this below that bound turns a silent 401 into a start-up failure.
  if (config.cookieMaxAgeSeconds > 30 * 86400) {
    fail('GATEWAY_COOKIE_MAX_AGE_SECONDS must not exceed 30 days');
  }
  // An authority allowlist that admits a wildcard is a configuration bug: it
  // would let a forged Host mint a cookie for an authority we do not serve.
  for (const authority of config.allowedAuthorities) {
    if (authority === '*' || authority.includes('/') || authority.includes('@')) {
      fail(`GATEWAY_ALLOWED_AUTHORITIES entry ${JSON.stringify(authority)} is not a bare host[:port]`);
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// Cookie minting
// ---------------------------------------------------------------------------

/**
 * DSH's browser cookie is HMAC-SHA256 over the exact JSON body, with the cookie
 * name derived from the authority. Verified against the installed binary; keep
 * this in lockstep with `dsh-client-connection` and re-verify on every upgrade.
 */
function dshCookie(secretBytes, authority, maxAgeSeconds, now = Date.now()) {
  // The secret is 32 raw bytes by construction; anything else means the file was
  // truncated, double-encoded or replaced, and minting would produce a cookie DSH
  // silently rejects. Fail loudly instead.
  if (!Buffer.isBuffer(secretBytes) || secretBytes.byteLength !== 32) {
    throw new Error('dshCookie: secret must be exactly 32 raw bytes');
  }
  if (typeof authority !== 'string' || authority === '') {
    throw new Error('dshCookie: authority must be a non-empty string');
  }
  const issuedAt = now;
  const expiresAt = now + maxAgeSeconds * 1000;
  const payload = { version: 1, authority, issuedAt, expiresAt };
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = crypto.createHmac('sha256', secretBytes).update(body).digest();
  const name = DSH_AUTH_PREFIX + encodeBase64Url(crypto.createHash('sha256').update(authority).digest());
  return {
    name,
    value: `v1.${body}.${encodeBase64Url(signature)}`,
    payload,
  };
}

/** Drop every DSH cookie the client sent, whatever its name or value. */
function stripDshCookies(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return '';
  return cookieHeader
    .split(';')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
    .filter((segment) => !segment.slice(0, Math.max(0, segment.indexOf('='))).startsWith(DSH_AUTH_PREFIX))
    .join('; ');
}

function header(headers, name) {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Constant-time comparison for the caller secret, so a timing signal cannot be
 * used to guess it byte by byte.
 */
function secretMatches(actual, expected) {
  const actualBytes = Buffer.from(actual ?? '', 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (actualBytes.byteLength !== expectedBytes.byteLength) return false;
  return crypto.timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Set-Cookie value for the DSH browser session.
 *
 * Attributes mirror what DSH mints itself, with one deliberate addition:
 * `Secure` is set unconditionally. The browser leg is always TLS-terminated
 * (nginx redirects plain HTTP with 308), and a cookie without `Secure` would be
 * sent over a cleartext hop if the edge were ever misconfigured. DSH cannot see
 * the browser's transport, so this gateway is the right place for that decision.
 *
 * HttpOnly keeps the cookie away from page scripts; SameSite=Strict matches DSH
 * so browser behaviour is identical whether the cookie came from here or from the
 * harness itself during local loopback use.
 */
function sessionCookie(minted, maxAgeSeconds) {
  const expires = new Date(minted.payload.expiresAt).toUTCString();
  return [
    `${minted.name}=${minted.value}`,
    `Max-Age=${String(maxAgeSeconds)}`,
    `Expires=${expires}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

function refuse(response, status, message) {
  const body = `${message}\n`;
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function createHandler(config) {
  return function handle(request, response) {
    // 1. The caller must be nginx, proven by a secret only nginx knows.
    if (!secretMatches(header(request.headers, 'x-dsh-gateway-secret'), config.proxySharedSecret)) {
      refuse(response, 403, 'forbidden');
      return;
    }

    // 2. Identity comes only from headers nginx set after a successful
    //    auth_request. Absent means oauth2-proxy did not authenticate.
    const subject = header(request.headers, 'x-auth-request-user');
    if (subject === undefined || subject === '') {
      refuse(response, 401, 'authentication required');
      return;
    }
    if (!config.allowedSubjects.includes(subject)) {
      // Authenticated by the IdP but not permitted here. This is the deny-by-
      // default outcome that protects the instance from every other colleague.
      process.stderr.write(`gateway: deny subject=${JSON.stringify(subject)} issuer=${config.issuer}\n`);
      refuse(response, 403, 'not authorised');
      return;
    }

    // 3. The authority must be one we serve. A forged Host cannot mint a cookie
    //    for another host, and a request without Host is refused outright.
    const host = header(request.headers, 'host');
    if (host === undefined || !config.allowedAuthorities.includes(host)) {
      refuse(response, 421, 'misdirected request');
      return;
    }

    const minted = dshCookie(config.cookieSecret, host, config.cookieMaxAgeSeconds);

    // 4. Replace, never merge: the gateway alone decides the DSH session.
    const forwardedCookies = stripDshCookies(header(request.headers, 'cookie'));
    const cookieHeader = forwardedCookies === '' ? `${minted.name}=${minted.value}` : `${forwardedCookies}; ${minted.name}=${minted.value}`;

    const headers = { ...request.headers };
    delete headers['x-dsh-gateway-secret'];
    delete headers['x-auth-request-user'];
    delete headers['x-auth-request-email'];
    delete headers['x-auth-request-groups'];
    delete headers['x-auth-request-access-token'];
    delete headers['x-forwarded-access-token'];
    delete headers["x-auth-request-id"];
    delete headers["x-forwarded-user"];
    delete headers["x-forwarded-email"];
    // Defence in depth: nginx clears these at the edge, but a gateway must not
    // depend on a peer configuration it cannot verify.
    delete headers.authorization;
    delete headers.proxy;
    headers.cookie = cookieHeader;
    // DSH needs the original authority to bind and verify its cookie; nginx has
    // already guaranteed the Host matches an allowlisted authority.
    headers.host = host;

    const options = {
      protocol: config.upstream.protocol,
      hostname: config.upstream.hostname,
      port: config.upstream.port || (config.upstream.protocol === 'https:' ? 443 : 80),
      method: request.method,
      path: request.url,
      headers,
    };

    const upstream = http.request(options, (upstreamResponse) => {
      // DSH does not emit Set-Cookie on an ordinary request; it only does so
      // during its own launch-token exchange, which this deployment never uses.
      // Verified against the installed binary: a request carrying a valid cookie
      // answers 200 with no Set-Cookie. The browser therefore never receives a
      // DSH session unless the gateway sets it explicitly — which is the whole
      // point of ADR-7.
      //
      // Replace any upstream Set-Cookie for our cookie name with our own: two
      // Set-Cookie headers for one name would leave the browser holding whichever
      // it saw last, and the upstream one is not the session we authorised.
      const upstreamHeaders = { ...upstreamResponse.headers };
      upstreamHeaders['set-cookie'] = [
        ...(upstreamResponse.headers['set-cookie'] ?? []).filter(
          (value) => !String(value).toLowerCase().startsWith(`${minted.name.toLowerCase()}=`),
        ),
        sessionCookie(minted, config.cookieMaxAgeSeconds),
      ];

      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamHeaders);
      upstreamResponse.pipe(response);
    });

    upstream.on('error', (error) => {
      process.stderr.write(`gateway: upstream error ${error.code ?? 'unknown'}\n`);
      if (!response.headersSent) refuse(response, 502, 'upstream unavailable');
      else response.destroy();
    });

    request.pipe(upstream);
    request.on('aborted', () => upstream.destroy());
  };
}

/**
 * WebSocket and other upgrades: the upgrade request carries the same nginx
 * headers, so the same admission applies. DSH's `/api/remote.mux` is a WebSocket,
 * and an unauthenticated upgrade must never reach it.
 */
function createUpgradeHandler(config) {
  return function upgrade(request, clientSocket, head) {
    const reject = (status) => {
      clientSocket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`);
      clientSocket.destroy();
    };

    if (!secretMatches(header(request.headers, 'x-dsh-gateway-secret'), config.proxySharedSecret)) return reject(403);
    const subject = header(request.headers, 'x-auth-request-user');
    if (subject === undefined || subject === '') return reject(401);
    if (!config.allowedSubjects.includes(subject)) {
      process.stderr.write(`gateway: deny upgrade subject=${JSON.stringify(subject)} issuer=${config.issuer}\n`);
      return reject(403);
    }
    const host = header(request.headers, 'host');
    if (host === undefined || !config.allowedAuthorities.includes(host)) return reject(403);

    const minted = dshCookie(config.cookieSecret, host, config.cookieMaxAgeSeconds);
    const forwardedCookies = stripDshCookies(header(request.headers, 'cookie'));
    const cookieHeader = forwardedCookies === '' ? `${minted.name}=${minted.value}` : `${forwardedCookies}; ${minted.name}=${minted.value}`;

    const headers = { ...request.headers };
    delete headers['x-dsh-gateway-secret'];
    delete headers['x-auth-request-user'];
    delete headers['x-auth-request-email'];
    delete headers['x-auth-request-groups'];
    delete headers['x-auth-request-access-token'];
    delete headers['x-forwarded-access-token'];
    delete headers["x-auth-request-id"];
    delete headers["x-forwarded-user"];
    delete headers["x-forwarded-email"];
    // Defence in depth: nginx clears these at the edge, but a gateway must not
    // depend on a peer configuration it cannot verify.
    delete headers.authorization;
    delete headers.proxy;
    headers.cookie = cookieHeader;
    headers.host = host;

    const upstreamSocket = net.connect({
      host: config.upstream.hostname,
      port: Number(config.upstream.port || 80),
    });

    upstreamSocket.on('connect', () => {
      const requestLine = `${request.method} ${request.url} HTTP/1.1\r\n`;
      const headerLines = Object.entries(headers)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => (Array.isArray(value) ? value.map((item) => `${name}: ${item}`).join('\r\n') : `${name}: ${value}`))
        .join('\r\n');
      upstreamSocket.write(`${requestLine}${headerLines}\r\n\r\n`);
      if (head && head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });

    const teardown = () => {
      upstreamSocket.destroy();
      clientSocket.destroy();
    };
    upstreamSocket.on('error', teardown);
    clientSocket.on('error', teardown);
    upstreamSocket.on('close', teardown);
    clientSocket.on('close', teardown);
  };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function main() {
  const config = loadConfig();
  const server = http.createServer(createHandler(config));
  server.on('upgrade', createUpgradeHandler(config));

  server.listen(config.listenPort, config.listenHost, () => {
    // Deliberately terse: no secrets, no authority list contents beyond a count.
    process.stdout.write(
      `gateway: listening on ${config.listenHost}:${config.listenPort} -> ${config.upstream.origin} ` +
        `(authorities=${config.allowedAuthorities.length}, subjects=${config.allowedSubjects.length}, ` +
        `maxAgeSeconds=${config.cookieMaxAgeSeconds}, issuer=${config.issuer})\n`,
    );
  });

  const shutdown = (signal) => {
    process.stdout.write(`gateway: ${signal} received, closing\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main();

module.exports = {
  dshCookie,
  stripDshCookies,
  secretMatches,
  decodeBase64Url,
  encodeBase64Url,
  createHandler,
  createUpgradeHandler,
  loadConfig,
};
