// Folder and capability discovery.
//
// THE RULE THIS FILE EXISTS TO ENFORCE
// ------------------------------------
// Mail folders are not standardised. `Archive` exists on Yandex and Mail.ru but
// not on Gmail; Gmail calls trash `[Gmail]/Trash`; a Cyrillic localisation calls
// it `Корзина`. Guessing a folder name for a WRITE operation is how mail ends up
// in the wrong place or, worse, is copied into a folder that gets auto-purged.
//
// So:
//   * a special folder is resolved from the server's own SPECIAL-USE attributes
//     (RFC 6154) first, then from explicit configuration, and
//   * if neither says where it is, the operation is refused with
//     `NOT_CONFIGURED` rather than guessed.
//
// Reads against INBOX are the one exception: INBOX is guaranteed to exist by
// RFC 3501, so it needs no discovery.
import { MailError } from './errors.js';

/** RFC 6154 special-use attributes, plus the ones servers commonly add. */
export const SPECIAL_USE = Object.freeze({
  ARCHIVE: '\\Archive',
  ALL: '\\All',
  DRAFTS: '\\Drafts',
  FLAGGED: '\\Flagged',
  JUNK: '\\Junk',
  SENT: '\\Sent',
  TRASH: '\\Trash',
});

/**
 * Read the folder layout of one account.
 *
 * @param {import('imapflow').ImapFlow} client connected, not necessarily selected
 * @returns {Promise<{path: string, name: string, delimiter: string|null, specialUse: string|null, flags: string[], subscribed: boolean|null}[]>}
 */
export async function listFolderRecords(client) {
  const mailboxes = await client.list();
  return mailboxes.map((mailbox) => ({
    path: mailbox.path,
    name: mailbox.name ?? mailbox.path,
    delimiter: mailbox.delimiter ?? null,
    specialUse: mailbox.specialUse ?? null,
    // \Noselect means the name exists as a hierarchy node but cannot hold mail.
    // Treating it as a destination would make a move fail confusingly.
    flags: [...(mailbox.flags ?? [])],
    selectable: ![...(mailbox.flags ?? [])].some((flag) => String(flag).toUpperCase() === '\\NOSELECT'),
    subscribed: mailbox.subscribed ?? null,
  }));
}

/**
 * Find the folder serving a special role.
 *
 * Order: server-declared SPECIAL-USE, then an explicitly configured path, then a
 * hard-coded role for INBOX. No heuristics on the name: a folder literally named
 * "Archive" that the server does not mark as `\Archive` is NOT used, because on
 * some hosts such a folder is a local folder that is not archived at all.
 *
 * @param {object[]} folders from listFolderRecords
 * @param {string} role one of SPECIAL_USE values
 * @param {{configuredPath?: string|null}} [options]
 * @returns {{path: string, source: 'special-use'|'configured'|'implicit'} | null}
 */
export function resolveSpecialFolder(folders, role, options = {}) {
  const wanted = role.toUpperCase();
  const bySpecialUse = folders.find(
    (folder) => typeof folder.specialUse === 'string' && folder.specialUse.toUpperCase() === wanted && folder.selectable,
  );
  if (bySpecialUse) return { path: bySpecialUse.path, source: 'special-use' };

  const configured = options.configuredPath;
  if (typeof configured === 'string' && configured.length > 0) {
    const match = folders.find((folder) => folder.path === configured);
    if (match) return { path: match.path, source: 'configured' };
    // Configured but absent: report it rather than silently picking another.
    return null;
  }
  return null;
}

/**
 * Resolve the folder a message should be archived into.
 *
 * Gmail has no archive folder: archiving means removing the `\Inbox` label. Every
 * other provider archives by moving the message into an existing archive folder.
 * The distinction is returned, not assumed, so the caller can pick the right
 * mechanism and refuse when it is unavailable.
 *
 * @param {object} params
 * @param {string} params.provider
 * @param {object[]} params.folders
 * @param {boolean} params.gmailExtensions // server advertises X-GM-EXT-1
 * @param {string|null} [params.configuredArchivePath]
 * @returns {{kind: 'gmail-label'|'folder', path?: string, source?: string} | null}
 */
export function resolveArchiveTarget({ provider, folders, gmailExtensions, configuredArchivePath = null }) {
  if (provider === 'gmail' && gmailExtensions) {
    // Archive on Gmail = remove \Inbox. This is the documented behaviour of
    // "Archive" in every Gmail client, and it keeps the message in All Mail with
    // its other labels intact. Copying it elsewhere would duplicate it.
    return { kind: 'gmail-label' };
  }
  const resolved = resolveSpecialFolder(folders, SPECIAL_USE.ARCHIVE, { configuredPath: configuredArchivePath });
  if (resolved) return { kind: 'folder', path: resolved.path, source: resolved.source };

  const all = resolveSpecialFolder(folders, SPECIAL_USE.ALL, { configuredPath: configuredArchivePath });
  if (all) return { kind: 'folder', path: all.path, source: all.source };
  return null;
}

