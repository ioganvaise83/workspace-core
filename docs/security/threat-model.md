# Threat model — Personal AI Workspace on a corporate VM

Scope: one DeepSeek Harness (DSH) instance that today runs on loopback on a
single workstation, moved to a corporate virtual machine and reached from a
browser. This document enumerates what can go wrong, what stops it, and what
stays open. It is the security companion of
[`secure-access-roadmap.md`](secure-access-roadmap.md); decisions referenced as
`ADR-N` live in [`decisions.md`](decisions.md).

Status legend used throughout the security documents:

| Mark | Meaning |
|---|---|
| NOT_STARTED | Designed or named, nothing written yet |
| IN_PROGRESS | Files exist, work incomplete |
| IMPLEMENTED | Configuration written, never executed |
| TESTED | Exercise passed in an offline/lab environment |
| VERIFIED | Passed against a real deployment (VM, corporate IdP) |
| BLOCKED | Cannot proceed without an external decision or component |

## 1. What is actually at risk

DSH is not a web page with a database. The process it protects can do all of
the following, with its own operating-system authority:

- run arbitrary shell commands in a workspace, without confinement;
- read and write the mounted workspace, including Knowledge and Apps;
- read every credential the process holds: model API keys, Gmail OAuth tokens,
  IMAP application passwords, MCP bridge tokens;
- read every session transcript of every conversation ever held in that home;
- act on mailboxes through the MCP tools.

That list is why an access-control bug here is not "someone saw a page". It is
"someone read the mailbox and the notes, and ran commands". The threat model is
written against that severity (ADR-1).

## 2. Assets

| Asset | Where it lives today | Consequence if disclosed or altered |
|---|---|---|
| Session transcripts | `$DSH_HOME/sessions` | Full history of personal and work conversations |
| Model provider keys | `$DSH_HOME/.credentials.yaml` (`refs`) | Spend, and a request path impersonating the owner |
| Cookie signing secret | `$DSH_HOME/.credentials.yaml` (`client-connection/browser-session`) | Ability to mint a valid DSH session cookie for any authority bound to that secret |
| MCP bridge tokens | `$DSH_HOME/bootstrap/*.token` | Full tool access to Gmail and IMAP bridges |
| Gmail OAuth material | host `runtime/gmail/oauth` | Long-lived mailbox read access |
| IMAP passwords | host `runtime/mail-imap/secrets` | Mailbox read access for each account |
| Workspace files | `runtime/workspace`, Knowledge, Apps repos | Source code, notes, credentials accidentally stored in files |
| Attachments, downloads | `$DSH_HOME/attachments`, `runtime/*/downloads` | Mail attachments and uploaded documents |
| Launch token | printed by `dsh web` at startup | One-shot exchange for a DSH browser cookie (see §5) |

## 3. Trust boundaries

```text
[ corporate network ] --HTTPS--> [ gateway: nginx + oauth2-proxy ] --HTTP/loopback--> [ DSH ]
                                          |                                            |
                                          +--> [ Keycloak ]                            +--> [ MCP bridges ]
                                          +--> [ PostgreSQL ]                          +--> [ workspace, Knowledge, Apps ]
```

Boundaries that matter:

1. **Internet/corporate network → gateway.** Only the TLS listener is reachable.
   Everything else is on a private network or loopback (ADR-6).
2. **gateway → DSH.** Plain HTTP on an internal network, carrying a bearer
   cookie. This hop must never be reachable from the corporate network.
3. **DSH → MCP bridges.** Bearer tokens minted per installation. No published
   ports; the tokens are the only credential.
4. **DSH process → host filesystem.** The container's mount set *is* the
   security boundary. There is no in-process confinement of `bash` (ADR-1).
5. **Identity provider → everything else.** Keycloak authenticates; it does not
   authorise data access. That distinction is the core of ADR-3.

## 4. Adversaries

