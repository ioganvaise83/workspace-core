#!/bin/sh
# Mints the shared bridge token on the dsh-home volume, if absent.
#
# Why this is a separate service: compose starts `gmail-mcp` before `harness`
# (harness depends_on gmail), but the token is stored on the dsh-home volume
# that both share. If the harness bootstrap minted it, gmail-mcp would start
# first, find no token and exit 1 on the very first `docker compose up`.
#
# Minting here makes the token independent of start order, and `restart:
# unless-stopped` on gmail-mcp is then never needed to paper over the race.
#
# Idempotent: an existing token is left untouched, so the harness and the
# integration keep agreeing across restarts and `--build`.
set -eu

TOKEN_DIR="${TOKEN_DIR:-/dsh-home/bootstrap}"
TOKEN_FILE="${TOKEN_DIR}/${TOKEN_NAME:-gmail-bridge.token}"

mkdir -p "$TOKEN_DIR"
chmod 0700 "$TOKEN_DIR" 2>/dev/null || true

if [ -s "$TOKEN_FILE" ]; then
  echo "bridge token already present at $TOKEN_FILE"
  exit 0
fi

# 32 random bytes as 64 hex chars; no dependency on node.
if command -v openssl >/dev/null 2>&1; then
  token=$(openssl rand -hex 32)
else
  token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
fi

# Write-then-rename so a concurrent reader never sees a partial token.
# The temp name is unique per process: with a shared name two simultaneous
# starts would race on the same temp file and one `mv` would fail.
umask 077
tmp="${TOKEN_FILE}.tmp.$$"
printf '%s\n' "$token" > "$tmp"
mv "$tmp" "$TOKEN_FILE"
chmod 0600 "$TOKEN_FILE"

echo "minted bridge token at $TOKEN_FILE"
