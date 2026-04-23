# syntax=docker/dockerfile:1.7
# Multi-stage ARM64 build for the dashboard-listen-relay Fargate task.
# Target: 0.25 vCPU / 0.5 GB (see 03-RESEARCH.md §13).

FROM --platform=linux/arm64 node:22.12-alpine3.20 AS build
WORKDIR /repo
RUN apk add --no-cache libc6-compat \
  && corepack enable \
  && corepack prepare pnpm@9.12.0 --activate

# Copy workspace manifests first for layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/dashboard-listen-relay/package.json services/dashboard-listen-relay/

# Install only what @kos/dashboard-listen-relay needs (incl. transitive workspace deps).
RUN pnpm install --frozen-lockfile --filter @kos/dashboard-listen-relay...

# Copy sources for compilation.
COPY packages/contracts packages/contracts
COPY services/dashboard-listen-relay services/dashboard-listen-relay

# Bundle relay app + workspace deps into a single ESM file via esbuild.
# Externalize npm runtime deps so they're loaded from node_modules at runtime
# (avoids issues bundling native modules like pg, dynamic AWS SDK requires).
# Workspace deps (@kos/contracts) are inlined since their package.json
# points main/exports at .ts source files which Node can't load natively.
RUN cd services/dashboard-listen-relay \
  && pnpm exec esbuild src/index.ts \
       --bundle \
       --platform=node \
       --target=node22 \
       --format=esm \
       --outfile=dist/bundle.mjs \
       --external:fastify \
       --external:pg \
       --external:pg-listen \
       --external:@aws-sdk/* \
  && cd /repo \
  && pnpm deploy --filter @kos/dashboard-listen-relay --prod /out

FROM --platform=linux/arm64 node:22.12-alpine3.20 AS runtime
WORKDIR /app
RUN addgroup -S kos && adduser -S kos -G kos
COPY --from=build --chown=kos:kos /out /app
COPY --from=build --chown=kos:kos /repo/services/dashboard-listen-relay/dist/bundle.mjs /app/dist/bundle.mjs
USER kos
ENV NODE_ENV=production TZ=UTC PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/bundle.mjs"]
