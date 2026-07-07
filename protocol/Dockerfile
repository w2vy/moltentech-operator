# ghcr.io/w2vy/mt-manifest — the operator's manifest signing tool as a container, so
# they can keygen + render/sign their manifest without installing Node. Published,
# generic, secret-free (the operator's key is generated into their mounted workdir,
# never baked in). Operators pull the published image and run it in their workdir:
#
#   docker run --rm -v "$PWD:/work" ghcr.io/w2vy/mt-manifest keygen
#   docker run --rm -v "$PWD:/work" ghcr.io/w2vy/mt-manifest \
#       sign --key manifest-key.pem --from-config config.env --out manifest.json
#
# Build/publish (maintainers):
#   docker build -f protocol/Dockerfile -t ghcr.io/w2vy/mt-manifest protocol
FROM node:22-bookworm-slim

WORKDIR /pkg
# Full install (keeps tsx, the TS runtime the CLI runs under).
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY src/ ./src/

# Operators mount their template checkout here; relative paths (config.env,
# manifest-key.pem, manifest.json) resolve against it.
WORKDIR /work
ENTRYPOINT ["/pkg/node_modules/.bin/tsx", "/pkg/src/cli.ts"]
