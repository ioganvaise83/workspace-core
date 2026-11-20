# Deployment guide — secure single-user access

This guide takes a working local Personal AI Workspace and puts it behind
Keycloak and HTTPS on a corporate VM, for **one** user. It assumes nothing about
the identity provider and states every step the owner must perform.

Companion documents: [`secure-access-roadmap.md`](secure-access-roadmap.md) (what
and why, status), [`threat-model.md`](threat-model.md) (what is defended),
[`decisions.md`](decisions.md) (ADR-N rationale).

> **Read before starting.** Phase 1 admits exactly one person (ADR-8). Publishing
> this to a team without phase 3 gives them one shared Harness home: one sessions
> list, one mailbox set, one workspace. Do not do that.

## 0. Prerequisites

| # | Requirement | How to confirm | Blocks |
|---|---|---|---|
| 1 | Corporate OIDC IdP exists **or** is explicitly not provided | Ask IT. Record the answer in the roadmap §8 | everything |
| 2 | VM with Docker Engine 24+ and Compose v2 | `docker version && docker compose version` | everything |
| 3 | DNS name for the VM | `dig +short dsh.corp.example` returns the VM's IP | activation |
| 4 | TLS certificate covering that name | `openssl x509 -in fullchain.pem -noout -text \| grep -A1 'Subject Alternative Name'` | activation |
| 5 | The existing Harness running locally | `docker compose ps` in the repository root | phase 1 |
| 6 | Owner's OIDC `sub` for the allowlist | see §3.5 | activation |

Nothing here requires a specific hostname. Replace `dsh.corp.example`,
`id.corp.example` and `personal-ai` with the real values throughout, in exactly
the same spelling.

### Choosing the identity provider

**If the company already has Keycloak or another OIDC IdP** — use it. Skip
`deploy/identity` entirely, ask IT for a confidential client, and configure the
single-user project against its issuer URL. Running a second Keycloak in the
company would be a governance problem, not a technical solution.

**If there is no IdP** — deploy `deploy/identity` as a lab first, and confirm
separately whether an internal service may serve identity to the network. A
self-hosted IdP on a VM is a service that must be owned and patched by someone;
that decision is the owner's, not the agent's.

## 1. What runs where

```text
                      ┌─────────────────────────── VM ───────────────────────────┐
browser ── 443/TLS ──>│ nginx ──auth_request──> oauth2-proxy ──OIDC──> Keycloak  │
                      │   │                                        (or corp IdP) │
                      │   └──proxy_pass──> gateway ──> harness:3080              │
                      │                      │             ├── gmail-mcp        │
                      │                      │             └── mail-imap-mcp    │
                      └──────────────────────┴───────────────────────────────────┘
```

Only nginx publishes a port. Everything else is on internal networks.

## 2. Prepare the repository

The deployment files live in `deploy/` and are additive; the base `compose.yaml`
is not modified (ADR-11, ADR-6).

```sh
cd ~/ai/workspace-core          # or wherever the repository is cloned

# 1. Confirm the working tree is clean before changing anything.
git status --porcelain

# 2. Validate the deployment files without starting anything.
docker compose -f deploy/identity/compose.yaml --env-file deploy/identity/.env config --quiet
docker compose -f deploy/single-user/compose.yaml --env-file deploy/single-user/.env config --quiet

# 3. Run the offline security checks.
sh deploy/tests/check-security.sh
node --test deploy/tests/gateway.test.js
```

If a `config --quiet` fails, fix `.env` before continuing. It usually means a
required variable is empty — the compose files use `${VAR:?}` deliberately, so a
missing value stops the deployment instead of silently binding nothing.

The Harness service also mounts `./deploy:/workspace/core/deploy` so the agent
can edit deployment files in place. That mount is already in `compose.yaml`; it
becomes active the next time the Harness container is recreated:

```sh
docker compose up -d harness     # recreates only the harness service
```

Recreating the Harness is safe for data — sessions, profiles and credentials live
on the `dsh-home` volume — but it drops in-flight sessions, so do it when nobody
is mid-answer.

