# Gmail integration — built-in, read-only

Status: built in and wired automatically. Verified 2026-11-13 against
`@klodr/gmail-mcp@3.0.0`, `supergateway@4.2.2` and DSH 0.2.1-rc.3.

Gmail is the first of the platform's built-in MCP integrations. It ships in the
main `compose.yaml`: `docker compose up -d --build` starts it next to the
harness, and the harness registers its tools on every boot with no hand editing
of DSH files. Adding GitHub later follows the same path — see
`integrations/registry.json`.

## Access model

**`gmail.readonly`, nothing else.** The agent reads and searches mail; the owner
writes and sends every message personally.

This is a deliberate narrowing of the earlier draft, which proposed "read + create
drafts". Drafts would require `gmail.compose`, and that scope also allows sending
(`Manage drafts and send emails`). A read-only token cannot be talked into sending
a message, so the narrower scope is the one used.

Consequence worth stating plainly: **with `gmail.readonly` the agent cannot apply
Gmail labels.** Applying or removing a label is `users.messages.modify`, which
requires `gmail.modify` — and Google documents `gmail.modify` as "Read, compose,
and send emails from your Gmail account". So "sort mail into folders" and
"cannot send" are mutually exclusive under this scope choice. This integration
implements the read-only half; label-based sorting stays manual until a decision
is made to accept a sending-capable token (which would then have to be held back
by the container-side allowlist alone).

What the agent *can* do:

| Capability | Tool |
|---|---|
| Search messages | `search_emails` |
| Read one message | `read_email` |
| Read a whole thread | `get_thread` |
| List inbox threads | `list_inbox_threads` |
| Inbox with thread summaries | `get_inbox_with_threads` |
| List label names | `list_email_labels` |
| Save one attachment | `download_attachment` |

## Files here

| File | Role |
|---|---|
| `Dockerfile` | Node 24 image with the pinned `gmail-mcp` and `supergateway` |
| `entrypoint.sh` | Tool allowlist + startup guards, then launches supergateway |

The service definition is in the root `compose.yaml` as `gmail-mcp`, so a single
`docker compose up -d --build` covers the whole platform. There is no separate
Compose file for this integration: it is a built-in service, not an add-on.

## Why two independent barriers

1. **Scope (`gmail.readonly`)** — Gmail itself rejects any write call. This holds
   even if a tool name is invented or the allowlist is edited by mistake.
2. **`--tools` allowlist in `entrypoint.sh`** — write tools never enter the list
   the model sees. Measured: klodr exposes 11 tools under `gmail.readonly`; the
   allowlist narrows that to 7 by removing `download_email`,
   `download_all_attachments`, `get_draft` and `list_drafts`.

Neither barrier is sufficient alone if the threat model changes, so both stay.

## Verified behaviour

Tested with placeholder OAuth files (no real mailbox involved):

| Check | Result |
|---|---|
| Tools exposed through the bridge | 7, all read-only |
| `send_email` call | `Unknown tool: send_email` |
| `modify_email` call | `Unknown tool: modify_email` |
| Request without API key | HTTP 401 |
| `/healthz` | HTTP 200 |
| Start without `SUPERGATEWAY_API_KEY` | exits 1 with a FATAL message |
| klodr under bare `gmail.readonly` | 11 tools; no send, no label writes |

Not tested: a real OAuth consent, and the image build itself — Docker is not
available inside the agent container.

## klodr behaviour worth knowing

These were established by testing `@klodr/gmail-mcp@3.0.0` directly. They explain
several behaviours that otherwise look like bugs.

**Without any OAuth file the server still starts, but `tools/list` fails.** klodr
boots in "lazy-auth" mode and warns on stderr, yet answers `tools/list` with
`Method not found` (`-32601`) instead of a tool list. Consequence: in the
"not connected yet" state the integration registers no tools at all, rather than
registering tools that would fail. The harness is unaffected either way.

**Scope decides the tool surface, and `gmail.readonly` is genuinely read-only.**
Measured: `gmail.modify` exposes 29 tools including `send_email`, `send_draft` and
`reply_all`; `gmail.readonly` exposes 11 and contains no write tool whatsoever —
not even label application. That is why label-based sorting is impossible under
the current scope.

