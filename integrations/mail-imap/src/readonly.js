// IMAP COMMAND POLICY
//
// The previous version of this file was a blanket read-only allowlist. The task
// now permits ORGANISING mail (flags, archive, move, labels, trash) while still
// forbidding correspondence (send, drafts) and irreversible destruction
// (EXPUNGE, permanent delete). So the guard is now a POLICY with two modes, and
// the forbidden set is narrower but absolute.
//
// WHAT NEVER CHANGES, IN EITHER MODE
// ---------------------------------
//   EXPUNGE / UID EXPUNGE   irreversible removal. Never sent, ever.
//   CLOSE                   implicitly expunges the mailbox. UNSELECT is used.
//   APPEND                  writing a message into a mailbox = drafts/send path.
//   STORE with \Deleted     marks for deletion; a later EXPUNGE elsewhere (the
//                           user's own mail client!) would then destroy the mail.
//                           Refused even though it is only a flag write.
//
// WHAT IS ADDED FOR ORGANISING
// ----------------------------
//   STORE / UID STORE       only for \Seen, \Flagged and Gmail labels
//   MOVE / UID MOVE         only when the server advertises MOVE
//   COPY / UID COPY         only as the mechanism inside an approved archive/move
//   SELECT                  now allowed, because STORE needs a writable mailbox.
//                           Reads still use EXAMINE.
//
// The guard inspects the actual command and its flags, not a caller's promise, so
// a bug in the action layer cannot delete mail. Tests assert every refusal.
import { MailError } from './errors.js';

/** Raised when a command would leave the permitted envelope. */
export class ReadOnlyViolation extends Error {
  constructor(command, reason) {
    super(`IMAP policy violation: ${command} refused (${reason})`);
    this.name = 'ReadOnlyViolation';
    this.code = 'READ_ONLY_VIOLATION';
    this.command = command;
    this.reason = reason;
  }
}

/** Commands permitted in both modes. */
export const READ_COMMANDS = Object.freeze(
  new Set([
    'CAPABILITY', 'NOOP', 'LOGOUT', 'STARTTLS', 'AUTHENTICATE', 'LOGIN', 'ID',
    'ENABLE', 'NAMESPACE', 'EXAMINE', 'LIST', 'LSUB', 'STATUS', 'SEARCH',
    'FETCH', 'COMPRESS', 'UNSELECT',
  ]),
);

/** Commands permitted only in write mode. */
export const WRITE_COMMANDS = Object.freeze(new Set(['SELECT', 'STORE', 'MOVE', 'COPY']));

/**
 * Commands refused unconditionally, in every mode, forever. This map is the
 * security contract of the integration and is asserted by tests.
 */
export const FORBIDDEN_COMMANDS = Object.freeze({
  EXPUNGE: 'irreversible removal; the integration never expunges',
  CLOSE: 'implicitly expunges \\Deleted messages; UNSELECT is used instead',
  APPEND: 'writes a message into a mailbox, which is the drafts/send path',
  CREATE: 'creates mailboxes; the owner decides the folder layout',
  DELETE: 'deletes a mailbox and everything in it',
  RENAME: 'renames a mailbox, which breaks folder configuration',
  SUBSCRIBE: 'changes the subscription list',
  UNSUBSCRIBE: 'changes the subscription list',
  CHECK: 'not needed',
});

/** Flags a write is allowed to touch. Everything else is refused. */
const ALLOWED_STORE_FLAGS = Object.freeze(new Set(['\\Seen', '\\Flagged']));

/** Refused even though it is "just a flag". */
const DESTRUCTIVE_STORE_FLAGS = Object.freeze(new Set(['\\Deleted', '\\Recent', '\\Draft', '\\Answered']));

/**
 * Split a wire command into its `UID` prefix and base command.
 *
 * @param {string} name uppercase command word
 * @returns {{uidPrefix: boolean, base: string}}
 */
export function splitUidPrefix(name) {
  if (!name.startsWith('UID ')) return { uidPrefix: false, base: name };
  return { uidPrefix: true, base: name.slice(4).trim() };
}

/**
 * Flatten an IMAP attribute tree into atoms, so a STORE can be inspected.
 *
 * @param {unknown} node
 * @returns {string[]}
 */
export function collectAtoms(node) {
  /** @type {string[]} */
  const out = [];
  /** @param {unknown} value */
  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'object') {
      const record = /** @type {{value?: unknown, section?: unknown}} */ (value);
      if (typeof record.value === 'string') out.push(record.value);
      if (record.section !== undefined) walk(record.section);
    }
  };
  walk(node);
  return out;
}