## 3. Identity provider

### 3.1 Start Keycloak (lab, local only)

```sh
cd deploy/identity
cp env.example .env
chmod 600 .env
```

Edit `.env`:

- `KC_DB_PASSWORD` — `openssl rand -base64 32`
- `KC_BOOTSTRAP_ADMIN_PASSWORD` — a strong, unique password
- `KC_HOSTNAME` — leave as `http://127.0.0.1:8443` for the lab

Then:

```sh
docker compose config --quiet     # validate
docker compose up -d
docker compose ps                 # both services healthy
docker compose logs -f keycloak   # wait for "Listening on: http://0.0.0.0:8080"
```

Reach the console through a tunnel — never by exposing the port:

```sh
ssh -L 8443:127.0.0.1:8443 <you>@<vm>
# then open http://127.0.0.1:8443/admin/
```

### 3.2 Create the realm

Import the shipped realm template instead of clicking through the console, so the
result is reviewable and reproducible:

```sh
cd deploy/identity
docker compose exec keycloak \
  /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://127.0.0.1:8080 --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"

docker compose exec keycloak \
  /opt/keycloak/bin/kcadm.sh create realms -r master \
  -f /opt/keycloak/data/import/dsh-single-user-realm.json
```

The template references `${OIDC_CLIENT_SECRET}`, `${OIDC_REDIRECT_URI}` and
`${OIDC_POST_LOGOUT_REDIRECT_URI}`. Keycloak resolves those from its own
environment at import time. Add them to `deploy/identity/.env` **before** the
import:

```sh
# deploy/identity/.env — add these three lines
OIDC_CLIENT_SECRET=<generate: openssl rand -base64 32>
OIDC_REDIRECT_URI=https://dsh.corp.example/oauth2/callback
OIDC_POST_LOGOUT_REDIRECT_URI=https://dsh.corp.example/
```

Then restart Keycloak so the variables are in its environment:

```sh
docker compose up -d keycloak
```

Verify the import:

```sh
docker compose exec keycloak \
  /opt/keycloak/bin/kcadm.sh get realms/personal-ai --fields realm,enabled
```

### 3.3 Verify OIDC discovery

This is the check most likely to catch a typo, and it is cheap:

```sh
# From the VM, using the issuer exactly as it will be configured.
curl -s http://127.0.0.1:8443/realms/personal-ai/.well-known/openid-configuration \
  | python3 -m json.tool | head -20
```

Confirm `issuer` equals `KC_HOSTNAME` + `/realms/personal-ai` **character for
character**, with no trailing slash. oauth2-proxy refuses to start on a mismatch.

### 3.4 Create the owner's account and enable MFA

In the admin console (through the tunnel):

1. **Users → Add user**: pick a username. Set email if the IdP requires it.
2. **Credentials → Set password**: temporary, and force a change at first login.
3. **Details → Required user actions**: add *Configure OTP* so MFA is mandatory.
4. **Groups → Join group**: `dsh-users` (created by the realm template).
5. **Role mapping → Assign role**: `dsh-access`.

MFA must be enforced by the IdP, not by this deployment. If the corporate IdP
mandates its own MFA policy, use that and skip step 3.

### 3.5 Obtain the stable subject for the allowlist

The allowlist keys on `sub`, not on email (ADR-4):

```sh
docker compose exec keycloak \
  /opt/keycloak/bin/kcadm.sh get users -r personal-ai \
  -q username=<username> --fields id,username,email
```

The `id` field **is** the `sub` claim. Put it into the gateway configuration and
into the oauth2-proxy allowlist:

```sh
cd ../single-user
mkdir -p secrets
printf '%s    # owner\n' '<the-id-from-above>' > secrets/allowed-subjects.txt
chmod 600 secrets/allowed-subjects.txt
```

And set it in `deploy/single-user/.env`:

```sh
GATEWAY_ALLOWED_SUBJECTS="<the-id-from-above>"
ALLOWED_SUBJECTS_FILE=./secrets/allowed-subjects.txt
```