| # | Adversary | Capability assumed |
|---|---|---|
| A1 | A colleague with a corporate account | Valid Keycloak login, knows the hostname or IP, can craft HTTP requests, can read documentation |
| A2 | A colleague without a corporate account | Network access only |
| A3 | A legitimate user after their access is revoked | Holds an old browser cookie, an old oauth2-proxy cookie, an old DSH cookie |
| A4 | Malicious content inside mail or a web page | Can place text the agent will read (prompt injection) |
| A5 | Someone on the VM host | Root or docker-group access, can read volumes |
| A6 | A network attacker on the corporate LAN | Can reach IP and port, cannot break TLS |

## 5. Threat catalogue

Each row: threat → control → test → residual risk. Tests are labelled
`offline` (no infrastructure needed) or `live` (needs VM/IdP).

### T1. Colleague opens the DSH URL directly

- **Control.** DSH is bound to loopback or a private interface, never published.
  Every request to `/`, `/api`, `/api/remote.mux`, `/connect` requires the
  gateway, which requires an oauth2-proxy session (ADR-6, ADR-7).
- **Test.** `live`: from a second machine, `curl https://dsh.corp.example/` →
  302 to IdP; `curl http://<vm-ip>:3080/` → connection refused;
  `curl -H 'Host: dsh.corp.example' http://<vm-ip>:3080/` → refused.
- **Residual.** Anyone who can reach the gateway port reaches the login page.
  That is intended; the login page leaks no data.

### T2. Colleague knows the VM IP and the DSH port

- **Control.** No `ports:` entry publishes DSH. The container listens on the
  compose network only. Host firewall default-deny except 443 (ADR-6).
- **Test.** `offline`: assert no `ports:` in `deploy/single-user/compose.yaml`
  and no `0.0.0.0` bind anywhere; `live`: port scan of the VM shows only 443.
- **Residual.** A mis-edited compose file could publish the port again. The
  offline check exists precisely for that; run it in review.

### T3. Authenticated colleague is not on the allowlist

- **Control.** Deny by default. oauth2-proxy is configured with an explicit
  allowlist of `(issuer, sub)` pairs (`--authenticated-emails-file` is *not*
  used; see ADR-4), and the gateway independently re-checks the `sub` it
  receives before proxying. Two independent refusals.
- **Test.** `offline`: the allowlist file parser rejects a domain-wide entry;
  `live`: log in as the forbidden test user → 403 before any DSH request.
- **Residual.** If both checks share the same config file, one edit defeats both.
  Mitigated by keeping the oauth2-proxy allowlist and the gateway allowlist in
  separate files with separate syntaxes.

### T4. Forged `X-Forwarded-User` / `X-Auth-Request-User`

- **Control.** nginx strips all incoming `X-Auth-Request-*`, `X-Forwarded-*` and
  `X-Real-IP` headers at the edge and sets them itself from the oauth2-proxy
  `auth_request` subrequest result. DSH receives connections only from the
  gateway's fixed address on a private network, so it cannot be reached with
  hand-made headers.
- **Test.** `offline`: nginx config contains the `proxy_set_header` resets and a
  `server_tokens off`; `live`: request with `X-Auth-Request-User: owner` and no
  cookie → still 302 to login.
- **Verified, offline.** Confirmed against the real DSH binary that identity
  headers alone grant nothing: a request with `X-Forwarded-User`,
  `X-Auth-Request-User` and `X-Forwarded-Email` and no DSH cookie returned 401.
- **Residual.** Header trust is only as good as the peer address restriction.
  Enforced twice: compose network isolation and nginx `allow`/`deny`.

### T5. Direct API calls, bypassing the UI

- **Control.** `/api`, `/api/remote.mux` and `/connect` are behind the same
  `auth_request` as the UI. DSH itself still validates its own cookie (ADR-7), so
  an API call needs both credentials: a valid oauth2-proxy session and a valid
  DSH cookie.
- **Test.** `offline`: nginx has no `location` that bypasses auth except
  `/oauth2/`; `live`: `curl -X POST https://.../api` without cookies → 401.
- **Verified, offline.** Against the real binary: anonymous `POST /api` → 401;
  authenticated (minted) cookie → request reaches the handler.
- **Residual.** None specific; this is defence in depth.

### T6. WebSocket opened directly

