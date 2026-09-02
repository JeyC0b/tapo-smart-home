# 🔥 Tapo Smart-Home Dashboard

> A self-hosted, open-source web dashboard for **TP-Link Tapo** smart-home devices.  
> Control plugs, bulbs, LED strips, hubs, temperature/humidity sensors, motion detectors, door/window contacts, and fans — all from one beautiful UI.

Built with **SvelteKit 2 + Svelte 5**, **MySQL**, and **[python-kasa](https://github.com/python-kasa/python-kasa)** as the device communication layer.

---

## 📸 Screenshots

> *(Add your own screenshots here — drag and drop images into this section on GitHub)*

| Home dashboard | Devices | Rules editor |
|---|---|---|
| ![Home](docs/screenshots/home.png) | ![Devices](docs/screenshots/devices.png) | ![Rules](docs/screenshots/rules.png) |

| Timers | Widgets | Settings |
|---|---|---|
| ![Timers](docs/screenshots/timers.png) | ![Widgets](docs/screenshots/widgets.png) | ![Settings](docs/screenshots/settings.png) |

---

## ✨ Features

| Area | Details |
|---|---|
| **Home dashboard** | Drag-and-drop responsive grid (desktop) / stacked list (mobile); fully customisable per user |
| **Devices** | Auto-discover via hub IP, import & rename, room assignment, online/offline tracking, energy monitoring |
| **Groups** | Logical device groups with shared on/off/brightness/colour/fan controls |
| **Automation rules** | Time- and sensor-based rules with multi-step actions, priorities, and hysteresis support |
| **Timers** | One-shot and repeating scheduled actions; vacation/random-window mode; automatic retry when a device is temporarily unreachable |
| **Widgets** | Custom dashboard tiles: device state, group toggle, sensor readings, HTTP data fetch, label, spacer, divider |
| **Logs** | Structured log viewer (debug / info / warn / error) with filtering and pagination |
| **Auth** | Single-admin password; guests see only the dashboard and may control individually allowed devices — every management page and configuration endpoint is admin-only |
| **Themes** | Light / dark, persisted per browser |
| **Language** | English + Czech UI, persisted per browser via cookie |

---

## 🏗 Architecture

```
Browser  (SvelteKit SSR + client hydration)
    │
    │  REST API (JSON)
    ▼
SvelteKit Node.js server
    ├── MySQL ── app_hubs, app_devices, app_rules, app_timers, app_widgets …
    └── child_process ── scripts/kasa_bridge.py ── python-kasa library
```

A **background scheduler** runs inside the Node process and every `POLL_INTERVAL_SECONDS`:

1. Polls all enabled hubs in parallel and upserts live state into `app_devices`.
2. Appends a reading snapshot to `app_readings` (history).
3. Runs the **rule engine** — each rule votes ON/OFF; **ON wins over OFF**; dependencies can force additional targets on.
4. Fires due timers and re-queues repeating ones.

---

## 📋 Requirements

| Dependency | Minimum version |
|---|---|
| Node.js | 20 LTS |
| MySQL / MariaDB | 8.0 / 10.6 |
| Python | 3.10 |
| python-kasa | 0.10.2 |

---

## 🚀 Installation

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/tapo-smart-home.git
cd tapo-smart-home
```

### 2. Create the database

```bash
mysql -u root -p -e "CREATE DATABASE tapo CHARACTER SET utf8mb4;"
```

The tables themselves are created in step 6 by `npm run db:migrate`, once `.env` holds the
connection details.

Then create a dedicated MySQL user:

```sql
CREATE USER 'tapo'@'localhost' IDENTIFIED BY 'yourpassword';
GRANT ALL PRIVILEGES ON tapo.* TO 'tapo'@'localhost';
FLUSH PRIVILEGES;
```

### 3. Install Python dependencies (python-kasa)

The app communicates with Tapo devices through `scripts/kasa_bridge.py`, which requires **python-kasa** and its dependencies.  
Install them into a local `python-libs/` directory — no system-wide pip install or virtual environment activation needed at runtime:

```bash
# Create the target directory
mkdir python-libs

# Download python-kasa 0.10.2 and all dependencies into it
pip install python-kasa==0.10.2 --target ./python-libs --no-compile
```

> **Why `--target ./python-libs`?**  
> The bridge script adds this folder to `sys.path` at startup via the `PYTHON_LIBS` env variable.  
> This isolates the dependencies from your system Python and avoids needing to activate a virtual environment every time the app runs.

**Verify:**

```bash
python3 -c "import sys; sys.path.insert(0, './python-libs'); import kasa; print(kasa.__version__)"
# Expected output: 0.10.2
```

**Alternative — use a virtual environment instead:**

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install python-kasa==0.10.2
```

Then set `PYTHON_BIN=.venv/bin/python3` (Windows: `.venv\Scripts\python.exe`) in your `.env` and leave `PYTHON_LIBS` empty.

### 4. Configure the environment

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
PYTHON_BIN=python3                 # or an absolute path / venv path
KASA_BRIDGE=./scripts/kasa_bridge.py
PYTHON_LIBS=./python-libs          # path to the python-kasa install (step 3)

# Background scheduler
POLL_INTERVAL_SECONDS=180          # how often hubs are polled (seconds)
RULES_ENABLED=true
```

### 5. Install Node.js dependencies

```bash
npm install
```

### 6. Create the tables

```bash
npm run db:migrate
```

### 7. Start (development mode)

```bash
npm run dev
```

Open **http://localhost:5173** in your browser.

### 8. First-run setup in the UI

1. A **setup dialog** appears — choose an admin password.
2. Go to **Settings → Hubs** → add a hub (IP address + Tapo account e-mail & password).  
   The app calls `kasa_bridge.py discover` to verify the connection.
3. Go to **Devices** → click **Import from hubs**, then rename devices and assign rooms.
4. Optionally create **Groups**, **Rules**, **Timers**, and **Widgets**.
5. Drag tiles onto the **Home** dashboard — or use the **+** picker to add widget tiles.

---

## 🏭 Production deployment

### Build

```bash
npm run build
```

### Run

```bash
node build/index.js
```

The scheduler starts automatically on the first HTTP request.

> **Important:** the scheduler requires a persistent, long-lived Node process.  
> It will **not** work in serverless environments (Vercel, Cloudflare Workers, etc.).

### Recommended: pm2

```bash
npm install -g pm2
pm2 start build/index.js --name tapo
pm2 save
pm2 startup   # follow the printed instructions to enable auto-start on reboot
```

Create a `pm2` ecosystem file for a cleaner setup:

```js
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'tapo',
    script: 'build/index.js',
    cwd: '/path/to/tapo-smart-home',
    env_file: '.env',
    restart_delay: 5000,
    max_restarts: 10
  }]
};
```

```bash
pm2 start ecosystem.config.cjs
```

### Reverse proxy (nginx example)

```nginx
server {
    listen 80;
    server_name tapo.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Add a TLS certificate with [Certbot](https://certbot.eff.org/) (`certbot --nginx`).

---

## ⏱ Timer reliability

Smart-home devices drop off the network. When a scheduled action cannot reach its device,
the timer is **not** thrown away:

- The task stays *pending* and is retried with a backoff (30 s → 1 min → 2 min → 5 min)
  until the device answers or its retry window expires.
- The **auto switch-off** of an "on for N minutes" timer gets a much longer window
  (24 h by default). Leaving a plug on is a state the user never asked for, so the app keeps
  chasing it; the countdown starts from the moment the device actually switched.
- A repeating timer queues its next occurrence **regardless of whether this run succeeded**,
  so one Wi-Fi hiccup can no longer end a daily schedule.
- A schedule missed while the server was down fires **once**, at its next future slot —
  it does not replay every missed occurrence.

Both windows are configurable under **Settings → Timer reliability** (`0` = do not retry).

---

## 🔒 Security notes

- Tapo credentials are stored **per hub in the database** — never in source code or `.env`.
- All database queries use **parameterised statements** (`mysql2`).
- The HTTP widget proxy and background cache block **private/loopback IP ranges** (SSRF protection).
- Deploy behind a **reverse proxy with HTTPS** — the app does not terminate TLS itself.
- Without the admin password everything is open by design (first-run state). Once it is set,
  guests can reach only the dashboard and the per-device control endpoints; hub IPs, the Tapo
  account e-mail, rules, timers and widget definitions are not served to them.
- `kasa_bridge.py` receives the Tapo password as a CLI argument, which is visible in process listings (`ps`). Run under a dedicated, unprivileged system user for additional isolation.

---

## 🗄 Database

`db/schema.sql` creates all tables for a **fresh install**; `db/migrations/*.sql` upgrade an
existing one. Both are applied by:

```bash
npm run db:migrate
```

Every statement is idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
`INSERT IGNORE`), so the command is safe to re-run after every `git pull` — and safe to run
against a brand-new database too. Add `-- --only v12` to apply a single migration.

Key tables: `app_hubs`, `app_devices`, `app_readings`, `app_rules`, `app_rule_conditions`, `app_dependencies`, `app_timers`, `app_timer_runs`, `app_widgets`, `app_groups`, `app_group_members`, `app_logs`, `app_settings`, `app_admin_sessions`.

---

## 📁 Project structure

```
tapo-smart-home/
├── db/
│   ├── schema.sql              # Full schema for fresh installs
│   └── migrations/             # Incremental upgrade scripts
├── python-libs/                # ← created by pip install --target (not in git)
│   └── kasa/ …                 # python-kasa 0.10.2 + all dependencies
├── scripts/
│   └── kasa_bridge.py          # Python ↔ python-kasa bridge (spawned by Node)
├── src/
│   ├── hooks.server.ts         # Scheduler bootstrap + auth/RBAC middleware
│   ├── lib/
│   │   ├── i18n/               # Translation files (en.json, cs.json)
│   │   ├── server/             # DB helpers, poller, rule engine, scheduler, auth
│   │   ├── types.ts            # Shared TypeScript types
│   │   └── ui/                 # Reusable Svelte components (DeviceCard, GroupCard …)
│   └── routes/
│       ├── +layout.svelte      # App shell (nav, auth modal, theme switcher)
│       ├── +page.svelte        # Home dashboard (widget grid)
│       ├── api/                # REST API endpoints
│       ├── devices/            # Device management page
│       ├── groups/             # Group management page
│       ├── rules/              # Automation rule editor
│       ├── settings/           # App settings (hubs, credentials, logging)
│       ├── timers/             # Scheduled timers page
│       ├── widgets/            # Widget editor page
│       └── logs/               # Log viewer page
├── .env.example                # Environment variable template
└── package.json
```

---

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first.

1. Fork the repo and create your branch from `main`.
2. Run `npm run check` to verify there are no TypeScript errors.
3. Open a pull request with a clear description of your changes.

---

## 📄 License

[MIT](LICENSE)

---

<p align="center">
  Made with ❤️ for TP-Link Tapo users who want full local control of their smart home.
</p>
