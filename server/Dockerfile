FROM node:20-alpine AS deps
WORKDIR /app
# Pull in patched Alpine packages (e.g. OpenSSL CVEs) at build time rather
# than trusting the base image tag's own build date.
RUN apk update && apk upgrade --no-cache
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Same OS-package patching as the deps stage, applied here since this is
# the stage that actually ships. Also strips the npm/npx/corepack/yarn CLIs
# bundled in the base image — this container only ever runs `node
# src/server.js`, never npm, but the base image's global npm install still
# vendors its own copies of tar/glob/minimatch/cross-spawn/sigstore/
# ip-address/etc. Those tools' CVEs have no way to be reached by this app,
# but scanners (rightly) still flag whatever bytes are sitting in the
# image, so removing the unused CLI removes the findings along with it.
RUN apk update && apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
