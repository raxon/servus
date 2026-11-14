FROM node:24-bookworm-slim AS dependencies
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/panel/package.json ./apps/panel/package.json
COPY apps/website/package.json ./apps/website/package.json
RUN npm ci --workspace=@servus/panel --include-workspace-root=false --no-audit --no-fund && npm prune --omit=dev --workspace=@servus/panel --include-workspace-root=false --no-audit --no-fund

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY --from=dependencies /build/node_modules /app/node_modules
COPY package.json /app/package.json
COPY panel-dist /app/dist
COPY apps/updater /work/apps/updater
COPY tests/updater/test_backup.py /work/tests/updater/test_backup.py
