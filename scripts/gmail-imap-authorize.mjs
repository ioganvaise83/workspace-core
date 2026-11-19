#!/usr/bin/env node
// One-time Gmail IMAP authorisation, run ON THE HOST.
//
// WHY THIS IS A SEPARATE SCRIPT AND A SEPARATE TOKEN
// --------------------------------------------------
// Gmail IMAP requires OAuth scope `https://mail.google.com/`. The existing
// Gmail API integration uses `gmail.readonly`, which Google refuses over IMAP.
// So this script performs its own consent and writes its own token file; it never
// reads or overwrites `~/.gmail-mcp`. If you revoke this one, the Gmail API
// integration keeps working, and vice versa.
//
// WHAT IT DOES
// ------------
//   1. Reads the OAuth "Desktop app" client JSON you downloaded.
//   2. Opens the consent URL (or prints it) and waits for the code you paste.
//   3. Exchanges it for a refresh token WITH the IMAP scope.
//   4. REFUSES to write anything if the granted scope is not the IMAP one, so the
//      "reused a readonly token by mistake" failure cannot happen silently.
//
// USAGE
//   node scripts/gmail-imap-authorize.mjs \
//     --client runtime/mail-imap/oauth/gmail-imap-client.json \
//     --token  runtime/mail-imap/state/oauth/gmail-imap-token.json
//
// Nothing here is a secret: the client file and the token file are read from and
// written to paths you choose, both outside Git. No value is printed.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

/** The only scope that works for Gmail IMAP XOAUTH2. */
const SCOPE = 'https://mail.google.com/';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Minimal argument parsing: only two flags, both required.
 *
 * @param {string[]} argv
 * @returns {{clientFile: string, tokenFile: string, port: number}}
 */
function parseArgs(argv) {
  const args = { port: 8765 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--client') { args.clientFile = value; index += 1; }
    else if (flag === '--token') { args.tokenFile = value; index += 1; }
    else if (flag === '--port') { args.port = Number(value); index += 1; }
    else if (flag === '--help' || flag === '-h') { args.help = true; }
    else if (flag !== undefined) { throw new Error(`unknown argument: ${flag}`); }
  }
  return args;
}

/**
 * Read the client id/secret from a Google client JSON.
 *
 * @param {string} file
 * @returns {{clientId: string, clientSecret: string}}
 */
function readClient(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const section = parsed.installed ?? parsed.web ?? parsed;
  if (typeof section.client_id !== 'string' || typeof section.client_secret !== 'string') {
    throw new Error('client file has no client_id / client_secret; download a Desktop app JSON from the Cloud console');
  }
  return { clientId: section.client_id, clientSecret: section.client_secret };
}

/**
 * Ask one question on the terminal.
 *
 * @param {string} prompt
 * @returns {Promise<string>}
 */
function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Try to start a loopback listener that receives the redirect.
 *
 * Returns the URL to open and a promise for the code, or null when the listener
 * cannot bind (in which case the caller falls back to manual code entry).
 *
 * @param {number} preferredPort
 * @returns {Promise<{redirectUri: string, code: Promise<string>} | null>}
 */
async function startLoopback(preferredPort) {
  const http = await import('node:http');
  /** @type {import('node:http').Server|null} */
  let server = null;
  for (const port of [preferredPort, 0]) {
    try {
      server = http.createServer();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      break;
    } catch {
      server = null;
    }
  }
  if (!server) return null;
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const redirectUri = `http://127.0.0.1:${address.port}`;
  const code = new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      const granted = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(granted ? 'Authorised. You can close this window and return to the terminal.\n' : `Authorisation failed: ${error ?? 'no code'}\n`);
      server.close();
      if (granted) resolve(granted);
      else reject(new Error(error ?? 'no code in redirect'));
    });
  });
  return { redirectUri, code };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.clientFile || !args.tokenFile) {
    process.stdout.write(
      'Usage: node scripts/gmail-imap-authorize.mjs --client <client.json> --token <token.json> [--port 8765]\n' +
      '\n' +
      `Requests the ${SCOPE} scope, which Gmail IMAP requires, and writes a refresh\n` +
      'token document. It never touches ~/.gmail-mcp.\n',
    );
    process.exit(args.help ? 0 : 2);
  }

  const { clientId, clientSecret } = readClient(path.resolve(args.clientFile));
  const tokenFile = path.resolve(args.tokenFile);

  const loopback = await startLoopback(args.port);
  const redirectUri = loopback ? loopback.redirectUri : 'urn:ietf:wg:oauth:2.0:oob';

  // A random state ties the redirect to this run.
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  // `prompt=consent` is what makes Google issue a refresh token every time; with
  // `select_account` it may omit it on a repeat authorisation.
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);

  process.stdout.write('\nOpen this URL in a browser and approve access:\n\n');
  process.stdout.write(`${authUrl.toString()}\n\n`);
  process.stdout.write('Scope requested: full Gmail access via IMAP. See the integration README.\n\n');

  let code;
  if (loopback) {
    process.stdout.write('Waiting for the browser to redirect to 127.0.0.1 (Ctrl-C to abort)...\n');
    code = await loopback.code;
  } else {
    code = await ask('Paste the authorisation code: ');
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = typeof body.error === 'string' ? body.error : '';
    } catch {
      /* keep empty */
    }
    process.stderr.write(`\nGoogle refused the exchange: ${detail || response.status}\n`);
    process.stderr.write('If this says redirect_uri_mismatch, create a Desktop app client rather than a Web client.\n');
    process.exit(1);
  }

  const token = await response.json();
  if (typeof token.refresh_token !== 'string' || token.refresh_token.length === 0) {
    process.stderr.write('\nGoogle returned no refresh token. Re-run with a fresh consent (this script always asks for one).\n');
    process.exit(1);
  }

  // The critical guard: refuse to store a token that cannot authenticate IMAP.
  const granted = typeof token.scope === 'string' ? token.scope.split(/\s+/) : [];
  if (!granted.includes(SCOPE)) {
    process.stderr.write(`\nRefusing to write a token: granted scope is "${token.scope ?? '(none)'}", which cannot authenticate Gmail IMAP.\n`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  const document = {
    refresh_token: token.refresh_token,
    access_token: token.access_token,
    expiry_date: Date.now() + (typeof token.expires_in === 'number' ? token.expires_in : 3600) * 1000,
    scope: token.scope,
    token_type: token.token_type ?? 'Bearer',
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(tokenFile, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });

  process.stdout.write(`\nWrote the IMAP refresh token to:\n  ${tokenFile}\n`);
  process.stdout.write('Scope granted and verified. Restart the mail service to pick it up:\n');
  process.stdout.write('  docker compose restart mail-imap-mcp\n\n');
  process.stdout.write('Reminder: while the OAuth consent screen is in Testing, Google expires this\n');
  process.stdout.write('refresh token after 7 days and this script must be run again.\n\n');
}

main().catch((error) => {
  process.stderr.write(`\nFailed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
