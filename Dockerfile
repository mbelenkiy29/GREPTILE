# syntax=docker/dockerfile:1
# Optional build secret `extra_ca`: a PEM bundle to trust when installs go
# through a TLS-intercepting proxy. Empty (unused) by default.
FROM node:22-alpine AS base
WORKDIR /app
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm install -g pnpm@10.28.0

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Workspace packages' manifests, so the lockfile's importers match (pnpm workspace).
COPY packages/mcp/package.json packages/mcp/
COPY packages/cli/package.json packages/cli/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/cli/node_modules ./packages/cli/node_modules
COPY . .
RUN pnpm build

# Background worker (indexing, reviews, mention answers). Needs git for repository checkouts.
FROM base AS worker
RUN apk add --no-cache git
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/cli/node_modules ./packages/cli/node_modules
COPY . .
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data/repos && chown app:app /data/repos
USER app
CMD ["node_modules/.bin/tsx", "worker/index.ts"]

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/drizzle ./drizzle
USER app
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
