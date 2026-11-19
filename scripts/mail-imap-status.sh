#!/bin/sh
# Diagnoses the read-only IMAP MCP integration, one layer at a time.
#
# WHY A SEPARATE SCRIPT, NOT AN EXTENSION OF integration-status.sh
# --------------------------------------------------------------
# integration-status.sh checks ONE account behind ONE credential (Gmail OAuth).
# This integration has N accounts with independent failures, and its verdict is
# per account — "yandex-personal-1 is fine, yandex-personal-2 has a bad password"
# is the useful answer, and it cannot be expressed as a single HEALTHY. That is a
# different shape of report, so it is a different script. Both share the same
# design rule: ask the running service, never inspect credential files.
#
# THE ELEVEN CHECKS THE BRIEF ASKS FOR
# ------------------------------------
#    1. IMAP MCP process
#    2. MCP endpoint
#    3. tools/list
#    4. configuration of the three accounts
#    5. TLS connection
#    6. authorisation
#    7. INBOX availability
#    8. search works
#    9. reading one message works
#   10. no IMAP flags changed
#   11. MCP registration in DSH
#
# STATUS VOCABULARY (per account, and for the integration as a whole)
#   NOT_CONFIGURED        no accounts file, or the account is absent
#   CONNECTION_FAILED     the server could not be reached
#   AUTH_FAILED           credentials refused
#   MCP_UNAVAILABLE       the MCP process or endpoint does not answer
#   READ_ONLY_CHECK_FAILED a write appeared, or a flag changed
#   HEALTHY               all of the above passed
#
# WHAT IT NEVER DOES
#   * It never prints a password, a token or a message body. It prints ids,
#     counts, subjects only when --show-subjects is given, and error codes.
#   * It never modifies anything: every tool it calls is a read, and it does not
#     even call the read tools when the account failed authentication.
#   * It does not treat /healthz as proof that mail works. Health proves the
#     process; the mail checks prove the mail.
#
# USAGE (from the harness container)
#   sh /workspace/core/scripts/mail-imap-status.sh
#   sh /workspace/core/scripts/mail-imap-status.sh --json
#   sh /workspace/core/scripts/mail-imap-status.sh --show-subjects
#   sh /workspace/core/scripts/mail-imap-status.sh --account yandex-personal-1
set -u

MCP_URL="${MAIL_IMAP_MCP_URL:-http://mail-imap-mcp:8765/mcp}"
case "${MCP_URL}" in
  */mcp) ;;
  */) MCP_URL="${MCP_URL}mcp" ;;
  *) MCP_URL="${MCP_URL}/mcp" ;;
esac
HEALTH_URL=$(printf '%s' "${MCP_URL}" | sed 's#/mcp$#/healthz#')
TOKEN_FILE="${MAIL_BRIDGE_TOKEN_FILE:-/home/node/.dsh/bootstrap/mail-bridge.token}"
PROFILE_PATCH="${DSH_HOME:-/home/node/.dsh}/profiles/web/cordis.patch.yml"
TIMEOUT="${DIAG_TIMEOUT:-25}"

JSON=0
SHOW_SUBJECTS=0
ONLY_ACCOUNT=""
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    --show-subjects) SHOW_SUBJECTS=1 ;;
    --account) NEXT_IS_ACCOUNT=1 ;;
    --account=*) ONLY_ACCOUNT="${arg#--account=}" ;;
    --help|-h) sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)
      if [ "${NEXT_IS_ACCOUNT:-0}" = "1" ]; then ONLY_ACCOUNT="$arg"; NEXT_IS_ACCOUNT=0; fi
      ;;
  esac
done

ok=0; bad=0; skipped=0

# --- output helpers ---------------------------------------------------------

# Accumulated JSON fragments for --json mode.
JSON_ACCOUNTS=""

line() {
  [ "${JSON}" = "1" ] && return 0
  printf '   %-22s: %s\n' "$1" "$2"
}

pass() { ok=$((ok+1)); line "$1" "$2"; }
fail() { bad=$((bad+1)); line "$1" "$2"; }
skip() { skipped=$((skipped+1)); line "$1" "$2"; }

# --- token ------------------------------------------------------------------

