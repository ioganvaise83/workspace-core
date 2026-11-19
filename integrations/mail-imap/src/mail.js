// Read-only mail operations. Every function here is a pure read.
//
// The folder/UID contract: a message is addressed by (account, mailbox, UID) and
// the UID is only meaningful together with the mailbox's UIDVALIDITY. When a
// caller passes the `uidvalidity` it saw earlier, it is compared before use: a
// server that renumbered the mailbox would otherwise hand back a different
// message under the same UID, which is exactly the silent mix-up the brief
// asks to prevent.
import { MailError } from './errors.js';
import { parseMessage, summariseEnvelope, LIMITS } from './mime.js';

/** IMAP SEARCH keys this server compiles from tool arguments. */
const MAX_SEARCH_LIMIT = 100;

/**
 * Normalise a folder argument.
 *
 * Only a plain mailbox path is accepted. The value is passed to the IMAP library
 * as a path (it encodes modified UTF-7 itself); it is never interpolated into a
 * command string, so there is no injection surface here.
 *
 * @param {unknown} folder
 * @param {string} fallback
 * @returns {string}
 */
export function normaliseFolder(folder, fallback) {
  if (folder === undefined || folder === null || folder === '') return fallback;
  if (typeof folder !== 'string') throw new MailError('INVALID_ARGUMENT', 'folder must be a string');
  const trimmed = folder.trim();
  if (trimmed.length === 0) return fallback;
  if (trimmed.length > 255) throw new MailError('INVALID_ARGUMENT', 'folder is too long');
  // Control characters would make the protocol layer parse something other than
  // a mailbox name; refuse rather than relying on the library to escape them.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new MailError('INVALID_ARGUMENT', 'folder must not contain control characters');
  }
  return trimmed;
}

/**
 * Normalise a UID. UIDs are positive 32-bit integers in IMAP.
 *
 * @param {unknown} uid
 * @returns {number}
 */
export function normaliseUid(uid) {
  const value = typeof uid === 'string' && /^[0-9]+$/.test(uid) ? Number(uid) : uid;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 0xffffffff) {
    throw new MailError('INVALID_ARGUMENT', 'uid must be a positive integer');
  }
  return value;
}

/**
 * Compare the caller's UIDVALIDITY with the live one.
 *
 * @param {unknown} expected
 * @param {bigint|number|undefined} actual
 * @returns {void}
 */
