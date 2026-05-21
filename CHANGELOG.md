# Changelog

## v3.5.2 — 2026-05-21

### Diagnostic build
- Added detailed server-side logging to trace why theme saves return 401. After this update, every PUT to `/api/branding/theme` writes diagnostic lines to the systemd journal so we can pinpoint the failing middleware.

---

## v3.5.1 — 2026-05-20

### Fixed (CRITICAL)
- **Saving theme colours or toggling light/dark mode logged you out**. The global `/api/branding/*` route was bypassing auth for ALL methods (GET + PUT), so PUT requests reached the route handler without `req.user` set, and `requireAdmin` returned 401, which the frontend interprets as session-expired. Now only GETs to `/branding` and `/branding/logo` bypass auth (which is correct — the login screen needs to read branding before you sign in).

---

## v3.5.0 — 2026-05-20

### New: Appearance customisation 🎨

Settings → new **Appearance** section lets admins fully customise how the app looks:

- **Theme Mode**: 🌙 Dark (default) or ☀️ Light
- **Four custom colour pickers**:
  - **Accent / Primary** — buttons, highlights, the Issue Stock button
  - **Success** — green ✓ marks, "Available" badges
  - **Warning** — low-stock alerts, "OUT" badges, overdue
  - **Info / Updates** — update buttons, info badges
- **Live preview** below the pickers so you see your changes before saving
- **Reset to Defaults** button (workshop amber on dark)

The colours are picked per-server. Pick once, every user on that install sees the new look. Hex codes can be typed in directly or chosen via the colour wheel.

Danger / delete colours (red) are intentionally non-customisable — universal warning signal.

### Technical
- Theme stored in `settings` table (alongside system name/subtitle)
- Applied via a single `<ThemeStyle>` component that injects scoped CSS overrides for Tailwind utility classes — no class renames needed throughout the 3500-line app
- Light mode flips the zinc colour scale and remaps backgrounds/text for readability

---

## v3.4.1 — 2026-05-20

### Fixed
- "UPDATE SUCCESSFUL" banner and log box no longer linger forever after a successful update. Now:
  - Auto-dismisses 6 seconds after the green banner appears (resets server-side state back to idle).
  - Added a manual **Dismiss** button on both the success and failure cards in case you want to clear them sooner.

---

## v3.4.0 — 2026-05-18

### New: In-house tool check-in/check-out 🔧

A whole new **"Check-In/Out"** sidebar tab (admin only) for tracking physical tools that operators borrow and return — drills, grinders, measuring tools, etc. Distinct from Products (which is consumable stock).

- **Smart scan workflow**: operator scans badge → scans tool → system auto-detects whether to check OUT (tool available) or IN (tool currently with that or any operator)
- **Three sub-tabs**:
  - **Scan**: the live check-out/in counter — same vibe as Issue Stock
  - **Tool List**: add, edit, delete tools; assign barcodes; flag/clear defective; see live status (Available / Out / Defective / Overdue) at a glance
  - **History**: full audit log of every event, filterable by tool and operator
- **Per-tool overdue threshold** in days (default 1). Tools out beyond that show OVERDUE in red.
- **Defective flag**: tools can be flagged on check-in or anytime from the Tool List. Defective tools cannot be checked out. Flag persists until an admin clicks "Mark OK".
- **Notes on check-in**: optional free-text note logged with each return (e.g. "chuck wobbly", "missing battery").
- **Auto-defective**: check-in notes containing words like "defect", "broken", "damaged", "fault" auto-flag the tool as defective.

### Technical
- New `tools` and `tool_movements` SQLite tables (auto-migrate on first start)
- `barcodes` table now also supports `toolId` (a single barcode can map to product OR operator OR tool)
- New REST endpoints under `/api/tools` and `/api/tool-movements` (all admin-only)

---

## v3.3.6 — 2026-05-18

### Changed
- Sidebar footer now includes a credit link to the GitHub repo author.

---

## v3.3.5 — 2026-05-18

### New: User accounts with permissions 🔐

The old "Admin Users" page has been redesigned and renamed to **Accounts**. Two types of accounts now exist:

- **Admin** — full access to everything (same as before)
- **User** — limited access, only what you tick when creating them

When you create a User, you choose which of these 8 permissions they get:
- Issue Stock (scan barcodes)
- View Dashboard
- View Products (read-only — cannot edit or delete)
- Receive Stock (+Stock button)
- View Operators (read-only — cannot edit or delete)
- View History
- View Reports + Monthly Reports
- Apply System Updates

Users only see the sidebar entries for sections they have permission to access. They can't edit Products, Operators, Branding, or any admin-only setting — even if they try the API directly. Admins always have full access.

### Notes for existing admins

All your existing admins keep their full admin powers (the migration sets them all to `role=admin`). When you upgrade to v3.3.5, head to **Accounts** to:
- Promote any existing admin to a User if you want to restrict them
- Or simply start adding new Users with tailored permissions