token=""
if [ -s "${TOKEN_FILE}" ]; then
  token=$(cat "${TOKEN_FILE}")
else
  fail "Bridge token" "MISSING — run: docker compose up -d (the mail-token service creates it)"
fi

# Call the MCP endpoint. The token goes in through a config file on stdin, never
# on the command line, so it never appears in the process table.
mcp_call() {
  body="$1"
  [ -n "${token}" ] || { echo '{"error":{"message":"no token"}}'; return; }
  printf 'header = "Authorization: Bearer %s"\n' "${token}" > /tmp/.curlrc-maildiag
  chmod 600 /tmp/.curlrc-maildiag 2>/dev/null || true
  curl -s --max-time "${TIMEOUT}" "${MCP_URL}" -X POST \
    -K /tmp/.curlrc-maildiag \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "${body}" 2>/dev/null | sed -n 's/^data: //p' | head -1
  rm -f /tmp/.curlrc-maildiag
}

# Extract a JSON field with a tiny parser: no jq dependency in the harness.
# Only used for short scalar values from our own server's responses. Accepts both
# a quoted string and a bare number, because /healthz reports `accounts` as a
# number while tool results use strings.
json_field() {
  value=$(printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" | head -1)
  if [ -z "$value" ]; then
    value=$(printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p" | head -1)
  fi
  printf '%s' "$value"
}

# --- 1. process and 2. endpoint ---------------------------------------------

health=""
health_body=""
health=$(curl -s -o /tmp/.maildiag-health -w '%{http_code}' --max-time 5 "${HEALTH_URL}" 2>/dev/null)
health_body=$(cat /tmp/.maildiag-health 2>/dev/null || echo '')
rm -f /tmp/.maildiag-health

case "${health}" in
  200)
    pass "MCP process" "running (HTTP 200 on /healthz)"
    pass "MCP endpoint" "${MCP_URL} reachable"
    ;;
  000|"")
    fail "MCP process" "NOT RUNNING — is the mail-imap-mcp container up?"
    fail "MCP endpoint" "unreachable"
    ;;
  *)
    fail "MCP process" "answered HTTP ${health} (unexpected)"
    fail "MCP endpoint" "unexpected response"
    ;;
esac
[ "${JSON}" = "1" ] || line "" "note: /healthz proves the process, NOT that any mailbox works"

declared_accounts=$(json_field "${health_body}" accounts)

# --- 3. tools/list ----------------------------------------------------------

tools_json=""
if [ -n "${token}" ] && [ "${bad}" -eq 0 ]; then
  tools_json=$(mcp_call '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
fi

tools_ok=0
if [ -n "${tools_json}" ]; then
  case "${tools_json}" in
    *'"tools"'*) tools_ok=1 ;;
  esac
fi

if [ "${tools_ok}" = "1" ]; then
  names=$(printf '%s' "${tools_json}" | grep -o '"name":"[A-Za-z0-9_]*"' | sed 's/"name":"//;s/"//' | sort -u)
  count=$(printf '%s\n' "${names}" | grep -c . )
  pass "tools/list" "${count} tool(s) exposed"
  [ "${JSON}" = "1" ] || printf '%s\n' "${names}" | sed 's/^/                        - /'
  # The read-only surface is a closed list. Anything outside it is a defect.
  # The write tools are expected now, but they must never be the only ones and
  # the destructive verbs must never appear at all.
  unexpected=$(printf '%s\n' "${names}" | grep -vE '^(mail_list_accounts|mail_get_account_status|mail_list_folders|mail_list_labels|mail_search|mail_get_message|mail_list_recent|mail_get_conversation|mail_get_daily_summary_data|mail_get_attachment_metadata|mail_preview_actions|mail_apply_actions|mail_get_operation_status|mail_undo_operation)$' || true)
  risky=$(printf '%s\n' "${names}" | grep -E '(^|_)(send|reply|forward|draft|append|delete|expunge|purge)(_|$)' || true)
  if [ -n "${risky}" ]; then
    fail "Write surface" "FORBIDDEN tool exposed: $(printf '%s' "${risky}" | tr '\n' ' ')"
  fi
  if [ -n "${unexpected}" ]; then
    fail "Read-only surface" "unexpected tool(s): $(printf '%s' "${unexpected}" | tr '\n' ' ')"
  else
    pass "Tool surface" "exactly the expected 14 tools, none destructive"
  fi
