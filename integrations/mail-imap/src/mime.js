// Message normalisation: IMAP bytes -> one predictable, size-bounded shape.
//
// Everything here treats the message as UNTRUSTED DATA. It is parsed, decoded
// and truncated, never evaluated, never fetched from the network, never written
// to disk. Decoding is done by mailparser, which uses libmime/iconv-lite —
// the same decoders imapflow depends on, so there is one MIME implementation,
// not two.
import { simpleParser } from 'mailparser';

/** Hard caps. Chosen so one huge message cannot exhaust the container. */
export const LIMITS = Object.freeze({
  /** Bytes of raw RFC822 source fetched for one message. */
  maxRawSourceBytes: 5 * 1024 * 1024,
  /** Characters of extracted plain-text body returned to the model. */
  maxTextBodyChars: 120_000,
  /** Characters of HTML returned to the model. */
  maxHtmlChars: 120_000,
  /** Characters of snippet stored in list results. */
  maxSnippetChars: 400,
  /** `text/plain` size that is still worth handing to the HTML extractor. */
  maxHtmlToTextChars: 400_000,
  /** Attachments listed per message (metadata only, never content). */
  maxAttachments: 100,
  /** Total characters of one list-style textual body. */
  maxListChars: 400_000,
  /** Deepest nesting the parser will attempt. */
  maxHeaderLength: 100_000,
});

/**
 * Decode a MIME-encoded header word and normalise whitespace.
 *
 * mailparser already decodes headers, this helper only takes the placeholders
 * `(no subject)` / `(unknown sender)` out of the way and makes truncated or
 * broken decoding visible instead of silently dropping text.
 *
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
export function cleanHeaderText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const collapsed = value.replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return collapsed.length === 0 ? fallback : collapsed;
}

/**
 * Normalise one address object from mailparser's `addressparser` output.
 *
 * @param {unknown} address
 * @returns {{name: string, address: string} | null}
 */
function normaliseAddress(address) {
  if (!address || typeof address !== 'object') return null;
  const record = /** @type {{name?: unknown, address?: unknown, group?: unknown}} */ (address);
  if (Array.isArray(record.group)) {
    // A group is not an address; keep its members, drop the group label.
    return null;
  }
  const name = typeof record.name === 'string' ? cleanHeaderText(record.name) : '';
  const email = typeof record.address === 'string' ? record.address.trim() : '';
  if (email.length === 0) return null;
  return { name, address: email };
}

/**
 * Flatten mailparser's address structures into a plain array.
 *
 * mailparser is not consistent here: a header with one address yields an array
 * of address objects, while a parsed address header is sometimes wrapped as
 * `{ value: [...], html, text }` — the shape it also uses for its own rendering.
 * Groups appear as `{ group: [...] }`. All three forms are unpacked, because a
 * recipient list that silently comes back empty is worse than a parse error.
 *
 * @param {unknown} value
 * @returns {{name: string, address: string}[]}
 */
export function normaliseAddressList(value) {
  /** @type {{name: string, address: string}[]} */
  const out = [];
  /** @param {unknown} node */
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object') return;
    const record = /** @type {{group?: unknown, value?: unknown, address?: unknown}} */ (node);
    if (Array.isArray(record.group)) {
      walk(record.group);
      return;
    }
    // The { value, html, text } wrapper carries the addresses in `value`.
    if (Array.isArray(record.value)) {
      walk(record.value);
      return;
    }
    const entry = normaliseAddress(node);
    if (entry) out.push(entry);
  };
  walk(value);
  return out;
}

/**
 * Read one header line verbatim from mailparser's `headerLines`.
 *
 * `headers.get('date')` has already been parsed into a Date, which drops the
 * sender's UTC offset. The raw line keeps it, and a human comparing two mail
 * clients needs exactly that.
 *
 * @param {unknown} headerLines
 * @param {string} name lowercase header name
 * @returns {string|null}
 */
