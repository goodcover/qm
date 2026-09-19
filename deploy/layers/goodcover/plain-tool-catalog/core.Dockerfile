FROM 008562636938.dkr.ecr.us-west-2.amazonaws.com/goodcover/qm@sha256:c69afe9d90e144d3af6b9e68616f8be2825d7165742430dc872f45a9f4cd772b
COPY --chown=node:node mcp-tool-service.ts /app/src/mcp/mcp-tool-service.ts
