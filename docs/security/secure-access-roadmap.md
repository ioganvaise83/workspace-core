# Secure access &amp; multi-user roadmap

**Read this first.** This document is the durable memory of a multi-iteration
project. If you are an AI agent starting a new session with no knowledge of the
earlier conversation, everything you need is here, in
[`threat-model.md`](threat-model.md), [`decisions.md`](decisions.md) and
[`deployment-guide.md`](deployment-guide.md). Do not re-litigate settled
architecture; extend it.

Last updated: 2026-11-20. Maintained by the agent, reviewed by the owner.

## Status legend

| Mark | Meaning |
|---|---|
| NOT_STARTED | Named, nothing written |
| IN_PROGRESS | Files exist, work incomplete |
| IMPLEMENTED | Written and reviewed, never executed end-to-end |
| TESTED | Exercise passed offline / in a lab |
| VERIFIED | Passed on a real VM against a real IdP |
| BLOCKED | Needs an external decision or component to continue |

Evidence classes are recorded separately, because they are not interchangeable:

- **offline** — static checks, config validation, unit tests, or behaviour
  reproduced against the installed DSH binary on a workstation.
- **live** — executed on the corporate VM with the corporate IdP.

A test that needed a real Keycloak but ran against a mock is **offline** and must
say so. Never label a mock test as a corporate-access verification.

---

## 1. Problem statement

The platform today runs on one workstation, reachable only from that machine.
Moving it to a corporate VM means publishing it to a network where colleagues
have access. Without controls, any colleague who can reach the port can read
every session transcript, every workspace file, the mail tools, and the
credentials the process holds.

The task is therefore not "add a login page". It is to make the published surface
safe while preserving a working local mode, and to lay a path to several users
without ever giving them one shared home.

## 2. Target architecture

```text
Corporate users
      |  HTTPS
      v
Reverse proxy (nginx)  ── TLS termination, header hygiene, single published port
      |  auth_request
      v
oauth2-proxy ──────────── OIDC Authorization Code + PKCE, allowlist by (issuer, sub)
      |  X-Auth-Request-* (set only by nginx)
      v
Identity-aware gateway ── re-checks sub, mints the DSH session cookie
      |  HTTP on a private network
      v
DSH instance ──────────── own DSH_HOME, own workspace, own MCP credentials
      +-- Mail MCP (own token, own accounts)
      +-- Gmail MCP (own token, own OAuth)
```

Phase 1 instantiates exactly one branch. Phase 3 adds branches; the shape does
not change (ADR-2).

## 3. Phases

### Phase 0 — Security audit of the installed Harness

**Status: VERIFIED (offline, against the installed 0.2.1-rc.3 binary)**

What was checked and what it means:

| Question | Finding |
|---|---|
| Launch token origin | Minted per process (`processLaunchToken(ref(crypto.randomBytes(32)))`), printed by `dsh web` in the startup URL |
| What the browser cookie is bound to | `HMAC-SHA256` over `{version, authority, issuedAt, expiresAt}`; name `dsh-auth-<sha256(authority)>`; `HttpOnly`, `SameSite=Strict`, `Path=/`; `Secure` only when the listener itself serves TLS |
| Where the signing secret lives | `$DSH_HOME/.credentials.yaml`, record `client-connection/browser-session`, 32 raw bytes base64url; created only when absent |
| Authority determination | `Host` header parsed under the listener's scheme; port kept when explicit; a cookie for one authority is rejected at another |
| Token exchange | `GET /?token=<launch>` on the root, single occurrence, `303` to `./` plus the cookie; a wrong token is `401` |
| Session lifetime | `cookieMaxAgeDays`, default 30; enforced both in the cookie payload and in the signature check |
| Logout | **None.** No logout endpoint. Revocation = clear the browser cookie, or delete the credential record and restart |
| Restart behaviour | Secret persists; existing cookies keep working. If the record is absent, a new secret is generated and all old cookies die |
| `--public-url` | Advertises the URL; grants no trust |
| `--trusted-host` | Adds accepted authorities to the `/api` Host/Origin fence; required behind a proxy |
| WebSocket | `/api/remote.mux` upgrade goes through the same admission; no cookie → 401 |
| Streaming | DSH uses WebSocket for Remote streams, not SSE (`text/event-stream` is only excluded from compression) |
| External auth mode | **None.** No OIDC/SAML/forward-auth support, no header-based identity, no pluggable auth provider |
| Identity headers | Ignored. `X-Forwarded-User`, `X-Auth-Request-User`, `X-Forwarded-Email` alone grant nothing |
| Multi-user | Not supported in one process. Only principal `{kind:'owner'}`; one shared `browserPeer`; one `$DSH_HOME` |

