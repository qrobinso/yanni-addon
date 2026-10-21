# Built by .github/workflows/release.yml (one image per arch, pushed to GHCR; config.yaml `image:`). The build
# context is this folder after scripts/stage-addon.sh has staged the bundled server, the web app and the models into
# rootfs/app (gitignored). Everything staged is plain JavaScript, so the same steps serve aarch64 and amd64.
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
