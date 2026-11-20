#!/bin/sh
# Generate every secret this deployment needs, on the host, outside Git.
#
# Why a script rather than "copy these values": a secret that a human types is a
# secret that gets reused and pasted into a ticket. This script generates fresh
# randomness, sets correct permissions, refuses to overwrite existing secrets, and
# never prints a value.
#
# What it produces, in $SECRETS_DIR (default ./secrets, git-ignored):
#
#   oauth2-cookie-secret         32 bytes, base64url    oauth2-proxy session encryption
#   gateway-proxy-shared-secret  32 bytes, base64url    nginx -> gateway attestation
#   dsh-cookie-secret            32 raw bytes, base64url DSH browser cookie signing
#
# The OIDC client secret is NOT generated here: Keycloak issues it. Paste the
# value from the Keycloak console into `oidc-client-secret` and the script will
# validate it on the next run.
#
# Usage:
#   ./prepare-secrets.sh [--secrets-dir DIR] [--force]
#
# Refuses to run as root? No: on a VM the deploy user may be root. It does refuse
# to write into a world-readable directory.
set -eu

SECRETS_DIR=${SECRETS_DIR:-./secrets}
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --secrets-dir) SECRETS_DIR=$2; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 64 ;;
  esac
done

log() { printf 'prepare-secrets: %s\n' "$*"; }
die() { printf 'prepare-secrets: fatal: %s\n' "$*" >&2; exit 1; }

command -v openssl >/dev/null 2>&1 || die 'openssl is required'

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
PERMS=$(stat -c '%a' "$SECRETS_DIR" 2>/dev/null || stat -f '%Lp' "$SECRETS_DIR")
[ "$PERMS" = "700" ] || die "secrets directory $SECRETS_DIR must be 0700, found $PERMS"

# 32 random bytes as base64url without padding. DSH's secret is decoded back to
# 32 raw bytes, so the length must be exact: base64 of 32 bytes is 44 chars with
# padding, 43 without.
gen_secret() {
  openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_' | tr -d '='
}

write_secret() {
  name=$1
  path="$SECRETS_DIR/$name"

  if [ -e "$path" ] && [ "$FORCE" -ne 1 ]; then
    # Validate rather than overwrite: silently replacing the DSH cookie secret
    # would invalidate every existing browser session.
    size=$(wc -c < "$path" | tr -d ' ')
    if [ "$size" -lt 32 ]; then
      die "$path exists but is only ${size} bytes; inspect it or rerun with --force"
    fi
    log "keeping existing $name (${size} bytes)"
    return 0
  fi

  umask 077
  gen_secret > "$path"
  chmod 600 "$path"
  size=$(wc -c < "$path" | tr -d ' ')
  log "generated $name (${size} bytes)"
}

log "secrets directory: $SECRETS_DIR"

write_secret oauth2-cookie-secret
write_secret gateway-proxy-shared-secret
write_secret dsh-cookie-secret

# The OIDC client secret comes from Keycloak and cannot be generated here.
OIDC_PATH="$SECRETS_DIR/oidc-client-secret"
if [ -s "$OIDC_PATH" ]; then
  size=$(wc -c < "$OIDC_PATH" | tr -d ' ')
  log "found oidc-client-secret (${size} bytes)"
else
  umask 077
  : > "$OIDC_PATH"
  chmod 600 "$OIDC_PATH"
  log 'created empty oidc-client-secret placeholder'
  log 'ACTION REQUIRED: paste the Keycloak client secret into that file (single line)'
fi

# --- cross-checks -----------------------------------------------------------

# The DSH cookie secret must be exactly 32 bytes when decoded. Verify now rather
# than letting the gateway refuse at startup.
DSH_SECRET="$SECRETS_DIR/dsh-cookie-secret"
if [ -s "$DSH_SECRET" ]; then
  # openssl's base64 decoder rejects base64url (`-` and `_`), so translate first
  # and restore padding. Getting this wrong produces a false failure, which is
  # worse than having no check.
  #
  # Preferred: python3 (present on virtually every Linux VM). Fallback: translate
  # to standard base64 and let openssl decode it. Both report a byte count.
  if command -v python3 >/dev/null 2>&1; then
    DECODED=$(
      python3 - "$DSH_SECRET" <<'PY' 2>/dev/null || echo invalid
import sys
text = open(sys.argv[1], encoding="utf-8").read().strip()
if not text or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for c in text):
    print("invalid")
    raise SystemExit(0)
padded = text.replace("-", "+").replace("_", "/")
padded += "=" * (-len(padded) % 4)
import base64
raw = base64.b64decode(padded, validate=True)
canonical = base64.b64encode(raw).decode().replace("+", "-").replace("/", "_").rstrip("=")
print(len(raw) if canonical == text else "invalid")
PY
    )
  else
    DECODED=$(
      tr -- '-_' '+/' < "$DSH_SECRET" | tr -d '\n' | {
        value=$(cat)
        case $((${#value} % 4)) in
          2) value="${value}==" ;;
          3) value="${value}=" ;;
        esac
        printf '%s' "$value"
      } | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' '
    )
  fi
  case "$DECODED" in
    32) log 'dsh-cookie-secret decodes to exactly 32 bytes' ;;
    invalid) die "dsh-cookie-secret is not canonical base64url; regenerate with --force" ;;
    ''|*[!0-9]*) die "could not verify dsh-cookie-secret; check it by hand" ;;
    *) die "dsh-cookie-secret decodes to ${DECODED} bytes, expected 32; regenerate with --force" ;;
  esac
fi

log ''
log 'Next:'
log '  1. Fill oidc-client-secret from the Keycloak client Credentials tab.'
log '  2. Point DSH at the same dsh-cookie-secret (docs/security/deployment-guide.md).'
log '  3. Never copy this directory into Git, an image, or a ticket.'