/**
 * Decide whether a STORE flags list is acceptable.
 *
 * @param {unknown} attributes
 * @returns {{operation: string, flags: string[]}}
 */
export function inspectStore(attributes) {
  const atoms = collectAtoms(attributes);
  const operationIndex = atoms.findIndex(
    (atom) => /^(?:[+-]?)FLAGS(?:\.SILENT)?$/i.test(atom) || /^(?:[+-]?)X-GM-LABELS$/i.test(atom),
  );
  if (operationIndex === -1) {
    throw new ReadOnlyViolation('STORE', 'no recognised FLAGS or X-GM-LABELS item');
  }
  return { operation: atoms[operationIndex], flags: atoms.slice(operationIndex + 1) };
}

/**
 * Apply the policy to one command.
 *
 * @param {string} command raw command name
 * @param {unknown} attributes raw attribute tree
 * @param {{mode: 'read'|'write', allowMove?: boolean, allowCopy?: boolean}} policy
 * @param {{skipItemInspection?: boolean}} [options] set by `runInternal`, which
 *   receives no attribute tree; `exec` inspects them instead
 * @throws {ReadOnlyViolation}
 */
export function assertCommandAllowed(command, attributes, policy, options = {}) {
  const name = String(command).toUpperCase();
  const { uidPrefix, base } = splitUidPrefix(name);
  const effective = uidPrefix ? base : name;

  if (Object.hasOwn(FORBIDDEN_COMMANDS, effective)) {
    throw new ReadOnlyViolation(name, FORBIDDEN_COMMANDS[effective]);
  }

  if (READ_COMMANDS.has(effective)) {
    // A non-PEEK body fetch sets \Seen as a side effect. An approved mark_read
    // uses an explicit STORE, not a side effect of reading, so a non-PEEK fetch
    // outside write mode is a bug.
    if (effective === 'FETCH') {
      const offending = findUnpeekedBodySection(attributes);
      if (offending && policy.mode !== 'write') {
        throw new ReadOnlyViolation(name, `body section without PEEK would set \\Seen (${offending})`);
      }
    }
    return;
  }

  if (!WRITE_COMMANDS.has(effective)) {
    throw new ReadOnlyViolation(name, 'not in the command allowlist');
  }

  if (policy.mode !== 'write') {
    throw new ReadOnlyViolation(name, 'write command attempted on a read-only session');
  }

  switch (effective) {
    case 'SELECT':
      return;
    case 'STORE': {
      // runInternal hands over (range, flags, opts) rather than an attribute
      // tree, so the flag inspection happens once, at the exec layer, which is
      // where every STORE is finally built. The command itself was already
      // judged above, so nothing escapes.
      if (options.skipItemInspection) return;
      const { operation, flags } = inspectStore(attributes);
      const isLabelStore = /X-GM-LABELS$/i.test(operation);
      for (const flag of flags) {
        const normalised = flag.trim();
        if (DESTRUCTIVE_STORE_FLAGS.has(normalised)) {
          throw new ReadOnlyViolation(name, `flag ${normalised} is destructive and refused`);
        }
        if (!isLabelStore && !ALLOWED_STORE_FLAGS.has(normalised)) {
          throw new ReadOnlyViolation(name, `flag ${normalised} is not an organising flag`);
        }
      }
      // A bare "FLAGS ()" clears everything, including \Seen.
      if (!isLabelStore && flags.length === 0) {
        throw new ReadOnlyViolation(name, 'clearing all flags is not a supported action');
      }
      return;
    }
    case 'MOVE':
      if (!policy.allowMove) {
        throw new ReadOnlyViolation(name, 'server does not advertise MOVE, and the COPY+EXPUNGE fallback is forbidden');
      }
      return;
    case 'COPY':
      // COPY on its own duplicated mail. Permitted only because an approved
      // archive on a non-Gmail host is COPY-then-flag, and the action layer marks
      // that intent explicitly.
      if (!policy.allowCopy) {
        throw new ReadOnlyViolation(name, 'COPY is only used inside an approved archive/move operation');
      }
      return;
    default:
      throw new ReadOnlyViolation(name, 'unhandled write command');
  }
}

