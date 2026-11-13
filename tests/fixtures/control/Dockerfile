FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs ./
ARG FIXTURE_VERSION=v1
ARG SOURCE_COMMIT=local
ARG GIT_SHA=local
ENV FIXTURE_VERSION=$FIXTURE_VERSION SOURCE_COMMIT=$SOURCE_COMMIT GIT_SHA=$GIT_SHA PORT=8080
RUN mkdir -p /data
EXPOSE 8080
HEALTHCHECK --interval=3s --timeout=2s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
