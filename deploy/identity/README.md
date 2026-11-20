# Keycloak + PostgreSQL

Identity infrastructure for the secure-access deployment. **Separate project**
from the Harness compose file on purpose (ADR-9): identity and workload have
different upgrade cadences.

```powershell
Copy-Item env.example .env    # then edit
docker compose config         # validate, starts nothing
docker compose up -d
```

Before the first start, two host-side steps are required — see
[`docs/security/deployment-guide.md`](../../docs/security/deployment-guide.md) §2b:

1. a local root CA trusted by Windows, and certificates for `keycloak.local`;
2. `127.0.0.1 keycloak.local` in the hosts file.

### Base file vs lab overlay

`compose.yaml` is what runs today: HTTP on loopback. It is deliberately free of
lab prerequisites, so an ordinary `docker compose up -d` never fails because a
certificate or a network is missing.

`compose.lab.yml` adds what the SSO test needs — HTTPS on `8443` terminated by
Keycloak itself, and the shared `edge` network with the `keycloak.local` alias:

```powershell
docker network create personal-ai-edge     # once
docker compose -f compose.yaml -f compose.lab.yml up -d
```

Use the overlay only while testing SSO. Without it, nothing changes.

The import-strategy fix is in the **base** file on purpose: it protects the realm
on every restart, lab or not.

Full procedure, including realm import, user creation, MFA and how to obtain the
`sub` for the allowlist: [`docs/security/deployment-guide.md`](../../docs/security/deployment-guide.md) §3.

## Should this run at all?

**Check first whether the company already has an identity provider.** If it does,
do not deploy this: use the corporate IdP, configure
`deploy/single-user/oauth2-proxy/oauth2-proxy.cfg` against its issuer, and delete
nothing here — this directory then stays a lab reference only. Running a second
Keycloak inside a company that already has one creates an unowned identity silo,
which is a governance problem rather than a technical one.

## What is here

| Path | Role |
|---|---|
| `compose.yaml` | Keycloak 26.8.2 + PostgreSQL 17.12, pinned by tag and digest |
| `config/personal-ai-realm.json` | Realm template. The file name MUST match the realm name inside (`personal-ai`), or Keycloak refuses it with "File name / realm name mismatch" |
| `env.example` | Every non-secret setting, with safe defaults |

## Deliberate design points

- **Durable database.** PostgreSQL with a named volume. Never the built-in H2
  database: it is for evaluation and loses data by design.
- **No Docker socket.** An identity provider must never be able to control the
  workload it authenticates for.
- **Loopback by default.** `KC_BIND_ADDRESS` defaults to `127.0.0.1`; the lab is
  reached through an SSH tunnel. Serving the login page to the network is an
  activation decision and needs TLS in front.
- **`start`, not `start-dev`.** Production mode refuses to boot without a
  hostname, which surfaces a misconfiguration immediately instead of silently
  running an insecure default.
- **`IGNORE_EXISTING` import strategy.** Not optional. Keycloak runs the directory
  import on every start and its default, `OVERWRITE_EXISTING`, deletes the existing
  realm — users, MFA enrolments, the client secret — before re-importing. A plain
  restart would silently reset the owner's account. Verified in Keycloak 26.8.2
  source; pinned in `compose.yaml` and defaulted in `env.example`.
- **`KCRAW_` for secrets.** With plain `KC_`, Keycloak evaluates `$` as an
  expression and can silently corrupt a password.
- **Bootstrap admin only once.** `KC_BOOTSTRAP_ADMIN_*` is read while no admin
  exists. After the first login, remove those lines from `.env` so a leaked file
  cannot re-bootstrap.

## Commands

```sh
docker compose up -d                     # start
docker compose ps                        # health
docker compose logs -f keycloak          # follow
docker compose stop                      # stop, keep data
docker compose down                      # remove containers, KEEP volumes
```

**Never** `docker compose down -v`: it destroys the realm and every user, and
there is no backup automation yet.

## Verifying it works

```sh
# Discovery document, the same check oauth2-proxy performs.
curl -s http://127.0.0.1:8443/realms/personal-ai/.well-known/openid-configuration \
  | python3 -m json.tool | head -20
```

The `issuer` field must equal `KC_HOSTNAME` + `/realms/personal-ai`, character for
character, with no trailing slash. A mismatch is the most common cause of
oauth2-proxy refusing to start.

## Recovering access

If the admin password is lost: Keycloak has no reset-by-email path for the master
realm. The supported routes are, in order of preference:

1. **Another admin exists** — log in as them and reset the password.
2. **`kcadm.sh` with a valid session** — if a token is still cached.
3. **Partial import / re-bootstrap** — stop Keycloak, temporarily clear the admin
   user from the database (not recommended; destructive), or restore the volume
   from backup.
4. **Recreate the realm** from `config/personal-ai-realm.json` and re-add
   users. The OIDC client secret changes: copy it into
   `deploy/single-user/secrets/oidc-client-secret` and restart oauth2-proxy.

Before relying on this, confirm that a backup of the `keycloak-db` volume exists.
Today it does not: see the roadmap's open questions.

## Production differences from the lab

| Lab | Production |
|---|---|
| `KC_HOSTNAME: http://127.0.0.1:8443` | `https://id.corp.example` behind TLS |
| loopback bind + SSH tunnel | terminates TLS at the edge proxy |
| self-signed or no certificate | corporate certificate |
| local volume | volume plus a tested backup and restore |

Nothing else changes: the realm template, the client and the security settings are
the same in both.