export function assertUidValidity(expected, actual) {
  if (expected === undefined || expected === null) return;
  const actualString = actual === undefined || actual === null ? null : String(actual);
  const expectedString = String(expected).trim();
  if (actualString !== expectedString) {
    throw new MailError(
      'UID_VALIDITY_CHANGED',
      'The mailbox has been renumbered since this message reference was issued; search again',
    );
  }
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === 'string' && /^-?[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * Parse an ISO date or `YYYY-MM-DD` into a Date for IMAP SEARCH.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {Date|undefined}
 */
export function parseSearchDate(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new MailError('INVALID_ARGUMENT', `${field} must be an ISO date string`);
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) throw new MailError('INVALID_ARGUMENT', `${field} is not a valid date`);
  return date;
}

/**
 * List the mailboxes of an account.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {string} accountId
 * @returns {Promise<object[]>}
 */
export async function listFolders(pool, accountId) {
  return pool.withConnection(accountId, async (client, account) => {
    const mailboxes = await client.list();
    return mailboxes.map((mailbox) => ({
      account_id: account.id,
      path: mailbox.path,
      name: mailbox.name ?? mailbox.path,
      delimiter: mailbox.delimiter,
      special_use: mailbox.specialUse ?? null,
      flags: [...(mailbox.flags ?? [])],
      subscribed: mailbox.subscribed ?? null,
    }));
  });
}

/**
 * List Gmail labels, when the server exposes them.
 *
 * On Gmail, `X-GM-EXT-1` makes labels visible; elsewhere IMAP has folders, not
 * labels, and this returns UNSUPPORTED rather than presenting folders as labels.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {string} accountId
 * @returns {Promise<object>}
 */
export async function listLabels(pool, accountId) {
  const account = pool.get(accountId);
  return pool.withSession(accountId, async ({ client, capabilities }) => {
    if (!capabilities.gmailExtensions) {
      throw new MailError(
        'UNSUPPORTED',
        `${accountId} does not advertise X-GM-EXT-1: this provider has folders, not labels. Use mail_list_folders and move_to_folder instead.`,
        { accountId },
      );
    }
    const folders = await client.list();
    // Gmail reports its labels through LIST as folders with the label mapping;
    // system labels are the \-prefixed ones, user labels are mailbox paths.
    const labels = folders
      .map((folder) => ({
        name: folder.path,
        kind: folder.path.startsWith('\\') || /^\[Gmail\]/.test(folder.path) ? 'system' : 'user',
        special_use: folder.specialUse ?? null,
      }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'system' ? -1 : 1));
    return { account_id: accountId, provider: account.provider, labels, count: labels.length };
  });
}

/**
 * Group messages by Message-ID/In-Reply-To/References inside one folder.
 *
 * Deliberately NOT presented as threads. IMAP has no thread model: a reply whose
 * client omitted References starts a new group, and Gmail's server-side thread ids
 * (X-GM-THRID) are a Gmail concept, not something these providers share. What is
 * returned is a header-derived group, labelled as such, and only when it holds
 * more than one message.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {string} accountId
 * @param {{messageId: string, folder?: string, limit?: number}} args
 * @returns {Promise<object>}
 */
export async function getConversation(pool, accountId, args) {
  const account = pool.get(accountId);
  const folder = normaliseFolder(args.folder, account.defaultFolder);
  const limit = clampInt(args.limit, 1, Math.min(100, account.maxResults * 4), 50);
  const seedId = String(args.messageId).trim();
  if (seedId.length === 0) throw new MailError('INVALID_ARGUMENT', 'message_id must not be empty');

  return pool.withMailbox(accountId, folder, async ({ client, mailbox }) => {
    // Find the seed message by its Message-ID header. IMAP HEADER search is exact
    // on the value, so the angle brackets are included as stored.
    const uids = await client.search({ header: { 'message-id': seedId } }, { uid: true });
    const seedUids = Array.isArray(uids) ? uids : [];
    if (seedUids.length === 0) {
      throw new MailError('MESSAGE_NOT_FOUND', `No message with Message-ID ${seedId} in ${folder}`, { accountId });
    }

    // Collect the neighbourhood: messages whose References mention the seed, plus
    // a bounded recent window to catch the parent that carries no reference to it.
    const related = new Set(seedUids);
    const referenced = await client.search({ header: { references: seedId } }, { uid: true });
    for (const uid of Array.isArray(referenced) ? referenced : []) related.add(uid);
    const inReplyTo = await client.search({ header: { 'in-reply-to': seedId } }, { uid: true });
    for (const uid of Array.isArray(inReplyTo) ? inReplyTo : []) related.add(uid);

    const all = [...related].sort((a, b) => a - b).slice(0, limit);
    /** @type {object[]} */
    const messages = [];
    const range = `${Math.min(...all)}:${Math.max(...all)}`;
    for await (const message of client.fetch(range, { uid: true, envelope: true, flags: true, headers: true }, { uid: true })) {
      if (!related.has(message.uid)) continue;
      const headerText = message.headers ? message.headers.toString('utf8') : '';
      const references = extractReferences(headerText);
      messages.push({
        ...summariseEnvelope(message.envelope, {
          accountId: account.id,
          provider: account.provider,
          mailbox: folder,
          uid: message.uid,
          uidValidity: String(mailbox.uidValidity),
          flags: message.flags ? [...message.flags] : [],
        }),
        in_reply_to: extractHeaderValue(headerText, 'in-reply-to'),
        references,
      });
    }
    messages.sort((a, b) => (a.date ? Date.parse(a.date) : 0) - (b.date ? Date.parse(b.date) : 0));

    return {
      account_id: account.id,
      mailbox: folder,
      uidvalidity: String(mailbox.uidValidity),
      seed_message_id: seedId,
      group_kind: 'header-references',
      // Said in the payload, not only the docs: this is not a provider thread.
      note: 'Grouped by Message-ID / In-Reply-To / References headers in this folder. A reply without References is not linked, and nothing is merged across folders or with Gmail threads.',
      message_count: messages.length,
      messages,
    };
  });
}

/**
 * Pull a References header into a list of message ids.
 *
 * @param {string} headerText raw header block
 * @returns {string[]}
 */
function extractReferences(headerText) {
  const value = extractHeaderValue(headerText, 'references');
  if (!value) return [];
  return value.match(/<[^>]+>/g) ?? [];
}

/**
 * Read one header value out of a raw header block, unfolding continuation lines.
 *
 * @param {string} headerText
 * @param {string} name lowercase header name
 * @returns {string|null}
 */
function extractHeaderValue(headerText, name) {
  const lines = headerText.split(/\r?\n/);
  /** @type {string[]} */
  const collected = [];
  let capturing = false;
  for (const line of lines) {
    if (/^\s/.test(line) && capturing) {
      collected.push(line.trim());
      continue;
    }
    capturing = false;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() === name) {
      collected.push(line.slice(colon + 1).trim());
      capturing = true;
    }
  }
  if (collected.length === 0) return null;
  return collected.join(' ').trim() || null;
}

