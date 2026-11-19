// Tool contracts: JSON Schema for the model, explicit validation for the server.
//
// TWO SCHEMAS, ONE SOURCE
// -----------------------
// The schemas below are written by hand rather than generated from a validation
// library. The reason is concrete: the harness enforces a narrow JSON-Schema
// subset (type / oneOf / properties / required / additionalProperties / items /
// enum / const plus description, title, default, examples). A generator adds
// `$schema`, `minLength`, `maximum` and similar keywords, and the harness then
// rejects the whole tool with "… is not a supported keyword".
//
// So the emitted schema uses only that subset, and validation is done by
// `validateArguments` below against the same declarative shape. Nothing a tool
// receives reaches IMAP unvalidated.
//
// READ-ONLY TOOL SURFACE
// ----------------------
// These are the only tools this server has. There is deliberately no send,
// reply, forward, delete, move, flag or draft tool — not hidden, not
// disabled-by-config: absent. A model cannot call what was never registered,
// and a future edit that tries to add one would have to pass the read-only
// command guard as well (see readonly.js).

/** @typedef {{type: string, description?: string, enum?: string[], items?: object, default?: unknown}} PropertySpec */

/**
 * Declarative argument shape shared by the JSON Schema and the validator.
 *
 * `required` is the only structural distinction; everything is optional unless
 * listed, because every tool has a sensible default.
 */
