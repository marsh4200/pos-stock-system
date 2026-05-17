# Changelog

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
