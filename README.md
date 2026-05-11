# Tapo Smart-Home Dashboard

A self-hosted web dashboard for controlling **TP-Link Tapo** devices — hubs, plugs, bulbs, LED strips, temperature sensors, motion sensors, and fans.  
Built with **SvelteKit 2 + Svelte 5**, **MySQL**, and **python-kasa** as the device communication layer.

> **Language support:** the UI ships with English and Czech. Switch at any time via Settings → Language.

---

## Features

| Area | Details |
|---|---|
| **Devices** | Auto-discover via hub IP, import & rename, room assignment, online/offline tracking |
| **Groups** | Logical device groups with shared on/off/brightness/colour controls |
| **Rules** | Time- and sensor-based automation with multi-step actions and hysteresis support |
| **Timers** | One-shot and repeating scheduled actions; vacation/random window mode |
| **Widgets** | Customisable dashboard tiles: device, group, sensor, HTTP-fetch, label, spacer, divider |
| **Home screen** | Drag-and-drop grid layout (desktop) / stacked list (mobile) |
| **Logs** | Structured log viewer with debug / info / warn / error levels |
| **Auth** | Single-admin password; guests can view and optionally control allowed devices |
| **Themes** | Light / dark, persisted per browser |
| **i18n** | English + Czech, persisted per browser via cookie |

---

## Architecture

```
Browser (SvelteKit SSR + client hydration)
        │  REST API
        ▼
SvelteKit Node.js server
  ├── MySQL  ── app_hubs, app_devices, app_rules, app_timers, …
  └── child_process ── scripts/kasa_bridge.py ── python-kasa library
```

A **background scheduler** runs inside the Node process.  
Every `POLL_INTERVAL_SECONDS` (default 180 s) it:

1. Polls all enabled hubs and upserts live state into `app_devices`.
2. Appends a snapshot row to `app_readings` (history).
3. Runs the **rule engine**:
   - Each enabled rule votes ON or OFF when its conditions match.
   - **ON wins over OFF** — any rule wanting power keeps the target on.
   - **Dependencies** (`app_dependencies`) can force a target on when a source is on.
   - An action is only sent when the desired state differs from the actual state.
4. Fires due timers and re-queues recurring ones.

---

## Requirements

| Dependency | Minimum version |
|---|---|
| Node.js | 20 LTS |
| MySQL / MariaDB | 8.0 / 10.6 |
| Python | 3.10 |
| python-kasa | 0.10.2 (bundled in `python-libs/`) |

---

## Installation

### 1. Create the database

```bash
mysql -u root -p < db/schema.sql
```

Create a dedicated MySQL user with full privileges on the `tapo` schema.

### 2. Python dependencies

`python-kasa` and all its dependencies are pre-bundled in the `python-libs/` directory — **no `pip install` needed**.

### 3. Configure the environment

```bash
cp .env.example .env
```

Edit `.env`:

```ini
# MySQL connection
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=tapo
DB_PASSWORD=yourpassword
DB_NAME=tapo

# Python bridge
PYTHON_BIN=python3                # or an absolute path
KASA_BRIDGE=./scripts/kasa_bridge.py
PYTHON_LIBS=../python-libs        # path to the bundled python-kasa

# Scheduler
POLL_INTERVAL_SECONDS=180         # polling interval in seconds
RULES_ENABLED=true
```

### 4. Install Node.js dependencies

```bash
npm install
```

### 5. Start (development)

```bash
npm run dev
```

Open `http://localhost:5173`.

### 6. First-run setup in the UI

1. A setup dialog appears — choose an **admin password**.
2. Go to **Settings → Hubs** → add a hub (IP address + Tapo account e-mail & password).  
   The app calls `kasa_bridge.py discover` to verify the connection.
3. Go to **Devices** → click **Import from hubs**, then rename devices and assign rooms.
4. Optionally create **Groups**, **Rules**, **Timers**, and **Widgets**.

---

## Production

### Build

```bash
npm run build
```

### Run

```bash
node build/index.js
```

The scheduler starts automatically on the first HTTP request.

> **Important:** the scheduler requires a persistent long-lived Node process.  
> It will **not** work in serverless environments (Vercel, Cloudflare Workers, etc.).

### Recommended: pm2

```bash
npm install -g pm2
pm2 start build/index.js --name tapo
pm2 save
pm2 startup
```

Pass environment variables via a `.env` file in the working directory or a `pm2` ecosystem file.

---

## Security notes

- Tapo credentials are stored **per hub in the database** — not in source code.
- All database queries use **parameterised statements** (`mysql2`).
- The HTTP widget proxy and background fetcher block **private/loopback IP ranges** (SSRF protection).
- Deploy behind a **reverse proxy** (nginx, Caddy) with HTTPS — the app does not terminate TLS itself.
- `kasa_bridge.py` receives the Tapo password as a CLI argument, which is visible in process listings (`ps`). Run the process under a dedicated, unprivileged system user.

---

## Project structure

```
app/
├── db/
│   ├── schema.sql             # Full schema for fresh installs
│   └── migrations/            # Incremental upgrade scripts
├── scripts/
│   └── kasa_bridge.py         # Python ↔ python-kasa bridge (spawned by Node)
├── src/
│   ├── hooks.server.ts        # Scheduler bootstrap + auth/RBAC middleware
│   ├── lib/
│   │   ├── i18n/              # Translation files (en.json, cs.json)
│   │   ├── server/            # DB, poller, rule engine, scheduler, auth
│   │   ├── types.ts           # Shared TypeScript types
│   │   └── ui/                # Reusable Svelte components
│   └── routes/
│       ├── +layout.svelte     # App shell (nav, auth modal, theme switcher)
│       ├── +page.svelte       # Home dashboard (widget grid)
│       ├── api/               # REST endpoints
│       ├── devices/           # Device management
│       ├── groups/            # Group management
│       ├── rules/             # Automation rule editor
│       ├── settings/          # App settings (hubs, credentials, logging)
│       ├── timers/            # Scheduled timers
│       ├── widgets/           # Widget editor
│       └── logs/              # Log viewer
└── python-libs/               # Bundled python-kasa 0.10.2 (no pip install required)
```

---

## License

MIT
