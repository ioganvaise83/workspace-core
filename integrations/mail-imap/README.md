# Universal Mail MCP

One MCP server for **four mailboxes** — Gmail, two Yandex, one Mail.ru — over a
**single IMAP engine**, with **one set of tools**, exposed to the DeepSeek Harness
as the `mail-imap` namespace.

It can organise mail. It cannot correspond.

| Level | Meaning | State |
|---|---|---|
| `IMPLEMENTED` | code, config, packaging, approval mechanism | **yes** |
| `TESTED_OFFLINE` | 167 automated tests, mock IMAP over real TLS, no real credentials | **yes** |
| `CONFIGURED` | four real accounts with credentials and `accounts.json` | **not yet — owner action** |
| `VERIFIED_LIVE_READ` | real authorisation and reading on each of the four | **not yet — needs approval** |
| `VERIFIED_LIVE_WRITE` | a real flag/archive/move confirmed in the provider's web UI | **not yet — needs approval** |

Nothing below claims a live result. No real mailbox has been contacted.

---

## 1. What changed from the read-only version

| | read-only (previous) | universal (this) |
|---|---|---|
| Accounts | 3 (2 Yandex + Mail.ru), app passwords | 4: Gmail **XOAUTH2** + 2 Yandex + Mail.ru |
| Tools | 7, none could write | 14: 10 read + preview + apply + status + undo |
| Command policy | blanket read-only allowlist | two modes; writes permitted for organising, `EXPUNGE`/`CLOSE`/`APPEND` still impossible |
| Mailbox open | always `EXAMINE` | `EXAMINE` for reads, `SELECT` only inside an approved write |
| Confirmation | none needed | digest + out-of-band owner approval |
| Gmail | API, separate server | also **IMAP XOAUTH2**, credentials separate from the API integration |

The old `gmail-mcp` (Gmail API, `gmail.readonly`) is untouched and still
registered. See §11 for the plan to retire it, which is **not applied**.

---

## 2. What it can and cannot do

**Can** — every one of these is gated by preview, and some by approval:

| Action | What it does on the wire |
|---|---|
| `mark_read` / `mark_unread` | `UID STORE +FLAGS/-FLAGS (\Seen)` |
| `archive` | Gmail: remove the `\Inbox` label. Others: `UID MOVE` to the `\Archive` folder |
| `move_to_folder` | `UID MOVE` to an existing folder you name |
| `add_label` / `remove_label` | `UID STORE ±X-GM-LABELS` (Gmail only, `X-GM-EXT-1`) |
| `move_to_trash` | `UID MOVE` to the `\Trash` folder. **Always needs approval** |

**Cannot** — not hidden, not disabled by config; absent from the code:

- sending mail of any kind: no SMTP client, no `send`, `reply` or `forward` tool;
- drafts: `APPEND` is refused by the command policy, so a draft cannot be created
  even indirectly;
- permanent deletion: `EXPUNGE`, `UID EXPUNGE` and `CLOSE` are refused;
- emptying trash, bulk purge, creating or renaming folders, subscriptions;
- marking `\Deleted` — refused even though it is "only a flag", because your own
  mail client would then expunge it later.

---

## 3. How read-only and write are both enforced

Four layers, each independent:

**1. Tool surface.** 14 tools. Ten only read. `mail_apply_actions` is the single
tool that applies changes, and it can only execute an action from a closed enum
(`approvals.js: ACTIONS`). There is no tool whose name or arguments could express
"send" or "delete permanently".

**2. Command policy** (`readonly.js`). Every IMAP command passes a guard that
inspects the command **and its flags** before it reaches the socket:

| Mode | Permitted writes |
|---|---|
| `read` | none. Any write command is a `READ_ONLY_VIOLATION` |
| `write` | `SELECT`, `STORE` with `\Seen`/`\Flagged`/X-GM-LABELS, `MOVE` if the server says so, `COPY` only when an operation explicitly allows it |

Refused unconditionally, in both modes: `EXPUNGE`, `UID EXPUNGE`, `CLOSE`,
`APPEND`, `CREATE`, `DELETE`, `RENAME`, `SUBSCRIBE`, `UNSUBSCRIBE`. Also refused:
`STORE` with `\Deleted`, `\Answered`, `\Draft`, `\Recent`; `STORE` that clears all
flags; `STORE` with an unknown flag.

