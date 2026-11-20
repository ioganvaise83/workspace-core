# Architecture decisions — secure access

One decision per record. Each states the context, the choice, what it costs and
what would make us revisit it. Records are append-only: a superseded decision
stays, marked `Superseded by ADR-N`.

Status values match the roadmap: NOT_STARTED, IN_PROGRESS, IMPLEMENTED,
TESTED, VERIFIED, BLOCKED.

---

## ADR-1 — The container is the security boundary, not an in-process policy

**Status:** Accepted (VERIFIED by source audit)

**Context.** DSH 0.2.1-rc.3 contains an authorisation seam
(`@deepseek-ai/dsh-api-remote-access`) with roles, resource bindings and
per-method decisions, and a `Peer` carries a `principal`. It is tempting to read
that as multi-tenancy. The audit shows it is not: the only declared principal is
`{ kind: 'owner' }`, every authenticated browser connection shares one
`browserPeer`, and `bash` runs with the process's own authority. Sessions,
credentials, profiles, workspace registry and MCP connections all live in one
`$DSH_HOME`.

**Decision.** Isolation between people is achieved by **separate processes**
(containers), each with its own `$DSH_HOME`, workspace and credentials. We do not
attempt multi-tenant policy inside one DSH process.

**Consequences.** Each user costs a container and its memory. In exchange, an
authorisation bug cannot cross a user boundary, and prompt injection cannot reach
another person's mail.

**Revisit if** upstream ships per-user principals with per-user homes and a
supported external-authentication mode; even then, shell access would still
argue for container isolation.

---

## ADR-2 — One product, one identity, one instance per user

**Status:** Accepted

**Context.** The owner wants one address and one corporate login for colleagues
later, without a shared session.

**Decision.** The product surface is unified: one hostname pattern, one Keycloak
realm, one gateway. Underneath, routing is identity-aware and each identity maps
to its own Harness instance with its own home, workspace and mail credentials.
Phase 1 implements the single-user case of exactly this shape, so phase 3 adds
instances rather than re-architecting.

**Consequences.** The gateway must understand identity from day one, even while
it serves one person. That is a deliberate cost paid early to avoid a rewrite.

**Revisit never** unless DSH gains genuine in-process multi-tenancy (ADR-1).

---

## ADR-3 — Keycloak authenticates; it does not authorise data access

**Status:** Accepted

**Context.** A common misreading is that adding SSO makes an application
multi-user. It does not: SSO proves who is calling, not which rows they may read.

**Decision.** Keycloak's only job is authentication plus group membership. Data
authorisation is enforced by (a) the gateway's allowlist of `(issuer, sub)` and
(b) the per-user container boundary. A user passing Keycloak and failing the
allowlist gets 403 and never reaches DSH.

**Consequences.** Two places to change when adding a person (Keycloak group, and
the gateway allowlist). Accepted: a single switch is a single mistake away from
granting everyone.

---

## ADR-4 — Allowlist on a stable identifier, never on an email domain

**Status:** Accepted

**Context.** Domain-wide admission (`--email-domain=corp.example`) admits every
employee, including service accounts and future hires.

**Decision.** Admission requires an exact match on the stable pair
`(issuer, sub)`. `sub` is what oauth2-proxy puts into its session `User` claim by
default (`oidcUserClaim = "sub"`), so the identity carried to the gateway is
stable across email changes and renames. Email is treated as a display attribute
only. Where a group is used instead, membership must be confirmed by the IdP
(`--allowed-group` with a group-membership mapper), never inferred from a name.

**Consequences.** Onboarding a colleague is a deliberate edit. `sub` values are
not human-readable, so the allowlist carries a comment with the person's name.

**Revisit if** the corporate IdP cannot expose `sub` (it always can) or requires
group-only authorisation; then group membership becomes the primary key, still
verified server-side.

---

## ADR-5 — DSH cookie lifetime is capped in phase 1

**Status:** Accepted (VERIFIED experimentally)

**Context.** A DSH browser cookie lives `cookieMaxAgeDays`, default 30 days. It
is independent of Keycloak: removing a user from a group does not invalidate it.
For a single-owner instance a 30-day bearer token is a large blast radius.

**Decision.** Phase 1 sets `cookieMaxAgeDays` to a short value (default **1**
day) through a profile override, and revocation includes rotating the DSH signing
secret. Both are documented procedures, not assumptions.

**Consequences.** The owner re-authenticates daily through Keycloak (fast, SSO).
Restart-based revocation is heavy but correct.

