FROM ghcr.io/yc-software/qm/core@sha256:5624e031ecbd00799040d3f614b9d70aee266895ecaf07a980357169054f51b7
COPY --chown=node:node src/api/routes/deployments.ts /app/src/api/routes/deployments.ts
