#!/bin/bash
cd "$(dirname "$0")/.."

mkdir -p build

regex='VERSION = '"'"'([a-z0-9.]*)'"'"''
[[ $(cat ./src/utils/Consts.ts) =~ $regex ]]

VERSION=${BASH_REMATCH[1]}

echo "Building Version $VERSION for Linux"

echo "NPM Install"
npm ci --include=dev --legacy-peer-deps

echo "Building Typescripts"
npx tsc

echo "Packing index.js"
node ./node_modules/@vercel/ncc/dist/ncc/cli.js build ./dist/AsphyxiaCore.js -o ./build-env --external pug --external ts-node

echo "Setting Up Build Environment"
cd ./build-env
npm ci --include=dev --legacy-peer-deps
cp -r typescript ./node_modules/

echo "Packing binaries"
cd ..
# Node 22 is the floor for node:sqlite; the experimental-sqlite flag is
# baked into the snapshot via --options so end users don't need to know.
node ./node_modules/@yao-pkg/pkg/lib-es5/bin.js ./build-env -t node22-linux-x64 -o ./build/asphyxia-core --options "no-warnings,experimental-sqlite"

echo "Compressing"

rm -f ./build/asphyxia-core-linux-x64.zip
cd build
zip -qq asphyxia-core-linux-x64.zip asphyxia-core
cd ..
zip -qq ./build/asphyxia-core-linux-x64.zip -r plugins
