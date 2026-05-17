# Everton Stock Management — v3.1 (Cloud + Auth + Monthly Periods)

Self-hosted stock & barcode tracking for a workshop. Cloud SQLite, admin auth,
monthly archiving, and customizable branding.

## What's new in v3.1

- **Monthly archiving** — close out the month manually with a button on the Reports screen,
  or let it auto-close on the 1st of each month at midnight. Stock levels are preserved
  across periods; only history & reports are scoped per month.
- **Monthly Reports page** — browse archived months and see full per-operator,
  per-product breakdowns for any past period.
- **Period dropdown in History** — flip between the live current month and any past month.
- **Customizable branding** — set your own system name, subtitle, and logo from Settings.
  The header, login screen, and browser tab title all use your branding.
- **Tighter session timeout** — sessions now expire after 5 minutes of inactivity
  (was 1 hour in v3).

## Upgrading from v3

If you already have v3 running, just use the included `update.sh` on the server:

```bash
bash ~/update.sh ~/everton-stock-cloud-v3.1.zip
```

Your database, users, products, operators, and existing history are preserved.
On first start, the migration:

1. Adds `periods` and `settings` tables.
2. Adds `periodId` columns to `transactions` and `movements`.
3. Opens a first period labelled for the current month and backfills all your
   existing transactions/movements into it.

You can then close that period whenever you're ready to start fresh for the next month.

## Fresh install (Ubuntu 22.04 / 24.04)

```bash
unzip everton-stock-cloud-v3.1.zip
cd everton-stock
bash install.sh
```

The installer creates a service user `everton`, installs Node.js 20, builds the
React frontend, and registers a systemd service `everton-stock` listening on
port 3001.

After install, browse to `http://server-ip:3001` and complete first-run setup
(creates the first admin account).

## Stack

- Frontend: React 18 + Vite + Tailwind + lucide-react
- Backend: Node.js 20 + Express + better-sqlite3 + bcryptjs + multer
- DB: SQLite with WAL mode, FK enforcement on
- Auth: bcrypt password hashing, DB-backed Bearer tokens, sliding 5-min expiry

## Data layout

All app data lives under `/opt/everton-stock/data/`:

- `everton.db` — main SQLite database
- `backups/` — automatic 6-hourly snapshots (last 30 kept) plus pre-upgrade snapshots
- `uploads/logo` — uploaded brand logo (if set)

## Useful commands

```bash
sudo systemctl status everton-stock      # service status
sudo systemctl restart everton-stock     # restart after config change
sudo journalctl -u everton-stock -f      # live logs
```

## How "Close Month" works

When you close a month (manually or automatically):

1. The current period is timestamped as closed and saved into the `periods` table
   along with totals (transactions and items).
2. A new period is opened immediately, labelled for the new month.
3. All new transactions automatically attach to the new period.
4. Live History and Reports screens scope to the **current** period.
5. The Monthly Reports page lets you drill into any closed period.

Stock levels are not affected. A "Close Month" is only a bookmark in time.
