# The add-on folder is the build context (HA builds it on the device). It holds no sources: run
# scripts/stage-addon.sh first, which bundles the server (one ESM file, deps included) and copies the built web app
# into rootfs/app. Everything staged is plain JavaScript, so the same image works on aarch64 and amd64.
FROM node:24-alpine

COPY rootfs /

ENV NODE_ENV=production \
    WEB_ROOT=/app/web \
    OWNER_ROOT=/app/public \
    DATA_DIR=/data \
    SSL_DIR=/ssl

# init: true (the default) gives the container an init process, so SIGTERM reaches node.
CMD ["/run.sh"]

LABEL \
    io.hass.type="app" \
    org.opencontainers.image.title="Yanni" \
    org.opencontainers.image.source="https://github.com/qrobinso/yanni-addon"
