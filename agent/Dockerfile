# Operator agent image. Build context = REPO ROOT (mirrors web/provisioner) so the
# `@moltentech/protocol` file:../protocol dep and the arcane-mage submodule are in
# scope. The real executor (src/executor.ts) shells out to the `arcane-mage` CLI, so
# the image bundles Python 3.13 + arcane-mage exactly like apps/provisioner/Dockerfile.
#
#   docker build -f agent/Dockerfile -t moltentech-agent .

# Stage 1: Install Python 3.13 + arcane-mage (with CLI)
FROM python:3.13-slim-bookworm AS python-base

RUN apt-get update && apt-get install -y --no-install-recommends gcc make libc6-dev && \
    rm -rf /var/lib/apt/lists/*

COPY arcane-mage/ /opt/arcane-mage/

RUN pip install --no-cache-dir "/opt/arcane-mage/[cli]"

# Stage 2: Node.js runtime + Python from stage 1
FROM node:22-bookworm-slim

# libssl3 needed by Python's _ssl module for HTTPS connections to Proxmox
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 libgomp1 && \
    rm -rf /var/lib/apt/lists/*

# Copy Python installation + the arcane-mage CLI from stage 1
COPY --from=python-base /usr/local/lib/python3.13 /usr/local/lib/python3.13
COPY --from=python-base /usr/local/bin/python3* /usr/local/bin/
COPY --from=python-base /usr/local/bin/arcane-mage /usr/local/bin/
COPY --from=python-base /usr/local/lib/libpython3* /usr/local/lib/
RUN ldconfig

WORKDIR /app

# Install both package roots so the file:../protocol symlink resolves AND protocol's
# own deps (zod) are present — node_modules is stripped from the context by
# .dockerignore, so we reproduce the host layout (protocol beside agent).
COPY protocol/package.json protocol/package-lock.json* ./protocol/
RUN cd protocol && npm install --no-audit --no-fund
COPY agent/package.json agent/package-lock.json* ./agent/
RUN cd agent && npm install --no-audit --no-fund

# Source last (keeps the dep layers cached)
COPY protocol/ ./protocol/
COPY agent/ ./agent/

WORKDIR /app/agent
# tsx runtime (npm start = tsx src/index.ts); outbound-only control loop, no ports.
CMD ["npm", "start"]