### Behind the scenes
- Added `role` and `permissions` columns to the users table (auto-migrates on first start)
- New `requirePermission()` and `requireAdmin()` middleware on the server
- Every API endpoint enforces permissions; the UI only hides controls a user can't use, but the server is the source of truth
- Login and session responses now include role + permissions so the UI can adapt

---

## v3.3.2 — 2026-05-17

### Fixed
- **Update screen no longer gets stuck**. When the user triggers an update and the server then reports "done", the page now auto-reloads after 1.5 seconds — picking up the new frontend code and showing a green "✅ Update successful!" banner.
- Safety net auto-reload timeout cut from 3 min → 45 sec (typical update is 15-20 sec).
- Manual "Reload the page" button now appears after 10 sec instead of 30 sec.
- Clearer "Update successful" banner appears for 6 seconds after a successful update.

### Tip
After installing v3.3.2, the very NEXT update you do will be smooth — the new auto-reload logic only kicks in for updates done from v3.3.2+ frontend.

---

## v3.3.1 — 2026-05-17

### Fixed
- Updates window stayed on "Updating…" forever after the service restarted, because the status polls failed when the service was briefly down. Now:
  - The page auto-reloads if the update has been "running" for over 3 minutes (safety net).
  - After 30 seconds of "running", a manual "Reload the page" button appears in case the user wants to refresh sooner.
  - Friendlier message: clarifies the disconnect is expected, not a problem.

---

## v3.3.0 — 2026-05-17

### New
- **One-line installer**: Fresh installs are now a single command since the repo is public:
  ```
  curl -sL https://raw.githubusercontent.com/marsh4200/pos-stock-system/main/install.sh | sudo bash
  ```
- The installer clones the repo over HTTPS — no per-server SSH deploy key needed.
- The installer wires up the in-app updater automatically; brand-new servers can update from the app from minute one.

### Removed
- `scripts/setup-git.sh` and `scripts/bootstrap-updater.sh` — no longer needed; the main installer handles everything.

### Notes
Existing v3.2.x installs don't need to change anything. The in-app updater will pull v3.3.0 from GitHub the next time you click Update Now.

---

## v3.2.3 — 2026-05-17

### Fixed
- "Check for Updates" failed with `sudo: user everton is not allowed` because the API used `sudo -u everton git ...` while already running as `everton`. Removed the redundant sudo layer.

---

## v3.2.2 — 2026-05-17

### Fixed (CRITICAL)
- **Updater API endpoints returned "Not found"**: The SPA catch-all route was registered before the `/api/updater/*` routes, so all updater API calls were swallowed by the frontend fallback and returned a 404 JSON. Moved the catch-all to run last, so all API routes are reachable.

This fixes the in-app updater for both fresh installs and existing servers.

---

## v3.2.1 — 2026-05-17

### Fixed
- Updates section showed "Updater not configured" even when it was, due to a UI rendering bug on first load.
- Sidebar footer now correctly shows the current version.

### Notes
This is the first version delivered via the in-app updater itself. 🎉

---

## v3.2.0 — 2026-05-17

### New features
- **In-app updater**: Settings → Updates. Check for updates from GitHub and update with one click. Live progress log shown while updating.
- **One-click rollback**: After any update, a "Roll back to previous version" button appears so you can instantly revert if something's wrong.
- **Changelog viewer**: Read what's new in every version directly from Settings.
- **Auto-backup before update**: A safety snapshot of the database is taken automatically before any update or rollback.

### Behind the scenes
- GitHub is now the source of truth for the codebase.
- New `/api/updater/*` endpoints (admin-only) for version check, update trigger, status polling, and rollback.

---

## v3.1.0 — 2026-05-17

### New features
- **Monthly archiving**: Close the month manually with a button on Reports, or automatically on the 1st of each month at midnight.
- **Monthly Reports page**: Browse archived months and see full per-operator, per-product breakdowns for any past period.
- **Period dropdown in History**: Flip between the live current month and any past month.
- **Customizable branding**: Set your own system name, subtitle, and logo from Settings.
- **5-minute session timeout** (was 1 hour).

### Fixed
- Database migration ordering: indexes on new `periodId` columns are now created after the `ALTER TABLE` migrations, so v3.0 → v3.1 upgrades work cleanly.
- Installer `$SUDO -u` syntax bug when running as root.

---

## v3.0.0 — 2026-05-16

- Admin login with bcrypt password hashing
- DB-backed sessions with sliding 1-hour expiry
- Users management page
- Locked-down API (every endpoint requires auth)
- "Employees" renamed to "Operators" in UI

---

## v2.0.0 — 2026-05-15

- Migrated from per-browser localStorage to cloud SQLite (shared across devices)
- Detailed transaction history with expandable per-tx product breakdown
- Per-operator product breakdown in Reports
- CSV exports for all data
- Backup/Restore in Settings
- 6-hourly automatic database snapshots (last 30 kept)
- Date-range filters
- 10-second device sync
- Atomic stock transactions

---

## v1.0.0 — 2026-05-14

- Initial React + localStorage prototype
