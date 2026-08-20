FROM coturn/coturn:4.17.2-r0-alpine

USER root
COPY --chown=nobody:nogroup services/turn/entrypoint.sh /usr/local/bin/codeinoven-turn-entrypoint
RUN apk add --no-cache libcap \
    && setcap -r /usr/bin/turnserver \
    && test -z "$(getcap /usr/bin/turnserver)" \
    && apk del libcap \
    && chmod 0555 /usr/local/bin/codeinoven-turn-entrypoint

USER nobody:nogroup

ENV TURN_PORT=3478 \
    TURN_MIN_PORT=49160 \
    TURN_MAX_PORT=49200 \
    TURN_REALM=turn.codeinoven.com \
    TURN_EXTERNAL_IP=auto

EXPOSE 3478/tcp 3478/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD turnutils_stunclient -p "${TURN_PORT}" 127.0.0.1 >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/codeinoven-turn-entrypoint"]
