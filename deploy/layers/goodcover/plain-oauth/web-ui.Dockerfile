FROM 008562636938.dkr.ecr.us-west-2.amazonaws.com/goodcover/qm@sha256:c7cf46e996f5d84e7506686d7000d8a4232c62bd314732c2178b4dfee982f963
COPY --chown=node:node plugins/admin/src/index.ts /admin/src/index.ts