> Exactly one active line. `deploy/tests/check-allowlist.sh` fails the deployment
> if a second entry is added while phase 3 is not implemented.

### 3.6 Stop Keycloak without losing data

```sh
docker compose stop         # containers stop, volumes and data survive
docker compose down         # same: volumes are NOT removed without -v
```

Never run `docker compose down -v` here: it deletes the realm, every user and the
client secret, and there is no backup yet.

## 4. Secrets for the gateway

```sh
cd deploy/single-user/scripts
./prepare-secrets.sh --secrets-dir ../secrets
```

It generates three secrets and refuses to overwrite existing ones. Then paste the
Keycloak client secret into `../secrets/oidc-client-secret`:

```sh
# Keycloak console → Clients → dsh-single-user → Credentials → Client secret
printf '%s' '<client-secret>' > ../secrets/oidc-client-secret
chmod 600 ../secrets/oidc-client-secret
```

### 4.1 Give the same cookie secret to DSH

This is the step that makes SSO work without handing out a launch token
(ADR-7). DSH reads its cookie signing secret from
`$DSH_HOME/.credentials.yaml`; the gateway must hold the identical value.

The supported way is to seed DSH's credential record before it starts:

```sh
# The DSH home volume is named `personal-ai-workspace_dsh-home` for the base
# project. Confirm the real name first:
docker volume ls | grep dsh-home
```

Then, with the Harness stopped:

```sh
# 1. Stop only the harness service; leave the integrations running.
docker compose stop harness

# 2. Seed the record. `records: {}` must not be empty when DSH starts, so write
#    the full record in one go.
SECRET=$(cat deploy/single-user/secrets/dsh-cookie-secret)
docker run --rm -i -v personal-ai-workspace_dsh-home:/dsh-home \
  alpine:3 sh -c '
    set -eu
    f=/dsh-home/.credentials.yaml
    [ -f "$f" ] || printf "version: 1\nrecords: {}\n" > "$f"
    grep -q "browser-session" "$f" && { echo "record already exists; leaving it alone"; exit 0; }
    cat > /tmp/seed.yaml <<EOF
version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: '"$SECRET"'
EOF
    # Merge by replacing the file only if there were no other records.
    mv /tmp/seed.yaml "$f"
    chmod 600 "$f"
  '

# 3. Start the harness again.
docker compose start harness
```

> **If DSH already has other credential records** (model keys live under `refs:`,
> so they are unaffected), inspect the file first and add only the
> `browser-session` block by hand. Replacing the whole file would drop them.
>
> **If the record already exists**, DSH keeps it — that is the documented
> behaviour, and it was verified. Read the existing `secret` instead of writing a
> new one, or delete the record and let the next start regenerate it, then update
> `deploy/single-user/secrets/dsh-cookie-secret` to match. The two must be equal;
> the gateway logs no secrets, so a mismatch shows up as a 401 on the first
> request.

Verification that the two agree:

```sh
docker run --rm -v personal-ai-workspace_dsh-home:/dsh-home alpine:3 \
  sh -c 'grep -A6 browser-session /dsh-home/.credentials.yaml | grep secret:'
# compare with:
cat deploy/single-user/secrets/dsh-cookie-secret
```

They must be identical. This is the only moment either value appears on screen;
do not paste the output into a ticket.

### 4.2 Cap the DSH cookie lifetime

Add a profile override so a stolen cookie dies quickly (ADR-5). Create or edit
`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
# Short browser-cookie lifetime for the network deployment. Restates trustedHosts
# because a patch replaces the whole `config` of the row it targets.
- id: connection
  name: '@deepseek-ai/dsh-client-connection'
  inject: [webStartup]
  config:
    cookieMaxAgeDays: 1
    trustedHosts: !!js ctx.webStartup.trustedHosts
```

The Harness must start with `--trusted-host <DSH_HOSTNAME>` and
`--public-url https://<DSH_HOSTNAME>/`, otherwise DSH rejects its own cookies
behind the proxy. That is a change to the harness service command, which is an
activation step (§6).

## 5. TLS and the network

1. Put the certificate and key on the host, outside Git:

