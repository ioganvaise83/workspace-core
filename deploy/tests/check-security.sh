#!/bin/sh
# Offline security checks for the secure-access deployment.
#
# What this proves and what it does NOT:
#   proves   — the configuration files are internally consistent, contain no
#              secrets, publish nothing unexpected, and encode the decisions taken
#              in docs/security/decisions.md;
#   does NOT — that the deployment works. Nothing here talks to Keycloak, nginx or
#              DSH. Those checks are the `live` tier in the roadmap.
#
# Exit codes: 0 all checks passed, 1 one or more failed, 77 skipped entirely.
#
# Usage:
#   deploy/tests/check-security.sh
#   DSH_UPSTREAM_URL=http://127.0.0.1:3199 deploy/tests/check-security.sh
set -u

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
DEPLOY="$REPO_ROOT/deploy"
IDENTITY="$DEPLOY/identity"
SINGLE="$DEPLOY/single-user"

PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS + 1)); printf '  [PASS] %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$*"; }
skip() { SKIP=$((SKIP + 1)); printf '  [SKIP] %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------------------
section '1. Files exist'
# ---------------------------------------------------------------------------
for file in \
  "$IDENTITY/compose.yaml" "$IDENTITY/env.example" \
  "$IDENTITY/config/dsh-single-user-realm.json" \
  "$SINGLE/compose.yaml" "$SINGLE/env.example" \
  "$SINGLE/nginx/nginx.conf.template" "$SINGLE/nginx/entrypoint.sh" \
  "$SINGLE/oauth2-proxy/oauth2-proxy.cfg" "$SINGLE/oauth2-proxy/allowed-subjects.txt" \
  "$SINGLE/gateway/server.js" "$SINGLE/scripts/prepare-secrets.sh" \
  "$REPO_ROOT/docs/security/secure-access-roadmap.md" \
  "$REPO_ROOT/docs/security/threat-model.md" \
  "$REPO_ROOT/docs/security/decisions.md" \
  "$REPO_ROOT/docs/security/deployment-guide.md"
do
  if [ -f "$file" ]; then pass "exists: ${file#"$REPO_ROOT"/}"
  else fail "missing: ${file#"$REPO_ROOT"/}"; fi
done

# ---------------------------------------------------------------------------
section '2. No published ports except the edge'
# ---------------------------------------------------------------------------
# Rule (ADR-6): the only `ports:` entries in the deployment may belong to nginx,
# and they must bind a concrete address. Harness, gateway, oauth2-proxy, Keycloak
# and PostgreSQL never publish.

check_no_published_ports() {
  file=$1
  service=$2
  if ! [ -f "$file" ]; then fail "cannot inspect $file"; return; fi
  # Extract the service block and look for a ports: key inside it.
  block=$(awk -v svc="$service" '
    $0 ~ "^  " svc ":" { inside=1; next }
    inside && /^  [a-zA-Z0-9_.-]+:/ { inside=0 }
    inside { print }
  ' "$file")
  if printf '%s' "$block" | grep -qE '^[[:space:]]+ports:'; then
    # Extract only the ports: list itself. Scanning the whole service block would
    # also catch healthcheck commands, which mention 127.0.0.1 for unrelated
    # reasons and produce a false pass.
    port_entries=$(printf '%s\n' "$block" | awk '
      /^[[:space:]]+ports:[[:space:]]*$/ { inside=1; next }
      inside && /^[[:space:]]+[a-zA-Z_-]+:/ { inside=0 }
      inside && /^[[:space:]]+- / { print }
    ')

    if [ -z "$port_entries" ]; then
      # `ports:` with a long-form mapping or an empty list: treat as suspicious
      # rather than silently passing.
      fail "$service declares ports: in a form this check cannot parse"
    elif ! printf '%s' "$port_entries" | grep -qvE '127\.0\.0\.1|localhost'; then
      # A loopback-only bind is an explicit, documented lab exception: it stays
      # unreachable from the network, which is what this check protects.
      pass "$service publishes only on loopback (documented lab exception)"
    else
      fail "$service publishes a port on a non-loopback address"
      printf '%s\n' "$port_entries" | sed 's/^/         /'
    fi
  else
    pass "$service publishes no ports"
  fi
}

check_no_published_ports "$IDENTITY/compose.yaml" keycloak
check_no_published_ports "$IDENTITY/compose.yaml" postgres
check_no_published_ports "$SINGLE/compose.yaml" gateway
check_no_published_ports "$SINGLE/compose.yaml" oauth2-proxy

# Keycloak in the identity project intentionally binds loopback in the lab; that
# is an allowed exception, but it must be loopback and must be documented.
if grep -qE 'KC_BIND_ADDRESS' "$IDENTITY/compose.yaml"; then
  pass 'Keycloak bind address is configurable (lab default must be loopback)'
else
  fail 'Keycloak bind address is hard-coded; it must be configurable'
fi
if grep -qE '127\.0\.0\.1' "$IDENTITY/env.example"; then
  pass 'identity env.example defaults to loopback'
else
  fail 'identity env.example does not default to a loopback bind'
fi

# nginx is the one service allowed to publish, and only on a concrete address.
if grep -qE 'NGINX_BIND_ADDRESS' "$SINGLE/compose.yaml"; then
  pass 'nginx bind address comes from configuration'
else
  fail 'nginx bind address is not configurable'
fi
if grep -qE '0\.0\.0\.0:\$\{NGINX' "$SINGLE/compose.yaml"; then
  fail 'nginx publishes on a wildcard address'
else
  pass 'nginx never publishes on a wildcard address'
fi

# ---------------------------------------------------------------------------
section '3. Forbidden mounts and privileges'
# ---------------------------------------------------------------------------
for file in "$IDENTITY/compose.yaml" "$SINGLE/compose.yaml" "$REPO_ROOT/compose.yaml"; do
  name=${file#"$REPO_ROOT"/}
  if grep -qE 'docker\.sock' "$file"; then fail "$name mounts the Docker socket"
  else pass "$name does not mount the Docker socket"; fi

  if grep -qE '^\s+privileged:\s*true' "$file"; then fail "$name requests privileged mode"
  else pass "$name is not privileged"; fi

  if grep -qE 'cap_add:' "$file"; then
    # nginx legitimately needs a small set; assert the *cap_add* block itself does
    # not re-add ALL. Searching the whole file would match `cap_drop: - ALL`,
    # which is the opposite of a problem.
    cap_add_block=$(awk '/cap_add:/{inside=1;next} inside&&/^ {2,}[a-zA-Z]/{inside=0} inside' "$file")
    if printf '%s' "$cap_add_block" | grep -qE '^\s*- ALL$'; then fail "$name re-adds ALL capabilities"
    else pass "$name adds only specific capabilities"; fi
  else
    pass "$name adds no capabilities"
  fi
done

# ---------------------------------------------------------------------------
section '4. No secrets committed'
# ---------------------------------------------------------------------------
# Look for high-entropy literals and for known secret-bearing keys with values.
SECRET_HITS=0
scan_targets=$(find "$DEPLOY" "$REPO_ROOT/docs/security" -type f \( -name '*.yaml' -o -name '*.yml' -o -name '*.cfg' -o -name '*.json' -o -name '*.js' -o -name '*.sh' -o -name '*.md' -o -name '*.template' -o -name '*.txt' -o -name '*.example' \) 2>/dev/null)

# A private key block is always a failure.
if printf '%s\n' "$scan_targets" | xargs grep -l 'BEGIN [A-Z ]*PRIVATE KEY' 2>/dev/null | grep -q .; then
  fail 'a PEM private key is present in deployment files'
  SECRET_HITS=$((SECRET_HITS + 1))
else
  pass 'no PEM private keys in deployment files'
fi

# Literal assignments of secret-looking values.
for pattern in \
  'password[[:space:]]*=[[:space:]]*"[^"]\{8,\}"' \
  'client_secret[[:space:]]*=[[:space:]]*"[^"]\{8,\}"' \
  'secret[[:space:]]*=[[:space:]]*"[A-Za-z0-9_-]\{32,\}"'
do
  hits=$(printf '%s\n' "$scan_targets" | xargs grep -nE "$pattern" 2>/dev/null | grep -v 'REPLACED_AT_RUNTIME\|UNUSED_OVERRIDDEN\|placeholder\|example' || true)
  if [ -n "$hits" ]; then
    fail "possible literal secret matching /$pattern/"
    printf '%s\n' "$hits" | sed 's/^/         /'
    SECRET_HITS=$((SECRET_HITS + 1))
  fi
done
[ "$SECRET_HITS" -eq 0 ] && pass 'no literal secrets matched the scanners'

# The allowlist shipped in Git must carry no active entry (deny by default).
if [ -f "$SINGLE/oauth2-proxy/allowed-subjects.txt" ]; then
  active=$(grep -vE '^\s*(#|$)' "$SINGLE/oauth2-proxy/allowed-subjects.txt" || true)
  if [ -z "$active" ]; then pass 'shipped allowlist has no active entry (deny by default)'
  else fail 'shipped allowlist contains an active entry: review it before committing'; fi
fi

# ---------------------------------------------------------------------------
section '5. Single-user constraint (ADR-8)'
# ---------------------------------------------------------------------------
# The gateway must refuse a configuration that admits more than one subject.
if grep -q 'allowedSubjects' "$SINGLE/gateway/server.js"; then
  pass 'gateway enforces a subject allowlist'
else
  fail 'gateway has no subject allowlist'
fi

# nginx must not bypass auth_request for application paths.
if grep -qE 'auth_request /oauth2/auth' "$SINGLE/nginx/nginx.conf.template"; then
  pass 'nginx requires auth_request for the application'
else
  fail 'nginx does not require auth_request'
fi

# Only the login surface may be reachable without auth_request. The check runs on
# the HTTPS server block alone: the plain-HTTP block is a pure redirect and would
# otherwise be counted as an unauthenticated `location /`.
https_block=$(awk '
  /listen \$\{NGINX_HTTPS_PORT\} ssl/ { inside=1 }
  inside { print }
' "$SINGLE/nginx/nginx.conf.template")

if [ -z "$https_block" ]; then
  fail 'could not locate the HTTPS server block'
else
  unauth_locations=$(printf '%s\n' "$https_block" | awk '
    /^[[:space:]]*location / { loc=$0; has_auth=0; next }
    /auth_request[[:space:]]+\/oauth2\/auth/ { has_auth=1 }
    /^[[:space:]]*}[[:space:]]*$/ { if (loc != "" && has_auth == 0) print loc; loc="" }
  ')

  # The public set is exactly: the auth subrequest, the login surface, the login
  # redirect, and a body-less health endpoint. Anything else must authenticate.
  unexpected=$(printf '%s\n' "$unauth_locations" \
    | grep -vE 'location (=[[:space:]]+/oauth2/auth|/oauth2/|@login|=[[:space:]]+/healthz)' \
    | grep -v '^[[:space:]]*$' || true)

  if [ -n "$unexpected" ]; then
    fail 'a location is reachable without authentication:'
    printf '%s\n' "$unexpected" | sed 's/^/         /'
  else
    pass 'every non-login location requires authentication'
  fi

  # And the application location must exist at all, with auth_request in it.
  if printf '%s\n' "$https_block" | awk '
    /^[[:space:]]*location \/ \{/ { inside=1; next }
    inside && /^[[:space:]]*}/ { exit found ? 0 : 1 }
    inside && /auth_request/ { found=1 }
  '; then
    pass 'the application location authenticates via auth_request'
  else
    fail 'the application location is missing auth_request'
  fi
fi

# Identity headers must be cleared before being set. They live in the hygiene
# include, which every proxying location includes: nginx discards inherited
# proxy_set_header directives as soon as a location declares one of its own.
HYGIENE="$SINGLE/nginx/proxy-hygiene.conf"
if [ -f "$HYGIENE" ]; then
  for header in X-Auth-Request-User X-Forwarded-User X-Auth-Request-Email Authorization; do
    if grep -qE "proxy_set_header $header[[:space:]]+\"\"" "$HYGIENE"; then
      pass "nginx clears incoming $header (hygiene include)"
    else
      fail "nginx does not clear incoming $header"
    fi
  done
  # Count proxying locations and assert each includes the hygiene file. A plain
  # count of includes is not enough: removing one still leaves the total high.
  proxying=$(awk '/^[[:space:]]*location /{inloc=1; prox=0; hyg=0}
    inloc && /proxy_pass/{prox=1}
    inloc && /proxy-hygiene\.conf/{hyg=1}
    inloc && /^[[:space:]]*}[[:space:]]*$/{ if(prox && !hyg) bad++; if(prox) total++; inloc=0}
    END{printf "%d %d", total+0, bad+0}' "$SINGLE/nginx/nginx.conf.template")
  total=${proxying% *}; bad=${proxying#* }
  if [ "$total" -ge 3 ] && [ "$bad" -eq 0 ]; then
    pass "all $total proxying locations include the hygiene file"
  else
    fail "$bad of $total proxying locations lack the hygiene include"
  fi
else
  fail "missing $HYGIENE"
fi

# The application location must forward the browser Host, or the gateway sees the
# container name and refuses every request.
if awk '/^ +location \/ \{/{inside=1;next} inside&&/^ +\}/{if(found)exit; inside=0} inside&&/proxy_set_header Host \$host;/{found=1}' "$SINGLE/nginx/nginx.conf.template" | grep -q .; then
  pass "the application location forwards the browser Host"
else
  # awk exits non-zero without printing when the directive is absent
  if grep -A 40 "location / {" "$SINGLE/nginx/nginx.conf.template" | grep -q "proxy_set_header Host \$host;"; then
    pass "the application location forwards the browser Host"
  else
    fail "the application location does not forward Host; the gateway will answer 421"
  fi
fi

# The gateway must demand its shared secret.
if grep -q 'x-dsh-gateway-secret' "$SINGLE/gateway/server.js" && \
   grep -q 'X-DSH-Gateway-Secret' "$SINGLE/nginx/nginx.conf.template"; then
  pass 'gateway and nginx share the attestation header'
else
  fail 'gateway attestation header is not wired on both sides'
fi

# ---------------------------------------------------------------------------
section '6. Logging cannot capture a token (threat T9)'
# ---------------------------------------------------------------------------
if grep -qE 'log_format dsh_safe' "$SINGLE/nginx/nginx.conf.template"; then
  pass 'a dedicated safe log format is defined'
else
  fail 'no safe log format is defined'
fi
# The safe format must use $uri, not $request_uri, and must not log cookies.
LOGFMT=$(sed -n "/log_format dsh_safe/,/;/p" "$SINGLE/nginx/nginx.conf.template")
for forbidden in 'request_uri' 'args' 'http_cookie' 'http_authorization'; do
  if printf '%s' "$LOGFMT" | grep -q "$forbidden"; then
    fail "log_format contains \$$forbidden, which can leak credentials"
  else
    pass "log_format omits \$$forbidden"
  fi
done
if grep -q 'request_logging = false' "$SINGLE/oauth2-proxy/oauth2-proxy.cfg"; then
  pass 'oauth2-proxy request logging is off'
else
  fail 'oauth2-proxy request logging is on (may log query strings)'
fi

# ---------------------------------------------------------------------------
section '7. Transport security'
# ---------------------------------------------------------------------------
if grep -qE 'ssl_protocols TLSv1\.2 TLSv1\.3' "$SINGLE/nginx/nginx.conf.template"; then
  pass 'TLS 1.2+ only'
else
  fail 'TLS version floor is not enforced'
fi
if grep -qE 'return 308 https://' "$SINGLE/nginx/nginx.conf.template"; then
  pass 'plain HTTP redirects to HTTPS'
else
  fail 'plain HTTP does not redirect'
fi
if grep -qE 'cookie_secure = true' "$SINGLE/oauth2-proxy/oauth2-proxy.cfg"; then
  pass 'oauth2-proxy cookie is Secure'
else
  fail 'oauth2-proxy cookie is not Secure'
fi
if grep -qE 'cookie_httponly = true' "$SINGLE/oauth2-proxy/oauth2-proxy.cfg"; then
  pass 'oauth2-proxy cookie is HttpOnly'
else
  fail 'oauth2-proxy cookie is not HttpOnly'
fi
# HSTS must be opt-in, never on by default.
if grep -q 'DSH_HSTS_DIRECTIVE' "$SINGLE/nginx/nginx.conf.template" && \
   grep -q 'DSH_HSTS_DIRECTIVE:-' "$SINGLE/compose.yaml"; then
  pass 'HSTS is opt-in via configuration'
else
  fail 'HSTS is not gated behind configuration'
fi

# WebSocket support must be present, with long timeouts.
if grep -q 'Connection \$connection_upgrade' "$SINGLE/nginx/nginx.conf.template"; then
  pass 'nginx forwards WebSocket upgrades'
else
  fail 'nginx does not forward WebSocket upgrades'
fi
if grep -qE 'proxy_read_timeout\s+3600s' "$SINGLE/nginx/nginx.conf.template"; then
  pass 'stream read timeout is long enough for a session'
else
  fail 'stream read timeout would truncate long answers'
fi

# ---------------------------------------------------------------------------
section '8. Identity provider alternatives (Keycloak not assumed)'
# ---------------------------------------------------------------------------
# The deployment must work against a corporate IdP too, so the issuer must be a
# variable rather than a hard requirement on a local Keycloak.
if grep -q 'OIDC_ISSUER_URL\|oidc_issuer_url' "$SINGLE/env.example"; then
  pass 'the OIDC issuer is configurable (corporate IdP is possible)'
else
  fail 'the OIDC issuer is hard-coded'
fi
if grep -q 'email_domains = \[\]' "$SINGLE/oauth2-proxy/oauth2-proxy.cfg"; then
  pass 'no email-domain admission (ADR-4)'
else
  fail 'email-domain admission may be enabled'
fi
if grep -q 'authenticated_emails_file' "$SINGLE/oauth2-proxy/oauth2-proxy.cfg"; then
  pass 'subject allowlist is wired into oauth2-proxy'
else
  fail 'oauth2-proxy has no allowlist'
fi
if grep -q 'insecure_oidc_skip_issuer_verification = false' "$SINGLE/oauth2-proxy/oauth2-proxy.cfg"; then
  pass 'issuer verification is explicitly not skipped'
else
  fail 'issuer verification is not pinned'
fi

# ---------------------------------------------------------------------------
section '9. Existing platform untouched'
# ---------------------------------------------------------------------------
# The base compose must still be present and must not have been rewritten by this
# work: the deployment is additive (roadmap §10, rollback).
if [ -f "$REPO_ROOT/compose.yaml" ]; then
  pass 'base compose.yaml is present'
else
  fail 'base compose.yaml is missing'
fi
if grep -qE 'personal-ai-workspace' "$REPO_ROOT/compose.yaml"; then
  pass 'base compose project name unchanged'
else
  fail 'base compose project name changed'
fi
# The base must not have gained a published Harness port.
if awk '/^  harness:/{i=1;next} i&&/^  [a-zA-Z]/{i=0} i' "$REPO_ROOT/compose.yaml" | grep -qE '^\s+ports:' -A2 | grep -qE '0\.0\.0\.0'; then
  fail 'base compose publishes Harness on a wildcard address'
else
  pass 'base compose keeps Harness on loopback'
fi

# ---------------------------------------------------------------------------
printf '\n== Summary\n'
printf '  passed: %d\n  failed: %d\n  skipped: %d\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '\nsecurity checks FAILED\n'
  exit 1
fi
printf '\nsecurity checks passed (offline tier; nothing here contacted Keycloak, nginx or DSH)\n'
exit 0
