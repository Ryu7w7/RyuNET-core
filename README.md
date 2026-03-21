# Asphyxia Core (Fork)

A fork of [asphyxia-core](https://github.com/asphyxia-core/core) with additional features.

Some of the core changes were made specifically to support a forked SDVX plugin. The plugin is maintained in a separate repository: [Beafowl/asphyxia_plugins (kfc branch)](https://github.com/Beafowl/asphyxia_plugins/tree/kfc), which is itself a fork of [22vv0's plugin](https://github.com/22vv0/asphyxia_plugins).

## Credits

- **[Team Asphyxia](https://github.com/asphyxia-core)** - Original Asphyxia Core and plugins
- **[22vv0](https://github.com/22vv0/asphyxia_plugins)** - Forked SDVX plugin (with LatoWolf)

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

### Core changes for the SDVX plugin
These are server-side changes in this repository that support the [forked SDVX plugin](https://github.com/Beafowl/asphyxia_plugins/tree/kfc).
- Tachi OAuth client ID and secret configurable via `config.ini`
- Nabla volforce recalculation endpoint
- Tachi export timestamp tracking and v7 score export support
- Clear comparison fix for proper Exceed Gear ranking order (MXV < UC < PUC)

### WebUI
- Removed shutdown/process controls from navbar
- Hidden data delete buttons for non-admin users