/**
 * Resolve the folder that serves as trash.
 *
 * Moving to trash must land in the provider's own trash so the provider's
 * retention rules apply. A folder that merely looks like trash is not enough.
 *
 * @param {object[]} folders
 * @param {string|null} [configuredTrashPath]
 * @returns {{path: string, source: string} | null}
 */
export function resolveTrashTarget(folders, configuredTrashPath = null) {
  return resolveSpecialFolder(folders, SPECIAL_USE.TRASH, { configuredPath: configuredTrashPath });
}

/**
 * Assemble the capability profile of one session.
 *
 * This is what "provider differences only at the IMAP capability level" means in
 * practice: the same code asks these questions of every server and never branches
 * on the provider's marketing name for a behaviour it can detect.
 *
 * @param {import('imapflow').ImapFlow} client
 * @param {object} account
 * @returns {{
 *   uidPlus: boolean,
 *   move: boolean,
 *   gmailExtensions: boolean,
 *   condstore: boolean,
 *   specialUse: boolean,
 *   utf8Accept: boolean,
 *   authMethod: string,
 * }}
 */
export function sessionCapabilities(client, account) {
  const has = (name) => client.capabilities instanceof Map && client.capabilities.has(name);
  return {
    uidPlus: has('UIDPLUS'),
    // Without MOVE, imapflow silently emulates it with COPY + \Deleted + EXPUNGE.
    // EXPUNGE is forbidden, so the caller must see this and refuse instead.
    move: has('MOVE'),
    gmailExtensions: has('X-GM-EXT-1'),
    condstore: has('CONDSTORE') || (client.enabled instanceof Set && client.enabled.has('CONDSTORE')),
    specialUse: has('SPECIAL-USE') || has('LIST-EXTENDED'),
    utf8Accept: client.enabled instanceof Set && client.enabled.has('UTF8=ACCEPT'),
    authMethod: account.authType === 'xoauth2' ? 'XOAUTH2' : 'LOGIN',
  };
}

/**
 * Explain why an archive operation is impossible, for the error message.
 *
 * @param {string} provider
 * @returns {string}
 */
export function archiveUnavailableReason(provider) {
  if (provider === 'gmail') {
    return 'This Gmail account does not advertise X-GM-EXT-1, so archiving by removing the \\Inbox label is unavailable. Set archivePath explicitly or use a move.';
  }
  return 'No folder is marked \\Archive (RFC 6154) on this server, and no archivePath is configured. Set "archivePath" for this account in accounts.json to the exact folder path; nothing is guessed.';
}

/**
 * Build the folder map a tool result reports.
 *
 * @param {object} params
 * @param {object[]} params.folders
 * @param {string} params.provider
 * @param {boolean} params.gmailExtensions
 * @param {string|null} [params.configuredArchivePath]
 * @param {string|null} [params.configuredTrashPath]
 * @returns {object}
 */
export function describeLayout({ folders, provider, gmailExtensions, configuredArchivePath = null, configuredTrashPath = null }) {
  const archive = resolveArchiveTarget({ provider, folders, gmailExtensions, configuredArchivePath });
  const trash = resolveTrashTarget(folders, configuredTrashPath);
  const special = (role) => resolveSpecialFolder(folders, role)?.path ?? null;
  return {
    archive: archive ? (archive.kind === 'gmail-label' ? '(Gmail: remove \\Inbox label)' : archive.path) : null,
    archive_source: archive ? archive.source ?? 'gmail-extension' : null,
    trash: trash?.path ?? null,
    trash_source: trash?.source ?? null,
    sent: special(SPECIAL_USE.SENT),
    drafts: special(SPECIAL_USE.DRAFTS),
    junk: special(SPECIAL_USE.JUNK),
    folder_count: folders.length,
  };
}

/**
 * Assert that a destination folder is an existing, selectable folder.
 *
 * Used before any write that names a destination: a move to a non-existent folder
 * must fail in preview, not half-way through execution.
 *
 * @param {object[]} folders
 * @param {string} path
 * @returns {object} the folder record
 */
export function assertDestinationExists(folders, path) {
  const match = folders.find((folder) => folder.path === path);
  if (!match) {
    throw new MailError('FOLDER_NOT_FOUND', `No folder named "${path}" exists on this account; list folders first`);
  }
  if (!match.selectable) {
    throw new MailError('FOLDER_NOT_SELECTABLE', `Folder "${path}" is a \\Noselect node and cannot receive mail`);
  }
  return match;
}