**3. MOVE, or nothing.** If a server does not advertise `MOVE`, `imapflow`
silently emulates it as **COPY + `\Deleted` + EXPUNGE**. That is exactly the
destructive path the brief forbids, and it happens *inside the library*. So the
guard sets `allowMove` from the server's own capability and refuses the command
outright when it is false. A test asserts that an account without `MOVE` refuses
to move rather than quietly deleting.

**4. `BODY.PEEK` for reads.** Reading never sets `\Seen` as a side effect. A write
sets it only when the action is `mark_read`.

Verified, not asserted: the test suite reads the flag state out of the mock
server's own store, and asserts the command stream contains no `EXPUNGE`, no
`CLOSE` and no `APPEND`.

---

## 4. The approval mechanism

> The confirmation must not rest on the model's textual promise.

**How it works**

1. `mail_preview_actions` validates the plan against live server state and returns
   a **digest**: SHA-256 over the canonical plan — each item's action, account,
   mailbox, UIDVALIDITY, every UID, target and label. The plan is stored
   server-side with a 15-minute expiry.
2. `mail_apply_actions` requires that digest. It **recomputes** it from the
   submitted plan and compares. Swapping an account, one UID, the folder, the
   label or the action all produce a different digest and are refused with
   `PREVIEW_MISMATCH`. Nothing is written.
3. For plans that need it, a **separate** owner approval is required, produced
   outside the agent:

   ```bash
   sh scripts/mail-approve.sh <digest>
   ```

   That writes `runtime/mail-imap/state/approvals/approval-<digest>.json` — a
   directory **not mounted into the harness**. The harness has no host access and
   no docker socket, so the agent cannot create that file. Approval is therefore
   something the owner does, not something the agent claims.

**When approval is required**

| Condition | Approval |
|---|---|
| any `move_to_trash` | always, even one message |
| more than `batchThreshold` messages (default 5) | yes |
| plan spanning more than one account | yes |
| a single small organising action on one account | no — the digest check is enough |

Without the approval, `mail_apply_actions` returns `APPROVAL_REQUIRED` and says
exactly which command to run. It does not proceed, and it does not send a
notification pretending the user agreed.

**Single use.** An approval is consumed on execution; a second attempt gets
`APPROVAL_ALREADY_USED`. An executed plan cannot be replayed either.

**What this is not.** It is not protection against someone with host access, and
it does not replace the command policy: a fully approved plan still cannot
`EXPUNGE`, because the policy refuses it earlier. Approval authorises a plan; the
policy decides what a plan may contain.

---

## 5. Tools

| Tool | Kind | Purpose |
|---|---|---|
| `mail_list_accounts` | read | accounts, provider, status, capabilities. No secrets, masked login |
| `mail_get_account_status` | read | one account: connection, writes enabled, folder layout, IMAP capabilities |
| `mail_list_folders` | read | mailboxes with special-use hints |
| `mail_list_labels` | read | Gmail labels, or `UNSUPPORTED` where the provider has folders not labels |
| `mail_search` | read | `query`, `from`, `to`, `subject`, `since`, `before`, `unread_only`, `limit` |
| `mail_get_message` | read | one message by UID + UIDVALIDITY: headers, text, HTML, attachment metadata |
| `mail_list_recent` | read | newest messages over a period |
| `mail_get_conversation` | read | **header** groups by Message-ID/In-Reply-To/References |
| `mail_get_daily_summary_data` | read | normalised data for a period, with a reopenable `ref` per message |
| `mail_get_attachment_metadata` | read | attachment names/types/sizes; flags executables. No content |
| `mail_preview_actions` | read | validate + digest + summary. Changes nothing |
| `mail_apply_actions` | **write** | execute an approved plan |
| `mail_get_operation_status` | read | the journal of one operation |
| `mail_undo_operation` | **write** | reverse what is reversible |

**`mail_get_conversation` is honest about what it is.** IMAP has no thread model.
It groups by the standard headers **within one folder**, returns only groups with
more than one message, and says so in the payload. A reply whose client omitted
`References` is not linked. It is never presented as a Gmail API thread.