**Verified.** On the installed binary: with `cookieMaxAgeDays: 1`, a cookie
minted with a 2-day lifetime is rejected (401), and `--trusted-host` still works
because the override restates `trustedHosts`.

**Revisit in phase 3**, where each user's instance can use a longer lifetime
because the container boundary — not the cookie — carries the isolation.

---

## ADR-6 — Only the gateway is published; DSH stays private

**Status:** Accepted

**Context.** DSH can execute code. Its own documentation warns that neither
`--public-url` nor the Host/Origin fence protects the port, and rejects
`--host 0.0.0.0`.

**Decision.** DSH binds a loopback or private interface inside its own network;
only `nginx` publishes a port, on one concrete address, with TLS. Every other
service (DSH, Gmail MCP, IMAP MCP, Keycloak, PostgreSQL, oauth2-proxy) has no
published port.

**Consequences.** Two-network design: an `edge` network between nginx,
oauth2-proxy and DSH, and an internal-only network for the rest. The owner must
supply a TLS certificate and a DNS name.

**Revisit never.**

---

## ADR-7 — The gateway mints the DSH cookie; the launch token never reaches a browser

**Status:** Accepted (VERIFIED experimentally)

**Context.** DSH authenticates browsers with a per-process launch token printed
at startup and exchanged for a signed cookie. Passing that token to every visitor
would give every visitor the same session — exactly what must not happen. The
alternatives were: (a) hand the token to the browser, (b) patch DSH, (c) find a
supported seam.

The audit found the seam. The cookie is `HMAC-SHA256(secret, body)` where `secret`
is the 32-byte `client-connection/browser-session` credential record in
`$DSH_HOME/.credentials.yaml`, and `body` is a base64url JSON payload of
`{version, authority, issuedAt, expiresAt}` with the cookie name
`dsh-auth-<sha256(authority)>`. DSH **reads** this record at activation and
generates it only when absent.

**Decision.** A small gateway component, after oauth2-proxy has authenticated the
request and the allowlist has matched, mints the DSH cookie for the exact
authority and sets it on the response. The signing secret is provisioned on the
host, shared read-only with both DSH and the gateway, and never leaves them. The
launch token is never printed to a browser and never appears in a URL.

**Consequences.** The gateway becomes security-critical: it holds the cookie
signing secret. It must therefore be small, auditable, and reachable only from
nginx. The secret must be rotated as part of revocation.

**Verified.** On the installed binary: a cookie minted offline from the stored
secret was accepted (200); a cookie minted for another authority was rejected
(401); an expired cookie and an over-long lifetime were rejected (401); a
pre-seeded secret was honoured rather than overwritten; WebSocket upgrade with a
minted cookie returned 101, without one 401.

**Revisit if** upstream ships a supported external-authentication mode, making
the minting unnecessary.

---

## ADR-8 — Phase 1 is explicitly single-owner and must not be reused as multi-user

**Status:** Accepted

**Context.** The gateway mints a cookie for "the" DSH instance. If two people
pass the allowlist, they share one home: one sessions list, one mail set, one
workspace.

**Decision.** Phase 1 admits exactly one `(issuer, sub)`. The allowlist parser
refuses more than one entry unless a future flag explicitly enables multi-instance
routing. Documentation states the limitation wherever the gateway is described.

**Consequences.** Adding a second colleague requires phase 3, not a config edit.
This is a feature: it makes the unsafe state hard to reach by accident.

**Revisit in phase 3**, when routing is per identity and the allowlist grows.

---

## ADR-9 — Keycloak is separate from the Harness compose project

**Status:** Accepted

**Context.** Identity infrastructure and the workload have different upgrade
cadences and different blast radii. Mixing them means a Harness change can log
everyone out, or a Keycloak upgrade can break the workspace.

**Decision.** Keycloak and PostgreSQL live in `deploy/identity/compose.yaml`, a
separate project with its own network, its own volumes and its own upgrade path.
The Harness deployment lives in `deploy/single-user/`. They share only the OIDC
issuer URL and the client secret.

**Consequences.** Two `docker compose` invocations, two `.env` files. Accepted for
independent lifecycle.

**Revisit never.**

---

## ADR-10 — Integrations and credentials stay per-instance

**Status:** Accepted

**Context.** Sharing a Gmail or IMAP bridge across users is the fastest way to
leak one person's mail to another.

**Decision.** Every bridge token, OAuth file and account list is minted and
mounted per instance. Phase 1 keeps today's single-owner paths unchanged; phase 3
parameterises the same layout by user id.

