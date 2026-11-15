# Application template

A starting point for a standalone application in `workspace-apps/`. Copy these
files into `workspace-apps/<app-name>/` and rename the two text files:

| Template file | Becomes |
|---|---|
| `README.md` | `README.md` |
| `compose.yaml` | `compose.yaml` (or delete it if the app needs no Docker) |
| `env.example.txt` | `.env.example` |
| `gitignore.txt` | `.gitignore` |

Two files are named `.txt` on purpose: a directory holding a literal `.env.example`
and `.gitignore` would be picked up by tooling as if it were a real project, and
git would refuse to track a nested `.gitignore` the way you expect. Renaming on
copy keeps this directory inert.

What the template encodes, and why:

- **`.gitignore` from the first commit.** `.env`, `runtime/`, databases and build
  output are excluded before they can ever be committed. Adding the rule later
  does not remove anything already in history.
- **`127.0.0.1` binding.** A new application is not reachable from the network by
  default. Widening that is a deliberate edit.
- **`read_only`-style hardening.** `no-new-privileges` and `cap_drop: ALL` match
  the platform's own containers.
- **A status checklist.** Build, tests, boot from `.env.example` only, fail
  loudly. Those four checks are what "ready to connect" means here.

The template deliberately contains no framework, no language choice and no
database. Pick those per application; this file only fixes the boundaries.
