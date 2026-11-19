// Test harness: a scriptable in-memory IMAP server over real TLS.
//
// WHY A REAL SERVER
// -----------------
// The property under test is "reading a message does not change its flags on the
// server". A stub cannot prove that: it would only prove our own mock agrees
// with our own code. imapkit implements IMAP4rev1 strictly over a real socket,
// records the exact command stream, and lets a test read the flags back out of
// band through its control API. That is what makes the read-only claim testable
// without a live mailbox.
//
// TLS: a self-signed certificate for localhost is generated per run into a
// temporary directory. It is trusted explicitly by the client under test, so TLS
// verification stays ENABLED (a test that disables verification would not prove
// the production path).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import imapkit from 'imapkit';

/** Credentials used by every test account. Not a secret: mock server only. */
export const TEST_USER = 'testuser';
export const TEST_PASSWORD = 'testpass';

/**
 * Generate a throwaway certificate/key pair for 127.0.0.1.
 *
 * @param {string} dir
 * @returns {{cert: string, key: string}}
 */
function generateCertificate(dir) {
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '2',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), certPath, keyPath };
}

/**
 * A legacy XLIST plugin, imitating Yandex and Mail.ru.
 *
 * WHY THIS EXISTS
 * ---------------
 * Those providers advertise the Gmail-era `XLIST` extension and NOT RFC 6154
 * `SPECIAL-USE`, and imapflow 2.12.1 picks the listing verb from exactly that:
 *
 *     const listCommand = connection.capabilities.has('XLIST') &&
 *         !hasCapability(connection, 'SPECIAL-USE') ? 'XLIST' : 'LIST';
 *
 * So a server that advertises XLIST forces the client to send XLIST, which is how
 * the command-policy bug turned into "Yandex is unreachable". A real server that
 * behaves this way is the only way to test the fix at the interception layer:
 * a test that merely calls exec('XLIST') would prove the allowlist entry exists
 * but not that imapflow actually produces that command.
 *
 * The plugin answers `XLIST` with `* XLIST (<flags>) "<delimiter>" "<name>"`
 * lines for every mailbox, and tags INBOX with \Inbox as the extension specifies.
 *
 * @param {object} server imapkit server instance
 */
function xlistPlugin(server) {
  server.registerCapability('XLIST');
  const coreList = server.getCommandHandler('LIST');
  server.setCommandHandler('XLIST', (connection, parsed, data, callback) => {
    // Validate the two astring arguments exactly as LIST does, so a malformed
    // command fails the same way and the client sees a real protocol error.
    if (
      !parsed.attributes ||
      parsed.attributes.length !== 2 ||
      ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0] && parsed.attributes[0].type) < 0 ||
      ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[1] && parsed.attributes[1].type) < 0
    ) {
      connection.send(
        { tag: parsed.tag, command: 'BAD', attributes: [{ type: 'TEXT', value: 'XLIST expects 2 string arguments' }] },
        'INVALID COMMAND',
        parsed,
        data,
      );
      return callback();
    }
    const folders = server.matchFolders(
      parsed.attributes[0].value,
      parsed.attributes[1].value,
      (mailboxPath) => connection.exportMailboxName(mailboxPath),
    );
    for (const folder of folders) {
      const flags = [].concat(folder.flags || []);
      // The XLIST convention: INBOX is distinguished by the \Inbox flag.
      if (String(folder.path).toUpperCase() === 'INBOX') flags.push('\\Inbox');
      connection.send(
        {
          tag: '*',
          command: 'XLIST',
          attributes: [
            flags.map((flag) => ({ type: 'ATOM', value: flag })),
            server.getSeparator(folder),
            connection.exportMailboxName(folder.path),
          ],
        },
        'XLIST ITEM',
        parsed,
        data,
        folder,
      );
    }
    connection.send(
      { tag: parsed.tag, command: 'OK', attributes: [{ type: 'TEXT', value: 'Completed' }] },
      'XLIST',
      parsed,
      data,
    );
    return callback();
  });
  // LIST stays available for clients that do not care about XLIST.
  server.setCommandHandler('LIST', coreList);
}

/**
 * Start a mock IMAP server with implicit TLS.
 *
 * @param {object} [options]
 * @param {Record<string, object>} [options.storage] mailbox tree
 * @param {boolean} [options.xlist] advertise legacy XLIST and withhold SPECIAL-USE,
 *   the way Yandex and Mail.ru do
 * @param {(ctx: {server: object, cert: Buffer, port: number, tempDir: string, commands: () => object[], flagsOf: (mailbox: string, uid: number) => string[]|null, stop: () => Promise<void>}) => Promise<void>} [options.run]
 * @returns {Promise<object>} harness handle
 */
