#!/usr/bin/env node
// Read-only sender analytics over the Universal Mail MCP.
//
// WHY THIS EXISTS
// ---------------
// The MCP search tool caps a single response at 25 rows while still reporting
// the true `total_matched`. Reading ~4376 messages through the chat interface
// would take ~176 round trips and fill the context with message bodies. This
// script talks to the SAME server, over the same HTTP transport and the same
// bearer token, and only collects what the analysis needs: sender address, the
// \Seen state and the date.
//
// WHAT IT NEVER DOES
//   * It only calls mail_search and mail_list_folders: no preview, no apply, no
//     undo, no message read.
//   * It never passes unread_only=false to "mark" anything: reading is done with
//     BODY.PEEK server-side, so no flag changes either way.
//   * It prints no subjects, bodies or addresses of the owner's correspondents
//     beyond the sender aggregates asked for.
//
// Pagination: IMAP SEARCH has no offset, so the mailbox is walked by DATE
// window. Each window reports its own total_matched; when a window holds more
// rows than the cap, it is split by date until every message is enumerated.

import fs from 'node:fs';

const ENDPOINT = process.env.MAIL_IMAP_MCP_URL ?? 'http://mail-imap-mcp:8765/mcp';
const TOKEN_FILE = process.env.MAIL_BRIDGE_TOKEN_FILE ?? '/home/node/.dsh/bootstrap/mail-bridge.token';
const ACCOUNTS = ['gmail-personal', 'yandex-1', 'yandex-2', 'mailru-1'];
const PAGE_CAP = 25; // the server's maxResults default; a window larger than this is split

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
let rpcId = 0;

/**
 * Call one MCP tool and return its structured result.
 *
 * Retries transport-level failures with a growing pause. A large mailbox means
 * hundreds of calls, and Yandex/Mail.ru occasionally reset a connection mid-way;
 * without a retry one reset would discard the whole account's walk. A refusal
 * that is a real answer (AUTH_FAILED, READ_ONLY_VIOLATION, ...) is NOT retried:
 * only the transient network codes are.
 */
const RETRYABLE = new Set(['CONNECTION_FAILED', 'CONNECTION_TIMEOUT', 'TIMEOUT']);