**Search is IMAP search.** No relevance ranking; `query` maps to `TEXT`
(headers+body); `SINCE`/`BEFORE` are day-granular. The tool description says so.

---

## 6. Per-provider behaviour

The brief's rule: providers may differ only at the IMAP capability level. In
practice the differences are these, and each is detected, not assumed.

### Gmail (`gmail-personal`)

- **Auth:** `AUTHENTICATE XOAUTH2` with scope **`https://mail.google.com/`**.
  This is the only scope that works for Gmail IMAP. The existing
  `gmail.readonly` token **cannot** be reused — a different scope, a different
  consent, separate files.
- **Archive:** removing the `\Inbox` label (`X-GM-LABELS`), not moving the
  message. It stays in All Mail with its other labels intact. Copying it anywhere
  would duplicate it; deleting it would lose it.
- **Labels:** `X-GM-LABELS` add/remove, when `X-GM-EXT-1` is advertised.
- **Trash:** requires `\Trash` from SPECIAL-USE and owner approval.
- **Caveat:** Gmail surfaces system categories and the `[Gmail]/…` hierarchy as
  folders. `mail_list_labels` distinguishes system from user labels; treat
  `[Gmail]/All Mail`, `[Gmail]/Trash` as infrastructure.

### Yandex (`yandex-1`, `yandex-2`)

- **Auth:** app password per account. IMAP must be enabled in Mail settings.
- **Archive:** `UID MOVE` into the folder marked `\Archive`. If none is marked and
  `archivePath` is not configured → `NOT_CONFIGURED`, never a guess.
- **Labels:** none; use `move_to_folder` to the folders Yandex exposes.

### Mail.ru (`mailru-1`)

- **Auth:** app password; IMAP must be enabled in the web settings.
- Same folder semantics as Yandex. Mail.ru marks some folders with SPECIAL-USE and
  some are localised (e.g. «Корзина»); that is exactly why the resolved path is
  reported rather than assumed.

### Folder roles, resolved not guessed

`mail_get_account_status` reports the layout it resolved and the source of each
answer. The order is: server SPECIAL-USE → explicit `archivePath`/`trashPath` in
`accounts.json` → refuse. A folder literally named "Archive" that the server does
not mark as `\Archive` is **not** used.

---

## 7. Setup

### 7.1 Gmail IMAP OAuth (the only scope that works)

This needs a conscious decision, so it is stated plainly: **the scope is
`https://mail.google.com/`, which grants full mailbox access.** There is no
narrower scope that works with Gmail IMAP. The tool restrictions in this server
are what bounds it afterwards. If that trade is not acceptable, skip the Gmail
account — the other three work without it.

1. Google Cloud console: use (or create) a project and enable the Gmail API.
2. Create an OAuth client of type **Desktop app**, download the JSON.
3. Put it at `runtime/mail-imap/oauth/gmail-imap-client.json`.
4. Authorise once **on the host** and write the refresh-token document:

   ```powershell
   node scripts\gmail-imap-authorize.mjs `
     --client runtime\mail-imap\oauth\gmail-imap-client.json `
     --token  runtime\mail-imap\state\oauth\gmail-imap-token.json
   ```

   It prints a URL, you paste back the code, and it writes the token file with the
   `https://mail.google.com/` scope. It refuses to write a token with any other
   scope, so the mistake in 7.1's warning cannot be made silently.

5. **Refresh-token caveat.** While the OAuth consent screen is in **Testing**,
   Google expires refresh tokens after **7 days**, so the account needs
   re-authorisation weekly. Publishing the app (verification) removes that, at the
   cost of the verification process. Plan for periodic re-authorisation; do not
   assume it works forever.

### 7.2 Yandex app passwords

Web interface → *Security* → *App passwords* → create one for **Mail (IMAP)**.
Enable IMAP under *Mail settings → Mail clients* first. Two accounts need two
separate app passwords.

### 7.3 Mail.ru app password

*Security* → *Passwords for external applications* → create for **IMAP**. Enable
IMAP in the mail settings. Use the app password, never the account password.

### 7.4 Files and commands (PowerShell, on the host)

