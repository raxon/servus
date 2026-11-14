FROM docker:29-cli AS docker-cli

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/panel/package.json ./apps/panel/package.json
COPY apps/website/package.json ./apps/website/package.json
RUN npm ci --workspace=@servus/panel --include-workspace-root=false --no-audit --no-fund
COPY apps/panel ./apps/panel
ARG SERVUS_BUILD_VERSION=unknown
ARG SERVUS_BUILD_REVISION=unknown
RUN node apps/panel/src/server/write-build-info.mjs apps/panel/package.json apps/panel/src/server/generated-build-info.ts
RUN npm run build --workspace=@servus/panel && npm prune --omit=dev --workspace=@servus/panel --include-workspace-root=false --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PANEL_DATA_DIR=/var/lib/panel PANEL_HOST=0.0.0.0 PANEL_PORT=4180
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates util-linux diffutils && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/panel/dist ./dist
COPY deployment/lifecycle-gate.sh /app/lifecycle-gate.sh
COPY package.json ./
COPY LICENSE ./
RUN mkdir -p /var/lib/panel && chown -R node:node /var/lib/panel
USER node
EXPOSE 4180
CMD ["node", "dist/server/index.js"]
