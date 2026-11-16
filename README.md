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
  check-line-endings.sh       fails on CRLF in files Linux executes
  check_setup.py              non-destructive preflight
  knowledge_status.py         read-only Git status of the private repo
  apps-registry.cjs           validates and syncs workspace-apps/registry.json
  .gitattributes              keeps those scripts LF on a Windows clone
docs/
  architecture.md             boundary and lifecycle decisions
  integrations.md             how to add a built-in integration
  applications.md             workspace-apps boundaries and registry
  app-development.md          mandatory policy for building applications
  agent-development.md        safe development rules
  env.example.txt             documented variables (copy to .env.example)
  gitattributes.txt           line-ending rules (copy to .gitattributes)
  app-template/               copyable skeleton for a new application
plugins/                      reusable DSH plugins (installed explicitly)
```

## Quick start

Requires Docker Desktop or Docker Engine + Compose v2, and Git. Python 3.10+ is
optional, for the preflight scripts.

1. Clone this repository and your private knowledge repository next to each
   other, and create the applications directory beside them:

   ```text
   ~/ai/
     workspace-core/
     workspace-knowledge/
     workspace-apps/          # one subdirectory per application
   ```

2. On Windows, install the line-ending rules before anything else. Git rewrites
   LF to CRLF on checkout when `core.autocrlf=true`, which is the default there,
   and the shell scripts below are mounted straight into Linux containers:

   ```powershell
   Copy-Item docs\gitattributes.txt .gitattributes
   git add .gitattributes
   git commit -m "chore: line-ending rules"
   ```

   This is already safe without the copy — `scripts/.gitattributes` and
   `integrations/.gitattributes` protect the executed files — but the root file
   covers `compose.yaml`, Python and Node sources too.

3. Optionally copy `.env.example` to `.env` and adjust. **Every variable has a
   working default**, so an empty `.env` is valid. Keep `.env` untracked.

   ```bash
   cp .env.example .env          # Linux/macOS
   Copy-Item .env.example .env   # PowerShell
   ```

4. Make sure `KNOWLEDGE_PATH` (default `../workspace-knowledge`) points at your
   private repository and `APPS_PATH` (default `../workspace-apps`) at your
   applications directory. Both must exist before launching: Docker creates a
   missing bind source as an empty root-owned directory instead of failing.

5. Create the local runtime directories so Docker does not create them as root:

   ```bash
   mkdir -p runtime/workspace runtime/gmail/state runtime/gmail/downloads runtime/gmail/attachments
   ```

   ```powershell
   'workspace','gmail/state','gmail/downloads','gmail/attachments' |
     ForEach-Object { New-Item -ItemType Directory -Force "runtime/$_" }
   ```

6. Optional preflight: `python scripts/check_setup.py`

7. Validate and start:

   ```bash
   docker compose config --quiet
   docker compose up -d --build
   docker compose logs --tail=50 harness
   ```

8. Open **http://127.0.0.1:3080** on the same machine. In Harness go to
   **Settings → Models → Add model provider → Custom model API**, enter your
   router's endpoint, protocol (typically OpenAI Chat Completions), credential and
   exact model ID. Save and select it.

9. Ask Harness to read `/workspace/knowledge/AGENTS.md` and, for example,
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

## Line endings (Windows)

Shell scripts here are bind-mounted from the host straight into Linux
containers, so the line endings that Git writes on checkout are part of the
runtime contract, not a formatting preference. With `core.autocrlf=true` — the
default on Windows — `compose.yaml` starts failing at the third service:

```text
/usr/local/bin/init-token.sh: 14: set: Illegal option -
service "mcp-token" didn't complete successfully: exit 2
```

`/bin/sh` is dash in these images. It reads `set -eu\r` and treats `\r` as an
option letter, so it rejects a command that is perfectly valid. Nothing in that
message mentions line endings.

The repository carries `.gitattributes` rules, which override `core.autocrlf`,
so a clone is correct on every platform without touching the local Git config:

| File | Scope |
|---|---|
| `docs/gitattributes.txt` | repository-wide; copy to `.gitattributes` in the root, which is not writable from the container |
| `scripts/.gitattributes` | `*.sh`, `*.py`, `*.cjs` in `scripts/` |
| `integrations/.gitattributes` | every integration's `*.sh` and `Dockerfile`, including ones added later |

A checkout is already correct with only the two directory-level files, because
they cover every file that a Linux container executes. The root file extends the
same rule to `compose.yaml` and the remaining sources.

Check, and repair, at any time:

```bash
sh scripts/check-line-endings.sh        # exit 1 and a file list on CRLF
sh scripts/check-line-endings.sh --fix  # rewrite those files as LF
```

The same check runs inside `python scripts/check_setup.py`, so the preflight step
above reports it before `docker compose up` ever starts a container.

To fix an existing clone once and for all, re-checkout the affected files.
Committing `.gitattributes` is not enough: it changes how Git writes files from
now on, but a file already on disk keeps its CRLF, and that copy is what Docker
mounts.

```bash
cp docs/gitattributes.txt .gitattributes
git add .gitattributes && git commit -m "chore: line-ending rules"