export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'mail_list_accounts',
    title: 'List mail accounts',
    description:
      'Lists the configured read-only IMAP accounts with provider, display name, live connection status and capabilities. Never returns passwords, tokens or full login addresses.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    properties: {
      verbose: {
        type: 'boolean',
        description: 'Accepted for compatibility; the response always includes status and capabilities.',
      },
    },
    required: [],
    validate: () => ({}),
  },
  {
    name: 'mail_list_folders',
    title: 'List mail folders',
    description:
      'Lists the mail folders (mailboxes) of one account, including special-use hints such as Sent or Trash. Read-only: no folder is created or changed.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    properties: {
      account_id: { type: 'string', description: 'Account id from mail_list_accounts, e.g. yandex-personal-1.' },
    },
    required: ['account_id'],
    validate: (args) => ({ accountId: requireString(args, 'account_id') }),
  },
  {
    name: 'mail_search',
    title: 'Search messages',
    description:
      'Searches one folder of one account and returns header summaries, newest first. `query` maps to IMAP TEXT (headers and body) — IMAP has no relevance ranking, so results are date-ordered, not scored. `since`/`before` are dates (IMAP SINCE/BEFORE, day granularity). The result count is capped by `limit`.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    properties: {
      account_id: { type: 'string', description: 'Account id.' },
      folder: { type: 'string', description: 'Mailbox path; defaults to the account default folder (usually INBOX).' },
      query: { type: 'string', description: 'Free text matched against headers and body (IMAP TEXT).' },
      from: { type: 'string', description: 'Substring match on the From header.' },
      to: { type: 'string', description: 'Substring match on the To header.' },
      subject: { type: 'string', description: 'Substring match on the Subject header.' },
      since: { type: 'string', description: 'Only messages received on or after this date (YYYY-MM-DD or ISO 8601).' },
      before: { type: 'string', description: 'Only messages received before this date (YYYY-MM-DD or ISO 8601).' },
      unread_only: { type: 'boolean', description: 'Only messages without the \\Seen flag. Checking this does not change any flag.' },
      limit: { type: 'integer', description: 'Maximum messages to return (1-100, default 25).' },
    },
    required: ['account_id'],
    validate: (args) => ({
      accountId: requireString(args, 'account_id'),
      folder: optionalString(args, 'folder'),
      query: optionalString(args, 'query'),
      from: optionalString(args, 'from'),
      to: optionalString(args, 'to'),
      subject: optionalString(args, 'subject'),
      since: optionalString(args, 'since'),
      before: optionalString(args, 'before'),
      unread_only: optionalBoolean(args, 'unread_only'),
      limit: optionalInteger(args, 'limit', 1, 100),
    }),
  },
  {
    name: 'mail_get_message',
    title: 'Read one message',
    description:
      'Reads one message by UID and returns decoded headers, plain-text body, optional HTML and attachment METADATA (names, types, sizes — never content). Reading does not mark the message as read: the body is fetched with BODY.PEEK. Pass `uidvalidity` from a previous result to be protected against a renumbered mailbox.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    properties: {
      account_id: { type: 'string', description: 'Account id.' },
      uid: { type: 'integer', description: 'Message UID inside the mailbox (not a sequence number).' },
      folder: { type: 'string', description: 'Mailbox path; defaults to the account default folder.' },
      uidvalidity: { type: 'string', description: 'UIDVALIDITY from the earlier result. When present it must match, otherwise the call fails instead of returning a different message.' },
      include_html: { type: 'boolean', description: 'Include a size-limited HTML body (default true).' },
    },
    required: ['account_id', 'uid'],
    validate: (args) => ({
      accountId: requireString(args, 'account_id'),
      uid: requireInteger(args, 'uid', 1, 0xffffffff),
      folder: optionalString(args, 'folder'),
      uidvalidity: optionalString(args, 'uidvalidity'),
      include_html: optionalBoolean(args, 'include_html'),
    }),
  },
  {
    name: 'mail_list_recent',
    title: 'List recent messages',
    description:
      'Lists the most recent messages of one account over a period (default: last 1 day). Returns the same header summaries as mail_search, plus the exact period used.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    properties: {
      account_id: { type: 'string', description: 'Account id.' },
      folder: { type: 'string', description: 'Mailbox path; defaults to the account default folder.' },
      days: { type: 'integer', description: 'How many days back to look (1-90, default 1).' },
      since: { type: 'string', description: 'Explicit start date (YYYY-MM-DD or ISO 8601); overrides days.' },
      unread_only: { type: 'boolean', description: 'Only unread messages.' },
      limit: { type: 'integer', description: 'Maximum messages to return (1-100, default 25).' },
    },
    required: ['account_id'],
    validate: (args) => ({
      accountId: requireString(args, 'account_id'),
      folder: optionalString(args, 'folder'),
      days: optionalInteger(args, 'days', 1, 90),
      since: optionalString(args, 'since'),
      unread_only: optionalBoolean(args, 'unread_only'),
      limit: optionalInteger(args, 'limit', 1, 100),
    }),
  },
  {
    name: 'mail_get_daily_summary_data',
    title: 'Daily summary data',
    description:
      'Returns normalised message data for a period across one, several or all accounts, plus aggregate counts and per-account failures. This tool only RETURNS DATA for the agent to analyse: it creates no schedule and sends no notification. Each message carries a stable `ref` (account, mailbox, uid, uidvalidity) for reopening it with mail_get_message.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    properties: {
      days: { type: 'integer', description: 'How many days back to look (1-90, default 1).' },
      since: { type: 'string', description: 'Explicit start date; overrides days.' },
      folder: { type: 'string', description: 'Mailbox path applied to every account; defaults to each account default folder.' },
      account_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Accounts to include; omit for all configured accounts.',
      },
      limit: { type: 'integer', description: 'Maximum messages per account (1-200, default 100).' },
    },
    required: [],
    validate: (args) => ({
      days: optionalInteger(args, 'days', 1, 90),
      since: optionalString(args, 'since'),
      folder: optionalString(args, 'folder'),
      account_ids: optionalStringArray(args, 'account_ids'),
      limit: optionalInteger(args, 'limit', 1, 200),
    }),
  },
  {
    name: 'mail_get_account_status',
    title: 'Account status',
    description:
      'Reports one account in detail: connection state, whether writes are enabled, the folder layout the server declares (archive, trash, sent), and the IMAP capabilities that determine which operations are possible. Read-only.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    properties: {
      account_id: { type: 'string', description: 'Account id.' },
    },
    required: ['account_id'],
    validate: (args) => ({ accountId: requireString(args, 'account_id') }),
  },
  {
    name: 'mail_list_labels',
    title: 'List labels',
    description:
      'Lists Gmail labels when the account advertises X-GM-EXT-1. On providers without that extension it returns UNSUPPORTED rather than pretending IMAP folders are labels.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    properties: {
      account_id: { type: 'string', description: 'Account id.' },
    },
    required: ['account_id'],
    validate: (args) => ({ accountId: requireString(args, 'account_id') }),
  },
  {
    name: 'mail_get_conversation',
    title: 'Message conversation',
    description:
      'Groups messages by the standard Message-ID / In-Reply-To / References headers within one folder. These are HEADER GROUPS, not Gmail API threads: a reply that carries no References starts a new group, and nothing is merged across folders. Returns a group only when it has more than one message.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    properties: {
      account_id: { type: 'string', description: 'Account id.' },
      message_id: { type: 'string', description: 'Message-ID header value of any message in the conversation.' },
      folder: { type: 'string', description: 'Folder to search; defaults to the account default folder.' },
      limit: { type: 'integer', description: 'Maximum messages to examine (1-100, default 50).' },
    },
    required: ['account_id', 'message_id'],
    validate: (args) => ({
      accountId: requireString(args, 'account_id'),
      messageId: requireString(args, 'message_id'),
      folder: optionalString(args, 'folder'),
      limit: optionalInteger(args, 'limit', 1, 100),
    }),
  },
  {
    name: 'mail_preview_actions',
    title: 'Preview mail actions',
    description:
      'Validates a plan of organising actions against live server state and returns a digest plus a human summary. CHANGES NOTHING. Every action needs the uidvalidity you got from a search, because a UID alone can point at a different message after a renumber. Allowed actions: mark_read, mark_unread, archive, move_to_folder, add_label, remove_label, move_to_trash. No action can send, draft or permanently delete.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    properties: {
      actions: {
        type: 'array',
        items: { type: 'object' },
        description:
          'Plan items: { account_id, mailbox, uidvalidity, uids, action, target?, label? }. target is the destination folder for move_to_folder; label is the Gmail label for add_label/remove_label.',
      },
    },
    required: ['actions'],
    validate: (args) => ({ actions: requireActionArray(args, 'actions') }),
  },
  {
    name: 'mail_apply_actions',
    title: 'Apply mail actions',
    description:
      'Executes a plan that was previewed with mail_preview_actions. Requires the digest from that preview; the plan is re-hashed and compared, so an account, UID, folder, label or action cannot be substituted after review. Plans that are mass operations, span accounts or touch trash additionally need the owner\'s approval, produced outside the agent (scripts/mail-approve.sh). Returns APPROVAL_REQUIRED when it is still missing.',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    properties: {
      actions: {
        type: 'array',
        items: { type: 'object' },
        description: 'The exact same plan items that were previewed.',
      },
      digest: { type: 'string', description: 'The digest returned by mail_preview_actions for this exact plan.' },
      operation_id: { type: 'string', description: 'Optional idempotency key; reusing it replays the journal lookup instead of acting twice.' },
    },
    required: ['actions', 'digest'],
    validate: (args) => ({
      actions: requireActionArray(args, 'actions'),
      digest: requireString(args, 'digest'),
      operationId: optionalString(args, 'operation_id'),
    }),
  },
  {
    name: 'mail_get_operation_status',
    title: 'Operation status',
    description:
      'Returns the journal of one applied plan: per-message results, verification outcome, approval that authorised it, and the recorded undo entries.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    properties: {
      operation_id: { type: 'string', description: 'The operation_id returned by mail_apply_actions.' },
    },
    required: ['operation_id'],
    validate: (args) => ({ operationId: requireString(args, 'operation_id') }),
  },
  {
    name: 'mail_undo_operation',
    title: 'Undo an operation',
    description:
      'Reverses the recorded changes of one operation where that is safe: flags and Gmail labels can be restored, moves can be reversed while the moved message keeps its UID. It cannot restore anything the owner deleted elsewhere, and it never expunges.',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    properties: {
      operation_id: { type: 'string', description: 'The operation_id to undo.' },
    },
    required: ['operation_id'],
    validate: (args) => ({ operationId: requireString(args, 'operation_id') }),
  },
  {
    name: 'mail_get_attachment_metadata',
    title: 'Attachment metadata',
    description:
      'Returns attachment metadata for one message: filename, content type, size and whether the type is potentially executable. Never downloads attachment content and never opens it.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    properties: {
      account_id: { type: 'string', description: 'Account id.' },
      uid: { type: 'integer', description: 'Message UID inside the mailbox.' },
      folder: { type: 'string', description: 'Mailbox path; defaults to the account default folder.' },
    },
    required: ['account_id', 'uid'],
    validate: (args) => ({
      accountId: requireString(args, 'account_id'),
      uid: requireInteger(args, 'uid', 1, 0xffffffff),
      folder: optionalString(args, 'folder'),
    }),
  },
]);

