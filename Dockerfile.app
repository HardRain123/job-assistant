FROM node:24-bookworm-slim AS deps
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install --global pnpm@11.19.0 --registry="$NPM_REGISTRY"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
RUN --mount=type=cache,id=job-assistant-pnpm,target=/pnpm/store,sharing=locked NODE_USE_ENV_PROXY=1 pnpm install --frozen-lockfile --store-dir /pnpm/store --registry="$NPM_REGISTRY"

FROM deps AS build
COPY apps ./apps
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/package.json ./package.json
COPY --from=deps --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/dist/web ./dist/web
RUN mkdir -p /data /attachments /evidence && chown -R node:node /data /attachments /evidence
USER node
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "apps/api/src/index.ts"]
