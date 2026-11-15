# Gmail MCP: @klodr/gmail-mcp (stdio) behind supergateway (stdio -> Streamable HTTP)
#
# Node 24 is required: @klodr/gmail-mcp declares engines node >=24.18.1.
# Both package versions are pinned because the tool surface and the allowlist in
# entrypoint.sh were verified against exactly these releases.
FROM node:24-bookworm-slim

ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install --global --no-audit --no-fund \
      @klodr/gmail-mcp@3.0.0 \
      supergateway@4.2.2 \
 && npm cache clean --force

USER node
WORKDIR /home/node

# OAuth material is bind-mounted read-only at run time; it never enters the image.
ENV GMAIL_OAUTH_PATH=/home/node/.gmail-mcp/gcp-oauth.keys.json \
    GMAIL_CREDENTIALS_PATH=/home/node/.gmail-mcp/credentials.json \
    GMAIL_MCP_STATE_DIR=/home/node/state \
    GMAIL_MCP_DOWNLOAD_DIR=/home/node/downloads \
    GMAIL_MCP_ATTACHMENT_DIR=/home/node/attachments \
    GMAIL_MCP_EXPORT_REMOTE_IMAGES=false \
    MCP_PORT=8765

COPY --chown=node:node entrypoint.sh /home/node/entrypoint.sh
RUN chmod 0555 /home/node/entrypoint.sh

EXPOSE 8765

ENTRYPOINT ["/home/node/entrypoint.sh"]
