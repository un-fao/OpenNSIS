# =============================================================================
# Build stage — Parcel produces a static SPA in /app/dist
# =============================================================================
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
# No package-lock.json checked in, so use `install` rather than `ci`.
RUN npm install --no-audit --no-fund

COPY src ./src
COPY public ./public

# Build args become inlined at build time via Parcel's process.env.* substitution.
ARG API_URL=http://localhost
ARG API_KEY
ARG MAPSERVER_URL=http://localhost/mapserver
ENV NODE_ENV=production

RUN echo "API_URL=${API_URL}" > .env && \
    echo "API_KEY=${API_KEY}" >> .env && \
    echo "MAPSERVER_URL=${MAPSERVER_URL}" >> .env

# --no-source-maps keeps originals out of the production bundle.
# --no-cache: parcel's on-disk (lmdb) cache can deadlock the process on exit
# inside docker build — and a one-shot build has no use for it anyway.
RUN npx parcel build src/index.html src/site.html --public-url ./ --no-source-maps --no-cache

# =============================================================================
# Runtime stage — unprivileged nginx (uid 101) serves the static dist/
# =============================================================================
FROM nginxinc/nginx-unprivileged:1.27-alpine

# Replace the default server block with our SPA-friendly config.
COPY nginx-static.conf /etc/nginx/conf.d/default.conf

# Copy only the built artifacts — no node_modules, no source, no parcel cache.
COPY --from=builder --chown=101:101 /app/dist /usr/share/nginx/html

EXPOSE 8000