**A bare `[]` in `paired.json` breaks recipient pairing.** The file must have the
shape `{"version":1,"addresses":[],"updatedAt":"..."}`. klodr validates the
structure, so a bare array is rejected and the check fails with an error instead
of refusing safely — a fail-open shape that must not be used as a second barrier.

**`GMAIL_MCP_DRY_RUN=true` is not a usable permanent guard.** It blocks every
write tool including `modify_email`, so it would disable sorting along with
sending. It is a debugging switch, not a security control.

**`GMAIL_MCP_RATE_LIMIT_send` cannot be set to zero.** klodr's `parseOverride`
rejects values below 1, so `0/day` is invalid; the minimum meaningful value is 1.

**The `--tools` list is not a network filter.** It controls what the model sees.
The server process itself holds whatever scope the token grants, so with a
`gmail.modify` token it could technically send mail; the barrier is the absence of
the tool from the list. This is why the scope is kept at `gmail.readonly`: with it
the barrier does not have to carry the whole weight.

**Audit log.** When `GMAIL_MCP_AUDIT_LOG` points at a writable path,
`audit.jsonl` is appended there (mode 0600). The shipped Compose file leaves it
inside the mounted state directory.

## Connecting your account (one time)

Authorization happens **on the host**, never inside a container: Google only
accepts a loopback callback, and the token must not live in Git or in an image.

1. **Download an OAuth client** of type *Desktop app* from Google Cloud Console
   and place it on the host:

   ```bash
   mkdir -p ~/.gmail-mcp
   cp ~/Downloads/client_secret_*.json ~/.gmail-mcp/gcp-oauth.keys.json
   chmod 600 ~/.gmail-mcp/gcp-oauth.keys.json
   ```

2. **Authorize with the read-only scope only:**

   ```bash
   npx -y @klodr/gmail-mcp@3.0.0 auth --scopes=gmail.readonly
   chmod 600 ~/.gmail-mcp/credentials.json
   ```

   Note: `auth` without `--scopes` defaults to `gmail.modify` + `gmail.settings.basic`,
   which would make the token send-capable. Always pass the flag.

3. **Restart just the integration:**

   ```bash
   docker compose up -d gmail-mcp
   docker compose exec harness /workspace/core/scripts/integration-status.sh
   ```

`$HOME/.gmail-mcp` is mounted read-only into the container
(`GMAIL_MCP_AUTH_DIR` overrides the path). With consent screen in *Testing*, the
refresh token expires after 7 days; publish the app to avoid weekly re-auth.

Until step 2 is done the platform still works: the harness boots, and
`integration-status.sh` reports `NOT CONNECTED` with the exact command to run.

## How registration works

Hand editing of DSH files is not required. On every start:

1. `mcp-token` (one-shot) mints a random bridge token onto the `dsh-home`
   volume outside Git.
2. `bootstrap-integrations.cjs` reads `integrations/registry.json` and writes a
   fenced block into the DSH profile's own `cordis.patch.yml`, which DSH applies
   automatically.
3. `gmail-mcp` starts and serves on the internal network only.

The harness and the integration both read the token from the same volume, so
they agree across restarts, `--build`, and container recreation.

Safety properties of the bootstrap, all verified:

- **Validated before written.** The generated patch is parsed and shape-checked
  exactly as DSH does (`top-level array`, every element a mapping). If validation
  fails, nothing is written and the harness starts anyway.
- **No stray `[]`.** A flow sequence may not follow block entries; the empty-array
  placeholder is emitted only when the document has no entries, and removed before
  entries are appended. This was the cause of the earlier `YAMLException`.
- **Idempotent.** Our fenced block and any stray `mcp-*` entries are stripped
  before writing, so reruns cannot duplicate registrations and files broken by
  older versions self-heal.
- **User content preserved.** Only top-level items belonging to the bootstrap are
  removed; everything else is kept byte for byte.
- **Atomic with backup.** The new file is written to a unique temp path and
  renamed into place; the previous content is saved to
  `cordis.patch.yml.workspace-core.bak`.
- **Never blocks startup.** Every failure path logs and exits 0, and compose runs
  it with `|| true`.

