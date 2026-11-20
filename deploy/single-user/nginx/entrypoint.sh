#!/bin/sh
# Render the nginx configuration and start nginx.
#
# Two things must happen before nginx can start:
#
#  1. The upstream addresses, hostname and TLS policy are substituted into
#     nginx.conf.template. Only an explicit variable list is substituted, so an
#     unrelated `${...}` inside a comment or a future directive is never touched
#     by accident.
#
#  2. The gateway shared secret is written to its own 0600 include. It is kept
#     out of the template and out of the environment so it cannot leak into Git,
#     `docker inspect`, or a rendered config that someone pastes into a ticket.
#
# The process fails loudly rather than starting with a missing or weak secret:
# a gateway without its shared header refuses every request, which would look
# like an outage rather than a misconfiguration.
set -eu

TEMPLATE=/etc/nginx/templates/nginx.conf.template
RENDERED=/etc/nginx/nginx.conf
SECRET_FILE=${GATEWAY_PROXY_SHARED_SECRET_FILE:-/run/secrets/gateway-proxy-shared-secret}
SECRET_INCLUDE=/etc/nginx/dsh/gateway-secret.conf

log() { printf 'nginx-entrypoint: %s\n' "$*" >&2; }
die() { printf 'nginx-entrypoint: fatal: %s\n' "$*" >&2; exit 78; }

# --- TLS material ----------------------------------------------------------
[ -r /etc/nginx/tls/fullchain.pem ] || die 'missing /etc/nginx/tls/fullchain.pem (mount the certificate chain)'
[ -r /etc/nginx/tls/privkey.pem ]   || die 'missing /etc/nginx/tls/privkey.pem (mount the private key)'

# --- shared secret ---------------------------------------------------------
[ -r "$SECRET_FILE" ] || die "missing gateway shared secret at $SECRET_FILE"

# Read without echoing. `$(cat)` strips the trailing newline; the value must be
# non-empty and must not contain characters that would break the nginx string
# literal. Refusing those is safer than escaping them.
SECRET=$(cat "$SECRET_FILE")
[ -n "$SECRET" ] || die 'gateway shared secret is empty'
case "$SECRET" in
  *'"'*|*'\'*|*'
'*) die 'gateway shared secret must not contain quotes, backslashes or newlines' ;;
esac
if [ ${#SECRET} -lt 32 ]; then
  die "gateway shared secret must be at least 32 characters, got ${#SECRET}"
fi

mkdir -p /etc/nginx/dsh
umask 077
printf 'set $dsh_gateway_secret "%s";\n' "$SECRET" > "$SECRET_INCLUDE"
chmod 600 "$SECRET_INCLUDE"

# --- required variables ----------------------------------------------------
# Validate before rendering: envsubst silently substitutes an empty string for a
# missing variable, which would produce a config that parses and binds nowhere.
for name in OAUTH2_PROXY_UPSTREAM DSH_GATEWAY_UPSTREAM DSH_HOSTNAME \
            NGINX_HTTP_PORT NGINX_HTTPS_PORT NGINX_CLIENT_MAX_BODY DSH_HSTS_DIRECTIVE; do
  eval "value=\${$name-}"
  [ -n "${value}" ] || die "required variable $name is empty (DSH_HSTS_DIRECTIVE may be an empty line marker)"
done

# The header-hygiene include must be mounted. Without it every proxying location
# fails to start, which is the desired fail-closed behaviour, but the message
# should say why rather than emitting a bare include error.
[ -r /etc/nginx/dsh/proxy-hygiene.conf ] || die "missing /etc/nginx/dsh/proxy-hygiene.conf (mount deploy/single-user/nginx/proxy-hygiene.conf)"

# DSH_HSTS_DIRECTIVE is intentionally allowed to be a single space meaning "no
# HSTS yet"; normalise it so the rendered file stays readable.
mkdir -p /etc/nginx/dsh

envsubst '${OAUTH2_PROXY_UPSTREAM} ${DSH_GATEWAY_UPSTREAM} ${DSH_HOSTNAME} ${NGINX_HTTP_PORT} ${NGINX_HTTPS_PORT} ${NGINX_CLIENT_MAX_BODY} ${DSH_HSTS_DIRECTIVE}' \
  < "$TEMPLATE" > "$RENDERED"

# --- validate --------------------------------------------------------------
if ! nginx -t 2>&1 | sed 's/^/nginx-entrypoint: /' >&2; then
  die 'rendered configuration failed validation'
fi

log 'configuration valid; starting nginx'
exec nginx -g 'daemon off;'
