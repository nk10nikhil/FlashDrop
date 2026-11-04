FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && useradd --system --uid 10001 --create-home flashdrop
COPY --from=build --chown=flashdrop:flashdrop /app ./
USER flashdrop
EXPOSE 3000 9464
CMD ["node", "--import", "apps/api/dist/instrumentation.js", "apps/api/dist/server.js"]
