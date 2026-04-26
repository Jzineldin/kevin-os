# Phase 5 Plan 05-00 scaffold — Baileys WhatsApp gateway container.
# Real Dockerfile body (multi-stage build, EFS mount points, healthcheck,
# non-root user) arrives in Plan 05-04. This shell is here so CDK references
# in subsequent plans resolve to a real path.

FROM node:22-alpine

WORKDIR /app

# Placeholder: Plan 05-04 copies built output + node_modules.
# COPY dist/ ./dist/
# COPY package.json ./

# Plan 05-04: persistent volume mount target for Signal-protocol session keys
# (Baileys pluggable auth provider, backed by `whatsapp_session_keys` table).
# VOLUME ["/app/data"]

CMD ["node", "dist/entrypoint.js"]
