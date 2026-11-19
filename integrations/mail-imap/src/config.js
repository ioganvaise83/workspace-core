// Account configuration for the Universal Mail MCP.
//
// DESIGN RULES
// ------------
// * Provider endpoints come from a TRUSTED table in this file, never from the
//   domain part of a login. An unknown provider must state host and port
//   explicitly; nothing is guessed from an e-mail address.
// * Credentials never travel through CLI arguments, environment values or this
//   JSON document's visible fields when avoidable. Two forms are supported:
//     - `passwordFile`: one app password per account (Yandex, Mail.ru, any host);
//     - `oauth`: Gmail IMAP XOAUTH2, with its own client file and token file.
//   Every credential is a PATH here; the secret lives in the mounted file.
// * The file is read once at start and re-read on SIGHUP, so a running server
//   never observes a half-written configuration.
// * A broken entry disables THAT account only. It never prevents the process
//   from starting, because the harness must boot with zero configured accounts.
// * Folder roles (`archivePath`, `trashPath`) are explicit configuration, never
//   inferred from a folder's name. See folders.js for why.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Trusted provider table. `null` means "must be given explicitly". */
export const PROVIDERS = Object.freeze({
  yandex: { host: 'imap.yandex.ru', port: 993, secure: true },
  mailru: { host: 'imap.mail.ru', port: 993, secure: true },
  gmail: { host: 'imap.gmail.com', port: 993, secure: true },
  custom: { host: null, port: null, secure: true },
});

const OAuthSchema = z
  .object({
    /** Google "installed app" client JSON (client_id + client_secret). */
    clientFile: z.string().min(1).max(1024),
    /** Refresh-token document written by the one-time host authorisation. */
    tokenFile: z.string().min(1).max(1024),
  })
  .strict();

const AccountSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase letters, digits and dashes'),
    provider: z.string().min(1).max(32),
    displayName: z.string().min(1).max(120).optional(),
    user: z.string().min(1).max(320),
    host: z.string().min(1).max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    /** 'password' (app password) or 'xoauth2' (Gmail IMAP). */
    authType: z.enum(['password', 'xoauth2']).optional(),
    passwordFile: z.string().min(1).max(1024).optional(),
    password: z.string().min(1).max(1024).optional(),
    oauth: OAuthSchema.optional(),
    /** Explicit folder roles for writes. Absent means "resolve via SPECIAL-USE
     *  only, and refuse the operation if the server does not declare it". */
    archivePath: z.string().min(1).max(255).optional(),
    trashPath: z.string().min(1).max(255).optional(),
    /** Whether this account may perform write actions at all. */
    allowWrites: z.boolean().optional(),
    /** Optional per-account overrides; defaults come from the global config. */
    connectionTimeoutMs: z.number().int().min(1000).max(120000).optional(),
    socketTimeoutMs: z.number().int().min(5000).max(600000).optional(),
    /** Folders searched by default when a tool does not name one. */
    defaultFolder: z.string().min(1).max(255).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const wantsOAuth = a.authType === 'xoauth2' || a.oauth !== undefined;
    if (wantsOAuth) {
      if (a.oauth === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'xoauth2 accounts must declare oauth.clientFile and oauth.tokenFile' });
      }
      if (a.password !== undefined || a.passwordFile !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'xoauth2 accounts must not also carry a password' });
      }
      return;
    }
    if (Boolean(a.passwordFile) === Boolean(a.password)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'exactly one of passwordFile or password must be set' });
    }
  });

const RootSchema = z
  .object({
    version: z.number().int().min(1).max(1).optional(),
    defaults: z
      .object({
        connectionTimeoutMs: z.number().int().min(1000).max(120000).optional(),
        socketTimeoutMs: z.number().int().min(5000).max(600000).optional(),
        defaultFolder: z.string().min(1).max(255).optional(),
        maxResults: z.number().int().min(1).max(200).optional(),
        batchThreshold: z.number().int().min(1).max(50).optional(),
      })
      .strict()
      .optional(),
    accounts: z.array(AccountSchema).max(50).default([]),
  })
  .strict();

export const DEFAULTS = Object.freeze({
  connectionTimeoutMs: 20000,
  socketTimeoutMs: 60000,
  defaultFolder: 'INBOX',
  maxResults: 25,
  // Above this many messages in one plan, the owner's out-of-band approval is
  // mandatory regardless of the action.
  batchThreshold: 5,
});

/** Raised for a configuration problem that makes one account unusable. */
export class AccountConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccountConfigError';
    this.code = 'INVALID_ACCOUNT_CONFIG';
  }
}

/**
 * Resolve host/port/secure for an account.
 *
 * An explicit host wins. Otherwise the provider table must know the provider;
 * an unknown provider without a host is a configuration error rather than a DNS
 * guess, because guessing where credentials are sent is exactly the mistake the
 * brief forbids.
 *
 * @param {object} account validated account entry
 * @returns {{host: string, port: number, secure: boolean}}
 */
