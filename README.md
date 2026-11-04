# Workspace Core

**Public** self-hosted AI workspace scaffold: Docker Compose + DeepSeek Harness + a separately cloned **private** Markdown knowledge repository.

> Status: starter scaffold. DeepSeek Harness is in developer preview. The Docker image below is **community-maintained**, not an official DeepSeek image; test and review it before trusting sensitive content. The Gmail / GitHub integration folders are **placeholders**, not working connectors.

## What goes where

- `workspace-core` (this public repository): Compose, scripts, documentation, future reusable plugins.
- `workspace-knowledge` (your private repository): Markdown files, personal agent guidelines, vehicle histories, private workspace preferences.
- **Outside Git**: model API credentials, Gmail OAuth tokens, GitHub tokens, DSH sessions and local runtime files. A private Git repo is not a vault.

## Quick start (Windows / macOS / Linux)

Requires Docker Desktop or Docker Engine + Compose v2, Git; for setup checking Python 3.10+ is optional.

1. Create two GitHub repositories named `workspace-core` (**Public**) and `workspace-knowledge` (**Private**). Clone both next to each other.
2. Unzip the corresponding starter archive **into each cloned repository root**. Do not add a second nested folder.
3. In `workspace-core` copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`; Linux/macOS: `cp .env.example .env`). Keep `.env` untracked.
4. Confirm your private repo is located at `../workspace-knowledge` or edit `KNOWLEDGE_PATH` inside `.env`. The directory **must exist before launching**. Relative paths resolve from this repository directory.
5. Create the local writable runtime directory:
   - Linux/macOS: `mkdir -p runtime/workspace`
   - PowerShell: `New-Item -ItemType Directory -Force runtime/workspace`
6. Optional: `python scripts/check_setup.py` (or `python3 scripts/check_setup.py`).
7. Run `docker compose config`, then `docker compose up -d`. View `docker compose logs -f harness`.
8. Open **http://127.0.0.1:3080** on that same computer. Inside Harness go to **Settings → Models → Add model provider → Custom model API**, enter the AI router's *actual* endpoint, API protocol (typically OpenAI Chat Completions), credential and exact model ID. Save, then select the model for your chat.
9. Ask Harness to inspect `/workspace/knowledge/AGENTS.md` and, for example, `/workspace/knowledge/knowledge/vehicles/`. Note that auto-loading the repository's `AGENTS.md` is **not configured yet**; opening those files is explicit at this stage.

The compose file does **not** yet configure AI Router by environment variable; it uses the official provider settings in the DSH Web UI. DSH model/session configuration is stored in the `dsh-home` Docker volume, which is per installation and is **not synchronized through Git**.

## Core ↔ Knowledge boundary

On the host `KNOWLEDGE_PATH` points to the **root of the private repository**. It is mounted read/write inside the container at `/workspace/knowledge`. As a result:

- `/workspace/knowledge/AGENTS.md` — personal guidance.
- `/workspace/knowledge/knowledge/vehicles/...` — vehicle notes.
- `/workspace/knowledge/workspace.yaml` — a **proposed future workspace manifest**, not interpreted by DSH or Core yet.
- `/workspace` outside the `knowledge` subdirectory — local scratch space, excluded from Git.

Do not place personal data under this public repository.

## Updates and synchronization

Synchronize each Git repository separately. Editing Markdown through Harness changes files in your **local** private repository; it does not automatically commit or push. Use `git status`, `git add`, `git commit` and `git push` from `workspace-knowledge`. On the next PC, `git pull --ff-only` there before editing. Resolve any divergence manually, do not enable unattended overwrite. The script `scripts/knowledge_status.py` shows status only and never changes Git history.

**Important:** `docker compose down` keeps the named volume; `docker compose down -v` **deletes DSH sessions/settings**. Backup the volume separately. A second running instance will have its **own** local DSH state. Avoid editing the same Markdown files concurrently from two computers.

## Security limits

- Web UI is bound to host loopback, not to the LAN. Do not expose port 3080 publicly without authentication, TLS, and network protections.
- This starter is **not a secure sandbox for untrusted autonomous shell commands**. DSH tools might execute commands in a writable workspace. Review requested actions and credentials.
- The agent receives write access to the private repo: keep backups and review diffs before pushing.
- Do not store API keys, tokens, passwords, personally identifying documents or Gmail message bodies in the public repo; carefully consider sensitive data even in the private repo.
- Future Gmail or GitHub integrations should request minimum OAuth scopes and require confirmation before sending, deleting, or pushing changes.

## Extension points

- `plugins/`: future reproducible DSH plugins (must be installed/enabled explicitly; directory isn't scanned automatically).
- `integrations/`: designs and permission boundaries for future MCP servers.
- `templates/knowledge/`: starter template for new private repositories.
- `docs/architecture.md`: boundary and lifecycle decisions.

## Upstream references

- Official Harness: https://github.com/deepseek-ai/deepseek-harness
- Official model configuration: https://deepseek-harness.github.io/deepseek-harness/en/guide/providers
- Community container source: https://github.com/runzhliu/deepseek-harness-docker

No Gmail, GitHub or AI-router accounts are connected by default.
