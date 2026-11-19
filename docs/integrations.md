# Built-in MCP integrations

The platform ships with working MCP integrations out of the box. A user clones
the repository, runs `docker compose up -d --build`, connects their accounts and
gets a working AI platform. No hand editing of DSH internals.

Gmail was the first such integration, IMAP the second, GitHub is next. This
document describes the pattern, and where it had to bend for IMAP: the two
integrations share the registration mechanism, the token mechanism and the
security posture, and differ in credential shape, tool naming and diagnostics.
Knowing which parts are the pattern and which are Gmail-specific is what makes a
third integration small.

## Anatomy of a built-in integration

Four pieces, each in a predictable place:

| Piece | Location | Role |
|---|---|---|
| Service | `compose.yaml` | one container, no published ports, internal network only |
| Source | `integrations/<name>/` | `Dockerfile`, an `entrypoint.sh`, and the server itself |
| Registry entry | `integrations/registry.json` | declares id, serverName, url, token file |
| Token | one-shot `*-token` service | mints a per-integration token onto `dsh-home` |
| Credentials | host (e.g. `~/.gmail-mcp`, `runtime/mail-imap/`) | bind-mounted read-only; never in Git |

The bootstrap script turns the registry into a DSH patch overlay, so the harness
learns about the integration without anyone editing DSH files.

## Invariants

These hold for every integration. They are the reason the platform stays usable
for someone who has connected nothing yet.

1. **The harness boots without any integration.** Entries register with
   `failOnStartupError: false`; a missing container or a missing OAuth consent
   only means the tools are absent.
2. **No published ports.** Integrations listen on the compose network only.
   The single loopback port belongs to the harness.
3. **Credentials live outside Git.** Bind-mounted read-only from the host, with
   a documented path and a `chmod 600` step.
4. **Local state outside Git.** Downloads, attachments and counters go to
   `./runtime/<name>/`, excluded from version control.
5. **Least privilege, twice.** The OAuth scope is the narrowest that works, and
   the `--tools` allowlist removes everything else from the model's tool list.
   Two independent barriers, because either can be edited by mistake.
6. **A per-installation secret, generated not configured.** The `mcp-token`
   service mints it onto the `dsh-home` volume. The user never copies a token.
7. **Registration is idempotent.** Restarting, rebuilding or recreating
   containers re-registers without duplicating entries or touching user settings.
8. **Unconnected is a visible state, not a failure.** `scripts/integration-status.sh`
   reports `NOT CONNECTED` and prints the exact command to fix it.

## What is shared, and what is not

Shared by both integrations — copy these freely:

- **Registration**: `registry.json` → `bootstrap-integrations.cjs` → a
  `streamable-http` `mcp-client` entry with `failOnStartupError: false`.
- **Transport**: Streamable HTTP on a compose-internal port, no host mapping.
- **Token**: minted by `init-token.sh` with a different `TOKEN_NAME`, mounted
  read-only. Each integration gets its **own** token, so one leak opens one door.
- **Container posture**: `read_only`, `cap_drop: ALL`,
  `no-new-privileges`, non-root user, log rotation.
- **Secret placement**: bind-mounted files outside Git, never environment values.

Deliberately different, because the integrations differ:

- **Tool surface and naming.** Gmail's tools are named by its upstream package
  (`search_emails`, …) and filtered with `--tools`. IMAP tools are written here
  and named `mail_*` so the two namespaces cannot collide. Neither server's tool
  names are reused by the other.
- **Credential shape.** Gmail: an OAuth client file plus a refresh token. IMAP:
  one app password file per account, because there is no OAuth across Yandex and
  Mail.ru that the owner can set up without a registered application.
- **Cardinality.** Gmail is one account. IMAP is N accounts with independent
  failure states, so its diagnostics report per account
  (`scripts/mail-imap-status.sh`) and its `--tools`-style allowlist is replaced
  by a code-level tool definition plus an IMAP command guard.
- **The second safety barrier.** Gmail's second barrier is the OAuth scope:
  `gmail.readonly` physically cannot send. IMAP has no equivalent server-enforced
  scope, so the second barrier is built in code: a command guard that inspects
  every command and its flags, `EXAMINE` and `BODY.PEEK` for reads, and
  unconditional refusal of `EXPUNGE`, `CLOSE`, `APPEND` and `\Deleted`.
- **Organising is allowed; corresponding is not.** The mail integration now
  permits flag, archive, move, label and trash actions, but each one must be
  previewed into a digest and applied with that digest, and some need an approval
  the owner produces outside the harness. That two-part shape — a server-side
  digest plus an approval the agent cannot mint — is the pattern for any future
  integration where the agent may act but not authorise itself.

## Adding GitHub

1. Create `integrations/github/` with a `Dockerfile` and an `entrypoint.sh` that
   applies a `--tools` allowlist for the read-only GitHub tools.
2. Add a `github-mcp` service to `compose.yaml`, modelled on `gmail-mcp`: no
   `ports`, `expose` only, `read_only: true`, `cap_drop: ALL`, state under
   `./runtime/github/`.
3. Append one object to `integrations/registry.json`:

   ```json
   {
     "id": "github",
     "enabled": true,
     "serverName": "github",
     "url": "http://github-mcp:8765/mcp",
     "tokenFile": "github-bridge.token"
   }
   ```

4. Extend `scripts/init-token.sh` invocation in `compose.yaml` if a second token
   is needed (run it twice with different `TOKEN_NAME`), or generalise it to mint
   one token per registry entry.
5. Add the token to `scripts/integration-status.sh` output.

Nothing in the harness profile is edited by hand at any point.

## Why a generated block instead of a custom bundle

The installed DSH (0.2.1-rc.3) supports `--patch <file>` overlays and applies the
profile's own `cordis.patch.yml` automatically. It has **no** environment
variable for extra overlays, and the image entrypoint accepts none. Writing a
fenced block into `cordis.patch.yml` therefore needs no image change, survives
`--build`, and keeps working when the image is upgraded.

A generated block is chosen over shipping a plugin bundle because a bundle would
have to live inside the profile's `node_modules`, which is recreated by DSH and
is not part of the repository. The overlay approach keeps the source of truth in
`integrations/registry.json`, inside the repository, under review.

## Adding a second token

`init-token.sh` is already parameterised by `TOKEN_NAME`; a new integration needs
one more one-shot service, not a script change:

```yaml
  mail-token:
    image: ${DSH_IMAGE:-runzhliu/deepseek-harness:0.2.1-rc.3-r1}
    entrypoint: ["/bin/sh", "/usr/local/bin/init-token.sh"]
    environment:
      TOKEN_DIR: /dsh-home/bootstrap
      TOKEN_NAME: mail-bridge.token
    volumes:
      - dsh-home:/dsh-home
      - ./scripts/init-token.sh:/usr/local/bin/init-token.sh:ro
    user: "1000:1000"
    read_only: true
    restart: "no"
```

Then reference `mail-bridge.token` in the registry entry and mount `dsh-home:ro`
into the integration.

## Status

Implemented and verified offline: Gmail (read-only, live), Universal Mail
(read + approved organising, four accounts, tests against a mock server only),
registration bootstrap, token initialisation, per-integration status reporting,
owner-side approval tooling.

Not yet live: the Universal Mail server has not been pointed at a real mailbox.
That needs four credentials — including a new Gmail IMAP OAuth consent with the
`https://mail.google.com/` scope — and an explicit go-ahead for live testing.

Planned: GitHub, and a knowledge plugin (see `plugins/knowledge/README.md`).