- **Control.** The WebSocket upgrade path `/api/remote.mux` goes through the same
  nginx `auth_request` and the same DSH admission (`admitConnection`). nginx is
  configured with `proxy_http_version 1.1`, `Upgrade`/`Connection` pass-through
  and a read timeout longer than DSH's own stream lifetime.
- **Test.** `offline`: upgrade headers present in the `location`; `live`:
  `websocat` or browser devtools shows 401/302 without a session, 101 with one.
- **Verified, offline.** Against the real binary: upgrade without cookie → 401;
  upgrade with a minted cookie → 101 Switching Protocols.
- **Residual.** A very long-lived idle stream may exceed proxy timeouts; tune
  `proxy_read_timeout` (see deployment guide) or DSH heartbeat.

### T7. Stale browser cookie after removal from the group

- **Control.** Two independent expiries. The oauth2-proxy cookie is short-lived
  and re-validated (`--cookie-refresh`, `--session-store-type`), so removal from
  Keycloak ends the proxy session. The DSH cookie is separate and is *not*
  invalidated by Keycloak; therefore revocation must also rotate the DSH signing
  secret (ADR-5, phase-1 limitation).
- **Test.** `offline`: revocation script removes the record and restarts the
  unit; `live`: after revocation, an old DSH cookie → 401.
- **Verified, offline.** Against the real binary: removing the
  `client-connection/browser-session` record and restarting regenerates the
  secret and every previously issued cookie returns 401; a cookie minted with
  the new secret returns 200.
- **Residual.** Between revocation and secret rotation, a stolen DSH cookie stays
  valid for up to `cookieMaxAgeDays`. Phase 1 therefore caps it (ADR-5).

### T8. Colleague reuses an old session (fixation)

- **Control.** DSH cookies are HMAC-signed, `HttpOnly`, `SameSite=Strict`,
  authority-bound, and carry an absolute issue/expiry interval. A cookie minted
  for one authority is rejected at another.
- **Test.** `offline`: minted cookie for `other.corp.example` presented with
  `Host: dsh.corp.example` → 401.
- **Verified, offline.** Against the real binary: wrong-authority cookie → 401;
  expired cookie → 401; lifetime beyond `cookieMaxAgeDays` → 401.
- **Residual.** Cookies are bearer tokens. A machine compromised after login
  keeps access until expiry.

### T9. Launch token leaks via URL, Referer or access log

- **Control.** In the target design the launch token is **never** given to a
  browser (ADR-7): the gateway mints the DSH cookie directly, so
  `?token=...` never appears in a URL, a Referer, a browser history entry or an
  nginx access log. If an operator falls back to the manual token flow, the URL
  must not be logged.
- **Test.** `offline`: `deploy/tests/check-security.sh` (§6) asserts that the nginx
  `log_format` uses the path only and omits `$request_uri`, `$args`, `$http_cookie` and
  `$http_authorization`, so a token or code cannot be written to the access log.
- **Residual.** Fallback mode (manual token paste) re-introduces the risk; it is
  documented as an emergency path only.

### T10. oauth2-proxy cookie secret compromised

- **Control.** Secret is generated on the host, lives outside Git, `chmod 600`,
  mounted read-only. Rotating it invalidates every proxy session. It is not the
  same secret as DSH's cookie key, so rotating one does not silently grant the
  other.
- **Test.** `offline`: secret scan over `deploy/` and Git index finds no literal;
  `live`: rotate and confirm old proxy cookies are rejected.
- **Residual.** A host compromise reads the secret; that is out of scope (A5).

### T11. Direct access to an MCP bridge

- **Control.** No published ports; bridges are reachable only on the compose
  network; each carries a per-installation bearer token. The gateway does not
  route to them at all.
- **Test.** `offline`: registry and compose contain no `ports:` for
  `gmail-mcp`, `mail-imap-mcp`; `live`: `curl http://<vm-ip>:8765/mcp` from
  another machine → refused.
- **Residual.** Any process inside the compose network can reach a bridge; it
  still needs the token.

### T12. Prompt injection from mail or a web page

- **Control.** Tool-level design, not network-level: mail is read-only by
  construction (no write verb in the tool surface), IMAP passes a command guard,
  and destructive mail actions need a two-phase digest plus an approval file the
  agent cannot create.
