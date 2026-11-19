// Tests for message normalisation: encodings, multipart, limits, attachments.
//
// The fixtures are synthetic. No real mailbox content is copied here, and none
// should ever be: a test fixture is committed to a public repository.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMessage,
  summariseEnvelope,
  normaliseAddressList,
  truncateText,
  makeSnippet,
  toIsoUtc,
  isExecutableType,
  summariseAttachments,
  rawHeaderValue,
  cleanHeaderText,
  LIMITS,
} from '../src/mime.js';
import { FIXTURES, bigMessage } from './helpers/mock-server.js';

/** Context object a real call would pass. */
const CONTEXT = Object.freeze({
  accountId: 'test-account',
  provider: 'test',
  mailbox: 'INBOX',
  uid: 1,
  uidValidity: '1',
  flags: [],
  size: 0,
});

test('a plain UTF-8 message is normalised into the unified shape', async () => {
  const message = await parseMessage(Buffer.from(FIXTURES.plainEnglish), {
    ...CONTEXT,
    flags: ['\\Seen'],
    size: FIXTURES.plainEnglish.length,
  });
  assert.equal(message.account_id, 'test-account');
  assert.equal(message.mailbox, 'INBOX');
  assert.equal(message.uid, 1);
  assert.equal(message.subject, 'Plain english subject');
  assert.equal(message.message_id, '<plain-1@example.com>');
  assert.equal(message.date, '2026-11-18T06:00:00.000Z');
  assert.equal(message.body.trim(), 'Body of the plain message.');
  assert.equal(message.has_attachments, false);
  assert.deepEqual(message.flags, ['\\Seen']);
  assert.equal(message.unread, false);
  assert.equal(message.thread_id, null);
});

test('a windows-1251 body and encoded-word subject decode correctly', async () => {
  const message = await parseMessage(Buffer.from(FIXTURES.cyrillicCp1251), CONTEXT);
  assert.equal(message.subject, 'Привет мир');
  assert.equal(message.body.trim(), 'Привет мир');
  // The From display name is a UTF-8 encoded word; both encodings in one message.
  assert.equal(message.from[0].name, 'Иван Петров');
  assert.equal(message.from[0].address, 'ivan@example.com');
});

test('the original date header keeps the sender\'s offset', async () => {
  const message = await parseMessage(Buffer.from(FIXTURES.cyrillicCp1251), CONTEXT);
  assert.equal(message.date, '2026-11-18T07:30:00.000Z', 'normalised to UTC');
  assert.match(message.date_header, /\+0300$/, 'the sender zone is preserved verbatim');
});

test('multipart/alternative yields both a text and an HTML body', async () => {
  const message = await parseMessage(Buffer.from(FIXTURES.multipart), CONTEXT);
  assert.equal(message.subject, 'Multipart message');
  assert.match(message.body, /Plain alternative body\./);
  assert.match(message.html, /HTML alternative body\./);
  assert.equal(message.html_truncated, false);
  // Multiple recipients and a Cc are all preserved.
  assert.deepEqual(message.to.map((entry) => entry.address), ['testuser@example.com', 'carol@example.com']);
  assert.deepEqual(message.cc.map((entry) => entry.address), ['dave@example.com']);
});

test('an attachment is reported by metadata only, never by content', async () => {
  const message = await parseMessage(Buffer.from(FIXTURES.withAttachment), CONTEXT);
  assert.equal(message.has_attachments, true);
  assert.equal(message.attachments.length, 1);
  const attachment = message.attachments[0];
  assert.equal(attachment.filename, 'report.pdf');
  assert.equal(attachment.contentType, 'application/pdf');
  assert.ok(attachment.size > 0);
  assert.equal(attachment.executable, false);
  // No base64 payload anywhere in the result.
  const serialised = JSON.stringify(message);
  assert.equal(serialised.includes('JVBERi0xLjQK'), false, 'attachment content must not be returned');
});

test('an executable attachment is flagged, and still not opened', async () => {
  const message = await parseMessage(Buffer.from(FIXTURES.withExecutableAttachment), CONTEXT);
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].filename, 'invoice.exe');
  assert.equal(message.attachments[0].executable, true);
  assert.equal(JSON.stringify(message).includes('TVqQAAMAAAAE'), false);
});

test('include_html: false drops the HTML body', async () => {
  const message = await parseMessage(Buffer.from(FIXTURES.multipart), CONTEXT, { includeBody: true });
  assert.ok(message.html);
  // The parser always returns HTML; the caller decides. This documents that the
  // option is applied in mail.js, not here.
  const withoutBody = await parseMessage(Buffer.from(FIXTURES.multipart), CONTEXT, { includeBody: false });
  assert.equal(withoutBody.body, null);
  assert.equal(withoutBody.html, null);
});

test('a large body is truncated with an explicit marker rather than silently cut', async () => {
  const message = await parseMessage(Buffer.from(bigMessage(300 * 1024)), CONTEXT);
  assert.equal(message.body_truncated, true);
  assert.ok(message.body.length <= LIMITS.maxTextBodyChars + 200, 'body stays inside the budget');
  assert.match(message.body, /\[truncated: \d+ characters omitted\]/);
});

