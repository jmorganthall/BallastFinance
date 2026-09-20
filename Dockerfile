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
# The build needs a DATABASE_URL present but never connects to it.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV AUTH_SECRET=build-time-placeholder
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

RUN addgroup -g 1001 -S nodejs && adduser -S ballast -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=ballast:nodejs /app/.next/standalone ./
COPY --from=builder --chown=ballast:nodejs /app/.next/static ./.next/static

# Migrations and the seed script ship with the image so a deploy can run them.
COPY --from=builder --chown=ballast:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=ballast:nodejs /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder --chown=ballast:nodejs /app/scripts ./scripts
COPY --from=builder --chown=ballast:nodejs /app/src/db ./src/db

USER ballast
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/sign-in').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