export function resolveEndpoint(account) {
  const known = PROVIDERS[account.provider];
  if (!known) {
    throw new AccountConfigError(
      `unknown provider "${account.provider}"; set host and port explicitly or use one of: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  const host = account.host ?? known.host;
  const port = account.port ?? known.port;
  const secure = account.secure ?? known.secure ?? true;
  if (!host || !port) {
    throw new AccountConfigError(
      `provider "${account.provider}" has no default endpoint; set host and port explicitly`,
    );
  }
  if (secure !== true) {
    throw new AccountConfigError('secure must stay true: this integration never opens a cleartext IMAP session');
  }
  return { host, port, secure };
}

/** Read one secret file without logging its contents. */
function readSecretFile(file, { baseDir } = {}) {
  const resolved = path.isAbsolute(file) ? file : path.resolve(baseDir ?? process.cwd(), file);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new AccountConfigError(`secret file is not readable: ${resolved}`);
  }
  if (!stat.isFile()) throw new AccountConfigError(`secret path is not a regular file: ${resolved}`);
  if (stat.size === 0) throw new AccountConfigError(`secret file is empty: ${resolved}`);
  if (stat.size > 8 * 1024) throw new AccountConfigError(`secret file is unexpectedly large: ${resolved}`);
  const value = fs.readFileSync(resolved, 'utf8').replace(/\r?\n$/, '');
  if (value.length === 0) throw new AccountConfigError(`secret file contains only whitespace: ${resolved}`);
  return value;
}

/**
 * Turn one validated entry into a runtime account. The password is resolved
 * eagerly so a missing secret is reported as that account's state, but it is
 * kept in a non-enumerable field and never serialised by JSON.stringify.
 */
function materialise(entry, defaults, baseDir) {
  const endpoint = resolveEndpoint(entry);
  const password = entry.passwordFile
    ? readSecretFile(entry.passwordFile, { baseDir })
    : entry.password;
  // An oauth account carries paths only; the token itself is read at connect
  // time so a rotated token needs no restart and never sits in this object.
  const authType = entry.authType === 'xoauth2' || entry.oauth !== undefined ? 'xoauth2' : 'password';
  const oauth = entry.oauth
    ? {
        clientFile: path.resolve(baseDir, entry.oauth.clientFile),
        tokenFile: path.resolve(baseDir, entry.oauth.tokenFile),
      }
    : null;
  const account = {
    id: entry.id,
    provider: entry.provider,
    displayName: entry.displayName ?? entry.user,
    user: entry.user,
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    authType,
    oauth,
    archivePath: entry.archivePath ?? null,
    trashPath: entry.trashPath ?? null,
    // Writes must be opted into per account, so adding an account for reading
    // never silently grants write access to it.
    allowWrites: entry.allowWrites === true,
    defaultFolder: entry.defaultFolder ?? defaults.defaultFolder ?? DEFAULTS.defaultFolder,
    connectionTimeoutMs: entry.connectionTimeoutMs ?? defaults.connectionTimeoutMs ?? DEFAULTS.connectionTimeoutMs,
    socketTimeoutMs: entry.socketTimeoutMs ?? defaults.socketTimeoutMs ?? DEFAULTS.socketTimeoutMs,
    maxResults: defaults.maxResults ?? DEFAULTS.maxResults,
    batchThreshold: defaults.batchThreshold ?? DEFAULTS.batchThreshold,
  };
  if (password !== undefined && password !== null) {
    Object.defineProperty(account, 'password', {
      value: password,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(account);
}

/**
 * Load accounts from a JSON file.
 *
 * Every returned account is usable; rejected entries are reported as errors so
 * the caller can expose them per account instead of failing the whole process.
 *
 * @param {string} file absolute path to the accounts file
 * @returns {{accounts: object[], errors: {id: string, message: string}[], source: string}}
 */
export function loadAccounts(file) {
  const errors = [];
  if (!file) return { accounts: [], errors, source: null };

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Absent configuration is a normal state, not a failure.
      return { accounts: [], errors, source: file };
    }
    return { accounts: [], errors: [{ id: '(file)', message: `cannot read accounts file: ${file}` }], source: file };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      accounts: [],
      errors: [{ id: '(file)', message: `accounts file is not valid JSON: ${file}` }],
      source: file,
    };
  }

  const validated = RootSchema.safeParse(parsed);
  if (!validated.success) {
    const detail = validated.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { accounts: [], errors: [{ id: '(file)', message: `invalid accounts file: ${detail}` }], source: file };
  }

  const baseDir = path.dirname(file);
  const defaults = validated.data.defaults ?? {};
  const accounts = [];
  const seen = new Set();
  for (const entry of validated.data.accounts) {
    if (seen.has(entry.id)) {
      errors.push({ id: entry.id, message: 'duplicate account id; the later entry is ignored' });
      continue;
    }
    seen.add(entry.id);
    try {
      accounts.push(materialise(entry, defaults, baseDir));
    } catch (error) {
      // Account-level failure: the id is still known so diagnostics can report it.
      errors.push({
        id: entry.id,
        message: error instanceof Error ? error.message : 'invalid account configuration',
      });
    }
  }
  return { accounts, errors, source: file };
}

/** Public, secret-free view of one account. */
export function describeAccount(account) {
  return {
    account_id: account.id,
    provider: account.provider,
    display_name: account.displayName,
    host: account.host,
    port: account.port,
    tls: true,
    auth_type: account.authType,
    user_masked: maskLogin(account.user),
    default_folder: account.defaultFolder,
    writes_allowed: account.allowWrites === true,
  };
}

/** `ivan.petrov@example.com` -> `iv***@example.com`; never the full mailbox. */
export function maskLogin(user) {
  const at = user.lastIndexOf('@');
  if (at <= 0) return user.length <= 2 ? '***' : `${user.slice(0, 1)}***`;
  const local = user.slice(0, at);
  const domain = user.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}