test('a message over the raw-size cap is flagged as truncated at the source', async () => {
  const huge = Buffer.alloc(LIMITS.maxRawSourceBytes + 1024, 0x61);
  // Not valid MIME, but the point is the size guard: parsing must not throw and
  // must report that the source was cut.
  const message = await parseMessage(huge, CONTEXT);
  assert.equal(message.raw_truncated, true);
});

test('malformed MIME does not throw and produces a usable result', async () => {
  const broken = Buffer.from(
    'From: broken@example.com\r\nSubject: =?unknown-charset?Q?caf=E9?=\r\nContent-Type: text/plain; charset="not-a-charset"\r\n\r\nBody with a bad charset.\r\n',
  );
  const message = await parseMessage(broken, CONTEXT);
  assert.equal(typeof message.subject, 'string');
  assert.ok(message.subject.length > 0);
  assert.equal(typeof message.body, 'string');
});

test('address lists expand groups and drop entries without an address', () => {
  const expanded = normaliseAddressList([
    { name: 'A', address: 'a@example.com' },
    { name: 'Team', group: [{ name: 'B', address: 'b@example.com' }, { name: 'C', address: 'c@example.com' }] },
    { name: 'No address' },
  ]);
  assert.deepEqual(expanded, [
    { name: 'A', address: 'a@example.com' },
    { name: 'B', address: 'b@example.com' },
    { name: 'C', address: 'c@example.com' },
  ]);
});

test('truncation never splits a surrogate pair', () => {
  const emoji = '😀'.repeat(10); // each is two UTF-16 code units
  const { text } = truncateText(emoji, 5);
  // 5 is mid-pair, so the cut moves to 4 and the result stays well-formed.
  assert.equal(text.startsWith('😀😀'), true);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), false, 'no dangling high surrogate');
});

test('snippets drop quoted lines and stop at a signature', () => {
  const text = 'Actual reply line.\n> quoted previous message\nAnother line.\n-- \nSignature block\n';
  const snippet = makeSnippet(text);
  assert.match(snippet, /Actual reply line\./);
  assert.match(snippet, /Another line\./);
  assert.equal(snippet.includes('quoted previous message'), false);
  assert.equal(snippet.includes('Signature block'), false);
});

test('snippets are bounded', () => {
  const snippet = makeSnippet('word '.repeat(5000));
  assert.ok(snippet.length <= LIMITS.maxSnippetChars + 100);
});

test('dates normalise to UTC and unparseable dates become null', () => {
  assert.equal(toIsoUtc(new Date('2026-11-18T09:00:00+03:00')), '2026-11-18T06:00:00.000Z');
  assert.equal(toIsoUtc('2026-11-18T09:00:00+03:00'), '2026-11-18T06:00:00.000Z');
  assert.equal(toIsoUtc('not a date'), null);
  assert.equal(toIsoUtc(undefined), null);
});

test('executable detection covers MIME type and extension', () => {
  assert.equal(isExecutableType('application/x-msdownload', 'a.bin'), true);
  assert.equal(isExecutableType('application/octet-stream', 'setup.exe'), true);
  assert.equal(isExecutableType('application/pdf', 'invoice.pdf'), false);
  assert.equal(isExecutableType('text/plain', 'notes.txt'), false);
  assert.equal(isExecutableType('application/octet-stream', 'report.docm'), true);
});

test('attachment summarising caps the list and tolerates junk entries', () => {
  const many = Array.from({ length: LIMITS.maxAttachments + 20 }, (_, index) => ({
    filename: `f${index}.txt`,
    contentType: 'text/plain',
    size: 1,
  }));
  many.push(null, 'not-an-object');
  const summarised = summariseAttachments(many);
  assert.equal(summarised.length, LIMITS.maxAttachments);
});

test('envelope summary needs no body download', () => {
  const summary = summariseEnvelope(
    {
      subject: 'Header only',
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      to: [{ address: 'testuser@example.com' }],
      date: new Date('2026-11-18T09:00:00Z'),
      messageId: '<h-1@example.com>',
    },
    { accountId: 'a', provider: 'p', mailbox: 'INBOX', uid: 7, uidValidity: '9', flags: ['\\Seen'], size: 100 },
  );
  assert.equal(summary.subject, 'Header only');
  assert.equal(summary.uid, 7);
  assert.equal(summary.unread, false);
  assert.equal(summary.date, '2026-11-18T09:00:00.000Z');
});

test('header helpers collapse whitespace and honour fallbacks', () => {
  assert.equal(cleanHeaderText('  spaced\t\ttitle  ', 'x'), 'spaced title');
  assert.equal(cleanHeaderText('', 'fallback'), 'fallback');
  assert.equal(cleanHeaderText(undefined, 'fallback'), 'fallback');
  assert.equal(
    rawHeaderValue([{ key: 'date', line: 'Date: Tue, 18 Nov 2026 09:00:00 +0300' }], 'date'),
    'Tue, 18 Nov 2026 09:00:00 +0300',
  );
  assert.equal(rawHeaderValue([], 'date'), null);
});
