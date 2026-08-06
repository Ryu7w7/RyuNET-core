# Getting version
Set-Location $PSScriptRoot\..
$VER_CODE = Select-String -Path ".\src\utils\Consts.ts" -Pattern "VERSION = '(.*)'"
$VERSION = $VER_CODE.Matches.Groups[1].Value;

Write-Output "Building Version $VERSION for Windows"

# Prepare directories
New-Item -Path "." -Name "build" -ItemType "directory" -Force | Out-Null

Write-Output "NPM Install"
npm ci --legacy-peer-deps

# Building
Write-Output "Building Typescripts"
npx tsc

# Packing index.js
Write-Output "Packing index.js"
node .\node_modules\@vercel\ncc\dist\ncc\cli.js build .\dist\AsphyxiaCore.js -o .\build-env --external pug --external ts-node

Write-Output "Setting Up Build Environment"
Set-Location -Path ".\build-env"
npm ci
Copy-Item -Recurse -Path "typescript" -Destination "node_modules/"

# Inject *.node into pkg.assets so @yao-pkg/pkg extracts native binaries at runtime
$pkgJsonPath = ".\package.json"
$pkgJson = Get-Content $pkgJsonPath | ConvertFrom-Json
$pkgJson.pkg.assets += "./*.node"
$pkgJson.pkg.assets += "./*.dat"
$pkgJson | ConvertTo-Json -Depth 10 | Set-Content $pkgJsonPath

# Copy icudtl.dat (Skia Unicode data required by @napi-rs/canvas text rendering)
$icuSource = "..\node_modules\@napi-rs\canvas-win32-x64-msvc\icudtl.dat"
if (Test-Path $icuSource) {
    Copy-Item $icuSource ".\icudtl.dat" -Force
    Write-Output "Copied icudtl.dat to build-env"
} else {
    Write-Output "WARNING: icudtl.dat not found, text rendering in Discord bot may crash"
}

Set-Location -Path ".."

# @yao-pkg/pkg fetches Node 22 base binaries from yao-pkg/pkg-fetch GitHub
# releases on first build, then caches them under ~/.pkg-cache. The bumped
# Node is required for node:sqlite (added in Node 22.5; pkg 5.x topped out
# at Node 18 and the bundled v16 had no SQLite at all).
#
# `experimental-sqlite` is baked into the snapshot via --options so that
# end users running the .exe don't need to know about a Node flag —
# stable in Node 24 (ignored), required + warning-suppressed by
# --no-warnings on Node 22.x.
#
# Windows x86 (ia32) is dropped: yao-pkg-fetch doesn't ship 32-bit
# Windows prebuilts past Node 18, and Node itself stopped publishing
# them. Anyone still on 32-bit Windows can run the dev path from source.

Write-Output "Packing binaries"

# Packing x64
node .\node_modules\@yao-pkg\pkg\lib-es5\bin.js .\build-env -t "node22-win-x64" -o .\build\asphyxia-core-x64 --options "no-warnings,experimental-sqlite"

# Replace the bundled Node.exe's icon with our own. We overwrite the
# existing RT_GROUP_ICON ID 1 in place — this is the form yao-pkg's docs
# recommend and the only one that leaves the embedded pkg snapshot intact.
# Earlier we used --delete-allicon + --allow-shrink, which rewrote the
# resource section's layout and corrupted pkg's payload (the exe boots
# straight into "Pkg: Error reading from file"). Skip silently if
# icon.ico isn't present so the build still works on a fresh checkout.
if (Test-Path ".\icon.ico") {
    Write-Output "Stamping icon.ico onto x64 exe"
    node .\node_modules\resedit-cli\dist\cli.js --in ".\build\asphyxia-core-x64.exe" --out ".\build\asphyxia-core-x64.iconed.exe" --icon "1,.\icon.ico"
    Move-Item -Force ".\build\asphyxia-core-x64.iconed.exe" ".\build\asphyxia-core-x64.exe"
} else {
    Write-Output "icon.ico not found at repo root; skipping icon injection"
}

# Copy icudtl.dat to build output so it sits next to the .exe for Discord bot text rendering
if (Test-Path ".\build-env\icudtl.dat") {
    Copy-Item ".\build-env\icudtl.dat" ".\build\icudtl.dat" -Force
    Write-Output "Copied icudtl.dat to build output"
}
