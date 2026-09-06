# syntax=docker/dockerfile:1

# ── build: deps, fonts, client bundle, typst CLI ───────────────────────────
FROM oven/bun:1.3 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# Stage the default fonts (no-op when public/fonts is already in the
# context), typecheck + bundle the client, then precompress the big assets:
# server/static.ts serves a .gz sibling when the browser accepts gzip, so the
# 28 MB compiler wasm is never compressed at request time.
RUN bun scripts/fonts.ts \
 && bun run build \
 && find dist/assets -type f \( -name '*.js' -o -name '*.css' -o -name '*.wasm' \) -exec gzip -9 -k {} \;

# The server-side compiler (MCP PDF export) needs the typst CLI on PATH.
ARG TYPST_VERSION=0.14.2
ADD https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz /tmp/typst.tar.xz
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils && rm -rf /var/lib/apt/lists/* \
 && tar -xJf /tmp/typst.tar.xz -C /tmp \
 && install -m 0755 /tmp/typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst \
 && /usr/local/bin/typst --version

# ── runtime ────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 STATIC_DIR=/app/dist DATA_DIR=/data
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /usr/local/bin/typst /usr/local/bin/typst
COPY tsconfig.json tsconfig.server.json ./
COPY server ./server
COPY src/types.ts src/template.ts ./src/
COPY src/lib ./src/lib
COPY --from=build /app/dist ./dist

RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["bun", "server/index.ts"]
