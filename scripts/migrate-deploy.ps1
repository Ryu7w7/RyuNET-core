# ============================================================
#  RyuNET-core — NeDB to SQLite Migration Script (Windows)
#  Usage: .\scripts\migrate-deploy.ps1
#  Optional: .\scripts\migrate-deploy.ps1 -SavedataDir "C:\path\to\savedata"
# ============================================================

param(
    [string]$SavedataDir = ""
)

$ErrorActionPreference = "Stop"

# --- Helpers ---
function Write-Success { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Info    { param($msg) Write-Host "  [..] $msg" -ForegroundColor Cyan }
function Write-Warn    { param($msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Fail    { param($msg) Write-Host "  [XX] $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "================================================" -ForegroundColor Magenta
Write-Host "  RyuNET-core  |  NeDB to SQLite Migration" -ForegroundColor Magenta
Write-Host "================================================" -ForegroundColor Magenta
Write-Host ""

# --- 1. Check Node.js version ---
Write-Info "Checking Node.js version..."
try {
    $nodeVersion = (node --version 2>&1).ToString().TrimStart('v')
    $parts = $nodeVersion.Split('.')
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
        Write-Fail "Node.js $nodeVersion detected. Version >= 22.5 is required."
        Write-Fail "Download the latest LTS from: https://nodejs.org"
        exit 1
    }
    Write-Success "Node.js $nodeVersion (compatible)"
} catch {
    Write-Fail "Node.js not found. Please install Node.js >= 22.5 first."
    exit 1
}

# --- 2. Locate savedata directory ---
if ($SavedataDir -eq "") {
    $candidates = @(
        (Join-Path $PSScriptRoot "..\savedata"),
        (Join-Path (Get-Location) "savedata")
    )
    foreach ($c in $candidates) {
        $resolved = [System.IO.Path]::GetFullPath($c)
        if (Test-Path $resolved) {
            $SavedataDir = $resolved
            break
        }
    }
}

if ($SavedataDir -eq "" -or -not (Test-Path $SavedataDir)) {
    Write-Fail "Could not locate the savedata directory."
    Write-Fail "Specify it manually: .\scripts\migrate-deploy.ps1 -SavedataDir 'C:\path\to\savedata'"
    exit 1
}

Write-Success "Savedata found at: $SavedataDir"

# --- 3. List .db files ---
$dbFiles = Get-ChildItem -Path $SavedataDir -Filter "*.db" -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -notlike "*.bak" }

if ($dbFiles.Count -eq 0) {
    Write-Warn "No .db files found in $SavedataDir"
    Write-Warn "If you already migrated, the directory will contain SQLite files."
    exit 0
}

Write-Info "$($dbFiles.Count) database file(s) found:"
foreach ($f in $dbFiles) {
    $sizeMB = [math]::Round($f.Length / 1MB, 2)
    Write-Host "      $($f.Name)  ($sizeMB MB)" -ForegroundColor DarkGray
}

# --- 4. Create backup ---
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupDir = Join-Path (Split-Path $SavedataDir -Parent) "savedata_backup_$timestamp"

Write-Info "Creating backup at: $backupDir"
try {
    Copy-Item -Path $SavedataDir -Destination $backupDir -Recurse -Force
    Write-Success "Backup created successfully"
} catch {
    Write-Fail "Failed to create backup: $_"
    Write-Fail "Aborting. Nothing was modified."
    exit 1
}

# --- 5. Confirm ---
Write-Host ""
Write-Warn "WARNING: $($dbFiles.Count) file(s) will be converted from NeDB to SQLite format."
Write-Warn "Backup location: $backupDir"
$confirm = Read-Host "  Continue? (y/N)"
if ($confirm -notmatch '^[yY]$') {
    Write-Info "Operation cancelled. Nothing was modified."
    Remove-Item -Recurse -Force $backupDir
    exit 0
}

# --- 6. Run migration ---
Write-Host ""
Write-Info "Running migration..."
$migScript = Join-Path $PSScriptRoot "migrate-nedb-to-sqlite.js"

try {
    $output = node --experimental-sqlite --no-warnings $migScript $SavedataDir 2>&1
    $output | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) {
        throw "Migration script exited with error code $LASTEXITCODE"
    }
    Write-Success "Migration completed"
} catch {
    Write-Fail "Error during migration: $_"
    Write-Host ""
    Write-Warn "ROLLBACK: To restore original data, run:"
    Write-Warn "  Remove-Item -Recurse '$SavedataDir'"
    Write-Warn "  Rename-Item '$backupDir' '$SavedataDir'"
    exit 1
}

# --- 7. Done ---
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  Migration completed successfully!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Backup saved at: $backupDir" -ForegroundColor DarkGray
Write-Host "  To rollback if needed:" -ForegroundColor DarkGray
Write-Host "    Remove-Item -Recurse '$SavedataDir'" -ForegroundColor DarkGray
Write-Host "    Rename-Item '$backupDir' '$SavedataDir'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  You can now start the server normally." -ForegroundColor Cyan
Write-Host ""
