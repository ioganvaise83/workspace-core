# Built-in MCP integrations

The platform ships with working MCP integrations out of the box. A user clones
the repository, runs `docker compose up -d --build`, connects their accounts and
gets a working AI platform. No hand editing of DSH internals.

Gmail is the first such integration; GitHub is next. This document describes the
pattern so a second integration is a small, mechanical change.

## Anatomy of a built-in integration

Four pieces, each in a predictable place:

| Piece | Location | Role |
|---|---|---|
| Service | `compose.yaml` | one container, no published ports, internal network only |
| Image + allowlist | `integrations/<name>/` | `Dockerfile` and `entrypoint.sh` with `--tools` filtering |
| Registry entry | `integrations/registry.json` | declares id, serverName, url, token file |
| Credentials | host, e.g. `~/.gmail-mcp` | bind-mounted read-only; never in Git |

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

## Status

Implemented: Gmail (read-only), registration bootstrap, token initialisation,
status reporting.

Planned: GitHub, and a knowledge plugin (see `plugins/knowledge/README.md`).