export async function startMockServer(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-imap-test-'));
  const { cert, key } = generateCertificate(tempDir);

  const storage = options.storage ?? { INBOX: {} };
  // A test may set its own password so a run can prove that a REAL secret value
  // never reaches the logs; the default keeps the common case simple.
  const password = options.password ?? TEST_PASSWORD;
  // XLIST and SPECIAL-USE are mutually exclusive on purpose: imapflow prefers
  // XLIST only when SPECIAL-USE is absent, which is exactly the Yandex/Mail.ru
  // situation this harness reproduces.
  const basePlugins = options.plugins ?? ['STARTTLS', 'MOVE', 'UIDPLUS'];
  const plugins = options.xlist ? [...basePlugins.filter((plugin) => plugin !== 'SPECIAL-USE'), xlistPlugin] : basePlugins;
  const server = imapkit({
    tls: { port: 0, host: '127.0.0.1' },
    credentials: { key, cert },
    storage,
    users: {
      [TEST_USER]: {
        password,
        // Present only when the XOAUTH2 plugin is loaded; an access token that
        // matches this value authenticates over AUTHENTICATE XOAUTH2.
        ...(options.accessToken ? { xoauth2: { accessToken: options.accessToken } } : {}),
      },
    },
    ...(options.oauth ? { oauth: options.oauth } : {}),
    // IDLE is not loaded on purpose: this integration never idles, and a server
    // without it proves the client does not depend on that extension. MOVE is
    // loaded by default because organising mail needs it; a test that needs the
    // "no MOVE" behaviour passes an explicit plugin list.
    plugins,
    maxLiteralSize: 64 * 1024 * 1024,
  });

  /** @type {{command: string, status: string}[]} */
  const commands = [];
  server.on('command', (event) => {
    commands.push({ command: event.command, status: event.status, tag: event.tag });
  });

  await server.start(0, '127.0.0.1');
  const port = server.tlsServer.address().port;

  /**
   * Read the live flags of one message straight from the server's own store,
   * bypassing IMAP entirely — this is the independent observer.
   *
   * @param {string} mailbox
   * @param {number} uid
   * @returns {string[]|null}
   */
  const flagsOf = (mailbox, uid) => {
    try {
      const message = server.control.getMessage(mailbox, uid);
      return message ? [...message.flags] : null;
    } catch {
      return null;
    }
  };

  const handle = {
    server,
    cert,
    port,
    tempDir,
    user: TEST_USER,
    password,
    commands: () => [...commands],
    flagsOf,
    /** @param {string} mailbox @param {object} message */
    addMessage: (mailbox, message) => server.control.addMessage(mailbox, message),
    listMessages: (mailbox) => server.control.listMessages(mailbox),
    async stop() {
      await server.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
  return handle;
}

/**
 * Run a body with a mock server, always tearing it down.
 *
 * @param {object} options
 * @param {Parameters<typeof startMockServer>[0]} [options.server]
 * @param {(harness: Awaited<ReturnType<typeof startMockServer>>) => Promise<void>} body
 */
export async function withMockServer(options, body) {
  const harness = await startMockServer(options);
  try {
    return await body(harness);
  } finally {
    await harness.stop();
  }
}

/**
 * Write an accounts file for the harness and return its path.
 *
 * The password is written to a SEPARATE file and referenced with `passwordFile`,
 * which is the production form: it exercises the secret-file path rather than the
 * plain `password` field.
 *
 * @param {string} dir
 * @param {{id: string, provider?: string, host?: string, port: number, user?: string, password?: string, defaultFolder?: string}[]} accounts
 * @returns {string} path to accounts.json
 */
export function writeAccountsFile(dir, accounts) {
  const dirPath = path.resolve(dir);
  fs.mkdirSync(dirPath, { recursive: true });
  const entries = accounts.map((account) => {
    const secretName = `${account.id}.secret`;
    fs.writeFileSync(path.join(dirPath, secretName), `${account.password ?? TEST_PASSWORD}\n`, { mode: 0o600 });
    /** @type {Record<string, unknown>} */
    const entry = {
      id: account.id,
      provider: account.provider ?? 'custom',
      displayName: account.displayName ?? account.id,
      user: account.user ?? TEST_USER,
      host: account.host ?? '127.0.0.1',
      port: account.port,
      secure: true,
      defaultFolder: account.defaultFolder ?? 'INBOX',
    };
    // OAuth accounts carry paths, not a password file.
    if (account.authType === 'xoauth2') {
      entry.authType = 'xoauth2';
      entry.oauth = account.oauth;
    } else {
      entry.passwordFile = secretName;
    }
    if (account.allowWrites !== undefined) entry.allowWrites = account.allowWrites;
    if (account.archivePath !== undefined) entry.archivePath = account.archivePath;
    if (account.trashPath !== undefined) entry.trashPath = account.trashPath;
    return entry;
  });
  const file = path.join(dirPath, 'accounts.json');
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, accounts: entries }, null, 2)}\n`);
  return file;
}

/**
 * Collect every line a function writes to stdout/stderr while it runs.
 *
 * Used by the "no secrets in logs" test: assertions must look at what was
 * actually emitted, not at what the code intended to emit.
 *
 * @param {() => Promise<T>} run
 * @returns {Promise<{result: T, output: string}>}
 * @template T
 */
export async function captureOutput(run) {
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  let buffer = '';
  /** @param {unknown} chunk @param {unknown} _encoding @param {unknown} callback */
  const capture = (chunk, _encoding, callback) => {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (typeof _encoding === 'function') _encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };
  // @ts-expect-error deliberate monkey-patch for the duration of one test
  process.stdout.write = capture;
  // @ts-expect-error see above
  process.stderr.write = capture;
  try {
    const result = await run();
    return { result, output: buffer };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

/** Build a minimal RFC822 message fixture without any personal content. */
export const FIXTURES = Object.freeze({
  plainEnglish: [
    'From: Alice Sender <alice@example.com>',
    'To: testuser@example.com',
    'Subject: Plain english subject',
    'Date: Tue, 18 Nov 2026 09:00:00 +0300',
    'Message-ID: <plain-1@example.com>',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    'Body of the plain message.',
    '',
  ].join('\r\n'),

  /**
   * A windows-1251 body with a mixed encoded-word subject. Exercises the exact
   * combination that breaks naive decoders: a UTF-8 From, a cp1251 Subject and
   * a cp1251 body, with non-ASCII bytes that are invalid as UTF-8.
   *
   * The B-encoded subject is cp1251 too (base64 of CF F0 E8 E2 E5 F2 20 EC E8
   * F0 = "Привет мир"), not UTF-8 inside a cp1251 word — that mixture is the
   * classic bug this fixture exists to catch, in the fixture first of all.
   */
  cyrillicCp1251: Buffer.concat([
    Buffer.from(
      [
        'From: =?UTF-8?B?0JjQstCw0L0g0J/QtdGC0YDQvtCy?= <ivan@example.com>',
        'To: testuser@example.com',
        'Subject: =?windows-1251?B?z/Do4uXyIOzo8A==?=',
        'Date: Tue, 18 Nov 2026 10:30:00 +0300',
        'Message-ID: <cyr-1@example.com>',
        'Content-Type: text/plain; charset=windows-1251',
        'Content-Transfer-Encoding: 8bit',
        '',
        '',
      ].join('\r\n'),
      'latin1',
    ),
    // "Привет мир" in windows-1251: 0xCF 0xF0 0xE8 0xE2 0xE5 0xF2 0x20 0xEC 0xE8 0xF0
    Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0xec, 0xe8, 0xf0]),
    Buffer.from('\r\n', 'latin1'),
  ]),

  /** multipart/alternative with both a text and an HTML part. */
  multipart: [
    'From: Bob <bob@example.com>',
    'To: testuser@example.com, carol@example.com',
    'Cc: dave@example.com',
    'Subject: Multipart message',
    'Date: Tue, 18 Nov 2026 11:00:00 +0000',
    'Message-ID: <multi-1@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="BOUNDARY-1"',
    '',
    '--BOUNDARY-1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Plain alternative body.',
    '--BOUNDARY-1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><p>HTML alternative body.</p></body></html>',
    '--BOUNDARY-1--',
    '',
  ].join('\r\n'),

  /** multipart/mixed carrying a binary attachment. */
  withAttachment: [
    'From: Carol <carol@example.com>',
    'To: testuser@example.com',
    'Subject: Message with attachment',
    'Date: Tue, 18 Nov 2026 12:00:00 +0000',
    'Message-ID: <att-1@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUNDARY-2"',
    '',
    '--BOUNDARY-2',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'See the attached report.',
    '--BOUNDARY-2',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSL0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp4nDPQM1Qo5ypUMFAwALJMLU31jBQsTAz1LBSKUrnCtRTyuQIVFLzDFHwUAMoQClAK',
    '',
    '--BOUNDARY-2--',
    '',
  ].join('\r\n'),

  /** An executable-looking attachment: metadata only, never opened. */
  withExecutableAttachment: [
    'From: Mallory <mallory@example.com>',
    'To: testuser@example.com',
    'Subject: Invoice',
    'Date: Tue, 18 Nov 2026 13:00:00 +0000',
    'Message-ID: <exe-1@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="BOUNDARY-3"',
    '',
    '--BOUNDARY-3',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please open the attached invoice.',
    '--BOUNDARY-3',
    'Content-Type: application/octet-stream; name="invoice.exe"',
    'Content-Disposition: attachment; filename="invoice.exe"',
    'Content-Transfer-Encoding: base64',
    '',
    'TVqQAAMAAAAEAAAA//8AALgAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '',
    '--BOUNDARY-3--',
    '',
  ].join('\r\n'),
});

/** Build a larger message for the size-limit test. */
export function bigMessage(bytes = 300 * 1024) {
  const body = 'x'.repeat(bytes);
  return [
    'From: Big <big@example.com>',
    'To: testuser@example.com',
    'Subject: Large message',
    'Date: Tue, 18 Nov 2026 14:00:00 +0000',
    'Message-ID: <big-1@example.com>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n');
}
