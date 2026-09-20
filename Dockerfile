# Ballast — self-hosted on Unraid (PRD §10).
#
# Multi-stage so the runtime image carries the built server and nothing else:
# no toolchain, no dev dependencies, no source. Runs as a non-root user.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No credentials here on purpose. The database client connects lazily, so the
# build needs neither a real nor a placeholder DATABASE_URL -- and a placeholder
# is exactly the kind of thing that later gets copied into a deployment.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
# The bootstrap is bundled to a single file so the runtime image needs neither
# node_modules nor the drizzle-kit CLI, which is a devDependency: calling the
# CLI at boot would mean fetching it from npm on every container start.
RUN npm run build:bootstrap

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# The git revision this image was built from, so the running app can compare
# itself with the published `latest` and say when a newer one exists. The
# publish workflow passes it; a plain local build leaves it empty and the check
# reports "unavailable" rather than guessing.
ARG GIT_SHA=""
ENV BALLAST_BUILD_SHA=$GIT_SHA

RUN addgroup -g 1001 -S nodejs && adduser -S ballast -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=ballast:nodejs /app/.next/standalone ./
COPY --from=builder --chown=ballast:nodejs /app/.next/static ./.next/static

# Migrations and the bundled bootstrap ship with the image so a first run needs
# no manual steps.
COPY --from=builder --chown=ballast:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=ballast:nodejs /app/dist/bootstrap.mjs ./bootstrap.mjs
COPY --chown=ballast:nodejs docker/entrypoint.sh ./entrypoint.sh

USER ballast
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/sign-in').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