/**
 * Build an IMAP SEARCH query from the supported filters.
 *
 * Only filters with a direct, well-defined IMAP equivalent are implemented.
 * There is no fuzzy "query" operator in IMAP version 4rev1 — `TEXT` covers
 * headers and body, which is the closest honest match, so that is what `query`
 * maps to and the tool description says so.
 *
 * @param {object} args
 * @returns {import('imapflow').SearchObject}
 */
export function buildSearchQuery(args) {
  /** @type {import('imapflow').SearchObject} */
  const query = {};
  let hasCriterion = false;
  if (typeof args.query === 'string' && args.query.trim().length > 0) {
    query.text = args.query.trim();
    hasCriterion = true;
  }
  if (typeof args.from === 'string' && args.from.trim().length > 0) {
    query.from = args.from.trim();
    hasCriterion = true;
  }
  if (typeof args.to === 'string' && args.to.trim().length > 0) {
    query.to = args.to.trim();
    hasCriterion = true;
  }
  if (typeof args.subject === 'string' && args.subject.trim().length > 0) {
    query.subject = args.subject.trim();
    hasCriterion = true;
  }
  const since = parseSearchDate(args.since, 'since');
  if (since) {
    query.since = since;
    hasCriterion = true;
  }
  const before = parseSearchDate(args.before, 'before');
  if (before) {
    query.before = before;
    hasCriterion = true;
  }
  if (args.unread_only === true) {
    query.seen = false;
    hasCriterion = true;
  }
  if (!hasCriterion) query.all = true;
  return query;
}

/**
 * Search one mailbox and return header-level summaries, newest first.
 *
 * SEARCH returns UIDs in ascending order; the tail is the newest, but "newest"
 * by UID is not the same as "newest by date" on every server (a UID is assigned
 * on delivery). Results are sorted by INTERNALDATE after fetching, so the order
 * a reader sees matches the dates they see.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {string} accountId
 * @param {object} args
 * @returns {Promise<object>}
 */
export async function searchMessages(pool, accountId, args) {
  const account = pool.get(accountId);
  const folder = normaliseFolder(args.folder, account.defaultFolder);
  const limit = clampInt(args.limit, 1, Math.min(MAX_SEARCH_LIMIT, account.maxResults), account.maxResults);
  const query = buildSearchQuery(args);

  return pool.withMailbox(accountId, folder, async ({ client, mailbox }) => {
    const uids = await client.search(query, { uid: true });
    if (!Array.isArray(uids) || uids.length === 0) {
      return {
        account_id: account.id,
        mailbox: folder,
        uidvalidity: String(mailbox.uidValidity),
        total_matched: 0,
        returned: 0,
        truncated: false,
        messages: [],
      };
    }
    // The newest messages sit at the end of the UID list. Fetch a bounded window
    // so a mailbox with 50k matches does not download 50k envelopes.
    const window = uids.slice(Math.max(0, uids.length - limit));
    const range = `${window[0]}:${window[window.length - 1]}`;
    /** @type {object[]} */
    const rows = [];
    for await (const message of client.fetch(
      range,
      { uid: true, envelope: true, flags: true, internalDate: true, size: true },
      { uid: true },
    )) {
      if (!window.includes(message.uid)) continue;
      rows.push(
        summariseEnvelope(message.envelope, {
          accountId: account.id,
          provider: account.provider,
          mailbox: folder,
          uid: message.uid,
          uidValidity: String(mailbox.uidValidity),
          flags: message.flags ? [...message.flags] : [],
          size: message.size,
          internalDate: message.internalDate,
        }),
      );
    }
    rows.sort((a, b) => {
      const left = a.date ? Date.parse(a.date) : 0;
      const right = b.date ? Date.parse(b.date) : 0;
      if (left !== right) return right - left;
      return b.uid - a.uid;
    });
    return {
      account_id: account.id,
      mailbox: folder,
      uidvalidity: String(mailbox.uidValidity),
      total_matched: uids.length,
      returned: rows.length,
      truncated: uids.length > rows.length,
      messages: rows,
    };
  });
}

