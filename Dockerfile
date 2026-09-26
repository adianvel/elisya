FROM oven/bun:1.3.14-alpine AS app-runtime
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/tasks/package.json ./apps/tasks/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/email/package.json ./packages/email/package.json
COPY packages/logger/package.json ./packages/logger/package.json
COPY packages/storage/package.json ./packages/storage/package.json
RUN bun install --filter @repo/api --filter @repo/tasks --frozen-lockfile --production
COPY apps/api ./apps/api
COPY apps/tasks ./apps/tasks
COPY packages ./packages
COPY tsconfig.json ./tsconfig.json
ENV NODE_ENV=production

FROM app-runtime AS api
EXPOSE 8000
CMD ["bun", "run", "apps/api/src/index.ts"]

FROM app-runtime AS tasks
EXPOSE 8081
CMD ["bun", "run", "apps/tasks/src/index.ts"]

FROM app-runtime AS migrate
CMD ["bun", "run", "packages/db/migrate.ts"]

FROM oven/bun:1.3.14-alpine AS web-build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
ARG APP_URL
ARG API_URL
ARG NUXT_PUBLIC_SITE_URL
ARG NUXT_PUBLIC_API_URL
ENV APP_URL=${APP_URL} \
    API_URL=${API_URL} \
    NUXT_PUBLIC_SITE_URL=${NUXT_PUBLIC_SITE_URL} \
    NUXT_PUBLIC_API_URL=${NUXT_PUBLIC_API_URL} \
    NODE_ENV=production
RUN cd apps/web && bun run build

FROM oven/bun:1.3.14-alpine AS web
WORKDIR /app
COPY --from=web-build /app/apps/web/.output ./.output
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", ".output/server/index.mjs"]
