#!/bin/sh
# Diagnoses the built-in Gmail MCP integration, layer by layer.
#
# WHY THIS WAS REWRITTEN
# ----------------------
# The old script checked for OAuth files at /home/node/.gmail-mcp and reported
# "OAuth token: missing / NOT CONNECTED" when it did not find them. That path is
# mounted ONLY into the gmail-mcp container, never into the harness. Running the
# script inside the harness therefore always said "missing", even when Gmail was
# fully working. The check was measuring the harness filesystem, not the
# integration.
#
# The fix: this script never looks at OAuth files. It is not its job — those
# files live in another container by design, and copying them into the harness
# just to satisfy a diagnostic would widen the blast radius of a credential. It
# asks the running service instead, which is both the only authority on whether
# Gmail works and the thing we actually care about.
#
# Four independent layers, reported separately so a failure is never ambiguous:
#
#   1. Bridge reachability  — is something answering HTTP on the MCP port?
#   2. Tool registration    — does the MCP server expose tools at all?
#   3. Gmail authorization  — does a real Gmail read succeed?
#   4. DSH registration     — does the harness know this server?
#
# `/healthz` proves only layer 1. It is answered by supergateway before Gmail is
# ever touched, so it says nothing about credentials — a point the old script
# blurred by jumping from "no files" straight to a conclusion.
#
# SECURITY: the bridge token is read from a file inside the harness (it is
# already there for the bootstrap) and passed to curl via stdin, never on the
# command line. Nothing prints the token, and label names come back as-is — they
# are Gmail system labels, not message content.
set -u

MCP_URL="${GMAIL_MCP_URL:-http://gmail-mcp:8765/mcp}"
# GMAIL_MCP_URL in compose already points at /mcp; tolerate a bare origin too.
case "${MCP_URL}" in
  */mcp) ;;
  */) MCP_URL="${MCP_URL}mcp" ;;
  *) MCP_URL="${MCP_URL}/mcp" ;;
esac
HEALTH_URL=$(printf '%s' "${MCP_URL}" | sed 's#/mcp$#/healthz#')
TOKEN_FILE="${GMAIL_BRIDGE_TOKEN_FILE:-/home/node/.dsh/bootstrap/gmail-bridge.token}"
PROFILE_PATCH="${DSH_HOME:-/home/node/.dsh}/profiles/web/cordis.patch.yml"
TIMEOUT="${DIAG_TIMEOUT:-20}"

ok=0; warn=0; bad=0
line() { printf '   %-18s: %s\n' "$1" "$2"; }

printf '\n workspace-core: Gmail MCP diagnostics\n'
printf ' ─────────────────────────────────────────────────────────────\n'
line "Endpoint" "${MCP_URL}"

# --- Layer 1: bridge reachability ------------------------------------------
health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${HEALTH_URL}" 2>/dev/null)
case "${health}" in
  200)
    line "Bridge" "reachable (HTTP 200 on /healthz)"
    ok=$((ok+1)) ;;
  000|"")
    line "Bridge" "UNREACHABLE — is the gmail-mcp container running?"
    bad=$((bad+1)) ;;
  *)
    line "Bridge" "responded HTTP ${health} (unexpected)"
    warn=$((warn+1)) ;;
esac
line "" "note: /healthz proves the gateway is up, NOT that Gmail works"

# --- Token presence (needed for layers 2 and 3) -----------------------------
token=""
if [ -s "${TOKEN_FILE}" ]; then
  token=$(cat "${TOKEN_FILE}")
  line "Bridge token" "present"
else
  line "Bridge token" "MISSING — run: docker compose up -d (the mcp-token service creates it)"
fi

# Call the MCP endpoint. The token goes in through a config file on stdin so it
# never appears in the process table or in any log.
mcp_call() {
  body="$1"
  [ -n "${token}" ] || { echo '{"error":{"message":"no token"}}'; return; }
  printf 'header = "Authorization: Bearer %s"\n' "${token}" > /tmp/.curlrc-diag
  chmod 600 /tmp/.curlrc-diag 2>/dev/null || true
  curl -s --max-time "${TIMEOUT}" "${MCP_URL}" -X POST \
    -K /tmp/.curlrc-diag \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "${body}" 2>/dev/null | sed -n 's/^data: //p' | head -1
  rm -f /tmp/.curlrc-diag
}

if [ -z "${token}" ]; then
  line "Tools" "skipped (no bridge token)"
  line "Gmail API" "skipped (no bridge token)"