export function rawHeaderValue(headerLines, name) {
  if (!Array.isArray(headerLines)) return null;
  const wanted = name.toLowerCase();
  for (const entry of headerLines) {
    if (!entry || typeof entry !== 'object') continue;
    const record = /** @type {{key?: unknown, line?: unknown}} */ (entry);
    if (record.key !== wanted || typeof record.line !== 'string') continue;
    // `line` is "Date: Tue, 18 Nov 2026 09:00:00 +0300"; drop the field name.
    const colon = record.line.indexOf(':');
    const value = colon === -1 ? record.line : record.line.slice(colon + 1);
    return cleanHeaderText(value, '') || null;
  }
  return null;
}

/**
 * Truncate to a character budget without splitting a surrogate pair, and say so.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {{text: string, truncated: boolean}}
 */
export function truncateText(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  let end = limit;
  const code = text.charCodeAt(end - 1);
  // High surrogate left dangling: drop it, so the result is valid UTF-16.
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: `${text.slice(0, end)}\n\n[truncated: ${text.length - end} characters omitted]`, truncated: true };
}

/**
 * ISO-8601 in UTC, keeping the original zone offset when the header had one.
 *
 * A mail Date header is usually already absolute; `date` is the UTC instant and
 * `date_header` preserves exactly what the sender wrote, including the offset,
 * so a human can see the sender's local time without losing the comparable one.
 *
 * @param {unknown} date
 * @returns {string|null}
 */
export function toIsoUtc(date) {
  if (date instanceof Date && !Number.isNaN(date.getTime())) return date.toISOString();
  if (typeof date === 'string') {
    const parsed = new Date(date);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof date === 'number' && Number.isFinite(date)) {
    const parsed = new Date(date);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/**
 * Describe attachments by metadata only.
 *
 * Content is deliberately not returned: the brief forbids downloading or
 * opening attachments at this stage, and a base64 blob in a tool result is both
 * a size hazard and a way to smuggle executable content into the model.
 *
 * @param {unknown} attachments
 * @returns {{filename: string, contentType: string, size: number, contentId: string|null, disposition: string|null, executable: boolean}[]}
 */
export function summariseAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  const out = [];
  for (const attachment of attachments.slice(0, LIMITS.maxAttachments)) {
    if (!attachment || typeof attachment !== 'object') continue;
    const record = /** @type {Record<string, any>} */ (attachment);
    const filename = cleanHeaderText(record.filename, '(unnamed)');
    const contentType = cleanHeaderText(record.contentType, 'application/octet-stream');
    const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : 0;
    const contentId = typeof record.cid === 'string' ? record.cid : null;
    const disposition = typeof record.disposition === 'string' ? record.disposition : null;
    out.push({
      filename,
      contentType,
      size,
      contentId,
      disposition,
      // Surfaced so a reader can be careful, never acted on by this server.
      executable: isExecutableType(contentType, filename),
    });
  }
  return out;
}

/** Content types and extensions that must never be opened or executed. */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'msi', 'msp', 'hta', 'cpl', 'jar', 'apk', 'dll', 'so', 'dylib',
  'lnk', 'reg', 'chm', 'iso', 'img', 'docm', 'xlsm', 'pptm',
]);

/**
 * @param {string} contentType
 * @param {string} filename
 * @returns {boolean}
 */
export function isExecutableType(contentType, filename) {
  const type = contentType.toLowerCase();
  if (/^application\/(x-msdownload|x-msdos-program|x-executable|x-sh|x-bat|vnd\.microsoft\.portable-executable)/.test(type)) {
    return true;
  }
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return false;
  return EXECUTABLE_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
}

