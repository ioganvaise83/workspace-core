# Application development policy

Binding rules for building applications with an AI agent in this workspace.
Read this before creating or changing anything under `/workspace/apps`.

An application is a **standalone program** — web app, desktop app, API service,
CLI tool, or a system with frontend and backend. It is not a plugin, not a script,
and not a folder of notes.

## Human-owned Git workflow

**The owner creates the repository. The agent works inside it.**

Every application lives in its own Git repository, created by the owner on GitHub
(or another host) and cloned by the owner into
`/workspace/apps/apps/<app-id>/`. The agent never creates the repository, never
runs `git init`, `git clone`, or `git remote add`, and never invents a directory
in place of the owner's clone.

### Mandatory pre-flight

Before writing a single line of code, verify all five and report the result:

```bash
cd /workspace/apps/apps/<app-id>
pwd                              # 1. target directory exists
git rev-parse --is-inside-work-tree   # 2. it is a Git working tree
git branch --show-current        # 3. current branch
git remote -v                    # 4. remote configured
git status --short --branch      # 5. working tree state
```

Then check the registry for a conflict: no other entry may already claim that
`id` or that `path`.

If any check fails — no directory, no `.git`, no remote, or an id already
registered — **stop**. Do not create, clone or initialise anything. Tell the owner
exactly what is missing:

> No Git repository at `/workspace/apps/apps/<app-id>` (or: no remote configured).
> Create it on GitHub and clone it there:
> `git clone <url> /workspace/apps/apps/<app-id>`
> Then tell me to continue.

Starting work in a directory the agent created itself is forbidden: the work
would end up with no remote, no history and no review path.

### What the agent may do

- Create, modify and delete files **inside** the provided repository.
- Run the application's tests and local build commands.
- Read Git state for reporting: `status`, `diff`, `log`, `branch`, `remote -v`.

### What the agent must never do without explicit permission, every time

- `git add`, `git commit`, `git push`
- `git merge`, `git rebase`, `git reset --hard`, `git checkout -- <file>`
- creating or deleting branches or tags, publishing releases
- `git remote add`, `git remote set-url`, `git config` changes
- rewriting history in any form

These are the owner's actions. The agent's job ends when the working tree
contains reviewable changes.

### Handing work back

When development is done, report:

1. **Changed files** — the list, with a one-line description each.
2. **Test results** — the actual command and its output summary.
3. **`git status`** — verbatim, so the owner sees exactly what is staged and
   untracked.
4. **Summary** — what changed and why, in a few sentences.
5. **How to verify** — the steps the owner runs to check it works.
6. **Suggested commit message** — one line, imperative mood, plus an optional
   body. A suggestion only; the agent does not commit.

The owner reviews, commits and pushes. The agent never pushes to the owner's
default branch.

### The registry is not a substitute for Git

`registry.json` is a catalogue: it records where an application lives and what
state it is in. It does not replace version control, and it never contains source
code. Git holds history; the registry holds the index.

### Nested repositories

Each application is its own repository. `workspace-apps` itself is **not** a Git
repository, and must not become one containing them: a nested `.git` is recorded
as a gitlink, which clones as an empty directory and cannot be pushed. If someone
later initialises Git at `workspace-apps`, `.gitignore` must exclude application
directories first — see the section below.

## Before you create anything

1. **Confirm the owner's repository exists.** See "Human-owned Git workflow"
   above. This is the first gate, not a formality.
2. **Read `workspace-apps/registry.json`.** It is the source of truth for what
   already exists. Creating a duplicate because you did not look is the most
   common failure mode.
3. **Read the existing app's `app.yaml` and `README.md`** before continuing work
   on it. The manifest states its stack, commands and status; guessing produces
   conflicting changes.
4. **Check `workspace-knowledge/knowledge/projects/<app-id>/`** for goals,
   requirements and past decisions. Context explains why the code looks the way
   it does.

## Where code lives

| Content | Location | Never |
|---|---|---|
| Application source, tests, manifests | `/workspace/apps/apps/<app-id>/` | Core or Knowledge |
| Platform infrastructure | `workspace-core` | an application directory |
| Goals, requirements, decisions, history | `workspace-knowledge` | Core or Apps |

On the host these are `~/ai/workspace-apps/...`, `~/ai/workspace-core/...`,
`~/ai/workspace-knowledge/...`.

Application source code must **never** be written into `workspace-core` or
`workspace-knowledge`. The registry records where an app is; it is not a place to
store the app.

## Required structure

```text
apps/<app-id>/
├── README.md      what it does, how to run and test it
├── app.yaml       manifest
├── src/
├── tests/
├── docs/
└── .gitignore
```

`<app-id>` is lowercase letters, digits and hyphens, and **must equal** the `id`
inside `app.yaml`. Add `frontend/`, `backend/`, `database/`, `public/`, `assets/`
only when that application genuinely has them. Do not impose one stack on every
project: a static site, a Python API and a desktop app are all valid shapes.

