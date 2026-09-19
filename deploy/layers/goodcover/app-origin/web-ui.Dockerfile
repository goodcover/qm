FROM ghcr.io/yc-software/qm/web-ui@sha256:8065caa09146a0b7af81f810d4e773bc839cfc94f3e08200075aa5986db143a4
COPY --chown=node:node plugins/web-ui/server/index.ts /app/server/index.ts
