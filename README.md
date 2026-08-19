# Asphyxia Core (Fork)

A fork of [asphyxia-core](https://github.com/asphyxia-core/core) with additional features.

Some of the core changes were made specifically to support a forked SDVX plugin. The plugin is maintained in a separate repository: [Ryu7w7/asphyxia_plugins](https://github.com/Ryu7w7/asphyxia_plugins), which is itself a fork of [22vv0's plugin](https://github.com/22vv0/asphyxia_plugins).

> [!IMPORTANT]
> This fork uses **SQLite** as its database backend instead of NeDB. If you are upgrading from an older version of this core (or from upstream Asphyxia), you **must** run the migration script before starting the server. See [Migrating from NeDB](#migrating-from-nedb) below.

## Requirements

- **Node.js >= 22.5** (required for the built-in `node:sqlite` module)

## Credits

- **[Team Asphyxia](https://github.com/asphyxia-core)** - Original Asphyxia Core and plugins
- **[22vv0](https://github.com/22vv0/asphyxia_plugins)** - Forked SDVX plugin (with LatoWolf)
- **[Beafowl](https://github.com/Beafowl/asphyxia_plugins)** - Forked Asphyxia Core

## Setup

### 1. Configure `config.ini`

Edit `config.ini` in the root directory to match your environment:

```ini
port=8083
bind=localhost
ping_ip=127.0.0.1
matching_port=5700
allow_register=true
maintenance_mode=false
enable_paseli=true
webui_on_startup=true
server_name=Asphyxia Core
server_tag=CORE

; Optional Discord OAuth2 configuration
discord_client_id=
discord_client_secret=

; Security
require_pcbid_auth=true
```

| Option | Description |
|---|---|
| `port` | Port the server listens on |
| `bind` | Address to bind to (`localhost` for local only, `0.0.0.0` for all interfaces) |
| `ping_ip` | IP address returned to clients for ping |
| `matching_port` | Port used for matching |
| `allow_register` | Allow new user registration (`true`/`false`) |
| `maintenance_mode` | Enable maintenance mode (`true`/`false`) |
| `enable_paseli` | Enable PASELI support (`true`/`false`) |
| `webui_on_startup` | Open the WebUI in browser on startup (`true`/`false`) |
| `server_name` | Display name of the server |
| `server_tag` | Client tag shown in-game |
| `discord_client_id` | OAuth2 Client ID from Discord Developer Portal |
| `discord_client_secret` | OAuth2 Client Secret for Discord OAuth2 |
| `require_pcbid_auth` | If true, only registered PCBIDs can connect to e-amusement services |

### 2. Change the default admin password

On first launch, a default admin account is created with the credentials:

- **Username:** `admin`
- **Password:** `admin`

Log in to the WebUI and change the admin password immediately. If your server is exposed to a network, leaving the default credentials is a security risk.

## Changes from upstream

### Core
- More card formats
- Country flags
- Leaderboard for SDVX & IIDX
- User authentication system (signup, login, account management)
- Admin role with user management
- Access control (profile ownership, admin-only pages)
- Server name and client tag configurable via `config.ini`
- **Discord OAuth2**: Fully integrated login and account linking.
- **Cabinet (PCBID) Management**: System for registering and authorizing specific arcade hardware.
- **Strict PCBID Security**: Optional enforcement to reject connections from unauthorized hardware.
- **Automatic Card Binding**: If a user logs in from a registered Cabinet without a card, their first used card is automatically bound to their account.
- **e-amusement cloud (Konaste) support**: Native protocol support for official PC/Cloud game clients.
- **SQLite backend**: Replaced NeDB with a SQLite-backed store for significantly better performance and reliability at scale.

### Core changes for the SDVX plugin
These are server-side changes in this repository that support the [forked SDVX plugin](https://github.com/Ryu7w7/asphyxia_plugins).
- Tachi OAuth client ID and secret configurable via `config.ini`
- Nabla volforce recalculation endpoint
- Tachi export timestamp tracking and v7 score export support
- Clear comparison fix for proper Exceed Gear ranking order (MXV < UC < PUC)
- **Last.fm scrobbling**: optional integration to scrobble played songs to Last.fm, toggled per-profile via the WebUI (`lastfm_api_key` / `lastfm_api_secret` in `config.ini`)

### WebUI
- Removed shutdown/process controls from navbar
- Hidden data delete buttons for non-admin users
- New "Cabinets" section for users to manage their registered hardware.
- Discord login/linking buttons on auth and account pages.

---

## Migrating from NeDB

If you are upgrading from an older version that used NeDB (`.db` files in NDJSON format), you must convert your savedata before starting the new core. The server will refuse to start if it detects legacy NeDB files.

> [!CAUTION]
> Always back up your `savedata/` directory before running the migration. The script creates an automatic backup, but an extra copy never hurts.

### Requirements

- Node.js >= 22.5

### Windows

```powershell
# From the core root directory
.\scripts\migrate-deploy.ps1

# Or specify savedata path manually
.\scripts\migrate-deploy.ps1 -SavedataDir "C:\path\to\savedata"
```

### Linux / ARM (VPS)

```bash
# Make the script executable
chmod +x scripts/migrate-deploy.sh

# Run (auto-detects savedata directory)
bash scripts/migrate-deploy.sh

# Or specify savedata path manually
bash scripts/migrate-deploy.sh /path/to/savedata
```

The script will:
1. Verify your Node.js version
2. List all `.db` files to be migrated
3. Create a timestamped backup (e.g. `savedata_backup_20250720_153000/`)
4. Ask for confirmation before making any changes
5. Convert each file from NDJSON to SQLite format in-place
6. Print rollback instructions if anything goes wrong

The migration is **idempotent** — files already in SQLite format are skipped automatically.

### Rollback

Each original `.db` file is preserved with a `.nedb.bak` suffix inside the savedata directory. The deploy scripts also create a full directory backup. To roll back:

```bash
# Linux
rm -rf savedata/
mv savedata_backup_YYYYMMDD_HHMMSS/ savedata/
```

```powershell
# Windows
Remove-Item -Recurse savedata
Rename-Item savedata_backup_YYYYMMDD_HHMMSS savedata
```