- **Test.** `offline`: mail-imap integration tests cover the guard; the approval
  directory is not mounted into the harness.
- **Residual.** Injection can still influence what the agent *says* and which
  read-only tools it calls. It cannot send or delete mail. Documented as a limit
  of the design, not a bug.

### T13. Agent has shell access

- **Control.** Accepted by design (that is the product). The boundary is the
  container's mount set and the absence of a Docker socket.
- **Test.** `offline`: compose asserts no `/var/run/docker.sock` mount, no
  `privileged: true`, `cap_drop: ALL`, `no-new-privileges: true`.
- **Residual.** The agent can read everything mounted. In phase 1 that is the
  owner's own data by construction; in phase 3 it is exactly why each user gets a
  separate container (ADR-2).

### T14. Docker socket access

- **Control.** Never mounted into the harness or into any integration. Any future
  orchestrator that needs it is a separate, explicitly reviewed component
  (phase 3).
- **Test.** `offline`: `deploy/tests/check-security.sh` (§3) and `deploy/tests/compose.test.js` fail on `docker.sock`.
- **Residual.** None in phase 1.

### T15. OAuth tokens exposed to the model or logs

- **Control.** Credentials live in `$DSH_HOME/.credentials.yaml` and in host
  directories outside Git; MCP tokens are passed by file path, not by prompt.
  Logging is configured to drop query strings and to keep the harness's stdout
  out of any shared log sink.
- **Test.** `offline`: secret scan; grep of nginx config for `log_format`
  without `$request_uri` or with `$uri` only.
- **Residual.** A tool result could still echo a token if a server returned one;
  the read-only bridges never return credentials.

### T16. Container port published by mistake

- **Control.** The single-user overlay is a *separate* compose file, and the
  offline test asserts the absence of `ports:` in both the overlay and the base
  integration services. The gateway is the only service with a published port,
  and it publishes `443` on one concrete address.
- **Test.** `offline`: `deploy/tests/check-security.sh` (§2) and `deploy/tests/compose.test.js`.
- **Residual.** A human can bypass any test. The test exists so review has a
  concrete artefact to point at.

### T17. Use of another user's workspace

- **Phase 1.** Not applicable: one owner, one workspace. The threat becomes real
  only with multiple users, which phase 1 must not pretend to solve.
- **Control (phase 3).** One container per user with its own `DSH_HOME`, its own
  workspace volume and its own MCP credentials (ADR-2). Identity is bound to a
  container, not to a shared session.
- **Test.** `live` (phase 3): user B's cookie presented to user A's instance is
  rejected; user B cannot read user A's volume.
- **Residual.** Phase 1 is explicitly marked single-user (ADR-8). Running it for
  two colleagues would give them one shared home; that is forbidden by the
  deployment guide.

### T18. One user's container compromised in the multi-user future

- **Phase 3.** Each container runs with `cap_drop: ALL`,
  `no-new-privileges: true`, a read-only root filesystem where possible, its own
  volumes, and no Docker socket. A compromised container yields only that user's
  data.
- **Residual.** All containers share the Docker network unless per-user networks
  are used; phase 3 must create one network per user or apply network policies.

## 6. Threats explicitly out of scope for phase 1

- Host compromise (A5): root on the VM reads every volume. Mitigation is
  operational, not architectural.
- Physical access to the workstation.
- Denial of service against the gateway: rate limiting is a proxy-level control
  noted in the deployment guide, not a phase-1 guarantee.
- Supply chain of the DSH image and the third-party images: pinned by tag and
  digest where practical, reviewed by the owner.

## 7. Summary of residual risk for phase 1

Phase 1 is safe **only** under three conditions, each of which the deployment
guide makes explicit:

1. exactly one human is allowed through the gateway;
2. the DSH port is never reachable except from the gateway;
3. revocation is performed as an explicit procedure, including the DSH secret
   rotation, because Keycloak alone cannot invalidate a DSH cookie.

If any of the three is dropped, the instance becomes a shared home for several
people, and this threat model no longer holds (ADR-8).
