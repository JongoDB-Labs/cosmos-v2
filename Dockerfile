# syntax=docker/dockerfile:1
# --- deps ---
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- build ---
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=4096
# NEXT_PUBLIC_APP_VERSION reads npm_package_version, which is empty under a raw
# `next build`; pass it explicitly so the sidebar version isn't "0.0.0".
ARG APP_VERSION=0.1.0
ENV npm_package_version=$APP_VERSION
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# --- migrate: one-shot job image with the FULL prisma toolchain ---
# The slim standalone runtime omits the `prisma` CLI and its hoisted deps (effect, etc.),
# so migrations run from the build stage (complete node_modules, root → no cache/home EACCES).
# Defined BEFORE runtime so that `docker build` (no --target) defaults to the app runtime.
FROM build AS migrate
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# --- runtime (standalone) — the default build target ---
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 HOME=/home/cosmos
# -m -d gives the non-root user a writable home (prisma/node tooling expect one).
RUN groupadd -r cosmos && useradd -r -g cosmos -m -d /home/cosmos cosmos
# Standalone server + static assets + Prisma engine/migrations for the migrate job.
COPY --from=build --chown=cosmos:cosmos /app/.next/standalone ./
COPY --from=build --chown=cosmos:cosmos /app/.next/static ./.next/static
COPY --from=build --chown=cosmos:cosmos /app/public ./public
COPY --from=build --chown=cosmos:cosmos /app/prisma ./prisma
# node_modules/.prisma holds the generated client + query engine the runtime app needs.
COPY --from=build --chown=cosmos:cosmos /app/node_modules/.prisma ./node_modules/.prisma
USER cosmos
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