Reproduced experimentally on the installed binary (evidence: offline):

| Check | Result |
|---|---|
| Anonymous `GET /` | 401 |
| Anonymous `POST /api` | 401 |
| `GET /?token=<valid>` | 303 + `Set-Cookie` |
| `GET /?token=<wrong>` | 401 |
| Cookie + matching `Host` | 200 |
| Cookie + foreign `Host` | 401 |
| Cookie + foreign `Host` + identity headers | 401 |
| Identity headers without cookie | 401 |
| Cookie minted offline from the stored secret | 200 |
| Cookie minted for a different authority | 401 |
| Expired cookie / lifetime over `cookieMaxAgeDays` | 401 |
| Pre-seeded secret honoured by DSH | yes (not overwritten) |
| WebSocket `/api/remote.mux` without cookie | 401 |
| WebSocket with minted cookie | 101 |
| Old cookie after deleting the record + restart | 401 |
| Cookie minted with the new secret | 200 |
| `cookieMaxAgeDays: 1` via profile override, 2-day cookie | 401, and `--trusted-host` still honoured |

**Conclusion.** A safe join is possible **without patching DSH**, because the
cookie is verifiable and mintable from a secret DSH reads rather than generates
when already present (ADR-7). No external-authentication mode exists, so the
gateway is the only supported seam.

**Follow-up not done:** whether the cookie format changes in later DSH versions.
The gateway must be treated as version-coupled to DSH and re-verified on upgrade.

### Phase 1 — One user behind Keycloak

**Status: IMPLEMENTED + TESTED (offline). Not VERIFIED: no VM, no real IdP yet.**

Deliverables and their state:

| Deliverable | Path | Status |
|---|---|---|
| Keycloak + PostgreSQL compose | `deploy/identity/compose.yaml` | IMPLEMENTED |
| Keycloak config templates | `deploy/identity/config/` | IMPLEMENTED |
| Keycloak runbook | `deploy/identity/README.md` | IMPLEMENTED |
| Single-user compose overlay | `deploy/single-user/compose.yaml` | IMPLEMENTED |
| nginx site config | `deploy/single-user/nginx/` | TESTED (real `nginx -t`) |
| oauth2-proxy config | `deploy/single-user/oauth2-proxy/` | TESTED (TOML parsed, options verified against v7.15.6 source) |
| Gateway (cookie minting) | `deploy/single-user/gateway/` | TESTED (unit + contract against live DSH) |
| Env templates | `deploy/*/env.example` | IMPLEMENTED |
| Offline security checks | `deploy/tests/` | TESTED (63 checks, 39 node tests) |
| Deployment guide | `docs/security/deployment-guide.md` | IMPLEMENTED |
| Live verification on VM | — | NOT_STARTED |

Evidence recorded for phase 1:

| Check | Result | Class |
|---|---|---|
| `sh deploy/tests/check-security.sh` | 66 passed, 0 failed | offline |
| `node --test deploy/tests/gateway.test.js` | 16 passed, 0 failed (incl. 2 contract tests against a live DSH) | offline |
| `node --test deploy/tests/compose.test.js` | 33 passed, 0 failed | offline |
| `sh deploy/tests/check-allowlist.sh` | deny-by-default and multi-user rejection behave correctly | offline |
| `sh deploy/tests/e2e-local.sh` | 16 passed, 0 failed: real nginx + real gateway + real DSH, both identities | offline |
| `nginx -t` on the rendered template with real nginx 1.26.3 | "test is successful" | offline |
| oauth2-proxy config parsed as TOML; every option name checked against v7.15.6 source | valid; three initial mistakes found and fixed | offline |
| Keycloak realm JSON parsed; self-registration off, confidential client, no password grant | valid | offline |
| Any of the roadmap §6 criteria | — | live, NOT_STARTED |

Phase 1 acceptance criteria live in §6. None of the `live` ones has been
executed; the handover report must say so plainly.

### Phase 1.5 — Pre-activation security review

**Status: IMPLEMENTED + TESTED (offline). See
[`security-review-single-user.md`](security-review-single-user.md).**

