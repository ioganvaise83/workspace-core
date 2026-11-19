# Architecture decisions (v0.2)

## Repository contract

`workspace-core` is distributable and public. `workspace-knowledge` is private, selectable per host, and must be mounted at `/workspace/knowledge`. The private repo owns its Markdown content. Its `workspace.yaml` is a design proposal only; no parser or deployment automation reads it yet.

## Persistence

- DSH sessions / model settings / stored credentials: Docker named volume `dsh-home`, not in Git.
- Agent scratch files: ignored host directory `runtime/workspace`.
- Long-term Markdown knowledge: private Git repo, edited on host through Docker bind mount.

## Built-in integrations

The platform ships with working MCP integrations. One `docker compose up -d
--build` starts the harness plus one container per integration; the harness
registers their tools automatically. See `docs/integrations.md` for the pattern.

Decisions behind it:

- **One compose file.** Integrations are services in the root `compose.yaml`, not
  separate projects, so a normal user never picks which file to run.
- **Internal network only.** No integration publishes a host port; the single
  loopback port belongs to the harness.
- **Registration is generated, not hand-edited.** `integrations/registry.json` is
  the source of truth; `scripts/bootstrap-integrations.cjs` writes a fenced block
  into the DSH profile at start. This works because DSH applies the profile's own
  `cordis.patch.yml` automatically and accepts no environment variable for extra
  overlays.
- **Secrets minted locally, not configured.** A one-shot service per integration
  writes a random bridge token onto `dsh-home`, outside Git, before any other
  container reads it. Ordering matters: integrations start before the harness.
- **Optional at runtime.** Entries register with `failOnStartupError: false`, so
  an unconfigured or stopped integration never blocks the harness.
- **One token per integration.** `mail-token` mints `mail-bridge.token` next to
  Gmail's, from the same script with a different `TOKEN_NAME`. Separate tokens
  mean a leak in one integration does not authenticate against the other.
- **Destructive limits are enforced by the server, not the prompt.** Gmail's
  strongest barrier is its OAuth scope. IMAP has no equivalent credential-level
  scope, so the barrier is code: a command guard that inspects every command and
  its flags, `EXAMINE` and `BODY.PEEK` for reads, and unconditional refusal of
  `EXPUNGE`, `CLOSE`, `APPEND` and `\Deleted`. A prompt instruction is never the
  guarantee.
- **Writes are two-phase and the approval is outside the agent's reach.** A plan
  becomes a digest over the exact accounts, UIDs, folder and action; applying it
  requires that digest, recomputed and compared. Plans that are large,
  cross-account or touch trash also need an approval file that only a host-side
  script can create, in a directory the harness does not mount. This is the
  pattern for any agent action that must be authorised rather than merely asked
  for: the agent can request, never grant.

## Future work (not shipped)

1. Versioned manifest validation and agent policy loader.
2. Dedicated knowledge tools, append-only logs and conflict-safe Git sync service.
3. GitHub MCP integration, following the pattern in `docs/integrations.md`.
4. A daily mail summary task on top of `mail_get_daily_summary_data`: an
   automation layer that calls the read-only server, not a loop inside it.
5. Semantic index built from private Markdown (never the source of truth).
6. Secret-store integration and optional VPS mode.

## Trust boundaries

Public platform code is never a home for private notes. Knowledge files are user data, not privileged agent instructions from an untrusted source. Imported emails, webpages and repository documents may carry prompt injection attempts; do not let them override tool permissions.
