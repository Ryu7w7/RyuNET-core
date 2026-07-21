#!/usr/bin/env bash
# ============================================================
#  RyuNET-core — NeDB to SQLite Migration Script
#  Compatible with: Linux x64, Linux ARM64, Linux ARM32
#  Usage: bash scripts/migrate-deploy.sh
#  Optional: bash scripts/migrate-deploy.sh /path/to/savedata
# ============================================================

set -euo pipefail

# --- Colors (ANSI) ---
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; GRAY='\033[0;37m'; MAGENTA='\033[0;35m'
BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "  ${GREEN}[OK]${NC} $*"; }
info() { echo -e "  ${CYAN}[..]${NC} $*"; }
warn() { echo -e "  ${YELLOW}[!!]${NC} $*"; }
fail() { echo -e "  ${RED}[XX]${NC} $*"; }

echo ""
echo -e "${MAGENTA}${BOLD}================================================${NC}"
echo -e "${MAGENTA}${BOLD}  RyuNET-core  |  NeDB to SQLite Migration${NC}"
echo -e "${MAGENTA}${BOLD}================================================${NC}"
echo ""

# Detect architecture (informational only)
ARCH=$(uname -m)
info "Platform: $(uname -s) / $ARCH"

# --- 1. Check Node.js version ---
info "Checking Node.js version..."
if ! command -v node &>/dev/null; then
    fail "Node.js not found."
    fail "Install Node.js >= 22.5:"
    fail "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    fail "  sudo apt-get install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node --version | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)

if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
    fail "Node.js $NODE_VERSION detected. Version >= 22.5 is required."
    fail "Update with: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
    exit 1
fi
ok "Node.js $NODE_VERSION (compatible)"

# --- 2. Locate savedata directory ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$(dirname "$SCRIPT_DIR")"

if [ -n "${1:-}" ]; then
    SAVEDATA_DIR="$1"
else
    # Common candidate locations
    for candidate in \
        "$CORE_DIR/savedata" \
        "/opt/asphyxia/savedata" \
        "$HOME/asphyxia/savedata" \
        "./savedata"
    do
        if [ -d "$candidate" ]; then
            SAVEDATA_DIR="$candidate"
            break
        fi
    done
fi

if [ -z "${SAVEDATA_DIR:-}" ] || [ ! -d "$SAVEDATA_DIR" ]; then
    fail "Could not locate the savedata directory."
    fail "Specify it manually: bash scripts/migrate-deploy.sh /path/to/savedata"
    exit 1
fi

ok "Savedata found at: $SAVEDATA_DIR"

# --- 3. List .db files ---
DB_COUNT=0
DB_LIST=()
while IFS= read -r f; do
    [[ "$f" == *.bak ]] && continue
    DB_LIST+=("$f")
    ((DB_COUNT++)) || true
done < <(find "$SAVEDATA_DIR" -maxdepth 1 -name "*.db" 2>/dev/null | sort)

if [ "$DB_COUNT" -eq 0 ]; then
    warn "No .db files found in $SAVEDATA_DIR"
    warn "If you already migrated, the directory will contain SQLite files."
    exit 0
fi

info "$DB_COUNT database file(s) found:"
for f in "${DB_LIST[@]}"; do
    SIZE=$(du -sh "$f" 2>/dev/null | cut -f1)
    echo -e "    ${GRAY}$(basename "$f")  ($SIZE)${NC}"
done

# --- 4. Create backup ---
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="$(dirname "$SAVEDATA_DIR")/savedata_backup_$TIMESTAMP"

info "Creating backup at: $BACKUP_DIR"
if ! cp -r "$SAVEDATA_DIR" "$BACKUP_DIR"; then
    fail "Failed to create backup. Aborting — nothing was modified."
    exit 1
fi
ok "Backup created successfully"

# --- 5. Confirm ---
echo ""
warn "WARNING: $DB_COUNT file(s) will be converted from NeDB to SQLite format."
warn "Backup location: $BACKUP_DIR"
read -r -p "  Continue? (y/N): " confirm
if [[ ! "$confirm" =~ ^[yY]$ ]]; then
    info "Operation cancelled. Nothing was modified."
    rm -rf "$BACKUP_DIR"
    exit 0
fi

# --- 6. Run migration ---
echo ""
info "Running migration..."
MIG_SCRIPT="$SCRIPT_DIR/migrate-nedb-to-sqlite.js"

if ! node --experimental-sqlite --no-warnings "$MIG_SCRIPT" "$SAVEDATA_DIR"; then
    echo ""
    fail "Error during migration."
    warn "ROLLBACK: To restore your original data:"
    warn "  rm -rf '$SAVEDATA_DIR'"
    warn "  mv '$BACKUP_DIR' '$SAVEDATA_DIR'"
    exit 1
fi

ok "Migration completed"

# --- 7. Done ---
echo ""
echo -e "${GREEN}${BOLD}================================================${NC}"
echo -e "${GREEN}${BOLD}  Migration completed successfully!${NC}"
echo -e "${GREEN}${BOLD}================================================${NC}"
echo ""
echo -e "  ${GRAY}Backup saved at: $BACKUP_DIR${NC}"
echo -e "  ${GRAY}To rollback if needed:${NC}"
echo -e "  ${GRAY}  rm -rf '$SAVEDATA_DIR'${NC}"
echo -e "  ${GRAY}  mv '$BACKUP_DIR' '$SAVEDATA_DIR'${NC}"
echo ""
echo -e "  ${CYAN}You can now start the server normally.${NC}"
echo ""
