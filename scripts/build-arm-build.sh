#!/bin/bash

# yao-pkg-fetch fetches Node 22 base binaries from the GitHub release
# matching the requested target. armv7 prebuilds may be missing for the
# latest Node — if so, this build will fail at the fetch step and the
# armv7 target needs to be skipped or a custom prebuild dropped at
# ~/.pkg-cache.

echo "Packing arm64"
node ./node_modules/@yao-pkg/pkg/lib-es5/bin.js ./build-env -t node22-linux-arm64 -o ./build/asphyxia-core-arm64 --options "no-warnings,experimental-sqlite"

echo "Packing armv7"
node ./node_modules/@yao-pkg/pkg/lib-es5/bin.js ./build-env -t node22-linux-armv7 -o ./build/asphyxia-core-armv7 --options "no-warnings,experimental-sqlite" || \
  echo "(armv7 prebuild not available for Node 22; skipping)"