/** Raised when tool arguments do not match the declared contract. */
export class ArgumentError extends Error {
  /**
   * @param {string} field
   * @param {string} message
   */
  constructor(field, message) {
    super(`invalid argument "${field}": ${message}`);
    this.name = 'ArgumentError';
    this.code = 'INVALID_ARGUMENT';
    this.field = field;
  }
}

/** @param {unknown} args @returns {Record<string, unknown>} */
function asRecord(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new ArgumentError('(root)', 'arguments must be an object');
  }
  return /** @type {Record<string, unknown>} */ (args);
}

/** @param {Record<string, unknown>} args @param {string} field @returns {string} */
function requireString(args, field) {
  const value = args[field];
  if (typeof value !== 'string') throw new ArgumentError(field, 'is required and must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ArgumentError(field, 'must not be empty');
  if (trimmed.length > 512) throw new ArgumentError(field, 'is too long');
  return trimmed;
}

/** @param {Record<string, unknown>} args @param {string} field @returns {string|undefined} */
function optionalString(args, field) {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ArgumentError(field, 'must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 512) throw new ArgumentError(field, 'is too long');
  return trimmed;
}

/** @param {Record<string, unknown>} args @param {string} field @returns {boolean|undefined} */
function optionalBoolean(args, field) {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ArgumentError(field, 'must be a boolean');
  return value;
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @returns {number|undefined}
 */
function optionalInteger(args, field, min, max) {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  return checkInteger(field, value, min, max);
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function requireInteger(args, field, min, max) {
  const value = args[field];
  if (value === undefined || value === null) throw new ArgumentError(field, 'is required and must be an integer');
  return checkInteger(field, value, min, max);
}

/**
 * Accept an integer or its decimal string form, bounded to [min, max].
 *
 * @param {string} field
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function checkInteger(field, value, min, max) {
  let number;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && /^-?[0-9]+$/.test(value.trim())) number = Number(value.trim());
  else throw new ArgumentError(field, 'must be an integer');
  if (!Number.isInteger(number)) throw new ArgumentError(field, 'must be an integer');
  if (number < min || number > max) throw new ArgumentError(field, `must be between ${min} and ${max}`);
  return number;
}

/**
 * Validate a plan array structurally. Deep validation against the server happens
 * in actions.js, because only the server knows which folders exist.
 *
 * @param {Record<string, unknown>} args
 * @param {string} field
 * @returns {object[]}
 */
function requireActionArray(args, field) {
  const value = args[field];
  if (!Array.isArray(value)) throw new ArgumentError(field, 'must be an array of action objects');
  if (value.length === 0) throw new ArgumentError(field, 'must contain at least one action');
  if (value.length > 50) throw new ArgumentError(field, 'must contain at most 50 actions; split larger plans');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ArgumentError(`${field}[${index}]`, 'must be an object');
    }
    return /** @type {Record<string, unknown>} */ (entry);
  });
}

/**
 * @param {Record<string, unknown>} args
 * @param {string} field
 * @returns {string[]|undefined}
 */
function optionalStringArray(args, field) {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ArgumentError(field, 'must be an array of strings');
  if (value.length > 50) throw new ArgumentError(field, 'must contain at most 50 entries');
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new ArgumentError(`${field}[${index}]`, 'must be a non-empty string');
    }
    return entry.trim();
  });
}

