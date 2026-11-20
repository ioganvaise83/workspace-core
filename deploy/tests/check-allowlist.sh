#!/bin/sh
# Enforce the phase-1 single-user constraint (ADR-8) and validate the allowlist.
#
# Why this exists: the gateway mints a DSH cookie for one Harness instance. If two
# people pass the allowlist, they share one home — one sessions list, one mailbox
# set, one workspace. That is precisely the failure this project exists to
# prevent, so it must be a hard check, not a documentation note.
#
# Checks:
#   1. the allowlist file is readable and well-formed;
#   2. exactly one active subject;
#   3. the active subject looks like an opaque identifier, not an email address;
#   4. GATEWAY_ALLOWED_SUBJECTS in .env matches the allowlist;
#   5. no wildcard or domain-wide rule is present anywhere.
#
# Usage:
#   deploy/tests/check-allowlist.sh
#   ALLOWLIST_FILE=/path/to/file sh deploy/tests/check-allowlist.sh
set -u

SINGLE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../single-user" && pwd)
ALLOWLIST_FILE=${ALLOWLIST_FILE:-$SINGLE_DIR/secrets/allowed-subjects.txt}
ENV_FILE=${ENV_FILE:-$SINGLE_DIR/.env}

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); printf '  [PASS] %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$*"; }
note() { printf '  [note] %s\n' "$*"; }

printf '== Allowlist: %s\n' "$ALLOWLIST_FILE"

if [ ! -f "$ALLOWLIST_FILE" ]; then
  # Absence is the correct deny-by-default state before the owner configures it.
  note 'not configured yet; nobody is admitted (correct before activation)'
  printf '\nA deployment is not ready to activate: create %s with exactly one subject.\n' "$ALLOWLIST_FILE"
  exit 0
fi

if [ ! -r "$ALLOWLIST_FILE" ]; then
  fail 'allowlist is not readable'
  printf '\nallowlist checks FAILED\n'; exit 1
fi

# Active entries: non-empty, not a comment.
entries=$(grep -vE '^[[:space:]]*(#|$)' "$ALLOWLIST_FILE" 2>/dev/null | sed 's/[[:space:]]*#.*$//' | sed 's/[[:space:]]*$//' | grep -v '^$' || true)
count=$(printf '%s\n' "$entries" | grep -c . || true)

case "$count" in
  0) note 'no active entry yet; deny by default' ;;
  1)
    pass 'exactly one active subject'
    subject=$(printf '%s' "$entries" | head -1)
    # A UUID is the common shape; do not require it, but reject an email, which
    # changes on rename and invites domain-wide admission (ADR-4).
    case "$subject" in
      *@*) fail "active entry looks like an email address: $subject" ;;
      \**) fail 'active entry is a wildcard' ;;
      *)   pass 'active entry is an opaque identifier (not an email)' ;;
    esac
    printf '  [info] active subject: %s\n' "$subject"

    if [ -f "$ENV_FILE" ]; then
      env_subjects=$(grep -E '^GATEWAY_ALLOWED_SUBJECTS=' "$ENV_FILE" | sed 's/^[^=]*=//' | tr -d '"' || true)
      if [ -z "$env_subjects" ]; then
        fail 'GATEWAY_ALLOWED_SUBJECTS is empty in .env but the allowlist has an entry'
      elif [ "$env_subjects" = "$subject" ]; then
        pass 'gateway subject list matches the allowlist'
      else
        fail "gateway subject list ($env_subjects) differs from the allowlist ($subject)"
        note 'the gateway and oauth2-proxy would disagree about who is allowed'
      fi
    else
      note 'no .env yet; cannot cross-check GATEWAY_ALLOWED_SUBJECTS'
    fi
    ;;
  *)
    fail "found $count active subjects; phase 1 admits exactly one"
    note 'adding a second user requires phase 3 (separate instances), not another line here'
    printf '%s\n' "$entries" | sed 's/^/         /'
    ;;
esac

# No domain-wide admission anywhere in the oauth2-proxy config.
O2P="$SINGLE_DIR/oauth2-proxy/oauth2-proxy.cfg"
if [ -f "$O2P" ]; then
  if grep -qE '^email_domains[[:space:]]*=[[:space:]]*\[[^]]' "$O2P"; then
    fail 'oauth2-proxy admits by email domain'
  else
    pass 'no email-domain admission in oauth2-proxy'
  fi
else
  fail 'oauth2-proxy.cfg not found; cannot check admission rules'
fi

printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf 'allowlist checks FAILED (%d passed, %d failed)\n' "$PASS" "$FAIL"
  exit 1
fi
printf 'allowlist checks passed (%d)\n' "$PASS"
exit 0
