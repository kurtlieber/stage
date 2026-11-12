# syntax=docker/dockerfile:1
# Stage as a shared server. One image, two processes on one data folder:
#   serve --root /data --listen 0.0.0.0:4747      the viewer (the default)
#   mcp --http 0.0.0.0:4748 --root /data          the MCP server
# Scenes live at /data/<project>/<variant>/scene.json. Set STAGE_ALLOWED_HOSTS
# to the host names a proxy sends, STAGE_PUBLIC_URL to the viewer's address as
# people reach it, and STAGE_VIEWER_URL to the viewer's address as the MCP
# container reaches it. See docs/server.md.
ARG NODE_IMAGE=node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
# Chromium renders and exports. Docker's default seccomp profile refuses the
# namespaces Chromium's sandbox needs, so it runs without one here; the
# container is the boundary, and the only page it loads is Stage's own viewer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    STAGE_CHROMIUM=/usr/bin/chromium \
    STAGE_CHROMIUM_FLAGS="--no-sandbox --disable-dev-shm-usage" \
    XDG_CACHE_HOME=/data/.cache
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/bin ./bin
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY --from=build /app/examples ./examples
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4747 4748
ENTRYPOINT ["node", "/app/bin/stage.js"]
CMD ["serve", "--root", "/data", "--listen", "0.0.0.0:4747"]
