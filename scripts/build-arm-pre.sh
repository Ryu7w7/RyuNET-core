#!/bin/bash
cd "$(dirname "$0")/.." || exit

mkdir -p build

regex='VERSION = '"'"'([a-z0-9.]*)'"'"''
[[ $(cat ./src/utils/Consts.ts) =~ $regex ]]

VERSION=${BASH_REMATCH[1]}

echo "Building Version $VERSION for Arm"

echo "NPM Install"
npm ci --legacy-peer-deps

echo "Building Typescripts"
npx tsc

echo "Packing index.js"
node ./node_modules/@vercel/ncc/dist/ncc/cli.js build ./dist/AsphyxiaCore.js -o ./build-env --external pug --external ts-node

echo "Setting Up Build Environment"
cd ./build-env
npm ci --legacy-peer-deps
cp -r typescript ./node_modules/

