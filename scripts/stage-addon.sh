#!/bin/sh
# Builds the web app and the server, then stages them into addon/rootfs/app (the add-on's Docker build context
# holds no sources). Run before tagging a release; commit addon/rootfs/app with it.
set -eu
cd "$(dirname "$0")/.."
out=addon/rootfs/app
npm run build -w web
npm run bundle -w server
rm -rf "$out"
mkdir -p "$out"
cp server/dist-bundle/main.js "$out/main.js"
cp -R server/public "$out/public"
cp -R web/dist "$out/web"
echo "staged into $out"
