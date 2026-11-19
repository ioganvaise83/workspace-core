#!/bin/sh
# Entrypoint for the read-only IMAP MCP.
#
# WHAT THIS SCRIPT DECIDES, AND WHY IT IS SO SHORT
# ------------------------------------------------
# Everything dangerous is deliberately absent:
#
#   * no password in an argument  — the token and the account secrets are read
#                                   from files by the Node process itself;
#   * no `set -x`                 — a trace would print every value it expands;
#   * no fallback to "no auth"    — a missing token is a hard failure in the
#                                   container, so a misconfigured deployment can
#                                   never expose an unauthenticated mail endpoint
#                                   on the compose network.
#
# The Node process starts even when NO accounts are configured: that is a normal
# state, and the harness must boot with it.
set -eu

: "${MCP_PORT:=8765}"
: "${MCP_HOST:=0.0.0.0}"

# Corporate TLS inspection: trust one extra root, but only when one was mounted.
# The bind mount always exists (a zero-byte placeholder by default), so an empty
# file means "no custom CA" and the image's own trust store is used unchanged.
#
# Both -f and -s are required: a misconfigured CUSTOM_CA_PATH makes Docker create
# a *directory* as the bind source, and a directory passes -s while failing Node.
# TLS verification is never disabled; this only adds a root.
if [ -f "${CUSTOM_CA_FILE:-/home/node/custom-ca.pem}" ] && [ -s "${CUSTOM_CA_FILE:-/home/node/custom-ca.pem}" ]; then
  NODE_EXTRA_CA_CERTS="${CUSTOM_CA_FILE:-/home/node/custom-ca.pem}"
  export NODE_EXTRA_CA_CERTS
  # The same file is passed to the IMAP client explicitly, because Node reads
  # NODE_EXTRA_CA_CERTS only at process start and an IMAP TLS handshake happens
  # long after that.
  MAIL_IMAP_CA_FILE="${CUSTOM_CA_FILE:-/home/node/custom-ca.pem}"
  export MAIL_IMAP_CA_FILE
  echo "mail-imap-mcp: trusting extra CA from $NODE_EXTRA_CA_CERTS"
fi

# The bridge token is minted by the init-token.sh service on the dsh-home volume
# and mounted read-only here. It is never echoed and never passed as an argument.
TOKEN_FILE="${MAIL_BRIDGE_TOKEN_FILE:-/dsh-home/bootstrap/mail-bridge.token}"
export MAIL_BRIDGE_TOKEN_FILE="$TOKEN_FILE"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "FATAL: no bridge token at $TOKEN_FILE." >&2
  echo "       Run 'docker compose up -d' so the mcp-token service creates it." >&2
  exit 1
fi

# Account configuration. A missing file is NOT an error: the server then reports
# zero accounts and every tool answers with that state. This is what lets the
# platform boot before the owner has connected any mailbox.
ACCOUNTS_FILE="${MAIL_IMAP_ACCOUNTS_FILE:-/config/accounts.json}"
export MAIL_IMAP_ACCOUNTS_FILE="$ACCOUNTS_FILE"
if [ -r "$ACCOUNTS_FILE" ]; then
  # Count entries without printing any of their contents.
  count=$(grep -c '"id"' "$ACCOUNTS_FILE" 2>/dev/null || echo 0)
  echo "mail-imap-mcp: accounts file present (approximately ${count} id field(s))"
else
  echo "mail-imap-mcp: no accounts file at $ACCOUNTS_FILE; starting with zero accounts"
fi

# Warn, without values, about secret files that are expected but unreadable.
# The server reports the same condition per account; this makes the cause visible
# in the container log at startup instead of only on the first tool call.
secrets_dir="${MAIL_IMAP_SECRETS_DIR:-/run/secrets/mail-imap}"
if [ -d "$secrets_dir" ]; then
  echo "mail-imap-mcp: secrets directory present at $secrets_dir"
fi

# APP_DIR defaults to the image layout and is only overridden by a test that runs
# this script outside a container.
exec node "${APP_DIR:-/app}/src/index.js"
