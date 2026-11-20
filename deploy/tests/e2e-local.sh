#!/bin/sh
# Local end-to-end test of the single-user secure access chain.
#
# WHAT THIS IS
#   A reproducible harness that starts the REAL nginx config, the REAL gateway and
#   a stand-in for oauth2-proxy, then drives them through both identities. It runs
#   entirely on loopback. It is the closest thing to a live test that can be done
#   without a VM, a Keycloak or a certificate, and it is what "ready for a
#   controlled local test run" means concretely.
#
# WHAT THIS IS NOT
#   It is NOT a live verification. oauth2-proxy is replaced by a stand-in that
#   speaks the same contract (401 without a session, 403 for a non-allowlisted
#   subject, 202 with X-Auth-Request-* headers for an allowed one). Keycloak, TLS
#   chain validity and a corporate DNS name are not exercised. Results are
#   classified as offline in the roadmap.
#
# PREREQUISITES
#   - node 20+
#   - an nginx binary: set NGINX_BIN, or have `nginx` on PATH
#   - a running DSH on loopback with a KNOWN cookie secret, e.g.
#       DSH_HOME=/tmp/dsh-e2e dsh web --no-open --host 127.0.0.1 --port 3199 \
#         --public-url https://dsh.local/ --trusted-host dsh.local
#     The secret is read from $DSH_HOME/.credentials.yaml and must be written to
#     the file named by DSH_COOKIE_SECRET_FILE.
#   - openssl, for the throwaway self-signed certificate
#
# USAGE
#   DSH_HOME=/tmp/dsh-e2e ./deploy/tests/e2e-local.sh
#
# The script never publishes a port beyond loopback, never touches the running
# deployment, and cleans up after itself.
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SINGLE="$REPO_ROOT/deploy/single-user"
WORK=${E2E_WORK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/dsh-e2e.XXXXXX")}

DSH_PORT=${DSH_PORT:-3199}
AUTHORITY=${AUTHORITY:-dsh.local}
OWNER_SUB=${OWNER_SUB:-owner-sub}
FOREIGN_SUB=${FOREIGN_SUB:-foreign-sub}

# Ports are chosen from a base so repeated runs and other local services do not
# collide. Override any of them explicitly when running alongside something else.
BASE_PORT=${BASE_PORT:-28000}
HTTP_PORT=${HTTP_PORT:-$((BASE_PORT + 81))}
HTTPS_PORT=${HTTPS_PORT:-$((BASE_PORT + 444))}
PROXY_PORT=${PROXY_PORT:-$((BASE_PORT + 180))}
GATEWAY_PORT=${GATEWAY_PORT:-$((BASE_PORT + 90))}

# Refuse to start when any port is busy, with a clear message naming the override,
# instead of failing later inside a background process where the message is lost.
port_busy() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -q ":$1 "; else
    netstat -ltn 2>/dev/null | grep -q ":$1 "; fi
}
for candidate in "$HTTP_PORT" "$HTTPS_PORT" "$PROXY_PORT" "$GATEWAY_PORT"; do
  if port_busy "$candidate"; then
    echo "e2e: port $candidate is already in use; rerun with BASE_PORT=<free base> or set that PORT explicitly" >&2
    exit 77
  fi
done

if [ -n "${NGINX_BIN:-}" ]; then :; else NGINX_BIN=$(command -v nginx || true); fi
[ -n "${NGINX_BIN:-}" ] || { echo "e2e: set NGINX_BIN or install nginx" >&2; exit 77; }
command -v node >/dev/null || { echo "e2e: node is required" >&2; exit 77; }
command -v openssl >/dev/null || { echo "e2e: openssl is required" >&2; exit 77; }

