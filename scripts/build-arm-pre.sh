#!/bin/bash
cd "$(dirname "$0")/.." || exit

mkdir -p build

regex='VERSION = '"'"'([a-z0-9.]*)'"'"''
[[ $(cat ./src/utils/Consts.ts) =~ $regex ]]

VERSION=${BASH_REMATCH[1]}

echo "Building Version $VERSION for Arm"

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

# Inject *.node and *.dat into pkg.assets so @yao-pkg/pkg extracts native binaries at runtime
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('./package.json')); p.pkg.assets=p.pkg.assets||[]; p.pkg.assets.push('./*.node'); p.pkg.assets.push('./*.dat'); fs.writeFileSync('./package.json', JSON.stringify(p,null,2))"

# Copy icudtl.dat (Skia Unicode data required by @napi-rs/canvas text rendering)
# ARM uses linux-arm64-gnu or linux-arm-gnueabihf depending on arch
for ICU_SRC in ../node_modules/@napi-rs/canvas-linux-arm64-gnu/icudtl.dat ../node_modules/@napi-rs/canvas-linux-arm-gnueabihf/icudtl.dat; do
  if [ -f "$ICU_SRC" ]; then
    cp "$ICU_SRC" ./icudtl.dat
    echo "Copied icudtl.dat from $ICU_SRC"
    break
  fi
done
