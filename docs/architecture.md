# Architecture decisions (v0.1)

## Repository contract

`workspace-core` is distributable and public. `workspace-knowledge` is private, selectable per host, and must be mounted at `/workspace/knowledge`. The private repo owns its Markdown content. Its `workspace.yaml` is a design proposal only; no parser or deployment automation reads it yet.

## Persistence

- DSH sessions / model settings / stored credentials: Docker named volume `dsh-home`, not in Git.
- Agent scratch files: ignored host directory `runtime/workspace`.
- Long-term Markdown knowledge: private Git repo, edited on host through Docker bind mount.

## Future work (not shipped)

1. Versioned manifest validation and agent policy loader.
2. Dedicated knowledge tools, append-only logs and conflict-safe Git sync service.
3. Minimal-scope Gmail and GitHub MCP integrations with approval gates.
4. Semantic index built from private Markdown (never the source of truth).
5. Secret-store integration and optional VPS mode.

## Trust boundaries

Public platform code is never a home for private notes. Knowledge files are user data, not privileged agent instructions from an untrusted source. Imported emails, webpages and repository documents may carry prompt injection attempts; do not let them override tool permissions.