```powershell
cd ~\ai\workspace-core
New-Item -ItemType Directory -Force runtime\mail-imap\secrets | Out-Null
New-Item -ItemType Directory -Force runtime\mail-imap\oauth   | Out-Null
New-Item -ItemType Directory -Force runtime\mail-imap\state   | Out-Null
Copy-Item integrations\mail-imap\accounts.example.json runtime\mail-imap\accounts.json

# one file per password account, each containing ONLY the app password:
#   runtime\mail-imap\secrets\yandex-1.password
#   runtime\mail-imap\secrets\yandex-2.password
#   runtime\mail-imap\secrets\mailru-1.password

docker compose build mail-imap-mcp
docker compose up -d mail-imap-mcp
docker compose exec harness sh /workspace/core/scripts/mail-imap-status.sh
```

**Do not** run `docker compose up -d` for the whole stack yet: recreating
`harness` is a separate decision (§12).

---

## 8. Configuration

`accounts.json` (read-only bind mount, no secrets):

```json
{
  "version": 1,
  "defaults": { "batchThreshold": 5, "maxResults": 25 },
  "accounts": [
    { "id": "gmail-personal", "provider": "gmail", "user": "me@gmail.com",
      "authType": "xoauth2",
      "oauth": { "clientFile": "/config/oauth/gmail-imap-client.json",
                 "tokenFile": "/state/oauth/gmail-imap-token.json" },
      "allowWrites": true },
    { "id": "yandex-1", "provider": "yandex", "user": "a@yandex.ru",
      "passwordFile": "/run/secrets/mail-imap/yandex-1.password",
      "allowWrites": true },
    { "id": "yandex-2", "provider": "yandex", "user": "b@yandex.ru",
      "passwordFile": "/run/secrets/mail-imap/yandex-2.password",
      "allowWrites": true, "archivePath": "Archive" },
    { "id": "mailru-1", "provider": "mailru", "user": "c@mail.ru",
      "passwordFile": "/run/secrets/mail-imap/mailru-1.password",
      "allowWrites": false }
  ]
}
```

| Field | Meaning |
|---|---|
| `authType` | `password` (default) or `xoauth2` |
| `passwordFile` / `oauth` | exactly one; paths only, never a secret value |
| `allowWrites` | **opt-in**. An account added for reading grants no writes |
| `archivePath` / `trashPath` | explicit folder role, used when SPECIAL-USE is absent |
| `batchThreshold` | per-plan message count above which approval is mandatory |

**A fifth account needs only an entry here.** No code change, no new container.

### Where secrets live

| Secret | Path | Never in |
|---|---|---|
| App passwords | `runtime/mail-imap/secrets/<id>.password` | compose, registry, README, Knowledge, image, logs |
| Gmail client JSON | `runtime/mail-imap/oauth/gmail-imap-client.json` | Git, image |
| Gmail refresh token | `runtime/mail-imap/state/oauth/gmail-imap-token.json` | Git, image, **the Gmail API integration's directory** |
| Bridge token | `dsh-home` volume, minted by `mail-token` | `.env`, Git |

The OAuth token lives in the **state** volume because refresh must write.
`runtime/` is git-ignored; nothing above is in the image.

---

## 9. Diagnostics

```bash
sh scripts/mail-imap-status.sh                  # per-account verdict
sh scripts/mail-imap-status.sh --json           # machine-readable
sh scripts/mail-imap-status.sh --show-subjects  # opt in to subjects
```

Eleven checks per account — process, endpoint, `tools/list`, configuration, TLS,
authorisation, INBOX, search, read, flags unchanged, DSH registration — reported
per account with statuses `NOT_CONFIGURED`, `CONNECTION_FAILED`, `AUTH_FAILED`,
`MCP_UNAVAILABLE`, `READ_ONLY_CHECK_FAILED`, `HEALTHY`. It never prints a
password, a token or a body.

---

## 10. Tests

```bash
cd integrations/mail-imap && npm test
```

**167 tests**, no credentials, no network beyond `127.0.0.1`. `imapkit` provides a
strict IMAP4rev1 server over real TLS, with `MOVE`, `UIDPLUS`, `SASL-IR`,
`XOAUTH2` and `X-GM-EXT-1` selectable per test, and exposes its own flag store so
assertions read state out of band.

