#!/bin/sh
# Approve one mail-organisation plan, from the HOST, outside the agent's reach.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# An agent that can decide "the user approved this" is not gated by anything. The
# only way an approval means something is if producing it requires access the
# agent does not have. The harness container has no host access, no docker socket,
# and no mount of the approval directory, so this script — run by the owner on the
# host — is the one thing that can create an approval.
#
# WHAT IT DOES
# ------------
# Writes one small JSON file next to the plan it approves:
#
#   runtime/mail-imap/state/approvals/approval-<digest>.json
#
# The MCP server consumes it exactly once, only for that digest, and only within
# the approval lifetime. It never contains message content or credentials.
#
# USAGE
#   sh scripts/mail-approve.sh <digest>
#   sh scripts/mail-approve.sh <digest> --by "Ivan" --ttl 600
#
#   <digest>   the 64-character digest printed by mail_preview_actions
#
# Neither the digest nor the file is a secret: the digest identifies a plan, and
# the file only says "the owner looked at this and said yes". That is the point —
# it is a capability to authorise, not a credential to steal.
set -eu

DIGEST="${1:-}"
if [ -z "$DIGEST" ]; then
  printf 'usage: sh %s <digest> [--by NAME] [--ttl SECONDS]\n' "$0" >&2
  printf '\nThe digest is the 64-character value returned by mail_preview_actions.\n' >&2
  exit 2
fi

# A digest is a SHA-256 hex string. Reject anything else before it becomes a path,
# so a crafted value cannot write outside the approval directory.
case "$DIGEST" in
  *[!0-9a-f]*)
    printf 'ERROR: "%s" is not a SHA-256 hex digest.\n' "$DIGEST" >&2
    exit 2
    ;;
esac
if [ "${#DIGEST}" -ne 64 ]; then
  printf 'ERROR: a digest is 64 hex characters; got %s.\n' "${#DIGEST}" >&2
  exit 2
fi

BY="owner"
TTL=600
shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    --by) BY="${2:?--by needs a value}"; shift 2 ;;
    --ttl) TTL="${2:?--ttl needs a value}"; shift 2 ;;
    *) printf 'ERROR: unknown argument "%s"\n' "$1" >&2; exit 2 ;;
  esac
done

case "$TTL" in
  *[!0-9]*|'') printf 'ERROR: --ttl must be a number of seconds.\n' >&2; exit 2 ;;
esac
if [ "$TTL" -lt 30 ] || [ "$TTL" -gt 3600 ]; then
  printf 'ERROR: --ttl must be between 30 and 3600 seconds.\n' >&2
  exit 2
fi

# The directory the server mounts read-write at /state/approvals. Defaults match
# compose.yaml; override with MAIL_APPROVAL_DIR if you moved it.
STATE_DIR="${MAIL_APPROVAL_DIR:-./runtime/mail-imap/state/approvals}"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

FILE="$STATE_DIR/approval-$DIGEST.json"
if [ -e "$FILE" ]; then
  printf 'An approval for this digest already exists:\n  %s\n' "$FILE" >&2
  printf 'It is single-use. Request a fresh preview if you need to approve again.\n' >&2
  exit 1
fi

# Compute the expiry portably. BSD date and GNU date differ, so try GNU first and
# fall back to a POSIX-ish arithmetic form using a single `date` call.
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if EXPIRES=$(date -u -d "+${TTL} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null); then
  :
else
  EXPIRES=$(date -u -r "$(( $(date +%s) + TTL ))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '%s' "$NOW")
fi

# Escape quotes in the free-text approver name so the JSON stays valid.
SAFE_BY=$(printf '%s' "$BY" | sed 's/\\/\\\\/g; s/"/\\"/g')

# Written to a temp file then renamed, so the server never reads a partial file.
TMP="$FILE.tmp.$$"
umask 077
{
  printf '{\n'
  printf '  "digest": "%s",\n' "$DIGEST"
  printf '  "approved_by": "%s",\n' "$SAFE_BY"
  printf '  "approved_at": "%s",\n' "$NOW"
  printf '  "expires_at": "%s"\n' "$EXPIRES"
  printf '}\n'
} > "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$FILE"

printf '\nApproved plan %s\n' "$DIGEST"
printf '  approver : %s\n' "$BY"
printf '  expires  : %s (in %s seconds)\n' "$EXPIRES" "$TTL"
printf '  file     : %s\n' "$FILE"
printf '\nThe server will consume this exactly once, for this digest only.\n'
printf 'If you change your mind, delete the file before the agent applies the plan.\n\n'
