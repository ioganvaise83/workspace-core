#!/bin/sh
# Starts supergateway in front of the klodr Gmail MCP server.
#
# ACCESS MODEL: gmail.readonly only.
#
# The OAuth token cannot send, label, archive, delete or draft anything: Gmail
# rejects those calls because the token lacks the scope. On top of that, the
# --tools allowlist below removes every write tool from the list the model ever
# sees. The two layers are independent:
#
#   * the scope stops the call even if a tool name is invented;
#   * the allowlist stops the tool from appearing at all.
#
# STARTUP IS NOT GATED ON OAUTH. Without credentials the server still starts and
# answers MCP requests; only calls that need Gmail fail. That keeps the whole
# platform bootable for a user who has not connected Google yet.
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
  echo "gmail-mcp: trusting extra CA from $NODE_EXTRA_CA_CERTS"
fi

# The bridge token is minted by the bootstrap script on the dsh-home volume and
# mounted read-only here. An explicit SUPERGATEWAY_API_KEY wins if provided.
if [ -z "${SUPERGATEWAY_API_KEY:-}" ] && [ -n "${GMAIL_BRIDGE_TOKEN_FILE:-}" ] && [ -r "${GMAIL_BRIDGE_TOKEN_FILE}" ]; then
  SUPERGATEWAY_API_KEY=$(cat "${GMAIL_BRIDGE_TOKEN_FILE}")
  export SUPERGATEWAY_API_KEY
fi

if [ -z "${SUPERGATEWAY_API_KEY:-}" ]; then
  echo "FATAL: no bridge token; set SUPERGATEWAY_API_KEY or provide GMAIL_BRIDGE_TOKEN_FILE." >&2
  exit 1
fi

# Read-only surface. Everything that writes is absent on purpose, including
# modify_email / batch_modify_emails / modify_thread (label application) and
# create_label / update_label / delete_label (label management).
TOOLS="search_emails read_email get_thread list_inbox_threads \
get_inbox_with_threads list_email_labels download_attachment"

set -- --stdio "gmail-mcp" \
       --outputTransport streamableHttp \
       --port "$MCP_PORT" \
       --host "$MCP_HOST" \
       --streamableHttpPath /mcp \
       --healthEndpoint /healthz \
       --logLevel info

for tool in $TOOLS; do
  set -- "$@" --tools "$tool"
done

mkdir -p "$GMAIL_MCP_STATE_DIR" "$GMAIL_MCP_DOWNLOAD_DIR" "$GMAIL_MCP_ATTACHMENT_DIR"

exec supergateway "$@"
