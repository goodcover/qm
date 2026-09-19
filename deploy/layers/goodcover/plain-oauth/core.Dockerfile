FROM 008562636938.dkr.ecr.us-west-2.amazonaws.com/goodcover/qm@sha256:3ee6165463233c000df1b59586af949fe9565c65347c500263a44659b6c63dac
COPY --chown=node:node src/connectors/oauth.ts /app/src/connectors/oauth.ts
COPY --chown=node:node src/mcp/mcp-server-store.ts /app/src/mcp/mcp-server-store.ts
COPY --chown=node:node src/mcp/mcp-tool-service.ts /app/src/mcp/mcp-tool-service.ts
COPY --chown=node:node src/api/routes/admin/mcp-servers.ts /app/src/api/routes/admin/mcp-servers.ts
COPY --chown=node:node src/wiring.ts /app/src/wiring.ts