**Consequences.** No shared volumes between users, ever. The existing
`bootstrap-integrations.cjs` mechanism already writes tokens per `DSH_HOME`, so it
is reused, not replaced.

**Revisit never.**

---

## ADR-11 — Deployment files live in `deploy/`, never in `scripts/` or `docs/`

**Status:** Accepted (owner decision)

**Context.** The agent's container mounts only `docs/`, `scripts/`,
`integrations/`, `plugins/` and a few files read-write; the repository root is
read-only for it. The owner decided the deploy configuration is a first-class
directory.

**Decision.** `workspace-core/deploy/` holds `identity/` and `single-user/`. The
owner creates the directory on the host; the agent never writes deployment
configuration into `scripts/` or `docs/` as a workaround. Documentation stays in
`docs/security/`.

**Consequences.** The Harness container needs the bind mount
`./deploy:/workspace/core/deploy` so the agent can write deployment files
directly. The owner added it to the `harness` service volumes in `compose.yaml`;
it takes effect after that service is recreated (`docker compose up -d harness`).
Until then the directory is outside the agent's writable set and files would
have to be prepared elsewhere and moved by hand.

**Revisit never.**

---

## ADR-12 — The gateway holds the signing secret and nothing else

**Status:** Accepted (reviewed, offline-tested)

**Context.** Minting a DSH cookie requires the harness signing secret. The obvious
implementation mounts `dsh-home` and reads the credentials file. That would give
the gateway read access to the model API keys, the MCP bridge tokens and every
session transcript — a front-door component holding the entire vault.

**Decision.** The gateway mounts exactly two files as Docker secrets: the 32-byte
cookie secret and the nginx shared secret. It mounts no volume, no home
directory, no OAuth material and no workspace. It runs `read_only`,
`cap_drop: ALL`, `no-new-privileges`, with memory and pid limits.

**Consequences.** A gateway compromise yields the ability to mint a cookie for an
allowlisted subject — serious, but it does not disclose mail, sessions or the
model key. The cost is operational: the secret must be copied to the host and
kept in sync with DSH, which the deployment guide turns into an explicit,
verifiable step.

**Revisit if** DSH ships a supported external-authentication mode, at which point
the gateway disappears entirely.

## ADR-13 — Header hygiene is one included file, never repeated per location

**Status:** Accepted (empirically justified)

**Context.** The first version cleared client-supplied identity headers at nginx
server level. nginx does not inherit `proxy_set_header` into a location that
declares any of its own, so the clears were silently discarded in the application
location — the only place they mattered. A client-supplied `Authorization` and
`X-Forwarded-User` reached the upstream, verified on nginx 1.26.3.

**Decision.** All clears live in `deploy/single-user/nginx/proxy-hygiene.conf`,
included by every proxying location. The server block deliberately sets no
`proxy_set_header` at all, so the include is the single mechanism. The offline
suite parses locations and fails if any proxying location lacks the include.

**Consequences.** A new location must remember one line. That is enforced by a
test rather than by review, and the test was mutation-checked: removing the
include from one location fails the suite.

**Revisit never**; this is an nginx semantic, not a preference.

## ADR-14 — The gateway is version-coupled to DSH and that is a release gate

**Status:** Accepted

**Context.** The cookie format (`HMAC-SHA256` over a JSON body, name
`dsh-auth-<sha256(authority)>`, 32-byte secret) is an implementation detail of
`dsh-client-connection`, not a published contract. The gateway reproduces it.

**Decision.** Treat the coupling as an explicit release gate: every DSH upgrade
re-runs `deploy/tests/gateway.test.js` against the new image, including the two
contract tests that present a gateway-minted cookie to a real binary. A mismatch
fails loudly (401), never quietly.

**Consequences.** A DSH upgrade can break login until the suite is re-run. That is
accepted, because the alternative — trusting an unpublished format — fails
silently and only in production.

**Revisit if** upstream publishes an external-authentication mode or a documented
session API.

## ADR-15 — The shared secret is opaque; the cookie secret is canonical base64url

**Status:** Accepted

**Context.** The first gateway implemented validated both secret files as
base64url. That rejected legitimate random values for the nginx shared secret
(base64 containing `+` or `/`), forcing operators to weaken generators or debug a
confusing start-up failure found during the local end-to-end run.

**Decision.** Only the cookie secret is canonical base64url with an exact decoded
length, because two spellings there would mean two different HMAC keys. The shared
secret is an opaque string, required only to be non-empty and at least 32
characters, and compared in constant time.

**Consequences.** The two secrets have different validation rules, which is
documented at the reading function so a future reader does not "unify" them.

**Revisit never.**