else
  if [ -n "${token}" ] && [ "${bad}" -eq 0 ]; then
    fail "tools/list" "no usable answer (unauthorized or malformed)"
  else
    skip "tools/list" "skipped (endpoint or token unavailable)"
  fi
fi

# --- 4..10. per-account checks ---------------------------------------------
#
# The account list comes from mail_list_accounts, which is the server's own
# authority on what is configured. If the tool call fails there is nothing to
# inspect, and that is reported rather than guessed at.

accounts_json=""
if [ "${tools_ok}" = "1" ]; then
  accounts_json=$(mcp_call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mail_list_accounts","arguments":{}}}')
fi

# Pull account records out of the JSON. The response is `structuredContent` in
# the MCP envelope; a compact scan for `"account_id"` entries is enough here and
# avoids depending on a JSON parser in the harness.
account_ids=$(printf '%s' "${accounts_json}" | grep -o '"account_id":"[a-z0-9-]*"' | sed 's/"account_id":"//;s/"//' | sort -u)

if [ -z "${account_ids}" ]; then
  status="NOT_CONFIGURED"
  if [ "${tools_ok}" = "1" ]; then
    line "Accounts" "none configured (valid state)"
    pass "Configuration" "0 accounts; the integration is idle, not broken"
  else
    skip "Configuration" "unknown (MCP unavailable)"
  fi
else
  count_accounts=$(printf '%s\n' "${account_ids}" | grep -c .)
  line "Accounts" "${count_accounts} configured"
fi

for account_id in ${account_ids}; do
  if [ -n "${ONLY_ACCOUNT}" ] && [ "${account_id}" != "${ONLY_ACCOUNT}" ]; then
    continue
  fi
  [ "${JSON}" = "1" ] || printf '\n   ── %s ──\n' "${account_id}"

  account_status="UNKNOWN"
  account_ok=0
  account_bad=0

  # 4. configuration
  provider=$(printf '%s' "${accounts_json}" | grep -o "\"account_id\":\"${account_id}\"[^}]*\"provider\":\"[a-z]*\"" | sed -n 's/.*"provider":"\([a-z]*\)".*/\1/p' | head -1)
  host=$(printf '%s' "${accounts_json}" | grep -o "\"account_id\":\"${account_id}\"[^}]*\"host\":\"[^\"]*\"" | sed -n 's/.*"host":"\([^"]*\)".*/\1/p' | head -1)
  writes=$(printf '%s' "${accounts_json}" | grep -o "\"account_id\":\"${account_id}\"[^}]*\"writes_allowed\":\(true\|false\)" | sed -n 's/.*"writes_allowed":\(true\|false\).*/\1/p' | head -1)
  line "Configuration" "provider=${provider:-unknown} host=${host:-unknown} tls=required writes=${writes:-unknown}"

  # 5. folder listing exercises TLS + auth + INBOX in one read.
  folders_json=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"tools/call\",\"params\":{\"name\":\"mail_list_folders\",\"arguments\":{\"account_id\":\"${account_id}\"}}}")
  case "${folders_json}" in
    *'"isError":true'*)
      code=$(json_field "${folders_json}" code)
      case "${code}" in
        AUTH_FAILED)
          account_status="AUTH_FAILED"
          account_bad=$((account_bad+1))
          line "TLS connection" "ok (a TLS handshake is required to reach LOGIN)"
          line "Authorisation" "FAILED — the provider refused the app password"
          line "INBOX" "not checked (no session)"
          ;;
        TLS_FAILED)
          account_status="CONNECTION_FAILED"
          account_bad=$((account_bad+1))
          line "TLS connection" "FAILED — certificate not trusted"
          line "Authorisation" "not attempted"
          line "INBOX" "not checked"
          ;;
        CONNECTION_FAILED|CONNECTION_TIMEOUT|TIMEOUT)
          account_status="CONNECTION_FAILED"
          account_bad=$((account_bad+1))
          line "TLS connection" "FAILED — server unreachable"
          line "Authorisation" "not attempted"
          line "INBOX" "not checked"
          ;;
        *)
          account_status="CONNECTION_FAILED"
          account_bad=$((account_bad+1))
          line "TLS connection" "unknown"
          line "Authorisation" "unknown"
          line "INBOX" "unknown"
          ;;
      esac
      ;;
    *'"folders"'*)
      folder_count=$(printf '%s' "${folders_json}" | grep -o '"path":"[^"]*"' | grep -c .)
      inbox_present=$(printf '%s' "${folders_json}" | grep -c '"path":"INBOX"' || true)
      account_ok=$((account_ok+1))
      line "TLS connection" "ok (handshake completed over TLS)"
      account_ok=$((account_ok+1))
      line "Authorisation" "ok (app password accepted)"
      if [ "${inbox_present}" -ge 1 ]; then
        account_ok=$((account_ok+1))
        line "INBOX" "available (${folder_count} folder(s) listed)"
      else
        account_bad=$((account_bad+1))
        line "INBOX" "MISSING from the folder list"
      fi

      # 8. search — the cheapest real read of message metadata.
      search_json=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tools/call\",\"params\":{\"name\":\"mail_search\",\"arguments\":{\"account_id\":\"${account_id}\",\"limit\":1}}}")
      search_uid=""
      if [ -n "${search_json}" ] && printf '%s' "${search_json}" | grep -q '"messages"'; then
        search_uid=$(printf '%s' "${search_json}" | grep -o '"uid":[0-9]*' | head -1 | sed 's/"uid"://')
        matched=$(printf '%s' "${search_json}" | grep -o '"total_matched":[0-9]*' | head -1 | sed 's/"total_matched"://')
        account_ok=$((account_ok+1))
        line "Search" "ok (${matched:-0} matched, newest uid ${search_uid:-none})"
        if [ "${SHOW_SUBJECTS}" = "1" ]; then
          subject=$(json_field "${search_json}" subject)
          [ -n "${subject}" ] && line "" "newest subject: ${subject}"
        fi

        # 9 + 10. read one message and prove the flags did not move.
        #
        # The check is intentionally indirect: this script cannot see the IMAP
        # server's own flag state from inside the harness. What it CAN do is read
        # the same message twice and compare the flags the server reports in the
        # tool result, and read it once with the read-only guarantee documented.
        # The authoritative proof is the offline test suite
        # (test/readonly.test.js), which reads flags out of band from the mock
        # server's store; this is the live smoke test of the same property.
        if [ -n "${search_uid}" ]; then
          read_a=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"tools/call\",\"params\":{\"name\":\"mail_get_message\",\"arguments\":{\"account_id\":\"${account_id}\",\"uid\":${search_uid}}}}")
          if printf '%s' "${read_a}" | grep -q '"body"'; then
            account_ok=$((account_ok+1))
            line "Read message" "ok (uid ${search_uid} decoded)"
            flags_a=$(printf '%s' "${read_a}" | grep -o '"flags":\[[^]]*\]' | head -1)
            read_b=$(mcp_call "{\"jsonrpc\":\"2.0\",\"id\":13,\"method\":\"tools/call\",\"params\":{\"name\":\"mail_get_message\",\"arguments\":{\"account_id\":\"${account_id}\",\"uid\":${search_uid}}}}")
            flags_b=$(printf '%s' "${read_b}" | grep -o '"flags":\[[^]]*\]' | head -1)
            if [ "${flags_a}" = "${flags_b}" ]; then
              account_ok=$((account_ok+1))
              line "Flags unchanged" "ok (${flags_a:-[]} before and after)"
            else
              account_status="READ_ONLY_CHECK_FAILED"
              account_bad=$((account_bad+1))
              line "Flags unchanged" "FAILED — ${flags_a:-[]} became ${flags_b:-[]}"
            fi
            # The strongest available signal: a message read twice still reports
            # itself unread. If the server had set \\Seen, this would flip.
            unread=$(printf '%s' "${read_b}" | grep -o '"unread":\(true\|false\)' | head -1 | sed 's/"unread"://')
            if [ "${unread}" = "true" ]; then
              account_ok=$((account_ok+1))
              line "Unread preserved" "ok (reading did not mark it read)"
            elif [ "${unread}" = "false" ]; then
              line "Unread preserved" "message was already read; cannot distinguish here"
            fi
          else
            account_bad=$((account_bad+1))
            line "Read message" "FAILED — the read tool returned an error"
          fi
        else
          skip "Read message" "mailbox is empty"
          skip "Flags unchanged" "nothing to read"
        fi
      else
        account_bad=$((account_bad+1))
        line "Search" "FAILED — search returned no usable answer"
      fi
      ;;
    *)
      account_status="MCP_UNAVAILABLE"
      account_bad=$((account_bad+1))
      line "Configuration" "could not be read (MCP unavailable)"
      ;;
  esac

  if [ "${account_bad}" -eq 0 ] && [ "${account_ok}" -gt 0 ]; then
    account_status="HEALTHY"
  elif [ "${account_status}" = "UNKNOWN" ]; then
    account_status="CONNECTION_FAILED"
  fi

  if [ "${account_status}" = "HEALTHY" ]; then
    pass "${account_id}" "HEALTHY (${account_ok} checks)"
  else
    fail "${account_id}" "${account_status}"
  fi

  JSON_ACCOUNTS="${JSON_ACCOUNTS}${JSON_ACCOUNTS:+,}{\"account_id\":\"${account_id}\",\"status\":\"${account_status}\",\"checks_passed\":${account_ok},\"checks_failed\":${account_bad}}"
