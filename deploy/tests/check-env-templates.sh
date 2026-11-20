#!/bin/sh
# Validate the dotenv templates and the values they ship with.
#
# Why this exists: a template written as `KEY: VALUE` is not an assignment. Docker
# Compose reads dotenv as `KEY=VALUE`, ignores the colon form silently, and the
# deployment then runs on defaults nobody chose — a wrong hostname, an empty
# issuer, a placeholder password. Nothing errors; it just does not work, and the
# cause is invisible.
#
# What it checks:
#   1. every non-comment line is `KEY=VALUE`;
#   2. no duplicate keys (a later assignment silently wins);
#   3. no real secret values are committed in the template;
#   4. the hostnames are internally consistent between the two projects;
#   5. the OIDC issuer matches the Keycloak hostname;
#   6. the realm file name matches the realm inside it.
#
# Usage: deploy/tests/check-env-templates.sh
set -u

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
IDENTITY_ENV="$REPO_ROOT/deploy/identity/env.example"
SINGLE_ENV="$REPO_ROOT/deploy/single-user/env.example"

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); printf '  [PASS] %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

# Strip a trailing comment that is not inside quotes: enough for these files.
value_of() {
  file=$1; key=$2
  sed -n "s/^${key}=//p" "$file" | head -1 | sed 's/[[:space:]]*$//'
}

