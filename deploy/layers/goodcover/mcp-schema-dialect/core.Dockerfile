FROM 008562636938.dkr.ecr.us-west-2.amazonaws.com/goodcover/qm@sha256:86e3ab2ce65ffd1431bf01fff964577e06ccf5bd3b833fa13769c2e9413d8388
COPY --chown=node:node claude-harness.ts /app/src/harness/claude-harness.ts