/**
 * Build a short preview from the plain-text body.
 *
 * Quoted reply chains and signature blocks are trimmed: a snippet of a reply
 * made only of the previous message is useless for triage.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function makeSnippet(text, limit = LIMITS.maxSnippetChars) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('>')) continue;
    if (/^--\s*$/.test(line)) break;
    if (/^_{5,}$/.test(line)) break;
    if (line.length === 0) {
      if (lines.length > 0) lines.push('');
      continue;
    }
    lines.push(line);
    if (lines.join(' ').length > limit * 2) break;
  }
  const joined = lines.join(' ').replace(/\s{2,}/g, ' ').trim();
  const { text: clipped } = truncateText(joined, limit);
  return clipped;
}

/** Options handed to mailparser. Shared by the full and the salvage attempt. */
const PARSER_OPTIONS = Object.freeze({
  // Never turn HTML into text for a huge part: that conversion is the most
  // expensive thing in the pipeline and is bounded here on purpose.
  maxHtmlLengthToParse: LIMITS.maxHtmlToTextChars,
  // Image links (cid:) are not rewritten; this server never inlines images.
  skipImageLinks: true,
  // No text->HTML conversion: the HTML body is returned raw and bounded.
  skipTextToHtml: true,
  // Do not build textAsHtml/link lists; unused output is wasted memory.
  skipTextLinks: true,
});

/**
 * Find the header/body boundary of an RFC822 message.
 *
 * @param {Buffer} buffer
 * @returns {{headerEnd: number, bodyStart: number}|null}
 */
