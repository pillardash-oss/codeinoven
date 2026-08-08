FROM oven/bun:1.3.10-alpine

WORKDIR /app
COPY services/remote-control/package.json services/remote-control/bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY services/remote-control/*.ts ./

ENV HOST=0.0.0.0
ENV PORT=8877
ENV REMOTE_DATABASE_PATH=/data/remote-control.sqlite

RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun

EXPOSE 8877
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const response = await fetch('http://127.0.0.1:8877/healthz'); if (!response.ok) process.exit(1)"]

CMD ["bun", "server.ts"]
