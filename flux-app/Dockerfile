# Operator Flux App image (inbound leg). Build context = REPO ROOT so the
# `@moltentech/protocol` file:../protocol dep is in scope. Node-only (no Python /
# arcane-mage — this leg never touches Proxmox). Stateless; the signed manifest is
# mounted at runtime via MANIFEST_PATH, the secrets come from env.
#
#   docker build -f flux-app/Dockerfile -t moltentech-flux-app .

FROM node:22-bookworm-slim

WORKDIR /app

# Install both package roots so file:../protocol resolves + protocol's own deps (zod)
# are present. node_modules is stripped from the context by .dockerignore.
COPY protocol/package.json protocol/package-lock.json* ./protocol/
RUN cd protocol && npm install --no-audit --no-fund
COPY flux-app/package.json flux-app/package-lock.json* ./flux-app/
RUN cd flux-app && npm install --no-audit --no-fund

COPY protocol/ ./protocol/
COPY flux-app/ ./flux-app/

WORKDIR /app/flux-app
EXPOSE 8088
# tsx runtime (npm start = tsx src/index.ts)
CMD ["npm", "start"]
