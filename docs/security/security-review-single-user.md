# Security review — single-user secure access (pre-activation)

**Scope.** The prepared `deploy/single-user` deployment and, in particular, the
custom gateway that mints a DSH session cookie from the harness signing secret.

**Status.** Review complete. It found **four defects**, three of them breaking the
design outright; all four are fixed in the configuration with offline tests. The
deployment is **ready for a controlled local test run**, not production-ready: no
check has run on a VM, against a real Keycloak, or with a real certificate.

Evidence classes: **offline** = reproduced here against the installed DSH 0.2.1-rc.3
binary and/or real nginx 1.26.3. **live** = requires the VM. Nothing below is live.

## 1. Findings that changed the design

### F-1 (critical, fixed) — header hygiene was silently discarded

The template cleared client-supplied `Authorization`, `X-Forwarded-User`,
`X-Auth-Request-*` at server level. nginx **does not inherit** `proxy_set_header`
into a location that declares any of its own. The application location declares
four, so every server-level clear was discarded exactly where it mattered.

Reproduced on nginx 1.26.3:

```text
server { proxy_set_header Authorization ""; proxy_set_header X-Forwarded-User ""; }
location /withset { proxy_set_header X-Auth-Request-User "alice"; proxy_pass ...; }

$ curl -H 'Authorization: Bearer ATTACKER' -H 'X-Forwarded-User: attacker' ... /withset
{"x-auth-request-user":"alice","authorization":"Bearer ATTACKER","x-forwarded-user":"attacker", ...}
```

A client-supplied `Authorization` and `X-Forwarded-User` reached the upstream
verbatim. Against oauth2-proxy this is worse than cosmetic: oauth2-proxy trusts
`X-Forwarded-*` from a configured trusted proxy, and nginx is that proxy.

**Fix.** All clears moved into `deploy/single-user/nginx/proxy-hygiene.conf`, which
every proxying location includes. A location cannot silently lose them, and the
offline suite asserts each proxying location includes the file. Re-verified:

```text
location / { include hygiene.conf; proxy_set_header X-Auth-Request-User "alice"; ... }
$ curl -H 'Authorization: Bearer ATTACKER' -H 'X-Auth-Request-User: attacker' ...
{"x-auth-request-user":"alice-from-auth"}      # Authorization and X-Forwarded-* gone
```

### F-2 (critical, fixed) — the gateway was handed the wrong `Host`

The application location did not set `Host`. nginx then sends the **upstream
name** (`dsh_gateway`), not the browser's authority. Because the gateway
authorises on an exact authority from its allowlist, every single request would
have been refused with 421 — and, had the allowlist been widened to accommodate
it, the minted cookie would have been bound to a name the browser never uses.

Reproduced:

```text
$ curl -H 'Host: dsh.corp.example' https://.../        # upstream sees:
{"host":"dsh_gateway", ...}
```

**Fix.** `proxy_set_header Host $host;` in the application location, with a comment
explaining why it is not optional.

### F-3 (critical, fixed) — the browser never received the cookie

The gateway minted a cookie for the upstream request but never sent `Set-Cookie`
to the browser. DSH does not emit one on an ordinary request — verified against
the installed binary: an authenticated `GET /` answers `200` with no `Set-Cookie`.
The user would therefore authenticate at Keycloak, be proxied successfully, and
land on a UI that immediately sees 401 on every API call.

This also revealed a design error in the review of the first draft: it assumed
DSH would re-issue its cookie. It does not.

**Fix.** The gateway now sets `Set-Cookie` on the response, replacing any
upstream value for the same name, with `Secure`, `HttpOnly`, `SameSite=Strict`,
`Max-Age` and `Expires` derived from the cookie payload.

### F-4 (medium, fixed) — no `auth_request` timeouts

A hung oauth2-proxy would hold an nginx worker for the upstream default timeout.
Timeouts are now 5s connect / 10s read-write. A timeout yields 500, which is
fail-closed.

## 2. Threat / control / test / residual table

