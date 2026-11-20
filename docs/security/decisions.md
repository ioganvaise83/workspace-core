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

---

## ADR-16 — One shared origin for Keycloak, with TLS on Keycloak itself

**Status:** Accepted (implemented, tested offline)

**Context.** The lab first used `http://127.0.0.1:8443` as the issuer. Inside a
container, `127.0.0.1` is that container, so oauth2-proxy could not reach Keycloak
at all, and "fixing" it by pointing the browser at one origin and the proxy at
another breaks the OIDC issuer check: the `iss` in the discovery document must
equal the URL the client was configured with, character for character.

The tempting workarounds are all unacceptable: disabling issuer verification,
skipping TLS verification, or publishing Keycloak on a network address.

**Decision.** Every component uses **one** origin: `https://keycloak.local:8443`.

- On Windows, `keycloak.local` resolves to `127.0.0.1` via the hosts file.
- Inside Docker, `keycloak.local` is a **network alias** of the Keycloak container
  on the shared `edge` network, so oauth2-proxy reaches it by name.
- Keycloak terminates TLS itself with a certificate for `keycloak.local`, signed
  by a local root CA that the host trusts and that oauth2-proxy trusts via
  `provider_ca_files`.

**Consequences.** The issuer is identical on every side, so no verification is
relaxed and no hostname rewriting is needed. The cost is two host-side
prerequisites, both requiring elevation once: import the root CA, and add two
hosts entries. The corporate migration is then a pure rename: real DNS, a real
certificate, the same configuration shape.

**Revisit never**; the alternative is disabling verification, which this project
forbids.

## ADR-17 — Local lab names, never the corporate placeholders

**Status:** Accepted

**Context.** The templates shipped `dsh.corp.example` and `id.corp.example`. These
do not resolve anywhere, so a "working" local test was impossible, and a developer
who made them work by editing `/etc/hosts` would then be testing a name that the
corporate deployment does not use either.

**Decision.** Templates default to `dsh.local` and `keycloak.local`, which are
explicitly lab names. The corporate migration replaces exactly three values —
`KC_HOSTNAME`, `DSH_HOSTNAME`, `OIDC_ISSUER_URL` — and nothing else. The env test
fails if a template reverts to a `*.corp.example` placeholder, so the difference
between "configured" and "pretending" stays visible.

**Consequences.** A local test proves the shape of the deployment, not the
corporate domain. That distinction is recorded in every status table.

**Revisit never.**

## ADR-18 — Admission is a group claim plus a subject check, never an email file

**Status:** Accepted (corrects a design error)

**Context.** The design assumed `authenticated_emails_file` enforces the subject
allowlist. It does not: oauth2-proxy calls `p.Validator(session.Email)`, so the
file is matched against the **email address**. A `sub` written there matches
nothing, which means it denies nobody — a control that looks present and enforces
nothing is worse than no control, because it stops further review.

**Decision.** Two gates, both verified:

1. `allowed_groups = ["dsh-users"]` on oauth2-proxy. Keycloak asserts membership in
   the `groups` claim; a non-member is refused at the proxy, before nginx proxies
   anything. The group name must exactly match the mapper output, which is
   `dsh-users` (no leading slash) because the realm uses `full.path=false`.
2. `GATEWAY_ALLOWED_SUBJECTS` on the gateway: the exact OIDC `sub` is compared
   before any cookie is minted.

The email file is not configured at all, because pointing it at a missing file
makes oauth2-proxy exit at start-up (`logger.Fatalf`), and pointing it at our
subject list would look like a working control.

**Consequences.** Denying a colleague requires either group removal (immediate, at
the IdP) or a subject edit plus a gateway restart. Both are explicit. The subject
is never an email, so a rename cannot move access.

**Revisit never.**

## ADR-19 — The realm import must never be able to destroy a live realm

**Status:** Accepted (critical fix)

**Context.** `--import-realm` runs the directory import on **every** start while
the import directory is configured. Keycloak's default strategy is
`OVERWRITE_EXISTING`, which removes the existing realm — users, MFA enrolments, the
client secret — before re-importing the template. Verified in 26.8.2
(`DirImportProviderFactory` default, `ImportUtils.importRealm` removing the realm).
A restart of the identity project would therefore have silently reset the owner's
account and wiped the MFA enrolment.

**Decision.** Pin `--spi-import--dir--strategy=IGNORE_EXISTING` in the compose
command, so a restart is a no-op once the realm exists. The env template defaults
the same value, and `check-env-templates.sh` fails if either is missing.

**Consequences.** Re-importing a changed template into an existing realm now
requires deleting the realm deliberately. That is the correct direction: a
destructive operation must be chosen, not inherited from a default.

**Revisit never.**

---

## ADR-20 — Lab prerequisites live in an overlay; the base file must stay startable

**Status:** Accepted (corrects a near-miss)

**Context.** Phase 1B needed three things in `deploy/identity/compose.yaml`: TLS
material mounted from the host, an external `edge` network, and an HTTPS listener.
Putting them in the base file would have made the owner's next ordinary
`docker compose up -d` fail — the certificates do not exist yet and the network has
not been created. A preparation step must never break the working installation.

**Decision.** The base file keeps working exactly as before. Everything the lab
needs goes into `deploy/identity/compose.lab.yml`, applied as an additional `-f`.

One thing is deliberately the exception: the `IGNORE_EXISTING` import strategy
stays in the **base** file. It is not a lab nicety, it is protection for the realm
that already exists — a restart without it can delete users, MFA enrolments and the
client secret (ADR-19). Protection belongs where it applies, not where it is
convenient.

**Consequences.** Two commands instead of one while testing SSO. In exchange, the
owner can enable and disable the lab without touching a working project, and
`check-security.sh` now fails if the base gains a required TLS path or an external
network.

**Revisit never.**

## ADR-21 — The lab repository does not fork into two compose files per project

**Status:** Accepted

**Context.** Splitting `deploy/single-user` the same way as identity was
considered and rejected: that project is *itself* opt-in, has no working
predecessor to protect, and is not started by anyone by accident. Splitting it
would double the file count for no safety gain.

**Decision.** Only `deploy/identity` gets an overlay, because only it has a
running installation behind it. `deploy/single-user` stays a single compose file.

**Consequences.** The rule is "an overlay exists where a working service must
survive the preparation", not "every project gets a lab variant".

**Revisit never.**