If the profile contains invalid YAML *outside* the managed block, the script
refuses to touch it and says so — rewriting would risk destroying your settings.

Because the entry is registered with `failOnStartupError: false`, a missing
OAuth consent or a stopped Gmail container never prevents the harness from
booting — the `mcp__gmail__*` tools simply do not appear.

### Verified first-boot sequence

| Step | Result |
|---|---|
| `init-token.sh` on a fresh volume | creates a 64-hex token, mode 0600 |
| bootstrap on `[]`-only profile | writes a valid overlay; DSH composes 1 entry |
| bootstrap run twice | second run reports "already current", no duplicate |
| bootstrap with missing token | writes `[]`, boots anyway, logs SKIPPED |
| DSH `--dump-config` | accepts the overlay, no error |
| gmail with token from file | 7 tools; wrong token → 401; `/healthz` → 200 |
| gmail with no OAuth at all | starts, serves; tool calls fail (Gmail rejects) |
| harness with Gmail down | boots and answers (verified on port 3399) |

Not tested here: a real OAuth consent, and the image build — Docker is not
available inside the agent container.

## Wiring into DSH (automatic)

For reference, the generated entry looks like this; you do not write it by hand:

```yaml
- insert:
    - id: mcp-gmail
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: gmail
        transport: streamable-http
        url: 'http://gmail-mcp:8765/mcp'
        headers:
          Authorization: 'Bearer <per-installation token>'
        failOnStartupError: false
```

Tools appear as `mcp__gmail__search_emails` and so on.

## Recovery

The bootstrap is safe to enable: it validates before writing, keeps a backup and
cannot block startup. If you disabled it after the earlier YAMLException, restore
in this order.

1. **Inspect what is on the volume** (read-only, safe):

   ```bash
   docker compose exec harness ls -la /home/node/.dsh/profiles/web/
   docker compose exec harness cat /home/node/.dsh/profiles/web/cordis.patch.yml
   ```

2. **Choose the source of truth.** If `cordis.patch.yml.broken` holds settings you
   want back, compare it with the live file first — the live file is the one the
   harness actually uses:

   ```bash
   docker compose exec harness diff \
     /home/node/.dsh/profiles/web/cordis.patch.yml.broken \
     /home/node/.dsh/profiles/web/cordis.patch.yml
   ```

3. **Dry-run the registration** without touching the live profile, by pointing the
   script at a copy:

   ```bash
   docker compose exec harness sh -c '
     mkdir -p /tmp/dry/profiles/web
     cp /home/node/.dsh/profiles/web/cordis.patch.yml /tmp/dry/profiles/web/
     cp -r /home/node/.dsh/bootstrap /tmp/dry/ 2>/dev/null || true
     DSH_HOME=/tmp/dry node /workspace/core/scripts/bootstrap-integrations.cjs
     cat /tmp/dry/profiles/web/cordis.patch.yml'
   ```

   A repaired file must show your entries unchanged plus one fenced block.

4. **Validate before booting.** `dsh --dump-config` parses the profile exactly as
   boot does, so it fails loudly on bad YAML without starting anything:

   ```bash
   docker compose exec harness \
     dsh web --patch /opt/deepseek-harness/web.cordis.patch.yml --dump-config >/dev/null \
     && echo "profile parses"
   ```

5. **Re-enable in compose** — the `harness` entrypoint already calls the script;
   if you removed that call, restore these lines:

   ```yaml
   entrypoint:
     - /usr/bin/tini
     - --
     - /bin/sh
     - -c
     - |
       node /workspace/core/scripts/bootstrap-integrations.cjs || true
       exec /usr/local/bin/deepseek-harness-entrypoint "$@"
     - sh
     - web
     - --patch
     - /opt/deepseek-harness/web.cordis.patch.yml
     - --no-open
   ```

6. **Recreate the harness** (this is the only step that restarts anything):

   ```bash
   docker compose up -d harness
   docker compose exec harness /workspace/core/scripts/integration-status.sh
   ```

To roll back, restore the backup and restart:

```bash
docker compose exec harness cp \
  /home/node/.dsh/profiles/web/cordis.patch.yml.workspace-core.bak \
  /home/node/.dsh/profiles/web/cordis.patch.yml
```