| # | Threat | Control | Test and result | Residual risk |
|---|---|---|---|---|
| 1 | Gateway reads more of `dsh-home` than the signing secret | Only two secrets are mounted: `dsh-cookie-secret` (32 raw bytes) and the nginx shared secret. No `dsh-home` volume, no OAuth files, no MCP tokens, no workspace | `compose.test.js`: gateway has no volume other than `server.js`; secrets are file-based | A compromised gateway can mint a cookie for any allowlisted subject. It cannot read mail, sessions or the workspace |
| 2 | Minimise gateway privileges | `cap_drop: ALL`, `read_only`, `no-new-privileges`, `mem_limit 128m`, `pids_limit 64`, no Docker socket, joins only `edge` + `app` | `check-security.sh` §3, `compose.test.js` | It sits on `app`, so it can reach the Harness network. Necessary and unavoidable |
| 3 | Client forges identity headers | nginx clears them in every proxying location (`proxy-hygiene.conf`) **and** the gateway requires a shared secret only nginx knows, **and** the gateway re-checks `sub` against its own allowlist | Verified offline: smuggled headers reach neither oauth2-proxy nor the gateway; wrong shared secret → 403 | A compromise of nginx yields full identity control. Accepted: nginx is the trust anchor |
| 4 | Bypass oauth2-proxy | App location is `auth_request`-guarded; the only unauthenticated locations are `/oauth2/`, `/oauth2/auth` (internal), `@login` and `/healthz` | `check-security.sh` §5 asserts no other location is reachable without auth; offline run: anonymous `/` → 500 (proxy down), never 200 | None known |
| 5 | Reach the Harness directly | Harness publishes no port; only nginx binds an address; gateway is the only bridge into `app` | `check-security.sh` §2, `compose.test.js`; base compose keeps `127.0.0.1:3080` | A firewall mistake or a re-published port. Mitigated by the check, not by design |
| 6 | API and WebSocket reached without a session | Same `auth_request` covers all paths, including the upgrade; the gateway re-applies admission on `upgrade` | Offline: upgrade without cookie → 401, with cookie → 101 (earlier iteration); gateway upgrade path shares the admission code | A future route that bypasses nginx. None exists today |
| 7 | Revoked user keeps access | Keycloak group removal ends the proxy session at the next refresh (15m). The DSH cookie is separate and **survives**, so revocation must also rotate the signing secret | Documented procedure; offline: deleting the record and restarting invalidates every old cookie (401) | **Window of up to `GATEWAY_COOKIE_MAX_AGE_SECONDS`** between Keycloak removal and secret rotation. Real risk, mitigated by a 1-day cap and an explicit procedure |
| 8 | Keycloak down | New logins impossible; existing proxy sessions live until expiry; gateway keeps working for already-authenticated requests | Verified offline that a down oauth2-proxy → 500 and the backend is unreachable | Existing sessions continue until expiry. Acceptable, and preferable to locking out the owner |
| 9 | oauth2-proxy down | `auth_request` fails → 500, no request reaches the gateway | Verified offline on real nginx | None; this is the desired fail-closed behaviour |
| 10 | Gateway down | nginx → 502; nothing reaches the Harness | Verified offline | None |
| 11 | Harness down | Gateway → 502 | Verified offline (upstream error path) | None |
| 12 | Secret leakage via logs | nginx log format uses `$uri`; oauth2-proxy request logging off; gateway logs subjects, never secrets or cookie values | `check-security.sh` §6 | A subject id in a log is a pseudonymous identifier, not a credential |
| 13 | Cookie theft in transit | TLS 1.2+ only; plain HTTP redirects with 308; gateway sets `Secure` unconditionally | `check-security.sh` §7; offline: 308 redirect observed on the rendered config | A stolen cookie is a bearer token until expiry |
| 14 | Host header attack | nginx `server_name` binding; gateway requires an exact allowlisted authority; DSH binds its own cookie to the authority | Offline: foreign `Host` → 401 from DSH; non-allowlisted authority → 421 from the gateway | If `GATEWAY_ALLOWED_AUTHORITIES` is widened carelessly, a second authority becomes valid |
| 15 | Open redirect after login | `whitelist_domains` restricts the `rd` target | Config assertion in `compose.test.js` | None known |
| 16 | CSRF on the login flow | OIDC `state` and nonce validated; `SameSite=Lax` on the proxy cookie; PKCE S256 | Config assertions | None known |
| 17 | DSH upgrade changes the cookie format | The gateway is version-coupled by design. It fails closed: a wrong format yields 401, never a bypass | Contract tests mint a cookie with the shipped algorithm and present it to a real DSH | **A DSH upgrade can silently break login.** Mitigation: the offline contract test must be re-run against the new image before activation; the roadmap lists this as a gate |
| 18 | Compromise of one component | Gateway → mint cookies for allowlisted subjects. oauth2-proxy → its own sessions plus the client secret. nginx → identity control, but still needs the gateway secret. Harness → everything it can reach, unchanged from today | Reviewed per component | A compromised gateway or nginx is equivalent to a compromised front door; neither yields mail or workspace contents directly |

