# Secure single-user deployment

nginx + oauth2-proxy + gateway in front of the existing Harness, for exactly one
user behind a corporate identity provider.

This directory is an **overlay**. It does not build a second Harness and does not
modify the base `compose.yaml`. Rollback is `docker compose down` here plus
restarting the original project.

```text
browser --443/TLS--> nginx --auth_request--> oauth2-proxy --OIDC--> Keycloak
                       |                                            (or corp IdP)
                       +--proxy_pass--> gateway --HTTP--> harness:3080
```

## Why a gateway component exists

DSH authenticates browsers with a cookie signed by a secret it stores in
`$DSH_HOME/.credentials.yaml`. It also prints a per-process launch token. Handing
that token to every visitor would give them all the same session.

The gateway holds the same signing secret, verifies that oauth2-proxy
authenticated the caller **and** that the caller's stable `sub` is on the
allowlist, and only then mints the DSH cookie. The launch token is never used,
printed, or transmitted (ADR-7 in [`docs/security/decisions.md`](../../docs/security/decisions.md)).

This was verified against the installed binary, not assumed: a cookie minted from
the stored secret is accepted (200), one minted for another authority is rejected
(401), and a pre-seeded secret is honoured rather than overwritten.

## Files

| Path | Role |
|---|---|
| `compose.yaml` | nginx, oauth2-proxy, gateway; joins the Harness network |
| `nginx/nginx.conf.template` | whole config: TLS, `auth_request`, WebSocket, safe logging |
| `nginx/entrypoint.sh` | renders the template, writes the 0600 secret include, runs `nginx -t` |
| `oauth2-proxy/oauth2-proxy.cfg` | OIDC + PKCE, subject allowlist, header hygiene |
| `oauth2-proxy/allowed-subjects.txt` | documentation of the subject allowlist; see the warning in that file — oauth2-proxy's own email file cannot enforce it |
| `scripts/new-local-ca.ps1` | creates the local CA and both leaf certificates |
| `gateway/server.js` | dependency-free Node gateway that mints the DSH cookie |
| `scripts/prepare-secrets.sh` | generates host secrets, `chmod 600`, never prints values |
| `env.example` | every non-secret setting |

## Quick start

```powershell
Copy-Item env.example .env                  # then fill in real values
bash ./scripts/prepare-secrets.sh           # generates secrets under ./secrets
docker compose config --quiet               # validate, starts nothing
```

Defaults are the **local lab** names: `dsh.local` for the Harness and
`https://keycloak.local:8443` for the issuer. Both resolve to `127.0.0.1` on the
host and to the right container inside Docker, so the OIDC issuer is identical
everywhere and no verification is relaxed. Setup:
[`docs/security/deployment-guide.md`](../../docs/security/deployment-guide.md) §2b.

Then follow [`docs/security/deployment-guide.md`](../../docs/security/deployment-guide.md)
— in particular §4.1, which gives DSH the same cookie secret as the gateway. Skip
that step and SSO will appear to work while every Harness request returns 401.

## Tests

```sh
sh ../tests/check-security.sh        # 63 offline checks
node --test ../tests/gateway.test.js # gateway unit + contract tests
node --test ../tests/compose.test.js # compose structure
sh ../tests/check-allowlist.sh       # single-user constraint
```

All are offline: they never contact Keycloak or a VM. Passing them is necessary,
not sufficient.

## What must never change here

- `NGINX_BIND_ADDRESS` must never be `0.0.0.0`. DSH executes code.
- The Harness must never publish a port.
- Only one subject may be on the allowlist while phase 1 is in force (ADR-8).
- The gateway shared secret, the DSH cookie secret and the OIDC client secret must
  never enter Git, an image, or a log.
- `GATEWAY_COOKIE_MAX_AGE_SECONDS` must not exceed DSH's `cookieMaxAgeDays`, or
  the gateway mints cookies DSH rejects.

## Troubleshooting

See [`docs/security/deployment-guide.md`](../../docs/security/deployment-guide.md) §10.
The most common failures, in order of frequency:

1. **401 from the Harness after a successful login** — cookie secret mismatch
   between DSH and the gateway (§4.1 of the guide).
2. **421 from the gateway** — `Host` not in `GATEWAY_ALLOWED_AUTHORITIES`; it must
   equal `DSH_HOSTNAME` exactly.
3. **403 after login** — the `sub` is not on the allowlist, or the wrong claim was
   pasted (an email instead of the subject id).
4. **oauth2-proxy exits immediately** — issuer mismatch or an unreadable secret
   file; `docker compose logs oauth2-proxy` says which.
