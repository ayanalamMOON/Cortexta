# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps ./apps
COPY cli ./cli
COPY core ./core
COPY daemon ./daemon
COPY packages ./packages
COPY scripts ./scripts
COPY storage ./storage
COPY config ./config
COPY formats ./formats
COPY types ./types

RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY --from=build /app/storage/sqlite/schema.sql ./storage/sqlite/schema.sql

ENV CORTEXA_DAEMON_PORT=4312
ENV CORTEXA_WS_PORT=4321
ENV CORTEXA_DB_PATH=/var/lib/cortexa/cortexa.db
ENV CORTEXA_VECTOR_PROVIDER=memory
ENV CORTEXA_DAEMON_AUTOSTART=1

RUN useradd --system --create-home --home /var/lib/cortexa --shell /usr/sbin/nologin cortexa
RUN chown -R cortexa:cortexa /var/lib/cortexa /app
USER cortexa

EXPOSE 4312 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:4312/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/daemon/server.js"]
