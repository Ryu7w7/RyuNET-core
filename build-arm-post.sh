#!/bin/bash

echo "Compressing"

rm -f ./build/asphyxia-core-armv7.zip
cd build
zip -qq asphyxia-core-armv7.zip asphyxia-core-armv7
cd ..
zip -qq ./build/asphyxia-core-armv7.zip -r plugins

rm -f ./build/asphyxia-core-arm64.zip
cd build
zip -qq asphyxia-core-arm64.zip asphyxia-core-arm64
cd ..
zip -qq ./build/asphyxia-core-arm64.zip -r plugins