## Diagnostics

`scripts/integration-status.sh` reports four independent layers, because one
"connected / not connected" flag hides which part actually failed:

| Layer | Question | What proves it |
|---|---|---|
| Bridge | Is the gateway answering? | HTTP 200 on `/healthz` |
| Tools | Does the server publish a tool list? | `tools/list` returns tools |
| Gmail API | Does a credential really work? | `list_email_labels` returns labels |
| DSH registration | Does the harness know the server? | `mcp-gmail` in the booted profile |

Run it inside the harness:

```bash
docker compose exec harness /workspace/core/scripts/integration-status.sh
```

It exits non-zero when any layer fails, so it also works in scripts.

### Why it no longer looks for OAuth files

An earlier version checked `/home/node/.gmail-mcp` from inside the harness and
reported `OAuth token: missing` even when Gmail worked perfectly. That path is
mounted **only** into the `gmail-mcp` container: the harness cannot see it, so
the check measured the wrong filesystem and produced a false negative.

Mounting the credentials into the harness to satisfy the diagnostic was the
obvious "fix" and the wrong one — it would put a working read token into a second
container for no functional gain. The script now asks the service instead, which
is the only authority on whether Gmail works.

### `/healthz` is not a Gmail check

The health endpoint is served by supergateway before klodr touches Gmail. It
returns 200 with no credentials, an expired token, or a revoked grant. Treating
it as proof of connectivity is exactly the mistake the layered report prevents.

The real credential check is `list_email_labels`: the cheapest genuine Gmail API
call, which reads no message and modifies nothing, yet fails immediately on a
dead token.

### Token handling

The bridge token is read from a file inside the harness and passed to `curl`
through a `-K` config file on stdin, so it never appears in the process table,
in logs, or in the report. The diagnostic prints tool names and label counts
only — never message content, never the token.

## Corporate TLS inspection (optional)

A proxy that re-signs HTTPS — Kaspersky Endpoint Security, Zscaler, a corporate
gateway — makes `npm install` fail with `SELF_SIGNED_CERT_IN_CHAIN` while the
image is built, and can also break the Gmail API calls afterwards.

Both are handled by one host setting, `CUSTOM_CA_PATH` in `compose.yaml`'s
`.env`. It is unset by default and nothing changes when it is.

| Stage | Mechanism | Lifetime |
|---|---|---|
| `npm install` | BuildKit secret `custom-ca`, mounted at `/run/secrets/custom-ca` | one `RUN`; in no layer |
| Runtime | `NODE_EXTRA_CA_CERTS=/home/node/custom-ca.pem` | process lifetime |

The certificate is never `COPY`-ed, never an `ARG`, and never committed: the
repository contains only `integrations/ca/empty-ca.pem`, a zero-byte placeholder
that keeps the secret source resolvable for users without inspection.

Verification is never weakened. `NODE_EXTRA_CA_CERTS` adds a root to the store;
it does not disable checks or make every host trusted. `strict-ssl=false` and
`NODE_TLS_REJECT_UNAUTHORIZED=0` are absent on purpose and should stay absent —
either one disables verification for every host, which turns the container into
an open target for anyone on the network path.

The guard is `[ -f X ] && [ -s X ]`, not `-s` alone: a mistyped
`CUSTOM_CA_PATH` makes Docker create a *directory* as the bind source, and a
directory passes `-s` while making Node fail at startup.

To confirm the CA is actually in use, check the container log at start:

```bash
docker compose logs gmail-mcp | grep "trusting extra CA"
```

No such line means the file was empty, missing, or not a regular file.

## Operational notes

- Container runs as the unprivileged `node` user with `read_only: true`,
  `cap_drop: ALL` and `no-new-privileges`.
- OAuth material is bind-mounted read-only; it is never baked into the image.
- State, downloads and attachments live outside Git via bind mounts.
- Rotating the bridge token: delete `dsh-home/bootstrap/gmail-bridge.token` and
  run `docker compose up -d`; the `mcp-token` service mints a new one and the
  bootstrap re-registers with it.
- Changing versions: edit the pinned tags in `Dockerfile` and rebuild.
- Deleting the container does not touch `~/.gmail-mcp` on the host.
