# Контекст збірки — корінь репозиторію (npm workspaces).
FROM node:22-slim AS base
RUN npm install -g npm@11.21.0
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --workspace @tickets/web --include-workspace-root

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/web apps/web
ENV NEXT_OUTPUT=standalone
RUN npm run build -w @tickets/web

FROM node:22-slim AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