## Keeping metadata current

After creating an application **or making a substantial change** to it, update all
three in the same session:

1. `app.yaml` — status, components, commands, env variable names, `updated` date.
2. `README.md` — how to run and test it now, not how it used to work.
3. `workspace-apps/registry.json` — via `scripts/apps-registry.cjs sync`.

A stale manifest is worse than no manifest: the next agent will trust it.

## Infrastructure changes need agreement

Do not modify Core's Compose file, scripts or integrations to satisfy a single
application. If an application genuinely needs a new platform service, a new
mount, or a change to the harness profile, propose it and wait for approval. The
platform serves every application; one project must not reshape it silently.

Do not modify other applications. If two projects need the same behaviour, put it
in a shared package or an HTTP/MCP interface, with the owner's agreement.

## Secrets

- Never write API keys, tokens, OAuth credentials or passwords into `app.yaml`,
  `README.md`, `registry.json`, `docs/` or source code.
- `app.yaml` lists environment variable **names only**.
- Each application keeps `.env` untracked from its first commit, and documents the
  variables in `.env.example` with placeholder values.
- Never copy the platform's credentials — the Gmail bridge token, model API keys —
  into an application. An app that needs access gets its own credential, with its
  own scope, or asks the platform through a defined interface.
- Runtime state, databases and logs live in `runtime/` or a named volume, never in
  `src/`.

## Operations that need confirmation

Ask the owner before each of these, every time — no standing permission:

- running database migrations that modify or delete data;
- deleting an application, its data or its volume;
- deploying, publishing or pushing anything outside this machine;
- `docker compose down -v` against any project;
- changing a shared service or the harness profile;
- installing a dependency that adds a background service or opens a port.

Read-only inspection, running tests, and editing files inside the application's
own directory do not need confirmation.

## Architecture choices

Prefer designs that remain maintainable:

- **Separate concerns early.** A frontend that talks to a documented API survives
  a rewrite of either side; a page that queries the database directly does not.
- **Keep the run path reproducible.** `install`, `run` and `test` belong in
  `app.yaml` and must work from a clean checkout using only `.env.example` values.
- **Fail loudly.** A missing required setting should stop the app with a clear
  message, not silently fall back to a default that corrupts data.
- **Bind to loopback by default.** Exposing a port to the network is a deliberate
  decision, not a convenience.
- **Write the test that would have caught the bug** you just fixed.
- **Record decisions where they will be found**: architecture in `docs/`, the
  durable "why" in Knowledge.

## Working with an existing application

```bash
# 1. Find it
node /workspace/core/scripts/apps-registry.cjs list

# 2. Read it
cat /workspace/apps/apps/<app-id>/app.yaml
cat /workspace/apps/apps/<app-id>/README.md

# 3. Work inside its directory only

# 4. Validate before you finish
node /workspace/core/scripts/apps-registry.cjs check
```

## Registry tooling

```bash
node /workspace/core/scripts/apps-registry.cjs check    # report drift, exit 1 on problems
node /workspace/core/scripts/apps-registry.cjs sync     # update registry from manifests
node /workspace/core/scripts/apps-registry.cjs sync --dry-run
node /workspace/core/scripts/apps-registry.cjs list
```

`sync` never deletes an entry. If an application's directory disappears, the entry
is kept and a warning is printed — a missing directory is often an unmounted volume
rather than a deleted project, and only a human can tell the difference.

## Knowledge entries

For each **existing** application you may keep a record at
`workspace-knowledge/knowledge/projects/<app-id>/` covering goals, user
requirements, architecture decisions, significant change history, known problems
and plans.

Do not create Knowledge entries for applications that do not exist yet. The
registry is authoritative about location and technical state; Knowledge is
authoritative about intent and reasoning.

## Git configuration for workspace-apps

`workspace-apps` is a **directory of independent repositories**, not a repository
itself. That is deliberate: a parent repository would record each application as a
gitlink (a commit pointer to a repository it does not contain). Cloning the parent
would then produce empty application directories, and pushing an application from
the parent would be impossible.

If you do initialise Git at `workspace-apps` — to version the registry and the
template, for example — the application directories must be excluded **before the
first commit**. Once an application is tracked, removing it from history is a
rewrite, not an edit.

```gitignore
# Each application is its own Git repository.
# Without this, a nested .git becomes a gitlink: it clones as an empty directory
# and cannot be pushed from here.
apps/*/
!apps/.gitkeep
```

Keep `apps/.gitkeep` so the directory survives a clone. The negation is
load-bearing: a bare `apps/*/` would also ignore the placeholder.

Verify before committing:

```bash
git check-ignore -v apps/app-one     # must print the ignore rule
git status --porcelain               # must not list any app directory
```

The agent does not create this repository, does not run `git init` here, and does
not add application directories to any index.