```sh
sudo install -d -m 0755 /etc/pki/dsh
sudo install -m 0644 fullchain.pem /etc/pki/dsh/fullchain.pem
sudo install -m 0600 privkey.pem   /etc/pki/dsh/privkey.pem
```

2. Point `TLS_DIR: /etc/pki/dsh` in `deploy/single-user/.env`.
3. Confirm the Harness is **not** reachable from the network:

```sh
ss -ltnp | grep 3080          # must show 127.0.0.1 or a container address only
```

The base `compose.yaml` already maps `127.0.0.1:${DSH_PORT}:3080`. Do not change
it to `0.0.0.0`.

### Firewall

Default deny inbound; allow only what is listed:

| Port | Source | Purpose |
|---|---|---|
| 443/tcp | corporate network | the application |
| 22/tcp | admin network | SSH, restricted further |

```sh
# Example with ufw; adapt to the company's tooling.
sudo ufw default deny incoming
sudo ufw allow from <admin-cidr> to any port 22 proto tcp
sudo ufw allow from <corp-cidr> to any port 443 proto tcp
sudo ufw enable
```

## 6. Activation — requires explicit owner approval

Nothing below is performed by the agent without a separate, explicit "go".

1. **Point the Harness at the proxy.** Add to the harness service command:

   ```yaml
   - --public-url
   - https://dsh.corp.example/
   - --trusted-host
   - dsh.corp.example
   ```

   Restarting the harness is required. Sessions and volumes survive.

2. **Attach the gateway to the Harness network.** Confirm the name:

   ```sh
   docker network ls | grep personal-ai
   ```

   Set `APP_NETWORK` in `.env` to that exact name.

3. **Bind nginx to the VM address.** Set `NGINX_BIND_ADDRESS` to the VM's concrete
   IP. This is the moment the application becomes reachable from the network.

4. **Start the gateway project:**

   ```sh
   cd deploy/single-user
   docker compose config --quiet
   docker compose up -d
   docker compose ps
   docker compose logs -f nginx gateway oauth2-proxy
   ```

5. **Enable HSTS** only after a successful browser login: set
   `DSH_HSTS_DIRECTIVE: "max-age=31536000; includeSubDomains"` and restart nginx.

## 7. First login and acceptance

1. Open `https://dsh.corp.example/` from a workstation.
2. Expect a redirect to the IdP, then back, then the Harness UI.
3. Create a session, send a message, confirm the answer streams.
4. Ask the agent to run a shell command; confirm the tool works.
5. Ask it to read mail; confirm the existing Mail MCP answers.
6. Restart the stack; confirm the session list is intact.

Verification checklist (all must pass before phase 1 is `VERIFIED`):

```sh
# 1. Anonymous access is refused or redirected.
curl -sk -o /dev/null -w '%{http_code} %{redirect_url}\n' https://dsh.corp.example/
#    expect 302 to the IdP

# 2. The Harness is not reachable directly.
curl -s -m 3 -o /dev/null -w '%{http_code}\n' http://<vm-ip>:3080/ || echo "refused (expected)"

# 3. API without a session is refused.
curl -sk -o /dev/null -w '%{http_code}\n' -X POST https://dsh.corp.example/api
#    expect 401 or 302

# 4. MCP bridges are not published.
curl -s -m 3 -o /dev/null -w '%{http_code}\n' http://<vm-ip>:8765/mcp || echo "refused (expected)"

# 5. Plain HTTP redirects.
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://dsh.corp.example/
#    expect 308 to https
```

The forbidden-user test needs a second Keycloak account (see the report
template in roadmap §6): log in with it and expect **403 before any Harness
request appears in the Harness log**. If the Harness log shows a request from
that user, the gateway or nginx is misconfigured — stop and investigate.

## 8. Revocation and Keycloak loss

### Removing access for a person

Keycloak alone is **not enough**: a DSH cookie is a bearer token that outlives
the IdP session (ADR-5). Do all four steps:

