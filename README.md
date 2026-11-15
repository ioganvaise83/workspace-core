# Workspace Core

**Public** platform layer for a self-hosted AI workspace: Docker Compose,
DeepSeek Harness, and built-in MCP integrations that work out of the box.

> Status: working platform, evolving. DeepSeek Harness is in developer preview.
> The harness image is **community-maintained**, not an official DeepSeek image —
> review it before trusting sensitive content. Gmail is a working read-only
> integration; GitHub is a planned placeholder.

## The three areas

| Area | In container | Holds |
|---|---|---|
| `workspace-core` (this repository) | `/workspace/core` | Compose, built-in MCP integrations, scripts, platform docs |
| `workspace-knowledge` | `/workspace/knowledge` | personal notes, memory, process timelines, agent instructions |
| `workspace-apps` | `/workspace/apps` | standalone applications built by you or the agent |

Core carries **no personal data and no application business logic**. The boundary
rules and the application model are in [`docs/applications.md`](docs/applications.md).

## Repository layout

```text
compose.yaml                  one file, all services
.env.example                  documented variables, no secrets
integrations/
  registry.json               which integrations exist
  gmail/                      Dockerfile, allowlist entrypoint, docs
  github/README.md            planned
scripts/
  bootstrap-integrations.cjs  registers integrations in the DSH profile
  init-token.sh               mints the shared MCP bridge token
  integration-status.sh       layered diagnostics
  check_setup.py              non-destructive preflight
  knowledge_status.py         read-only Git status of the private repo
  apps-registry.cjs           validates and syncs workspace-apps/registry.json
docs/
  architecture.md             boundary and lifecycle decisions
  integrations.md             how to add a built-in integration
  applications.md             workspace-apps boundaries and registry
  app-development.md          mandatory policy for building applications
  agent-development.md        safe development rules
  env.example.txt             documented variables (copy to .env.example)
  app-template/               copyable skeleton for a new application
plugins/                      reusable DSH plugins (installed explicitly)
```

## Quick start

Requires Docker Desktop or Docker Engine + Compose v2, and Git. Python 3.10+ is
optional, for the preflight scripts.

1. Clone this repository and your private knowledge repository next to each other:

   ```text
   ~/ai/
     workspace-core/
     workspace-knowledge/
   ```

2. Optionally copy `.env.example` to `.env` and adjust. **Every variable has a
   working default**, so an empty `.env` is valid. Keep `.env` untracked.

   ```bash
   cp .env.example .env          # Linux/macOS
   Copy-Item .env.example .env   # PowerShell
   ```

3. Make sure `KNOWLEDGE_PATH` (default `../workspace-knowledge`) points at your
   private repository. The directory must exist before launching.

4. Create the local runtime directories so Docker does not create them as root:

   ```bash
   mkdir -p runtime/workspace runtime/gmail/state runtime/gmail/downloads runtime/gmail/attachments
   ```

   ```powershell
   'workspace','gmail/state','gmail/downloads','gmail/attachments' |
     ForEach-Object { New-Item -ItemType Directory -Force "runtime/$_" }
   ```

5. Optional preflight: `python scripts/check_setup.py`

6. Validate and start:

   ```bash
   docker compose config --quiet
   docker compose up -d --build
   docker compose logs --tail=50 harness
   ```

7. Open **http://127.0.0.1:3080** on the same machine. In Harness go to
   **Settings → Models → Add model provider → Custom model API**, enter your
   router's endpoint, protocol (typically OpenAI Chat Completions), credential and
   exact model ID. Save and select it.

8. Ask Harness to read `/workspace/knowledge/AGENTS.md` and, for example,
   `/workspace/knowledge/knowledge/vehicles/`. Auto-loading `AGENTS.md` is **not**
   configured at this stage; opening it is explicit.

Model and session settings live in the `dsh-home` Docker volume, per installation,
never in Git.

## Services

`docker compose up -d --build` starts three:

| Service | Role |
|---|---|
| `harness` | DeepSeek Harness, loopback port 3080 |
| `gmail-mcp` | read-only Gmail MCP server, internal network only, no host port |
| `mcp-token` | one-shot; mints the shared bridge token onto `dsh-home` |

Integrations start before the harness, which is why the token is minted by a
separate one-shot service rather than by the harness itself.

## Built-in integrations

Integration sources live in `integrations/`, exactly one directory per
integration. Adding one means: a service in `compose.yaml`, a source directory,
and an entry in `integrations/registry.json`. Registration in the DSH profile is
then automatic — see [`docs/integrations.md`](docs/integrations.md).

An integration that is unconfigured or down never blocks the harness: entries are
registered with `failOnStartupError: false`.

### Gmail

Read-only on the `gmail.readonly` scope: search, read a message, read a thread,
list inbox threads, list label names, download one attachment. Nothing in the
container can send, reply, forward, draft, label or delete mail — enforced twice,
by scope and by the `--tools` allowlist.

Setup requires a one-time OAuth authorization **on the host**; see
[`integrations/gmail/README.md`](integrations/gmail/README.md). Without it the
platform still works, and `scripts/integration-status.sh` reports precisely which
layer is missing.

Labels act as folders, but under `gmail.readonly` the agent cannot apply them:
labelling requires `gmail.modify`, which also permits sending. Sorting mail stays
manual by design.

## Applications

Applications live in `workspace-apps`, mounted at `/workspace/apps`, and are
independent of this repository: each has its own source, dependencies, tests and
Git history.

```bash
node /workspace/core/scripts/apps-registry.cjs list    # what exists
node /workspace/core/scripts/apps-registry.cjs check   # drift between manifests and registry
node /workspace/core/scripts/apps-registry.cjs sync    # update the registry
```

The mandatory policy for building one is
[`docs/app-development.md`](docs/app-development.md); boundaries are in
[`docs/applications.md`](docs/applications.md). A skeleton lives in
`docs/app-template/`.

## Diagnostics

```bash
docker compose exec harness /workspace/core/scripts/integration-status.sh
```

It reports four independent layers — bridge reachability, tool registration,
Gmail API authorization, DSH registration — and exits non-zero if any fails.
`/healthz` alone proves only that the gateway is up, not that Gmail works.

## Security limits

- The Web UI is bound to host loopback. Do not expose port 3080 without
  authentication, TLS and network protections.
- This is **not** a sandbox for untrusted autonomous commands. The agent can run
  commands in its writable workspace; review what it asks to do.
- The agent has write access to the private repository. Keep backups, review
  diffs, and let *you* commit and push.
- Secrets stay outside Git: model API keys, OAuth tokens, GitHub tokens, DSH
  sessions, runtime files. A private Git repository is not a vault.
- Never commit `.env`, `*.pem`, `*.key`, `credentials.json` or
  `gcp-oauth.keys.json`. `.gitignore` covers these; check before pushing anyway.

## Updates and synchronization

Synchronize each repository separately. Editing Markdown through Harness changes
files in your **local** private repository; it does not commit or push.
`scripts/knowledge_status.py` shows status and never touches history.

`docker compose down` keeps the named volume; `docker compose down -v` **deletes
DSH sessions and settings**. Back the volume up separately. A second instance has
its own DSH state. Do not edit the same Markdown from two computers at once.

## Upstream references

- Official Harness: https://github.com/deepseek-ai/deepseek-harness
- Model configuration: https://deepseek-harness.github.io/deepseek-harness/en/guide/providers
- Community container source: https://github.com/runzhliu/deepseek-harness-docker

Gmail is the only account connected by default, and only after you authorize it.
GitHub and any AI router are yours to configure.