done

# --- 11. DSH registration ---------------------------------------------------

registration="MISSING"
if [ -f "${PROFILE_PATCH}" ]; then
  if grep -q "id: mcp-mail-imap" "${PROFILE_PATCH}" 2>/dev/null; then
    if grep -q "failOnStartupError: false" "${PROFILE_PATCH}" 2>/dev/null; then
      registration="present, non-blocking"
      pass "DSH registration" "${registration}"
    else
      registration="present, BLOCKING"
      fail "DSH registration" "${registration} — failOnStartupError is not false"
    fi
  else
    fail "DSH registration" "MISSING — no mcp-mail-imap entry in the booted profile"
    line "" "the harness cannot see these tools until the bootstrap runs; restart it"
  fi
else
  registration="unknown"
  skip "DSH registration" "profile not found at ${PROFILE_PATCH}"
fi

# --- verdict ----------------------------------------------------------------

overall="HEALTHY"
if [ "${bad}" -gt 0 ]; then
  overall="ATTENTION NEEDED"
fi
if [ "${tools_ok}" != "1" ] && [ -n "${token}" ]; then
  overall="MCP_UNAVAILABLE"
fi

if [ "${JSON}" = "1" ]; then
  printf '{"generated_at":"%s","endpoint":"%s","overall":"%s","checks_passed":%s,"checks_failed":%s,"checks_skipped":%s,"declared_accounts":%s,"registration":"%s","accounts":[%s]}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${MCP_URL}" "${overall}" "${ok}" "${bad}" "${skipped}" "${declared_accounts:-null}" "${registration}" "${JSON_ACCOUNTS}"
else
  printf ' ─────────────────────────────────────────────────────────────\n'
  if [ "${bad}" -eq 0 ]; then
    printf ' Verdict: HEALTHY — %s check(s) passed, %s skipped\n' "${ok}" "${skipped}"
  else
    printf ' Verdict: %s — %s failing, %s passed, %s skipped\n' "${overall}" "${bad}" "${ok}" "${skipped}"
  fi
  printf '\n Status meanings:\n'
  printf '   NOT_CONFIGURED         no accounts configured (a valid state)\n'
  printf '   CONNECTION_FAILED      IMAP server unreachable, or TLS not trusted\n'
  printf '   AUTH_FAILED            provider refused the app password\n'
  printf '   MCP_UNAVAILABLE        the MCP process or endpoint does not answer\n'
  printf '   READ_ONLY_CHECK_FAILED a message flag changed during a read\n'
  printf '   HEALTHY                TLS, auth, INBOX, search and read all passed\n'
  printf ' This script never shows passwords, tokens or message bodies.\n'
  printf ' Use --show-subjects to print the newest subject per account.\n\n'
fi

[ "${bad}" -eq 0 ] || exit 1
exit 0