async function callTool(name, args, attempt = 1) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${name}`), { code: 'HTTP' });
    const text = await res.text();
    // Streamable HTTP answers as SSE: pick the last data: line.
    const line = text.split('\n').filter((l) => l.startsWith('data: ')).pop();
    if (!line) throw Object.assign(new Error(`no data for ${name}`), { code: 'TRANSPORT' });
    const body = JSON.parse(line.slice(6));
    if (body.error) throw Object.assign(new Error(`${name}: ${JSON.stringify(body.error)}`), { code: 'RPC' });
    const result = body.result;
    if (result && result.isError) {
      const err = (result.structuredContent && result.structuredContent.error) || {};
      throw Object.assign(new Error(`${name}: ${err.code ?? 'tool error'}`), { code: err.code ?? 'TOOL' });
    }
    return result && result.structuredContent ? result.structuredContent : result;
  } catch (error) {
    const transient = RETRYABLE.has(error.code) || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(error.cause?.code);
    if (!transient || attempt >= 6) throw error;
    const wait = Math.min(15000, 500 * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, wait));
    return callTool(name, args, attempt + 1);
  }
}

/** ISO date (UTC) for a Date, day granularity, which is what IMAP SINCE/BEFORE use. */
const isoDay = (d) => d.toISOString().slice(0, 10);

/** The date of one message, as a day string. */
const dayOf = (message) => String(message.date ?? '').slice(0, 10);

/**
 * Enumerate every message in a window, splitting by date when the cap is hit.
 *
 * @returns {Promise<{rows: object[], total: number}>}
 */
async function walkWindow(accountId, since, before, rows = [], out = { total: 0 }) {
  const result = await callTool('mail_search', {
    account_id: accountId,
    limit: PAGE_CAP,
    ...(since ? { since } : {}),
    ...(before ? { before } : {}),
  });
  const total = result.total_matched ?? 0;
  const messages = result.messages ?? [];
  out.total = total;

  // Everything fits: keep it and stop.
  if (total <= messages.length) {
    rows.push(...messages);
    return { rows, total };
  }

  // The window is larger than one page, so it must be split. BISECT by date
  // rather than splitting at the oldest returned message: the response always
  // carries the NEWEST rows, so an "oldest day" split shaves off ~25 messages per
  // level and degenerates into thousands of calls on a large mailbox. Halving the
  // range converges in log2(days) instead.
  const lo = new Date(`${since}T00:00:00Z`).getTime();
  const hi = new Date(`${before}T00:00:00Z`).getTime();
  const midMs = lo + Math.floor((hi - lo) / 2 / 86400000) * 86400000;
  const midDay = isoDay(new Date(midMs));

  // A single day cannot be halved further. Accept the newest page and record the
  // shortfall rather than looping forever.
  if (midDay <= since || midDay >= before) {
    rows.push(...messages);
    if (total > messages.length) out.shortDays = (out.shortDays ?? 0) + (total - messages.length);
    console.error(`  ${accountId}: day granularity limit at ${since}, ${total - messages.length} not enumerated`);
    return { rows, total };
  }

  await walkWindow(accountId, since, midDay, rows, out);
  await walkWindow(accountId, midDay, before, rows, out);
  return { rows, total };
}

/** Build the aggregate for one account. */
async function analyseAccount(accountId) {
  const all = { rows: [], total: 0 };
  // Bisection needs BOTH ends finite, so the range is bounded explicitly. The
  // upper bound is tomorrow: a message dated "today" must still be included, and
  // IMAP BEFORE is exclusive.
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const result = await walkWindow(accountId, '1990-01-01', isoDay(tomorrow), all.rows, all);
  const seen = new Map();
  // Deduplicate by UID: IMAP SEARCH day granularity is not perfectly exclusive at
  // a window boundary on every provider, so a message can land in both halves of
  // a bisection. Without this the totals drift upward and one sender is credited
  // with a message twice.
  const unique = new Map();
  for (const message of all.rows) {
    const key = `${message.mailbox}|${message.uid}`;
    if (!unique.has(key)) unique.set(key, message);
  }
  for (const message of unique.values()) {
    const from = (message.from && message.from[0]) || {};
    const address = String(from.address ?? '').toLowerCase().trim();
    const name = String(from.name ?? '').trim();
    if (!address) continue;
    const entry = seen.get(address) ?? { address, name, total: 0, read: 0, unread: 0 };
    entry.total += 1;
    if (message.unread === true) entry.unread += 1; else entry.read += 1;
    if (!entry.name && name) entry.name = name;
    seen.set(address, entry);
  }
  const senders = [...seen.values()].sort((a, b) => b.total - a.total);
  return {
    account_id: accountId,
    inbox_total: result.total,
    enumerated: unique.size,
    complete: unique.size === result.total,
    short_days: all.shortDays ?? 0,
    senders,
  };
}

const output = { generated_at: new Date().toISOString(), accounts: [] };
// An explicit account list lets a run be resumed for the mailbox that failed,
// instead of re-walking 500 messages that already succeeded.
const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = requested.length ? requested : ACCOUNTS;
for (const accountId of targets) {
  try {
    const data = await analyseAccount(accountId);
    output.accounts.push(data);
    console.error(`${accountId}: ${data.enumerated}/${data.inbox_total} enumerated, ${data.senders.length} senders`);
  } catch (error) {
    output.accounts.push({ account_id: accountId, error: String(error.message ?? error) });
    console.error(`${accountId}: ERROR ${error.message ?? error}`);
  }
}
console.log(JSON.stringify(output, null, 2));
