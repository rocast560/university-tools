# syntax=docker/dockerfile:1
# Circuit AI Tool: bun server + kicad-cli in one image.
# Design: docs/superpowers/specs/2026-09-06-docker-design.md

# ---- client: build the web UI ------------------------------------------------
FROM oven/bun:1.3 AS client
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- runtime: KiCad's own image (kicad-cli + symbol libraries) plus bun -------
FROM kicad/kicad:9.0.9 AS runtime
USER root
COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# cloudflared for the Tunnel button. The base image has no curl; bun fetches it.
RUN bun -e "const r = await fetch('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64'); if (!r.ok) throw new Error('cloudflared download failed: ' + r.status); const buf = await r.arrayBuffer(); await Bun.write('/usr/local/bin/cloudflared', buf);" \
 && chmod 755 /usr/local/bin/cloudflared \
 && /usr/local/bin/cloudflared --version
# The base image gives its user passwordless sudo; a web server does not need it.
# Both steps are conditional so a future base image without sudo still builds.
# (Purging the sudo package outright was tried and rejected: apt/dpkg refuses to
# remove it because it is the last configured way to reach root, even non-interactively.)
RUN if id -nG kicad | grep -qw sudo; then gpasswd -d kicad sudo; fi \
 && if [ -f /etc/sudoers ]; then sed -i '/NOPASSWD/d' /etc/sudoers; fi
RUN mkdir -p /app /data /projects && chown kicad:kicad /app /data /projects
USER kicad
WORKDIR /app
COPY --chown=kicad:kicad package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=kicad:kicad tsconfig.json ./
COPY --chown=kicad:kicad server ./server
COPY --chown=kicad:kicad src ./src
COPY --chown=kicad:kicad --from=client /app/dist ./dist
ENV NODE_ENV=production \
    CIRCUIT_HOST=0.0.0.0 \
    CIRCUIT_PORT=8765 \
    CIRCUIT_PUBLIC_URL=http://localhost:8765 \
    KICAD_CLI=/usr/bin/kicad-cli \
    KICAD_SYMBOL_DIR=/usr/share/kicad/symbols \
    KICAD_SYM_LIB_TABLE=/home/kicad/.config/kicad/9.0/sym-lib-table \
    DATA_DIR=/data \
    PROJECTS_DIR=/projects \
    STATIC_DIR=/app/dist \
    CIRCUIT_WATCH_POLL_MS=1000 \
    CIRCUIT_CONTAINER=circuit-ai-tool
VOLUME /data
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.CIRCUIT_PORT ?? 8765) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "server/index.ts"]

# ---- test: typecheck + full suite against the real kicad-cli ------------------
# The suite runs only with --target test:  docker build --target test -t circuit-ai-tool:test .
FROM runtime AS test
COPY --chown=kicad:kicad --from=client /app/node_modules ./node_modules
COPY --chown=kicad:kicad client ./client
COPY --chown=kicad:kicad scripts ./scripts
COPY --chown=kicad:kicad test ./test
COPY --chown=kicad:kicad index.html vite.config.ts ./
RUN bun run typecheck && bun test

# ---- final: default target, so a bare `docker build .` gives the runtime image, not the test image ----
FROM runtime AS final