Four defects were found by reviewing the prepared configuration, three of them
breaking the design outright:

| Id | Severity | Finding | State |
|---|---|---|---|
| F-1 | critical | nginx discards server-level `proxy_set_header` clears as soon as a location sets its own; client `Authorization` and `X-Forwarded-User` reached the upstream | fixed, regression-tested |
| F-2 | critical | the application location did not forward `Host`; nginx sent the container name, so the gateway would refuse every request with 421 | fixed, regression-tested |
| F-3 | critical | the gateway never sent `Set-Cookie`; DSH emits none on ordinary requests, so the browser never received a session | fixed, regression-tested |
| F-4 | medium | no `auth_request` timeouts; a hung oauth2-proxy could stall a worker | fixed |

Each fix has a regression test that was verified to fail when the fix is
reverted (mutation-checked), because a test that cannot fail is worse than none.

### Phase 2 — Design for several users

**Status: NOT_STARTED** (design only; no implementation this iteration)

To be designed before any code:

- per-user container and per-user `DSH_HOME` (reusing the single-user overlay as
  the template);
- per-user workspace volume and per-user Knowledge/Apps mounts;
- per-user MCP instances: one Gmail bridge and one IMAP bridge each, own tokens;
- per-user secrets directory on the host, `chmod 600`, never shared;
- per-user resource limits (CPU, memory, pids) so one runaway agent cannot starve
  the VM;
- identity-aware routing: identity → instance, with an explicit registry;
- provisioning: create on first authorised login, from a template;
- idle stop with durable volumes, and start-on-demand;
- logout and revocation per user, including DSH secret rotation;
- audit trail: who accessed which instance when;
- user lifecycle: onboarding, transfer, offboarding, data retention.

Constraint: reuse phase 1 components. If a design needs a second gateway
implementation, the design is wrong.

### Phase 3 — Multi-user orchestration

**Status: NOT_STARTED**

Open technology question, deliberately unanswered: Compose templates driven by a
small orchestrator, versus Kubernetes. Decide only after measuring: number of
users, concurrency, VM size, and whether the corporate VM is itself a Kubernetes
node. Do not choose Kubernetes by default (ADR-2, phase-3 note).

### Phase 4 — Corporate integrations per user

**Status: NOT_STARTED**

Personal mail accounts, separation of corporate and personal connections, Git
repositories with the user's own permissions, Telegram, MAX, other MCP services,
and a central access policy. Hard rule from ADR-10: no user may obtain another
user's mail tokens through a shared MCP service or a shared volume.

## 4. Dependencies between phases

```text
Phase 0 (audit) ──> Phase 1 (single user) ──> Phase 2 (design) ──> Phase 3 (orchestration)
                          |                                            |
                          +──> Phase 4 (integrations) <────────────────+
```

- Phase 1 depends on Phase 0 only for the cookie-minting decision (ADR-7).
- Phase 2 may start in parallel with Phase 1 verification, but its design must be
  validated against a working phase 1 — otherwise it encodes guesses.
- Phase 3 depends on Phase 2 decisions and on real usage data.
- Phase 4 depends on Phase 3 for the per-user credential layout.

## 5. Roles and responsibilities

| Thing | Owner | Agent |
|---|---|---|
| DNS name, TLS certificate | provides | documents requirements |
| Corporate IdP decision (existing or new) | decides | prepares both variants |
| Keycloak realm, user, client, MFA | performs in console (or approves scripted) | prepares runbook and templates |
| `deploy/` directory on host | creates | writes into it once mounted |
| Secrets on host | creates, `chmod 600` | documents, never commits |
| Activation (publishing ports, switching auth) | explicitly approves | never performs unasked |
| Git commits | owns entirely | proposes message only |

## 6. Acceptance criteria for phase 1

Until every item is `VERIFIED (live)`, phase 1 is not done.

### Authentication

- Unauthenticated request is refused or redirected to the IdP.
- The permitted user completes OIDC and reaches the UI.
- A Keycloak user not on the allowlist receives 403 and never reaches DSH.
- A second Keycloak account cannot obtain access by any route.
- After logout, the proxy session ends and access stops.
- After revocation, an existing session cannot bypass policy.

### Network

- Direct access to DSH by VM IP is refused.
- Port 3080 from another machine is refused.
- API is unreachable without authentication.
- WebSocket is unreachable without authentication.
- MCP endpoints are not published.
- HTTPS is mandatory; plain HTTP does not serve the app.

