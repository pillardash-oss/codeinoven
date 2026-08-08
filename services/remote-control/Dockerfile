FROM oven/bun:1.3.10-alpine

WORKDIR /app
COPY services/remote-control ./services/remote-control

ENV HOST=0.0.0.0
ENV PORT=8877
ENV REMOTE_DATABASE_PATH=/data/remote-control.sqlite

RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun

EXPOSE 8877
VOLUME ["/data"]
CMD ["bun", "services/remote-control/server.ts"]