/**
 * Build the model-facing tool list.
 *
 * Only the subset the harness accepts is emitted: `type`, `properties`,
 * `required`, `additionalProperties`, `items`, `enum` and `description`.
 *
 * @returns {{name: string, title: string, description: string, inputSchema: object, annotations: object}[]}
 */
export function toolList() {
  return TOOL_DEFINITIONS.map((tool) => {
    /** @type {Record<string, object>} */
    const properties = {};
    for (const [name, spec] of Object.entries(tool.properties)) {
      /** @type {Record<string, unknown>} */
      const property = { type: spec.type };
      if (spec.items) property.items = spec.items;
      if (spec.enum) property.enum = spec.enum;
      if (spec.description) property.description = spec.description;
      properties[name] = property;
    }
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties,
        required: [...tool.required],
        additionalProperties: false,
      },
      annotations: tool.annotations,
    };
  });
}

/**
 * Look up and validate one tool call.
 *
 * Unknown argument names are rejected rather than ignored: a model that sends
 * `folder_name` instead of `folder` must be told, not silently given INBOX.
 *
 * @param {string} name
 * @param {unknown} rawArguments
 * @returns {{tool: object, args: Record<string, unknown>}}
 */
export function resolveToolCall(name, rawArguments) {
  const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new ArgumentError('(tool)', `unknown tool "${name}"`);
  }
  const args = asRecord(rawArguments);
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(tool.properties, key)) {
      throw new ArgumentError(key, `unknown argument; accepted: ${Object.keys(tool.properties).join(', ') || '(none)'}`);
    }
  }
  return { tool, args: tool.validate(args) };
}
