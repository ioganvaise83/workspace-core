# Personal AI Workspace — instruction router

Small on purpose. This file routes you to the right place; it does not contain
documentation. Read the destination before acting.

## Three workspaces

| Workspace | Path | Holds |
|---|---|---|
| Core | `/workspace/core` | platform: Compose, MCP integrations, scripts, policy docs |
| Knowledge | `/workspace/knowledge` | personal notes, memory, process timelines, agent rules |
| Apps | `/workspace/apps` | complete applications: source, tests, manifests |

On the host: `~/ai/workspace-core`, `~/ai/workspace-knowledge`,
`~/ai/workspace-apps`.

## Choosing where work belongs

- **Platform, integration, script, Compose, platform docs** → Core.
- **Notes, decisions, requirements, history, personal context** → Knowledge.
- **A program with its own interface, build and lifecycle** → Apps.
- **Unsure?** If the output is something a user runs, it is an app. If it
  describes or configures the system, it is Core. If it records what the user
  wants or decided, it is Knowledge.

Never place application source in Core or Knowledge. Never place platform
infrastructure in an application directory.

## Building an application

Before writing any code under `/workspace/apps`:

1. **Read `/workspace/core/docs/app-development.md`.** It is the binding policy:
   required structure, manifest fields, secrets handling, operations that need
   the owner's confirmation.
2. **Confirm the owner's Git repository exists** at
   `/workspace/apps/apps/<app-id>/` — with a real `.git`, a branch and a remote.
   If it is missing, stop and tell the owner which repository to clone where. Do
   not run `git init` or `git clone`, and do not invent a directory.
3. **Read `/workspace/apps/README.md`** for the registry contract.
4. **Check `/workspace/apps/registry.json`** — the source of truth for what
   already exists. Do not create a duplicate.
5. **Check `/workspace/knowledge/knowledge/projects/<app-id>/`** for goals and
   past decisions, if it exists.
6. **Start from `/workspace/apps/templates/app-template/`** rather than an empty
   directory.

Application code lives only in `/workspace/apps/apps/<app-id>/`.

**Git is the owner's.** The agent writes and tests code but never runs `git add`,
`git commit`, `git push`, `merge`, `rebase`, `reset`, or creates tags and
releases. Changes stay in the working tree for review. Finish by reporting changed
files, test results, `git status`, how to verify, and a suggested commit message.

## The registry

`/workspace/apps/registry.json` records where each application lives and what
state it is in.

- Update it after creating an app or making a substantial change:
  `node /workspace/core/scripts/apps-registry.cjs sync`
- Verify before finishing: `node /workspace/core/scripts/apps-registry.cjs check`
- Never hand-write entries when `sync` can derive them.
- `sync` never deletes an entry — a missing entry removal is a human decision.

## Boundaries that do not bend without approval

- **Secrets.** No tokens, keys, passwords or OAuth credentials in Core, Apps,
  Knowledge, manifests or docs. They live outside Git, in `.env` or on the host.
- **User settings.** Knowledge content, OAuth files, the DSH profile, RouterAI
  settings and the model choice are the owner's. Do not rewrite them to make
  something work.
- **Infrastructure.** Compose services, mounts, MCP integrations and scripts
  serve every task. Do not reshape them for one project; propose the change and
  wait for approval.
- **Destructive operations.** Deploying, publishing, deleting data or volumes, and
  running destructive migrations all need explicit confirmation each time.

## Where the full rules are

- Platform boundaries: `/workspace/core/docs/architecture.md`
- Applications policy: `/workspace/core/docs/app-development.md`
- Application boundaries: `/workspace/core/docs/applications.md`
- Integrations: `/workspace/core/docs/integrations.md`
- Personal notes rules: `/workspace/knowledge/AGENTS.md`

Knowledge's `AGENTS.md` governs personal data and mail; this file governs the
workspace layout. They complement each other — follow both.