## 3. Answers to the specific questions

**1–2. How the gateway gets the secret; can it be narrowed?**
It receives exactly one file, `dsh-cookie-secret`, mounted as a Docker secret,
plus the nginx shared secret. It does **not** mount `dsh-home`, the OAuth
directory, MCP tokens, the workspace or the credentials file. Narrowing further is
not possible: the secret is the minimum needed to mint a cookie, and the
alternative (the launch token) is strictly worse because it is a single shared
credential for every visitor. Recorded as ADR-12.

**3. Identity forgery and oauth2-proxy bypass.**
Closed, with two independent mechanisms: edge-level header clearing (now actually
in force after F-1) and the gateway shared secret. Verified offline with smuggled
headers.

**4. Are all routes protected?**
Yes. Only `/oauth2/`, `@login`, `/healthz` and the internal `/oauth2/auth` are
unauthenticated. `/api` and `/api/remote.mux` are ordinary paths under
`location /`, so they inherit the guard; the upgrade is separately checked in the
gateway.

**5. Direct network access to the Harness.**
The base compose keeps `127.0.0.1:<port>:3080` and the overlay adds no port for
the Harness. Only nginx publishes.

**6. Revocation.**
Keycloak removal stops the proxy session within the refresh interval. The DSH
cookie is **not** revoked by Keycloak — this is inherent to DSH and is the single
most important operational caveat. Revocation therefore includes rotating the
signing secret, which invalidates all cookies at once.

**7. Component failure.**
All three legs are fail-closed and verified offline: proxy down → 500, gateway
down → 502, harness down → 502. No path degrades to "allow".

**8. Secrets, cookies, redirect URI, Host, forwarded headers.**
Secrets are file-mounted, never in Git or the environment. Cookie carries `Secure`,
`HttpOnly`, `SameSite=Strict`. Redirect URI is exact and whitelisted. `Host` is
propagated explicitly after F-2 and validated against the allowlist. Forwarded
headers are cleared and re-set from the edge after F-1.

**9. DSH upgrade.**
The gateway breaks loudly (401) rather than quietly, and the contract test is the
gate. This is a real operational dependency; it is listed as a release gate, not a
footnote.

**10. Residual risk under component compromise.**
Front-door components (nginx, oauth2-proxy, gateway) are equivalent to a stolen
session. None of them reaches mail or workspace files directly, because none
mounts them. The Harness remains the component that holds everything, exactly as
in local mode — which is precisely why per-user instances are the phase-3 answer
rather than policy inside one process.

## 4. Local end-to-end plan with two Keycloak users

Goal: prove on a workstation, before any VM exists, that the allowed owner gets in
and the forbidden colleague does not — including the API and WebSocket, not just
the page.

**What is already automated.** `deploy/tests/e2e-local.sh` runs tier A below
(reduced form, with a stand-in for the identity proxy) and currently passes 16/16
on real nginx, the real gateway and a real DSH. Tiers B and C need a real Keycloak
and are not automated.

### Tier A — automated, no Keycloak (runs today)

```sh
# 1. Start a throwaway DSH on loopback with its own home.
DSH_HOME=/tmp/dsh-e2e dsh web --no-open --host 127.0.0.1 --port 3199 \
  --public-url https://dsh.corp.example/ --trusted-host dsh.corp.example

# 2. In another shell, run the harness. It starts nginx, the gateway and a
#    contract-compatible stand-in for oauth2-proxy on loopback only.
NGINX_BIN=/path/to/nginx DSH_HOME=/tmp/dsh-e2e ./deploy/tests/e2e-local.sh
```

