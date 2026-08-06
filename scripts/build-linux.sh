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

# Inject *.node into pkg.assets so @yao-pkg/pkg extracts native binaries at runtime
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('./package.json')); p.pkg.assets=p.pkg.assets||[]; p.pkg.assets.push('./*.node'); p.pkg.assets.push('./*.dat'); fs.writeFileSync('./package.json', JSON.stringify(p,null,2))"

# Copy icudtl.dat (Skia Unicode data required by @napi-rs/canvas text rendering)
ICU_SRC="../node_modules/@napi-rs/canvas-linux-x64-gnu/icudtl.dat"
if [ -f "$ICU_SRC" ]; then
  cp "$ICU_SRC" ./icudtl.dat
  echo "Copied icudtl.dat to build-env"
else
  echo "WARNING: icudtl.dat not found, text rendering in Discord bot may crash"
fi



echo "Packing binaries"
cd ..
# Node 22 is the floor for node:sqlite; the experimental-sqlite flag is
# baked into the snapshot via --options so end users don't need to know.
node ./node_modules/@yao-pkg/pkg/lib-es5/bin.js ./build-env -t node22-linux-x64 -o ./build/asphyxia-core --options "no-warnings,experimental-sqlite"

echo "Compressing"

# Copy icudtl.dat to build output so it sits next to the binary
[ -f ./build-env/icudtl.dat ] && cp ./build-env/icudtl.dat ./build/icudtl.dat

rm -f ./build/asphyxia-core-linux-x64.zip
cd build
zip -qq asphyxia-core-linux-x64.zip asphyxia-core
[ -f icudtl.dat ] && zip -qq asphyxia-core-linux-x64.zip icudtl.dat
cd ..
zip -qq ./build/asphyxia-core-linux-x64.zip -r plugins
