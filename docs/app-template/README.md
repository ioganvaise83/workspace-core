# <app-name>

One or two sentences: what this application does and who it is for.

Standalone application. It is **not** part of the platform: it has its own
dependencies, its own history and its own lifecycle. See
`workspace-core/docs/applications.md` for the boundaries.

## What it needs

- Runtime / toolchain: <e.g. Python 3.12, Node 24>
- Ports: <e.g. 8080, bound to 127.0.0.1>
- External services: <none, or: Gmail MCP via http://gmail-mcp:8765/mcp>
- Persistence: <none, or: SQLite in ./runtime/data.db>

## Configuration

Copy `.env.example` to `.env` and fill in the values. `.env` is git-ignored.

| Variable | Required | Meaning |
|---|---|---|
| `APP_PORT` | no | Host port, default 8080 |
| `APP_DATA_DIR` | no | Where runtime data lives, default `./runtime` |

Do not put secrets in `.env.example`. This application does not receive the
platform's credentials automatically; if it needs one, it gets its own, with its
own scope.

## Run

```bash
docker compose up -d --build
```

Without Docker:

```bash
<the one command that starts it locally>
```

## Test

```bash
<the one command that runs the tests>
```

## Data and secrets

- Runtime state lives in `runtime/` (git-ignored) or a named volume.
- No credentials, tokens or database dumps are committed.
- Deleting `runtime/` resets the application; deleting the volume does the same
  for containerised data. Both are destructive — confirm before doing either.

## Status

- [ ] builds from a clean checkout
- [ ] tests pass
- [ ] starts using only `.env.example` values
- [ ] fails loudly when a required setting is missing
