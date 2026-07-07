#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "Building @elevenlabs/client..."

# Ensure dependencies are installed
npm install

# Build the bundle from local node_modules
npx esbuild node_modules/@elevenlabs/client/dist/index.js --bundle --format=esm --outfile=elevenlabs-client.esm.js

# Remove the window.log global assignment
sed -i 's/window.log = _log;//g' elevenlabs-client.esm.js

echo "Build complete: elevenlabs-client.esm.js"