```sh
# 1. Remove from the IdP group (or disable the user) in Keycloak.
# 2. Remove the subject from the allowlist and restart oauth2-proxy.
$EDITOR deploy/single-user/secrets/allowed-subjects.txt
docker compose -f deploy/single-user/compose.yaml restart oauth2-proxy

# 3. Rotate the DSH cookie secret: delete the record so the next start makes a
#    new one, then update the gateway to match.
docker compose -f compose.yaml stop harness
docker run --rm -v personal-ai-workspace_dsh-home:/dsh-home alpine:3 \
  sed -i '/client-connection\/browser-session:/,+4d' /dsh-home/.credentials.yaml
docker compose -f compose.yaml start harness
# Read the new secret and write it where the gateway reads it:
docker run --rm -v personal-ai-workspace_dsh-home:/dsh-home alpine:3 \
  sh -c 'grep -A6 browser-session /dsh-home/.credentials.yaml | grep secret:' \
  | sed 's/.*secret: //' > deploy/single-user/secrets/dsh-cookie-secret
chmod 600 deploy/single-user/secrets/dsh-cookie-secret
docker compose -f deploy/single-user/compose.yaml up -d gateway

# 4. Rotate the oauth2-proxy cookie secret so old proxy sessions die immediately.
cd deploy/single-user/scripts && ./prepare-secrets.sh --force --secrets-dir ../secrets
docker compose -f ../compose.yaml up -d oauth2-proxy
```

Step 3 deletes the record; if the file has other records, delete only the
`client-connection/browser-session` block by hand instead of using the `sed`.

### If Keycloak is lost

- **Existing sessions** keep working until the proxy cookie expires (8h) and the
  DSH cookie expires (1 day).
- **New logins** fail: there is no IdP.
- **Recovery:** restore the Keycloak database volume from backup, or recreate the
  realm from the template and re-add users. The client secret changes if the
  realm is recreated: update `secrets/oidc-client-secret` and restart
  oauth2-proxy.
- **Emergency local access:** stop the gateway project and reach the Harness on
  loopback (through an SSH tunnel) as before. This is the documented fallback and
  it is why the base `compose.yaml` is never modified.

## 9. Rollback to pure local mode

```sh
cd deploy/single-user
docker compose down          # stops nginx, oauth2-proxy, gateway; keeps volumes

cd ../../..
# If the harness command was changed:
git diff compose.yaml        # review, then revert the --public-url/--trusted-host lines
docker compose up -d harness
```

Data is untouched: `dsh-home`, the workspaces and the integration volumes are the
same ones the local deployment already used. The one thing that does not roll
back is a rotated cookie secret — existing browser sessions are invalidated,
which is desirable during a rollback.

Confirm local mode:

```sh
docker compose ps
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/   # 401 without a token
```

## 10. Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Redirect loop between nginx and the IdP | `--public-url`/`Host` mismatch, or redirect URI differs | `docker compose logs oauth2-proxy`; compare redirect URI exactly |
| `502` from nginx | gateway down, or wrong `APP_NETWORK` | `docker compose ps`; `docker network ls` |
| `403` after a successful login | subject not in the allowlist, or wrong `sub` | compare `X-Auth-Request-User` with the allowlist |
| `421` from the gateway | `Host` not in `GATEWAY_ALLOWED_AUTHORITIES` | must equal `DSH_HOSTNAME` exactly, including port if explicit |
| Login works, Harness shows 401 | DSH cookie secret differs from the gateway's | §4.1 comparison |
| WebSocket fails, UI half-loads | upgrade headers or timeout | nginx `Connection $connection_upgrade`, `proxy_read_timeout` |
| `startup failed: connection` after editing credentials | `.credentials.yaml` left `records:` empty | restore `records: {}` and restart |
| oauth2-proxy exits at start | issuer mismatch or unreadable secret file | `docker compose logs oauth2-proxy` |

## 11. What is deliberately not automated

- Realm creation is a command, not a script that hides failures, because the
  owner must see what is created.
- MFA enrolment is interactive.
- Activation (binding a network address, changing the harness command) is
  manual and approved.
- No backup automation exists yet; it is listed as an open question.
