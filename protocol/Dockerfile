# ghcr.io/w2vy/fh-toolkit — the operator's toolkit as a container, so they can keygen,
# scaffold, sign, check and assemble without installing Node. Published,
# generic, secret-free (the operator's key is generated into their mounted workdir,
# never baked in). Operators pull the published image and run it in their workdir:
#
#   docker run --rm -v "$PWD:/work" ghcr.io/w2vy/fh-toolkit keygen
#   docker run --rm -v "$PWD:/work" ghcr.io/w2vy/fh-toolkit \
#       sign --key manifest-key.pem --from-config config.env --out manifest.json
#
# Build/publish (maintainers):
#   docker build -f protocol/Dockerfile -t ghcr.io/w2vy/fh-toolkit \
#       --build-arg FH_BUILD_SHA="$(git rev-parse HEAD)" \
#       --build-arg FH_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" protocol
FROM node:22-bookworm-slim

WORKDIR /pkg
# Full install (keeps tsx, the TS runtime the CLI runs under).
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY src/ ./src/

# Build identity, so `fh-toolkit version` can say which commit is answering. The publish
# workflow feeds these; a local `docker build` leaves them empty and the CLI says
# "source checkout" rather than inventing a SHA. Last, so a rebuild at a new SHA reuses
# every layer above.
ARG FH_BUILD_SHA=""
ARG FH_BUILD_TIME=""
ENV FH_BUILD_SHA=$FH_BUILD_SHA \
    FH_BUILD_TIME=$FH_BUILD_TIME

# Operators mount their template checkout here; relative paths (config.env,
# manifest-key.pem, manifest.json) resolve against it.
WORKDIR /work
ENTRYPOINT ["/pkg/node_modules/.bin/tsx", "/pkg/src/cli.ts"]