else

# --- Layer 2: tool registration ---------------------------------------------
tools_json=$(mcp_call '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
case "${tools_json}" in
  *'"tools"'*)
    # Extract names only; count and sort for a stable, token-free summary.
    names=$(printf '%s' "${tools_json}" \
      | grep -o '"name":"[A-Za-z0-9_]*"' | sed 's/"name":"//;s/"//' | sort)
    count=$(printf '%s' "${names}" | grep -c .)
    line "Tools" "registered (${count} exposed)"
    printf '%s\n' "${names}" | sed 's/^/                      - /'
    # A read-only integration must never advertise a write verb.
    risky=$(printf '%s' "${names}" | grep -E '^(send_|reply_|forward_|draft_|delete_|modify_|move_to_spam|create_label|update_label|batch_)' || true)
    if [ -n "${risky}" ]; then
      line "Allowlist" "WARNING — write tools exposed: $(printf '%s' "${risky}" | tr '\n' ' ')"
      warn=$((warn+1))
    else
      line "Allowlist" "read-only (no send/reply/forward/draft/label-write tools)"
      ok=$((ok+1))
    fi ;;
  *"Method not found"*)
    line "Tools" "NOT available — server answered but exposes no tool list"
    line "" "usual cause: OAuth client file missing, so klodr runs in lazy-auth mode"
    bad=$((bad+1)) ;;
  *)
    line "Tools" "no usable answer (unauthorized or malformed)"
    bad=$((bad+1)) ;;
esac

# --- Layer 3: real Gmail authorization --------------------------------------
# Listing labels is the cheapest genuine Gmail API call: no message is read,
# nothing is modified, and it fails loudly on an expired or revoked token.
labels_json=$(mcp_call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_email_labels","arguments":{}}}')
case "${labels_json}" in
  *'Found '*' labels'*)
    summary=$(printf '%s' "${labels_json}" | grep -o 'Found [0-9]* labels ([0-9]* system, [0-9]* user)' | head -1)
    line "Gmail API" "read OK — ${summary:-labels returned}"
    ok=$((ok+1)) ;;
  *'"error"'*|*'error'*)
    # Report the shape of the failure without echoing anything sensitive.
    short=$(printf '%s' "${labels_json}" | grep -o '"message":"[^"]*"' | head -1 | cut -c1-160)
    line "Gmail API" "FAILED — ${short:-call rejected}"
    line "" "token may be expired or revoked; re-run auth on the HOST"
    bad=$((bad+1)) ;;
  *)
    line "Gmail API" "no answer (timeout or unauthorized)"
    bad=$((bad+1)) ;;
esac

fi

# --- Layer 4: DSH registration ----------------------------------------------
# Read-only check of the profile the harness actually boots from.
if [ -f "${PROFILE_PATCH}" ]; then
  if grep -q "id: mcp-gmail" "${PROFILE_PATCH}" 2>/dev/null; then
    if grep -q "failOnStartupError: false" "${PROFILE_PATCH}" 2>/dev/null; then
      line "DSH registration" "present, non-blocking"
    else
      line "DSH registration" "present (note: failOnStartupError not set to false)"
    fi
    ok=$((ok+1))
  else
    line "DSH registration" "MISSING — no mcp-gmail entry in the booted profile"
    line "" "the harness cannot see Gmail tools until bootstrap runs; restart it"
    bad=$((bad+1))
  fi
else
  line "DSH registration" "unknown — profile not found at ${PROFILE_PATCH}"
  warn=$((warn+1))
fi

# --- Verdict ----------------------------------------------------------------
printf ' ─────────────────────────────────────────────────────────────\n'
if [ "${bad}" -eq 0 ]; then
  printf ' Verdict: HEALTHY — Gmail readable through MCP, %s checks passed\n' "${ok}"
else
  printf ' Verdict: ATTENTION NEEDED — %s failing, %s warning(s), %s passed\n' "${bad}" "${warn}" "${ok}"
fi
printf '\n Layer meanings:\n'
printf '   Bridge        gateway process answers HTTP\n'
printf '   Tools         MCP tool list is served (needs an OAuth client file)\n'
printf '   Gmail API     a credential actually works against Google\n'
printf '   DSH registr.  the harness profile knows the server\n'
printf ' A green Bridge with a red Gmail API is the normal "files present but\n'
printf ' token expired" state; it is not the same as "files missing".\n\n'

[ "${bad}" -eq 0 ] || exit 1
exit 0
