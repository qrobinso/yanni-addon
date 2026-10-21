#!/bin/sh
# Builds the web app and the server, then stages them into addon/rootfs/app (the add-on's Docker build context
# holds no sources). Run before tagging a release; commit addon/rootfs/app with it: HA builds the image on the device
# from the git repo, and the display must work offline, so the models and wasm runtimes ship inside it.
set -eu
cd "$(dirname "$0")/.."
out=addon/rootfs/app
# Models + wasm into web/public (idempotent; SHA-256 verified, downloads only what is missing or stale).
node web/scripts/fetch-models.mjs
npm run build -w web
npm run bundle -w server
rm -rf "$out"
mkdir -p "$out"
cp server/dist-bundle/main.js "$out/main.js"
cp -R server/public "$out/public"
cp -R web/dist "$out/web"
# Vite copies web/public into dist; fail if anything the display loads at runtime did not make it.
for f in models/silero_vad.onnx models/smart-turn-v3.2-gpu.onnx models/face_landmarker.task \
  models/hand_landmarker.task models/pose_landmarker_lite.task \
  ort/ort-wasm-simd-threaded.jsep.mjs ort/ort-wasm-simd-threaded.jsep.wasm \
  mediapipe/vision_wasm_module_internal.js mediapipe/vision_wasm_module_internal.wasm; do
  [ -s "$out/web/$f" ] || { echo "stage-addon: missing $out/web/$f" >&2; exit 1; }
done
# The runtime is self-hosted under /ort; a second copy in assets/ means onnxruntime-web's bundle entry crept back in.
if ls "$out"/web/assets/*.wasm >/dev/null 2>&1; then echo "stage-addon: unexpected wasm in $out/web/assets" >&2; exit 1; fi
echo "staged into $out ($(du -sh "$out" | cut -f1))"