section '1. Syntax is KEY=VALUE'
for file in "$IDENTITY_ENV" "$SINGLE_ENV"; do
  name=${file#"$REPO_ROOT"/}
  [ -f "$file" ] || { fail "$name is missing"; continue; }

  # Any line that looks like an assignment but uses a colon.
  colon=$(grep -nE '^[A-Z][A-Z0-9_]*:[[:space:]]' "$file" || true)
  if [ -n "$colon" ]; then
    fail "$name contains KEY: VALUE lines, which Compose ignores:"
    printf '%s\n' "$colon" | sed 's/^/         /'
  else
    pass "$name uses KEY=VALUE"
  fi

  # Any non-comment line that is neither blank nor KEY=VALUE.
  malformed=$(grep -nvE '^[[:space:]]*(#|$|([A-Z][A-Z0-9_]*=))' "$file" || true)
  if [ -n "$malformed" ]; then
    fail "$name has lines that are not assignments or comments:"
    printf '%s\n' "$malformed" | sed 's/^/         /'
  else
    pass "$name has no stray lines"
  fi
done

section '2. No duplicate keys'
for file in "$IDENTITY_ENV" "$SINGLE_ENV"; do
  name=${file#"$REPO_ROOT"/}
  [ -f "$file" ] || continue
  dups=$(grep -oE '^[A-Z][A-Z0-9_]*=' "$file" | sort | uniq -d || true)
  if [ -n "$dups" ]; then
    fail "$name assigns these keys more than once:"
    printf '%s\n' "$dups" | sed 's/^/         /'
  else
    pass "$name has no duplicate keys"
  fi
done

section '3. No real secrets in the templates'
for file in "$IDENTITY_ENV" "$SINGLE_ENV"; do
  name=${file#"$REPO_ROOT"/}
  [ -f "$file" ] || continue
  # Secret-bearing keys must be empty in a template.
  leaked=$(grep -nE '^(KC_DB_PASSWORD|KC_BOOTSTRAP_ADMIN_PASSWORD|OIDC_CLIENT_SECRET|GATEWAY_ALLOWED_SUBJECTS)=[^"[:space:]]' "$file" || true)
  if [ -n "$leaked" ]; then
    fail "$name has a non-empty secret:"
    printf '%s\n' "$leaked" | sed 's/^/         /'
  else
    pass "$name ships no secret values"
  fi
done

section '4. Hostnames are consistent across the two projects'
[ -f "$IDENTITY_ENV" ] && [ -f "$SINGLE_ENV" ] || { fail 'cannot compare hostnames'; }

KC_HOST=$(value_of "$IDENTITY_ENV" KC_HOSTNAME)
DSH_HOST=$(value_of "$SINGLE_ENV" DSH_HOSTNAME)
ISSUER=$(value_of "$SINGLE_ENV" OIDC_ISSUER_URL)
AUTHORITY=$(value_of "$SINGLE_ENV" GATEWAY_ALLOWED_AUTHORITIES)

printf '  [info] Keycloak origin: %s\n' "$KC_HOST"
printf '  [info] Harness hostname: %s\n' "$DSH_HOST"
printf '  [info] OIDC issuer: %s\n' "$ISSUER"

# The issuer must be the Keycloak origin plus /realms/<realm>. Any drift here is
# the single most common cause of "oidc: issuer did not match".
case "$ISSUER" in
  "$KC_HOST"/realms/*) pass 'OIDC issuer is built from the Keycloak origin' ;;
  *) fail "OIDC issuer ($ISSUER) does not start with the Keycloak origin ($KC_HOST)/realms/" ;;
esac

# The gateway authority must equal the Harness hostname, or every request is 421.
if [ "$AUTHORITY" = "$DSH_HOST" ]; then
  pass 'gateway authority matches the Harness hostname'
else
  fail "gateway authority ($AUTHORITY) differs from the Harness hostname ($DSH_HOST)"
fi

# This iteration is a LOCAL lab: names must be the .local lab names, not the
# corporate placeholders that do not resolve.
case "$DSH_HOST" in
  *.local) pass "Harness hostname is a local lab name ($DSH_HOST)" ;;
  *.corp.example) fail "Harness hostname still the corporate placeholder ($DSH_HOST); it does not resolve locally" ;;
  *) printf '  [info] Harness hostname is neither .local nor the placeholder: %s\n' "$DSH_HOST" ;;
esac
case "$KC_HOST" in
  *keycloak.local*) pass "Keycloak origin is the local lab origin" ;;
  *id.corp.example*) fail 'Keycloak origin still the corporate placeholder; it does not resolve locally' ;;
  *) printf '  [info] Keycloak origin: %s\n' "$KC_HOST" ;;
esac

section '5. Realm file name matches the realm inside it'
REALM_DIR="$REPO_ROOT/deploy/identity/config"
found=0
for realm_file in "$REALM_DIR"/*-realm.json; do
  [ -f "$realm_file" ] || continue
  found=1
  base=$(basename "$realm_file")
  expected=${base%-realm.json}
  actual=$(sed -n 's/.*"realm"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$realm_file" | head -1)
  if [ "$expected" = "$actual" ]; then
    pass "$base contains realm '$actual' (name matches)"
  else
    fail "$base contains realm '$actual'; Keycloak refuses this with 'File name / realm name mismatch' and the correct name is $actual-realm.json"
  fi
done
[ "$found" -eq 1 ] || fail 'no *-realm.json file in deploy/identity/config'

section '6. Import strategy cannot destroy an existing realm'
COMPOSE="$REPO_ROOT/deploy/identity/compose.yaml"
if [ -f "$COMPOSE" ]; then
  if grep -q 'IGNORE_EXISTING' "$COMPOSE"; then
    pass 'compose pins the import strategy to IGNORE_EXISTING'
  else
    fail 'compose does not pin the import strategy; the Keycloak default OVERWRITE_EXISTING deletes the realm on every restart'
  fi
  if grep -qE '^KC_IMPORT_STRATEGY=IGNORE_EXISTING' "$IDENTITY_ENV" 2>/dev/null; then
    pass 'env template defaults the import strategy to IGNORE_EXISTING'
  else
    fail 'env template does not default KC_IMPORT_STRATEGY to IGNORE_EXISTING'
  fi
else
  fail 'deploy/identity/compose.yaml is missing'
fi

section '7. oauth2-proxy admission settings are consistent with the realm'
O2P="$REPO_ROOT/deploy/single-user/oauth2-proxy/oauth2-proxy.cfg"
if [ -f "$O2P" ]; then
  # The group must match the mapper's claim format exactly.
  mapper_path=$(sed -n 's/.*"full.path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REALM_DIR"/*-realm.json | head -1)
  allowed_group=$(sed -n 's/^allowed_groups[[:space:]]*=[[:space:]]*\["\([^"]*\)"\].*/\1/p' "$O2P" | head -1)
  if [ -z "$allowed_group" ]; then
    fail 'oauth2-proxy has no allowed_groups; admission would rest on the gateway alone'
  elif [ "$mapper_path" = "false" ] && [ "${allowed_group#/}" != "$allowed_group" ]; then
    fail "allowed_groups ($allowed_group) has a leading slash but the mapper uses full.path=false, so the claim has none — this denies everyone"
  elif [ "$mapper_path" = "true" ] && [ "${allowed_group#/}" = "$allowed_group" ]; then
    fail "allowed_groups ($allowed_group) lacks a leading slash but the mapper uses full.path=true, so the claim has one — this denies everyone"
  else
    pass "allowed_groups ($allowed_group) matches the mapper format (full.path=$mapper_path)"
  fi

  # Email-file admission must not be presented as the subject control.
  if grep -qE '^authenticated_emails_file' "$O2P"; then
    fail 'authenticated_emails_file is active; it matches EMAIL, not sub, so it cannot enforce a subject allowlist'
  else
    pass 'no email-file admission is claimed as the subject control'
  fi

  # TLS verification must never be relaxed.
  if grep -qE 'insecure_oidc_skip_issuer_verification[[:space:]]*=[[:space:]]*true' "$O2P"; then
    fail 'issuer verification is disabled'
  else
    pass 'issuer verification stays enabled'
  fi
  if grep -qE '^provider_ca_files' "$O2P"; then
    pass 'a provider CA is configured, so verification can stay on against the local CA'
  else
    fail 'no provider_ca_files: keycloak.local cannot be verified, which invites disabling TLS verification'
  fi
else
  fail 'oauth2-proxy.cfg is missing'
fi

printf '\n== Summary\n'
printf '  passed: %d\n  failed: %d\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then printf '\nenv template checks FAILED\n'; exit 1; fi
printf '\nenv template checks passed (offline)\n'
exit 0