PIDS=""
cleanup() {
  for pid in $PIDS; do kill "$pid" 2>/dev/null || true; done
  sleep 0.3
  for pid in $PIDS; do kill -9 "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

log() { printf 'e2e: %s\n' "$*"; }
fail() { printf 'e2e: FAIL: %s\n' "$*" >&2; FAILED=1; }
ok() { printf 'e2e:   [ok]   %s\n' "$*"; }

PASS=0; FAILED=0
expect() {
  description=$1; expected=$2; shift 2
  actual=$(curl -sk -o /dev/null -w '%{http_code}' "$@" || echo 000)
  if [ "$actual" = "$expected" ]; then PASS=$((PASS+1)); ok "$description -> $actual"
  else FAILED=$((FAILED+1)); fail "$description -> $actual (expected $expected)"; fi
}

# ---------------------------------------------------------------------------
# Prerequisites: a running DSH and its secret
# ---------------------------------------------------------------------------
if ! curl -s -o /dev/null -m 2 "http://127.0.0.1:$DSH_PORT/" 2>/dev/null; then
  echo "e2e: nothing listening on 127.0.0.1:$DSH_PORT; start DSH first (see header)" >&2
  exit 77
fi

CREDENTIALS=${DSH_HOME:-$HOME/.dsh}/.credentials.yaml
[ -r "$CREDENTIALS" ] || { echo "e2e: cannot read $CREDENTIALS" >&2; exit 77; }

SECRET_FILE="$WORK/dsh-cookie-secret"
grep -A6 'client-connection/browser-session' "$CREDENTIALS" \
  | sed -n 's/.*secret:[[:space:]]*//p' | head -1 > "$SECRET_FILE"
[ -s "$SECRET_FILE" ] || { echo "e2e: no browser-session secret in $CREDENTIALS" >&2; exit 77; }
chmod 600 "$SECRET_FILE"

# ---------------------------------------------------------------------------
# Stand-in for oauth2-proxy
# ---------------------------------------------------------------------------
cat > "$WORK/fake-oauth2-proxy.js" <<'PROXY'
// Contract-compatible stand-in for oauth2-proxy with --set-xauthrequest:
//   no session            -> 401 (nginx turns that into a redirect to login)
//   session, not allowed  -> 403
//   session, allowed      -> 202 + X-Auth-Request-User / -Email
const http = require('node:http');
const [port, allowed] = [Number(process.argv[2]), process.argv[3]];
http.createServer((req, res) => {
  const match = (req.headers.cookie || '').match(/who=([^;]+)/);
  if (!match) { res.writeHead(401); res.end('no session'); return; }
  const sub = decodeURIComponent(match[1]);
  if (sub !== allowed) { res.writeHead(403); res.end('forbidden'); return; }
  res.writeHead(202, {
    'X-Auth-Request-User': sub,
    'X-Auth-Request-Email': `${sub}@corp.example`,
  });
  res.end();
}).listen(port, '127.0.0.1');
PROXY
node "$WORK/fake-oauth2-proxy.js" "$PROXY_PORT" "$OWNER_SUB" &
PIDS="$PIDS $!"

# ---------------------------------------------------------------------------
# Gateway with the real configuration surface
# ---------------------------------------------------------------------------
SHARED_FILE="$WORK/gateway-shared-secret"
printf '%s\n' "$(openssl rand -base64 32 | tr -d '\n')" > "$SHARED_FILE"
chmod 600 "$SHARED_FILE"

(
  cd "$SINGLE/gateway"
  GATEWAY_LISTEN_HOST=127.0.0.1 \
  GATEWAY_LISTEN_PORT="$GATEWAY_PORT" \
  DSH_UPSTREAM="http://127.0.0.1:$DSH_PORT" \
  GATEWAY_ALLOWED_AUTHORITIES="$AUTHORITY" \
  GATEWAY_ALLOWED_SUBJECTS="$OWNER_SUB" \
  GATEWAY_COOKIE_SECRET_FILE="$SECRET_FILE" \
  GATEWAY_PROXY_SHARED_SECRET_FILE="$SHARED_FILE" \
  GATEWAY_COOKIE_MAX_AGE_SECONDS=3600 \
  exec node server.js
) > "$WORK/gateway.log" 2>&1 &
PIDS="$PIDS $!"

# ---------------------------------------------------------------------------
# nginx with the real template
# ---------------------------------------------------------------------------
# No brace expansion here: this script runs under sh, where it is not supported
# and would create one directory with a literal brace in its name.
for dir in logs tmp/body tmp/proxy tmp/fastcgi tmp/uwsgi tmp/scgi tls dsh; do
  mkdir -p "$WORK/$dir"
done
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$AUTHORITY" \
  -keyout "$WORK/tls/privkey.pem" -out "$WORK/tls/fullchain.pem" 2>/dev/null

printf 'set $dsh_gateway_secret "%s";\n' "$(cat "$SHARED_FILE")" > "$WORK/dsh/gateway-secret.conf"
printf 'types { text/html html; }\n' > "$WORK/mime.types"

sed -e "s|\${OAUTH2_PROXY_UPSTREAM}|127.0.0.1:$PROXY_PORT|g" \
    -e "s|\${DSH_GATEWAY_UPSTREAM}|127.0.0.1:$GATEWAY_PORT|g" \
    -e "s|\${DSH_HOSTNAME}|$AUTHORITY|g" \
    -e "s|\${NGINX_HTTP_PORT}|$HTTP_PORT|g" \
    -e "s|\${NGINX_HTTPS_PORT}|$HTTPS_PORT|g" \
    -e "s|\${NGINX_CLIENT_MAX_BODY}|64m|g" \
    -e "s|\${DSH_HSTS_DIRECTIVE}||g" \
    -e "s|/etc/nginx/dsh/proxy-hygiene.conf|$SINGLE/nginx/proxy-hygiene.conf|g" \
    -e "s|/etc/nginx/dsh/gateway-secret.conf|$WORK/dsh/gateway-secret.conf|" \
    -e "s|/etc/nginx/tls|$WORK/tls|g" \
    -e "s|/var/log/nginx|$WORK/logs|g" \
    -e "s|^worker_processes auto;|worker_processes 1;|" \
    -e "s|^pid /var/run/nginx.pid;|pid $WORK/nginx.pid;|" \
    -e "s|include       /etc/nginx/mime.types;|include $WORK/mime.types;|" \
    -e "s|^http {|http {\n    client_body_temp_path $WORK/tmp/body;\n    proxy_temp_path $WORK/tmp/proxy;\n    fastcgi_temp_path $WORK/tmp/fastcgi;\n    uwsgi_temp_path $WORK/tmp/uwsgi;\n    scgi_temp_path $WORK/tmp/scgi;\n    access_log $WORK/logs/global.log;|" \
    "$SINGLE/nginx/nginx.conf.template" > "$WORK/nginx.conf"

"$NGINX_BIN" -t -c "$WORK/nginx.conf" -p "$WORK" >/dev/null 2>&1 \
  || { echo "e2e: rendered nginx config failed validation" >&2; "$NGINX_BIN" -t -c "$WORK/nginx.conf" -p "$WORK"; exit 1; }
"$NGINX_BIN" -c "$WORK/nginx.conf" -p "$WORK" >/dev/null 2>&1 &
PIDS="$PIDS $!"

# Wait for both listeners rather than sleeping a fixed time.
# Readiness by curl, not /dev/tcp: the latter is a bash feature and this script
# runs under sh.
wait_for_https() {
  port=$1; tries=0
  while [ "$tries" -lt 100 ]; do
    if curl -sk -o /dev/null -m 1 "https://127.0.0.1:$port/healthz" 2>/dev/null; then return 0; fi
    tries=$((tries+1)); sleep 0.1
  done
  return 1
}
wait_for_http() {
  port=$1; tries=0
  while [ "$tries" -lt 100 ]; do
    if curl -s -o /dev/null -m 1 "http://127.0.0.1:$port/" 2>/dev/null; then return 0; fi
    tries=$((tries+1)); sleep 0.1
  done
  return 1
}
wait_for_http "$PROXY_PORT"   || { echo "e2e: oauth2 stand-in did not start" >&2; exit 1; }
wait_for_http "$GATEWAY_PORT" || { echo "e2e: gateway did not start; log:" >&2; cat "$WORK/gateway.log" >&2; exit 1; }
wait_for_https "$HTTPS_PORT"  || { echo "e2e: nginx did not start" >&2; exit 1; }

BASE="https://127.0.0.1:$HTTPS_PORT"
WS_HEADERS='-H Connection:Upgrade -H Upgrade:websocket -H Sec-WebSocket-Version:13 -H Sec-WebSocket-Key:dGhlIHNhbXBsZSBub25jZQ=='

log "authority=$AUTHORITY owner=$OWNER_SUB foreign=$FOREIGN_SUB"
log "workdir=$WORK"

# ---------------------------------------------------------------------------
# Identity matrix
# ---------------------------------------------------------------------------
expect "anonymous gets redirected to login"            302 -H "Host: $AUTHORITY" "$BASE/"
expect "forbidden SSO user is refused at the edge"     403 -H "Host: $AUTHORITY" -H "Cookie: who=$FOREIGN_SUB" "$BASE/"
expect "owner reaches the harness"                     200 -H "Host: $AUTHORITY" -H "Cookie: who=$OWNER_SUB" "$BASE/"
expect "smuggled identity headers grant nothing"       302 -H "Host: $AUTHORITY" -H 'X-Auth-Request-User: '"$OWNER_SUB" -H 'X-Forwarded-User: '"$OWNER_SUB" "$BASE/"
expect "smuggled Authorization grants nothing"         302 -H "Host: $AUTHORITY" -H 'Authorization: Bearer forged' "$BASE/"
expect "foreign Host is refused by the gateway"        421 -H "Host: attacker.example" -H "Cookie: who=$OWNER_SUB" "$BASE/"
expect "plain HTTP redirects to HTTPS"                 308 "http://127.0.0.1:$HTTP_PORT/"

# WebSocket: the Remote stream mux is the component a login screen would forget.
expect "anonymous WebSocket upgrade refused"           302 --http1.1 -H "Host: $AUTHORITY" $WS_HEADERS "$BASE/api/remote.mux"
expect "forbidden WebSocket upgrade refused"           403 --http1.1 -H "Host: $AUTHORITY" -H "Cookie: who=$FOREIGN_SUB" $WS_HEADERS "$BASE/api/remote.mux"
expect "owner WebSocket upgrade accepted"              101 --http1.1 -H "Host: $AUTHORITY" -H "Cookie: who=$OWNER_SUB" $WS_HEADERS "$BASE/api/remote.mux"

# ---------------------------------------------------------------------------
# Cookie delivery and log hygiene
# ---------------------------------------------------------------------------
OWNER_HEADERS="$WORK/owner.headers"
curl -sk -D "$OWNER_HEADERS" -o /dev/null -H "Host: $AUTHORITY" -H "Cookie: who=$OWNER_SUB" "$BASE/"

if grep -qi '^set-cookie: dsh-auth-' "$OWNER_HEADERS"; then
  PASS=$((PASS+1)); ok "the gateway sets the DSH session cookie on the browser"
else
  FAILED=$((FAILED+1)); fail "no dsh-auth Set-Cookie on the owner response"
fi
for attribute in HttpOnly Secure SameSite=Strict; do
  if grep -qi "^set-cookie:.*$attribute" "$OWNER_HEADERS"; then
    PASS=$((PASS+1)); ok "cookie carries $attribute"
  else
    FAILED=$((FAILED+1)); fail "cookie is missing $attribute"
  fi
done

# An access log must never contain a token, a cookie value or the signing secret.
if grep -qiE 'token=|dsh-auth-|secret' "$WORK/logs/dsh-access.log" 2>/dev/null; then
  FAILED=$((FAILED+1)); fail "access log leaked a credential"
else
  PASS=$((PASS+1)); ok "access log contains no token, cookie or secret"
fi

# The gateway must never log its secret.
if grep -qiE 'secret|dsh-auth-' "$WORK/gateway.log" 2>/dev/null; then
  FAILED=$((FAILED+1)); fail "gateway log leaked a credential"
else
  PASS=$((PASS+1)); ok "gateway log contains no secret"
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
printf '\ne2e: %d passed, %d failed\n' "$PASS" "$FAILED"
if [ "$FAILED" -gt 0 ]; then
  printf 'e2e: FAILED\n'
  printf 'e2e: gateway log:\n'; sed 's/^/    /' "$WORK/gateway.log" 2>/dev/null || true
  exit 1
fi
printf 'e2e: PASSED (offline tier: oauth2-proxy is a stand-in; no Keycloak, no VM, no real TLS chain)\n'
exit 0
