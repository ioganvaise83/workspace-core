# Read-only multi-account IMAP MCP server.
#
# Node 22 is the floor: the code uses `node --test` with ESM, `fetch` and modern
# `TextDecoder` charsets, and imapflow/simpleParser both require >= 20. Pinning a
# major rather than a patch keeps the base image current while the two libraries
# that matter (imapflow, mailparser) are pinned exactly in package.json.
#
# CREDENTIAL ISOLATION, IN FOUR PLACES
# ------------------------------------
#  1. No account credentials exist in this image. They arrive as a read-only bind
#     mount of accounts.json plus one secret file per account, and nowhere else.
#  2. `npm ci` runs at build time against the committed lock file, so the image
#     is reproducible and no install-time network access happens at run time.
#  3. The container runs as `node` (uid 1000), read-only root filesystem, with
#     every capability dropped (see compose.yaml).
#  4. Nothing in the image writes to disk: the server is stateless, so a read-only
#     root filesystem costs nothing.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    MCP_PORT=8765 \
    MCP_HOST=0.0.0.0 \
    MAIL_IMAP_ACCOUNTS_FILE=/config/accounts.json \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Corporate TLS inspection (Kaspersky, Zscaler, an HTTPS proxy) breaks
# `npm ci` with SELF_SIGNED_CERT_IN_CHAIN unless npm trusts the inspecting CA.
# The certificate arrives as a BuildKit secret, never as COPY or ARG: it is
# mounted for this one RUN and is part of no layer, so `docker history` cannot
# reveal it and the resulting image is identical to one built without it.
#
# TLS verification stays fully enabled; only the trust store gains one root.
# Opt-in without editing this file: the secret source is a zero-byte placeholder
# by default, and the -f/-s test is false for it, so nothing is exported.
#
# Requires BuildKit, which is the default in Docker Desktop and Compose v2.
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=custom-ca,required=false \
    set -eu; \
    if [ -f /run/secrets/custom-ca ] && [ -s /run/secrets/custom-ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/custom-ca; \
      export NODE_EXTRA_CA_CERTS; \
      echo "npm: trusting extra CA from build secret"; \
    fi; \
    npm ci --omit=dev --no-audit --no-fund; \
    npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node entrypoint.sh /app/entrypoint.sh
RUN chmod 0555 /app/entrypoint.sh

USER node

# The port is reachable only from the compose network; compose.yaml publishes
# no host mapping for it.
EXPOSE 8765

# A healthcheck that proves the process serves MCP over HTTP, not that any
# mailbox is reachable. Mailbox state is per account and is reported by the
# integration's own diagnostics, never by this probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8765)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