### Functionality

- UI loads; a new session can be created.
- Streaming generation works.
- Shell tools work.
- Workspace works.
- Existing Mail MCP works.
- State survives restart.
- Integration bootstrap still succeeds.

### Security

- No secrets in Git.
- No real passwords in logs.
- No launch token handed to any browser.
- No shared user credentials.
- A tested rollback exists.
- The Keycloak-loss procedure is known and written.

## 7. Current status board

| Item | Status | Evidence |
|---|---|---|
| DSH authentication audit | VERIFIED | offline, installed binary |
| Cookie-minting feasibility | VERIFIED | offline, installed binary |
| Architecture documents | IMPLEMENTED | this file and siblings |
| Keycloak compose + runbook | TESTED | offline config checks |
| nginx configuration | TESTED | real `nginx -t`, plus behavioural probes on nginx 1.26.3 |
| oauth2-proxy configuration | TESTED | TOML parsed; options verified against v7.15.6 source |
| Gateway component | TESTED | 16 tests, incl. 2 contract tests against a live DSH |
| Security review (pre-activation) | IMPLEMENTED | [`security-review-single-user.md`](security-review-single-user.md); 4 defects found and fixed |
| Offline security test suite | TESTED | 66 checks + 49 node tests, all green |
| Local end-to-end harness | TESTED | `e2e-local.sh`: 16/16 with both identities on real nginx + gateway + DSH |
| Live VM verification | NOT_STARTED | needs corporate VM |
| Corporate IdP availability | BLOCKED | owner must confirm whether one exists |
| Phase 2 design | NOT_STARTED | — |
| Phase 3 orchestration | NOT_STARTED | — |
| Phase 4 integrations | NOT_STARTED | — |

### What "TESTED" does and does not mean here

TESTED means the artefact was exercised with a real tool: nginx parsed the
config, the TOML parser accepted the proxy config, the gateway minted cookies that
a real DSH binary accepted, and the checks ran against the files. It does **not**
mean the deployment works end to end, because no Keycloak, no VM and no TLS
certificate existed. Nothing in this project is VERIFIED yet.

## 8. Open questions

1. **Does a corporate IdP already exist?** If yes, phase 1 must use it and the
   local Keycloak becomes a lab-only tool. This is the single biggest unknown and
   it changes the deliverable.
2. **Which hostname and certificate?** Needed before nginx can serve TLS. Until
   then only a template exists.
3. **Is the VM allowed to accept inbound 443 from the corporate network?** Some
   environments require a load balancer in front; then header handling moves.
4. **How many users, and when?** Determines phase 2/3 sizing.
5. **MFA policy.** Required for the owner; can the IdP enforce it, or must it be
   per-user?
6. **Retention and backup of `$DSH_HOME`.** Not yet designed; affects revocation
   and offboarding.
7. **DSH upgrade policy.** The gateway is coupled to the cookie format; every DSH
   upgrade must re-run the offline verification suite.

## 9. Instructions for the next agent session

1. Read this file, then `decisions.md`, then `threat-model.md`, then
   `deployment-guide.md`. Do not restate the architecture; extend it.
2. Check the status board in §7 before doing anything. If `live` verification is
   still NOT_STARTED, your first job is probably to run it, not to redesign.
3. Never weaken a control to make a demonstration work. If a step needs an unsafe
   shortcut, stop and record it as BLOCKED with the concrete cause.
4. Any change that affects network reachability, the running Harness, or existing
   Docker containers belongs to the **activation** step and needs explicit owner
   approval.
5. `deploy/` is the only home for deployment configuration. Never put it under
   `scripts/` or `docs/` (ADR-11).
6. After completing a phase item, update §3 (status + what was done) and §7 (the
   board), and add the evidence class: offline or live.
7. Git is the owner's. Propose a message; never commit.
8. When something is only checked offline, say "offline". Overstating verification
   is the worst failure mode of this project.

## 10. Rollback

Local mode must be restorable without data loss. The mechanism is structural:
deployment files are additive and live under `deploy/`; the base `compose.yaml`
is unchanged by phase 1; DSH keeps its existing `dsh-home` volume. Rolling back
means stopping the gateway project and starting the original compose project
again. The deployment guide spells out the exact commands and the one thing that
is not automatically reversible: a rotated cookie secret invalidates existing
browser sessions, which is desirable during rollback.
