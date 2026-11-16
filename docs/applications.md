# Applications (workspace-apps)

Status: architecture only. No application manager, no deploy automation and no
Compose service exists yet — this document defines the boundaries so that adding
them later does not require undoing anything.

## Three independent areas

| Area | Visibility | Owns | Must not contain |
|---|---|---|---|
| `workspace-core` | public | platform: Compose, built-in MCP integrations, scripts, docs | personal notes, app business logic, credentials |
| `workspace-knowledge` | private | personal notes, memory, process timelines, agent instructions | Docker files, MCP sources, platform docs, tokens |
| `workspace-apps` | private or public, per app | complete applications: frontend, backend, database, tests | platform infrastructure, personal notes |

The rule behind the split: **Core is shared and publishable, Knowledge is
personal, Apps are products.** Each has its own lifecycle, its own Git history and
its own reason to change.

On the host the three sit side by side:

```text
~/ai/
  workspace-core/        # public
  workspace-knowledge/   # private
  workspace-apps/        # one subdirectory per application
```

`workspace-apps` is mounted into the harness at `/workspace/apps`; the host path
comes from `APPS_PATH` in `.env`, defaulting to `../workspace-apps` beside this
repository. Mounting is not creation: the directory and its `registry.json` must
already exist, otherwise Docker creates an empty root-owned directory and the
registry tool has nothing to read.

## What an application is

An application is a standalone program, not a plugin and not a script:

- its own source tree, dependency manifest, lockfile and tests;
- its own run configuration, which may be its own `compose.yaml`;
- its own Git repository (recommended), so its history is independent of Core;
- optionally its own database and its own migrations;
- optionally an MCP server exposing tools to the agent — **optional**, never
  required. A plain web app with no agent surface is a perfectly valid app.

An application must not be reachable from another application's code. Shared
behaviour goes into a published package or an HTTP/MCP interface, not an import
across app boundaries.

## Suggested layout per application

```text
workspace-apps/<app-name>/
├── README.md            # what it does, how to run it, what it needs
├── compose.yaml         # optional; its own project name
├── .env.example         # documented variables, NO secrets
├── .gitignore           # .env, runtime/, data/, node_modules/, build output
├── src/                 # frontend and/or backend
├── tests/
├── Dockerfile           # if it ships as a container
└── runtime/             # local state, databases, logs — git-ignored
```

Each application picks its own stack. Core does not impose a framework, and this
document does not either.

## Boundaries and access

### From an application to the platform

Access is granted explicitly, through named interfaces only:

| Target | How | Never |
|---|---|---|
| Knowledge | a read-only bind mount, or an HTTP/MCP endpoint that serves specific files | mounting the whole repo read-write by default |
| Gmail MCP | the internal Compose network, `http://gmail-mcp:8765/mcp`, with its own token | reusing the harness token; reading `~/.gmail-mcp` directly |
| Harness | `http://harness:3080` on the internal network | publishing port 3080 beyond loopback |
| Other apps | HTTP or MCP | importing another app's source |

Read and write rights are granted separately. A default for a new application is
**read-only everywhere**; write access is a deliberate change, reviewed like code.

### From the platform to an application

The agent may read and write inside an application directory once it is mounted.
It may run its tests. It must not:

- deploy, publish or register the application anywhere;
- delete an application or its database;
- run destructive migrations or `docker compose down -v` against it;
- handle the application's production secrets.

Those need explicit confirmation from the owner, every time.

## Secrets and runtime data

- **Never in Git.** `.env`, tokens, keys and database dumps stay in `.gitignore`
  from the first commit of a new application.
- `.env.example` documents the variables with placeholder values only.
- Runtime state lives in `runtime/` or a named Docker volume, never in `src/`.
- A secret that the platform already holds (the Gmail bridge token, model API
  keys) is not copied into an app. The app asks the platform, or it gets its own
  credential with its own scope.

## Testing and deployment

A new application is expected to demonstrate, before it is connected to anything:

1. it builds from a clean checkout;
2. its tests pass;
3. it starts with `docker compose up` (or its documented equivalent) using only
   values from `.env.example`;
4. it fails loudly, not silently, when a required setting is missing.

Deployment is a manual step performed by the owner. There is no auto-deploy, no
watcher and no registry lookup in this version.

## Registry

The registry now exists as `workspace-apps/registry.json` and is generated from
each application's `app.yaml` by `scripts/apps-registry.cjs`. It is additive by
design: adding an application appends an entry, never rewrites a boundary.

What is deliberately **not** built yet:

- automatic wiring of an application's MCP tools into the harness profile (the
  pattern exists for integrations; applying it to apps needs its own decision);
- deploy automation, a watcher, or a lookup service;
- vector search or embeddings over applications.

Those stay out until the number of real applications makes them worth the
complexity. A plain manifest scan answers every question asked so far.

## The directory exists

The layout inside `workspace-apps` is:

```text
workspace-apps/
├── README.md            how the space is organised
├── registry.json        machine-readable catalogue — source of truth
├── apps/                one directory per application
└── templates/
    └── app-template/    copyable skeleton with app.yaml and .gitignore
```

On the host that is `~/ai/workspace-apps/`. The binding rules for creating and
maintaining an application are in [`app-development.md`](app-development.md);
this document describes the boundaries, that one describes the procedure.

## Registry tooling

```bash
node /workspace/core/scripts/apps-registry.cjs check   # report drift, exit 1 on problems
node /workspace/core/scripts/apps-registry.cjs sync    # update registry from app.yaml files
node /workspace/core/scripts/apps-registry.cjs list
```

`sync` never removes an entry on its own: a missing directory is reported and the
entry is kept, because an unmounted volume looks exactly like a deleted project.

## If you clone this on another machine

Create the directory next to the other two repositories:

```powershell
cd $HOME\ai
New-Item -ItemType Directory workspace-apps
```

Copy `README.md`, `registry.json` and `templates/` from this repository's
`docs/app-template/` siblings, or let the platform recreate them. Mount it at
`/workspace/apps`, never inside `/workspace/knowledge` or `/workspace/core`:
those two are contractual paths.