Expected: `16 passed, 0 failed`. It covers anonymous → 302, forbidden → 403,
owner → 200, smuggled identity headers → 302, foreign Host → 421, anonymous and
forbidden WebSocket → 302/403, owner WebSocket → 101, cookie attributes, and log
hygiene.

### Tier B — real Keycloak, local only (manual, ~30 min)

Prerequisite: `deploy/identity` running, realm imported per the deployment guide
§3. Two users exist:

| User | Group | On allowlist | Expected |
|---|---|---|---|
| `owner` | `dsh-users` | yes | full access |
| `colleague` | none (or `dsh-users`, then removed from the allowlist) | no | 403, never reaches the harness |

1. **Publish nothing to the network.** Keep `KC_BIND_ADDRESS` and
   `NGINX_BIND_ADDRESS` at `127.0.0.1`; reach both through SSH or a local
   port-forward. The internet-facing step is activation and needs approval.

2. **Set the allowlist to the owner's `sub` only.**

   ```sh
   docker compose -f deploy/identity/compose.yaml exec keycloak \
     /opt/keycloak/bin/kcadm.sh get users -r personal-ai -q username=owner --fields id
   # put that id into deploy/single-user/secrets/allowed-subjects.txt (one line)
   sh deploy/tests/check-allowlist.sh        # must pass
   ```

3. **Start the single-user stack** with `TLS_DIR` pointing at a self-signed pair
   for `dsh.corp.example`, and add `127.0.0.1 dsh.corp.example` to `/etc/hosts`.

4. **Owner path.** Open `https://dsh.corp.example/`:
   - redirected to Keycloak, log in as `owner`, complete MFA if enrolled;
   - land on the Harness UI;
   - create a session, send a message, confirm streaming;
   - run a shell tool, confirm it works;
   - ask for mail, confirm the existing MCP answers.

5. **Forbidden path.** In a private window, log in as `colleague`:
   - expect a **403 page from oauth2-proxy**, before any Harness request;
   - confirm the Harness log shows **no request** for that attempt.

6. **Revocation, the part Keycloak alone does not solve.**

   ```sh
   # a. remove colleague from the group / disable the account in Keycloak
   # b. restart the proxy so its session cache drops the old grant
   docker compose -f deploy/single-user/compose.yaml restart oauth2-proxy
   # c. rotate the DSH cookie secret (procedure in the deployment guide §8)
   ```

   Then confirm: the colleague's browser, holding an old DSH cookie, gets 401.

7. **Failure-path checks**, each expecting fail-closed:
   - `docker compose stop oauth2-proxy` → 500, no page;
   - `docker compose stop gateway` → 502;
   - `docker compose stop harness` → 502;
   - restore each and confirm login works again.

### Tier C — what must wait for the VM

- Real certificate chain and corporate DNS name.
- Corporate IdP instead of the local Keycloak, if one exists.
- Binding nginx to a network address (activation).
- Any test with a second machine as the client.

### Recording results

Every result goes into the roadmap with an explicit class. A Tier A pass is
`offline`. Tier B is still `offline` even with a real Keycloak, because it runs on
a workstation: it proves the configuration, not the deployment. Only Tier C on the
VM against the corporate IdP can be recorded as `VERIFIED (live)`.

## 5. What must be true before activation

1. Tier A passes on the machine that will be deployed.
2. Tier B passes with a real Keycloak, both identities, including revocation.
3. `GATEWAY_ALLOWED_SUBJECTS` and the allowlist file agree, and hold exactly one
   entry.
4. The DSH cookie secret in `deploy/single-user/secrets` equals the one in
   `$DSH_HOME/.credentials.yaml`.
5. `GATEWAY_COOKIE_MAX_AGE_SECONDS` is at most the DSH `cookieMaxAgeDays` in
   seconds.
6. A firewall rule restricts 443 to the corporate range and 22 to admin.
7. A rollback has been performed once, deliberately, not only described.

Anything short of all seven is a test deployment, not a service.