/** A fetch item that fetches a body section without PEEK sets \Seen. */
const UNPEEKED_BODY = /^(?:BODY|BINARY|RFC822)(?:\.HEADER|\.TEXT)?\s*(?:\[|$)/i;
const PEEKED_BODY = /\.PEEK\s*(?:\[|$)/i;

/**
 * Inspect FETCH attributes for a non-PEEK body section.
 *
 * @param {unknown} attributes
 * @returns {string|null}
 */
export function findUnpeekedBodySection(attributes) {
  /** @type {string[]} */
  const atoms = [];
  /** @param {unknown} node */
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node === 'object') {
      const record = /** @type {{value?: unknown, section?: unknown}} */ (node);
      if (typeof record.value === 'string') {
        const hasSection = record.section !== undefined && record.section !== null;
        atoms.push(hasSection ? `${record.value}[]` : record.value);
      }
      if (record.section !== undefined) walk(record.section);
    }
  };
  walk(attributes);
  for (const atom of atoms) {
    if (PEEKED_BODY.test(atom)) continue;
    if (UNPEEKED_BODY.test(atom)) return atom;
  }
  return null;
}

/**
 * Wrap one ImapFlow instance with the policy.
 *
 * `policy` is read at call time, so a session can start in read mode and be
 * promoted only for a specific approved write.
 *
 * @param {object} client ImapFlow instance
 * @param {{mode: 'read'|'write', allowMove?: boolean, allowCopy?: boolean}} policy
 * @returns {{violations: string[], dispose: () => void, setPolicy: (next: object) => void}}
 */
export function enforcePolicy(client, policy) {
  const violations = [];
  let current = { allowMove: false, allowCopy: false, ...policy };
  const originalExec = client.exec.bind(client);
  const originalRunInternal = client.runInternal.bind(client);

  /**
   * @param {string} command
   * @param {unknown} attributes
   */
  const judge = (command, attributes) => {
    try {
      assertCommandAllowed(command, attributes, current);
    } catch (error) {
      if (error instanceof ReadOnlyViolation) violations.push(error.message);
      throw error;
    }
  };

  /** @type {typeof client.exec} */
  client.exec = function guardedExec(command, attributes, options) {
    judge(command, attributes);
    return originalExec(command, attributes, options);
  };

  /** @type {typeof client.runInternal} */
  client.runInternal = function guardedRunInternal(command, ...args) {
    // mailboxOpen(readOnly) is routed as SELECT internally; resolve it so a
    // legitimate read-only open is not mistaken for a write.
    const name = String(command).toUpperCase();
    if (name === 'SELECT') {
      const options = args.find((arg) => arg !== null && typeof arg === 'object' && !Array.isArray(arg));
      const readOnly = options ? /** @type {{readOnly?: unknown}} */ (options).readOnly : undefined;
      judge(readOnly === true ? 'EXAMINE' : 'SELECT', []);
      return originalRunInternal(command, ...args);
    }
    // This layer sees the command NAME but not the attribute tree, which `exec`
    // builds later. Judge the name here and defer the flag inspection to `exec`,
    // never the other way round: skipping the command check would be the bug.
    try {
      assertCommandAllowed(command, [], current, { skipItemInspection: true });
    } catch (error) {
      if (error instanceof ReadOnlyViolation) violations.push(error.message);
      throw error;
    }
    return originalRunInternal(command, ...args);
  };

  return {
    violations,
    setPolicy(next) {
      current = { ...current, ...next };
    },
    dispose() {
      client.exec = originalExec;
      client.runInternal = originalRunInternal;
    },
  };
}

/** Backwards-compatible alias used by the read-only test suite. */
export function enforceReadOnly(client) {
  return enforcePolicy(client, { mode: 'read' });
}

/** Backwards-compatible allowlist export. */
export const ALLOWED_COMMANDS = READ_COMMANDS;

/** Backwards-compatible denial map export. */
export const DENIED_COMMANDS = FORBIDDEN_COMMANDS;

/**
 * Assert a mailbox is in the state a write needs.
 *
 * @param {object} client
 * @param {{requireWritable?: boolean}} [options]
 */
export function assertMailboxState(client, options = {}) {
  const mailbox = client.mailbox;
  if (!mailbox) throw new MailError('MAILBOX_NOT_FOUND', 'No mailbox is selected');
  if (options.requireWritable && mailbox.readOnly === true) {
    throw new MailError('UNSUPPORTED', `Mailbox ${mailbox.path} was opened read-only; a write needs a writable select`);
  }
}

/** Alias kept for the previous read-only assertion. */
export function assertSelectedReadOnly(client) {
  const mailbox = client.mailbox;
  if (!mailbox) throw new ReadOnlyViolation('EXAMINE', 'no mailbox is selected');
  if (mailbox.readOnly !== true) {
    throw new ReadOnlyViolation('EXAMINE', `mailbox ${mailbox.path} was opened read-write`);
  }
}