# Re-checkout only the executable files, so unrelated edits survive.
git ls-files '*.sh' '*.py' '*.cjs' Dockerfile | while IFS= read -r f; do
  rm -f "$f" && git checkout -- "$f"
done
```

On Windows, do not reach for `git add --renormalize .` expecting this to be
fixed: it rewrites the *index* for files Git already tracks and does not stage
new files, so it neither adds `.gitattributes` nor touches your working tree.
`git reset --hard` would work but discards any uncommitted work, which is why
the loop above is surgical.

Simpler alternative if your working tree is clean:

```bash
sh scripts/check-line-endings.sh --fix
```

If that command prints `set: Illegal option -` or `syntax error near unexpected
token`, the checker script itself arrived with CRLF and cannot repair anything —
including itself. Use the `git ls-files` loop above in that case; it does not
depend on any script being readable.

`--fix` rewrites files in place and keeps their inode, which matters for the
single-file bind mounts (`compose.yaml`, `README.md`): replacing the inode would
detach the host file from the running container.

CI runs the same checks. The workflow ships as a template because the root is not
writable from the container; install it once on the host:

```bash
mkdir -p .github/workflows
cp docs/github-workflow-line-endings.yml .github/workflows/line-endings.yml
```

```powershell
New-Item -ItemType Directory -Force .github\workflows | Out-Null
Copy-Item docs\github-workflow-line-endings.yml .github\workflows\line-endings.yml
```

It has three jobs: one greps tracked files without executing anything from the
repository (a broken clone cannot report on itself), one re-clones with
`core.autocrlf=true` and asserts LF survives, and one runs the checker script.

## Corporate TLS inspection (optional)

If a proxy re-signs HTTPS traffic — Kaspersky Endpoint Security, Zscaler, most
corporate gateways — `npm install` during the `gmail-mcp` build fails with
`SELF_SIGNED_CERT_IN_CHAIN`. The platform does not weaken TLS to work around it.
It trusts one extra root certificate instead, and only when you ask it to.

1. Export the inspecting root certificate as PEM on the host, outside this
   repository. Kaspersky: **Settings → Network settings → Encrypted connections
   scanning → View certificates → Export**. Take the root, not a leaf.
2. Point `CUSTOM_CA_PATH` at it in `.env`, using forward slashes on Windows:

   ```dotenv
   CUSTOM_CA_PATH=C:/Users/you/kaspersky-ca.pem
   ```

3. Rebuild: `docker compose build --no-cache gmail-mcp && docker compose up -d`.

The certificate is used three ways, all read-only and none of them in Git:

| Where | What it does |
|---|---|
| `gmail-mcp` build | mounted as a BuildKit secret for the `npm install` RUN only; it is in no image layer |
| `gmail-mcp` runtime | `NODE_EXTRA_CA_CERTS`, so Gmail API calls succeed through the proxy |
| `harness` runtime | `NODE_EXTRA_CA_CERTS`, so model API endpoints behind the same proxy work |

Leave `CUSTOM_CA_PATH` unset and everything behaves exactly as before: the
default is a zero-byte placeholder, which the entrypoints detect with
`[ -f X ] && [ -s X ]` and ignore.

Notes:

- `NODE_EXTRA_CA_CERTS` **adds** a root; it never removes or bypasses one.
  `strict-ssl=false` and `NODE_TLS_REJECT_UNAUTHORIZED=0` appear nowhere and
  must not be added — they would disable verification for every host.
- Build secrets need BuildKit, the default in Docker Desktop and Compose v2. If
  the build says the classic builder does not support secrets, unset
  `DOCKER_BUILDKIT=0` and ensure the `buildx` plugin is installed.
- Verifying trust without Docker: `docker compose run --rm gmail-mcp node -e
  "require('https').get('https://registry.npmjs.org',r=>console.log(r.statusCode))"`.
- A certificate that is a leaf, expired, or in DER rather than PEM produces the
  same error as no certificate at all. Confirm with
  `openssl x509 -in your-ca.pem -noout -subject`.

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
