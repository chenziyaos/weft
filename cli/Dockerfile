# Local stdio MCP server, built from this repository's source.
# Build from the repository root: docker build -f cli/Dockerfile -t weft-mcp .
# Only the packed CLI reaches the final image: no repository files,
# credentials, or session logs are copied into it.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund && npm run cli:pack

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
COPY --from=build /src/cli/weft-canvas-*.tgz /tmp/
RUN npm install --global --ignore-scripts --no-audit --no-fund /tmp/weft-canvas-*.tgz \
    && rm /tmp/weft-canvas-*.tgz && npm cache clean --force

ENV WEFT_HOME=/home/node/.weft \
    WEFT_SESSION_ROOTS=/data/sessions \
    WEFT_CANVAS_ROOTS=/data/canvases \
    WEFT_MEMORY_ROOTS=""

USER node
WORKDIR /home/node
ENTRYPOINT ["weft"]
CMD ["mcp"]