| Area | Covered |
|---|---|
| Policy | every forbidden verb in both modes; `\Deleted` refused; non-PEEK fetch refused; `UID` prefix resolved; `MOVE`-less server refuses to move |
| Approval | digest covers action/account/mailbox/UIDVALIDITY/UIDs/target/label; substitution of each refused; single use; expiry; cross-digest isolation; disabled store fails closed |
| Execution | mark read/unread really applied and verified; archive by label (Gmail) and by move (folder); trash needs approval; journal; undo; replay refused |
| Failure modes | renumbered mailbox, vanished UID, unreachable host, bad password, untrusted certificate, `MOVE` unsupported, folder absent, `allowWrites` off |
| XOAUTH2 | SASL string format, cached token, refresh + persistence, revoked token, wrong scope, missing refresh token, hang, **real handshake against the mock server** |
| Accounts | four configure independently, one broken does not stop others, fifth needs config only, mixed credentials rejected |
| Platform | registry, bootstrap idempotency, Gmail-only degradation, compose hardening, approval dir not mounted into the harness, no docker socket |

---

## 11. Retiring the old Gmail MCP — plan, NOT applied

`gmail-mcp` (Gmail API) stays running and registered until a live test of this
server has been confirmed by the owner. After that:

1. Confirm `mail_search` / `mail_get_message` work on `gmail-personal` and that a
   write was verified in the Gmail web UI.
2. Set `"enabled": false` on the `gmail` entry in `integrations/registry.json`.
   The bootstrap drops the registration on the next harness start; the container
   may keep running harmlessly.
3. Stop the container: `docker compose stop gmail-mcp` (not `rm`).
4. Keep the OAuth material at `~/.gmail-mcp` **and** the `gmail-mcp` service
   definition for at least a month, so reverting is a one-line change.
5. Only then consider removing the service, and only with explicit approval.

Nothing in this repository has been changed to start that process.

---

## 12. Rollback

1. `git checkout -- compose.yaml integrations/registry.json README.md docs/`
2. `git clean -fd integrations/mail-imap scripts/mail-approve.sh`
3. Optionally delete `runtime/mail-imap/` (credentials and journals).
4. `docker compose up -d` — the bootstrap rewrites the profile without this
   integration.

`gmail-mcp` is unaffected at every step.

---

## 13. Limitations, stated plainly

- **Nothing is live-tested.** Gmail XOAUTH2 is proven against a mock server that
  implements the same SASL exchange, not against Google.
- **The Gmail scope is broad** (`https://mail.google.com/`) and unavoidable for
  IMAP. Testing-mode refresh tokens expire after 7 days.
- **Google may throttle or block IMAP** for some account types; Workspace admins
  can disable it entirely.
- **One connection per tool call.** Simple and stateless; costs a TLS handshake
  per call. Yandex login rate limits could make a bounded cache the next step.
- **`uidvalidity` must be passed** to every write; without it the plan is refused,
  because a UID alone can point at a different message after a renumber.
- **Undo is best-effort.** A move is reversible only while the moved message keeps
  its UID; a message you deleted in your own mail client cannot be restored.
- **No permanent delete, ever.** Trash is reached by move; the provider's
  retention policy governs what happens next.
- **Conversations are header groups**, not provider threads.
- **Message content is untrusted.** Instructions inside a message are data; no tool
  here can act on them.
- **The approval is only as strong as the host.** Someone with shell access there
  can approve anything. That is the intended trust boundary.

---

## 14. Security summary

| Concern | Handling |
|---|---|
| Sending / replying / forwarding | no SMTP code, no tool, no `APPEND` |
| Drafts | `APPEND` refused by policy |
| Permanent deletion | `EXPUNGE`, `CLOSE`, `\Deleted` all refused |
| Accidental mass change | batch ceiling 50, approval above 5 |
| Model claims "user approved" | impossible: approval is a host-side file the agent cannot write |
| Substituted plan after review | digest over the exact plan, recomputed at apply |
| Credentials in Git / logs / model | paths only; never logged; login masked |
| Gmail API integration breakage | separate client, separate token, separate directory |
| TLS downgrade | `rejectUnauthorized: true`, TLSv1.2 floor, cleartext refused |
| Prompt injection from mail | no write path that a message could authorise |