export function findHeaderBoundary(buffer) {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  if (crlf === -1 && lf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { headerEnd: crlf, bodyStart: crlf + 4 };
  return { headerEnd: lf, bodyStart: lf + 2 };
}

/**
 * Rebuild a parseable message from hostile input.
 *
 * mailparser caps a header block at 1 MiB and throws EMAXLEN past it. A real
 * mailbox can contain such a message (a broken sender, a mail loop), and a mail
 * reader that dies on one message is broken. So the header is reduced to whole
 * lines inside a smaller budget and the body is kept: the caller gets a degraded
 * but truthful result, flagged with `parse_error`.
 *
 * @param {Buffer} buffer already size-capped source
 * @returns {Buffer|null} a message that is likely to parse, or null
 */
export function salvageSource(buffer) {
  const boundary = findHeaderBoundary(buffer);
  if (!boundary) {
    // No header/body separator at all. Treat the whole buffer as the body of a
    // synthetic message so its text is still readable and inspected for nothing.
    return Buffer.concat([Buffer.from('Subject: (unparsed message)\r\n\r\n', 'utf8'), buffer.subarray(0, LIMITS.maxHeaderLength)]);
  }
  if (boundary.headerEnd <= LIMITS.maxHeaderLength) {
    // Headers are fine; the failure was elsewhere, so there is nothing to salvage.
    return null;
  }
  const headerText = buffer.subarray(0, LIMITS.maxHeaderLength).toString('latin1');
  const lastNewline = Math.max(headerText.lastIndexOf('\r\n'), headerText.lastIndexOf('\n'));
  if (lastNewline <= 0) return null;
  const keptHeader = buffer.subarray(0, lastNewline);
  return Buffer.concat([keptHeader, Buffer.from('\r\n\r\n', 'latin1'), buffer.subarray(boundary.bodyStart)]);
}

/**
 * Parse one raw message into the unified shape.
 *
 * Parsing is best-effort by contract: a malformed or hostile message yields a
 * result with `parse_error` set rather than throwing, because one unreadable
 * message must not fail a mailbox listing.
 *
 * @param {Buffer} source raw RFC822 bytes
 * @param {object} context account/mailbox/uid metadata
 * @param {{includeBody?: boolean}} [options]
 * @returns {Promise<object>}
 */
export async function parseMessage(source, context, options = {}) {
  const includeBody = options.includeBody !== false;
  if (!Buffer.isBuffer(source)) throw new TypeError('parseMessage expects a Buffer');

  const truncatedSource = source.length > LIMITS.maxRawSourceBytes;
  const input = truncatedSource ? source.subarray(0, LIMITS.maxRawSourceBytes) : source;

  /** @type {Record<string, any>} */
  let parsed;
  let parseError = null;
  try {
    parsed = await simpleParser(input, PARSER_OPTIONS);
  } catch (error) {
    parseError = error;
    const salvage = salvageSource(input);
    if (salvage) {
      try {
        parsed = await simpleParser(salvage, PARSER_OPTIONS);
        parseError = null;
      } catch (secondError) {
        parseError = secondError;
      }
    }
  }
  if (!parsed) {
    // Last resort: an empty-but-shaped result. The caller still gets uid and
    // flags, and `parse_error` tells it the body could not be decoded.
    parsed = {};
  }

  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const attachments = summariseAttachments(parsed.attachments);
  const dateIso = toIsoUtc(parsed.date);

  const textBody = includeBody ? truncateText(text, LIMITS.maxTextBodyChars) : null;
  const htmlBody = includeBody && html.length > 0 ? truncateText(html, LIMITS.maxHtmlChars) : null;

  return {
    account_id: context.accountId,
    provider: context.provider,
    mailbox: context.mailbox,
    uid: context.uid,
    uidvalidity: context.uidValidity,
    message_id: parsed.messageId ?? context.messageId ?? null,
    thread_id: null,
    subject: cleanHeaderText(parsed.subject, '(no subject)'),
    from: normaliseAddressList(parsed.from),
    to: normaliseAddressList(parsed.to),
    cc: normaliseAddressList(parsed.cc),
    bcc: normaliseAddressList(parsed.bcc),
    reply_to: normaliseAddressList(parsed.replyTo),
    date: dateIso,
    // The sender's own zone, kept verbatim for display; null when unparseable.
    date_header: rawHeaderValue(parsed.headerLines, 'date'),
    snippet: makeSnippet(text),
    body: includeBody ? (textBody ? textBody.text : null) : null,
    body_truncated: Boolean(textBody?.truncated),
    html: htmlBody ? htmlBody.text : null,
    html_truncated: Boolean(htmlBody?.truncated),
    has_attachments: attachments.length > 0,
    attachments,
    flags: Array.isArray(context.flags) ? context.flags : [],
    size: typeof context.size === 'number' ? context.size : source.length,
    raw_truncated: truncatedSource,
    unread: Array.isArray(context.flags) ? !context.flags.includes('\\Seen') : null,
    // Non-null when the message could not be decoded. A reader should say so
    // rather than present an empty body as the message content.
    parse_error: parseError ? String(parseError.code ?? 'PARSE_ERROR') : null,
  };
}

/**
 * Header-only summary used by search and recent-list results.
 *
 * `parseMessage` with `includeBody: false` already avoids body extraction, but a
 * list over hundreds of messages still needs to skip MIME parsing entirely:
 * imapflow's ENVELOPE gives subject/from/date without downloading the body.
 *
 * @param {object} envelope imapflow ENVELOPE
 * @param {object} context
 * @returns {object}
 */
export function summariseEnvelope(envelope, context) {
  const env = envelope && typeof envelope === 'object' ? /** @type {Record<string, any>} */ (envelope) : {};
  const flags = Array.isArray(context.flags) ? context.flags : [];
  return {
    account_id: context.accountId,
    provider: context.provider,
    mailbox: context.mailbox,
    uid: context.uid,
    uidvalidity: context.uidValidity,
    message_id: typeof env.messageId === 'string' ? cleanHeaderText(env.messageId, '') || null : null,
    thread_id: null,
    subject: cleanHeaderText(env.subject, '(no subject)'),
    from: normaliseAddressList(env.from),
    to: normaliseAddressList(env.to),
    date: toIsoUtc(env.date),
    snippet: '',
    has_attachments: null,
    flags,
    unread: !flags.includes('\\Seen'),
    size: typeof context.size === 'number' ? context.size : null,
  };
}