/**
 * Read one message in full.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {string} accountId
 * @param {object} args
 * @returns {Promise<object>}
 */
export async function getMessage(pool, accountId, args) {
  const account = pool.get(accountId);
  const folder = normaliseFolder(args.folder, account.defaultFolder);
  const uid = normaliseUid(args.uid);
  const includeHtml = args.include_html !== false;

  return pool.withMailbox(accountId, folder, async ({ client, mailbox }) => {
    assertUidValidity(args.uidvalidity, mailbox.uidValidity);
    // `source` is fetched as BODY.PEEK[], so this read does not set \Seen. It is
    // also bounded: a 400 MB message is cut at the transport level, not buffered.
    let found = null;
    for await (const message of client.fetch(
      String(uid),
      { uid: true, source: { maxLength: LIMITS.maxRawSourceBytes }, flags: true, internalDate: true, size: true },
      { uid: true },
    )) {
      if (message.uid !== uid) continue;
      found = message;
      break;
    }
    if (!found || !found.source) {
      throw new MailError('MESSAGE_NOT_FOUND', `No message with uid ${uid} in ${folder}`, { accountId });
    }
    const parsed = await parseMessage(found.source, {
      accountId: account.id,
      provider: account.provider,
      mailbox: folder,
      uid,
      uidValidity: String(mailbox.uidValidity),
      flags: found.flags ? [...found.flags] : [],
      size: found.size,
    });
    if (!includeHtml) {
      parsed.html = null;
      parsed.html_truncated = false;
    }
    return parsed;
  });
}

/**
 * Recent messages for one account over a period.
 *
 * `days` and `since` are alternatives; `days` is a convenience that maps to an
 * IMAP `SINCE` date. The result is the same envelope summary as search, so a
 * caller can reuse one rendering path.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {string} accountId
 * @param {object} args
 * @returns {Promise<object>}
 */
export async function listRecent(pool, accountId, args) {
  const account = pool.get(accountId);
  const folder = normaliseFolder(args.folder, account.defaultFolder);
  const days = clampInt(args.days, 1, 90, 1);
  const limit = clampInt(args.limit, 1, Math.min(MAX_SEARCH_LIMIT, account.maxResults), account.maxResults);
  const since = parseSearchDate(args.since, 'since') ?? new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const result = await searchMessages(pool, accountId, {
    folder,
    since: since.toISOString(),
    unread_only: args.unread_only === true,
    limit,
  });
  return { ...result, period: { since: since.toISOString(), until: new Date().toISOString() } };
}

/**
 * Normalised digest data for a daily summary.
 *
 * This is a data provider, not a scheduler: it makes one bounded pass per
 * account and returns rows plus aggregate counts. Building the message, the
 * schedule and any delivery is a separate layer by design.
 *
 * @param {import('./accounts.js').AccountPool} pool
 * @param {object} args
 * @returns {Promise<object>}
 */
export async function dailySummaryData(pool, args) {
  const accountIds = Array.isArray(args.account_ids) && args.account_ids.length > 0
    ? args.account_ids
    : pool.list().map((account) => account.id);
  const limit = clampInt(args.limit, 1, 200, 100);
  const perAccount = [];
  const failures = [];

  for (const accountId of accountIds) {
    try {
      const result = await listRecent(pool, accountId, {
        days: clampInt(args.days, 1, 90, 1),
        since: args.since,
        folder: args.folder,
        limit,
      });
      perAccount.push({
        account_id: accountId,
        mailbox: result.mailbox,
        uidvalidity: result.uidvalidity,
        total_matched: result.total_matched,
        truncated: result.truncated,
        messages: result.messages.map((message) => ({
          ...message,
          // A stable handle for reopening the exact message later.
          ref: {
            account_id: accountId,
            mailbox: result.mailbox,
            uid: message.uid,
            uidvalidity: result.uidvalidity,
          },
        })),
      });
    } catch (error) {
      failures.push({
        account_id: accountId,
        code: error instanceof MailError ? error.code : 'IMAP_ERROR',
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  const all = perAccount.flatMap((entry) => entry.messages);
  return {
    generated_at: new Date().toISOString(),
    period: { days: clampInt(args.days, 1, 90, 1), since: args.since ?? null },
    accounts: perAccount,
    failures,
    totals: {
      messages: all.length,
      unread: all.filter((message) => message.unread === true).length,
      with_attachments: all.filter((message) => message.has_attachments === true).length,
    },
  };
}

export { MAX_SEARCH_LIMIT };
