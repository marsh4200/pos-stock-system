// ============================================================
// EVERTON ENGINEERING - STOCK MANAGEMENT SERVER v3.1
// Adds: monthly period archiving, system settings (branding+logo),
//       5-minute sessions
// ============================================================
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'everton.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PORT = process.env.PORT || 3001;
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes, sliding

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Database setup ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    lastLoginAt TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sku TEXT,
    category TEXT,
    location TEXT,
    supplier TEXT,
    cost REAL DEFAULT 0,
    stock INTEGER DEFAULT 0,
    minStock INTEGER DEFAULT 0,
    reorderQty INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT,
    role TEXT,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS barcodes (
    value TEXT PRIMARY KEY,
    productId TEXT,
    employeeId TEXT
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    employeeId TEXT,
    type TEXT,
    status TEXT,
    totalItems INTEGER,
    createdAt TEXT,
    confirmedAt TEXT,
    periodId TEXT
  );

  CREATE TABLE IF NOT EXISTS movements (
    id TEXT PRIMARY KEY,
    productId TEXT,
    employeeId TEXT,
    type TEXT,
    quantity INTEGER,
    balanceAfter INTEGER,
    transactionId TEXT,
    notes TEXT,
    createdAt TEXT,
    periodId TEXT
  );

  CREATE TABLE IF NOT EXISTS periods (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    startedAt TEXT NOT NULL,
    closedAt TEXT,
    closedBy TEXT,
    autoClosed INTEGER DEFAULT 0,
    totalTransactions INTEGER DEFAULT 0,
    totalItems INTEGER DEFAULT 0
  );

  -- v3.4.0: in-house tools (check-out / check-in)
  CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    serial TEXT,                       -- serial / asset tag (optional)
    category TEXT,
    location TEXT,
    overdueAfterDays INTEGER DEFAULT 1,
    defective INTEGER DEFAULT 0,       -- 0/1 — defective blocks checkout
    defectiveNote TEXT,                -- last reason it was marked defective
    active INTEGER DEFAULT 1,
    createdAt TEXT,
    -- denormalized "current status" for fast lookup
    currentEmployeeId TEXT,            -- NULL if available, else who has it
    checkedOutAt TEXT                  -- NULL if available
  );

  -- Audit log of every check-out / check-in event
  CREATE TABLE IF NOT EXISTS tool_movements (
    id TEXT PRIMARY KEY,
    toolId TEXT NOT NULL,
    employeeId TEXT,                   -- who did it (operator)
    type TEXT NOT NULL,                -- 'CHECKOUT' | 'CHECKIN' | 'DEFECTIVE_FLAG' | 'DEFECTIVE_CLEAR'
    notes TEXT,
    createdAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_movements_created ON movements(createdAt);
  CREATE INDEX IF NOT EXISTS idx_movements_tx ON movements(transactionId);
  CREATE INDEX IF NOT EXISTS idx_movements_emp ON movements(employeeId);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expiresAt);
`);

// Migrate older DBs (v3.0) that don't have periodId columns or periods table
// (CREATE TABLE IF NOT EXISTS above adds new tables, but ALTER for existing tables:)
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    console.log(`Migration: added ${column} to ${table}`);
  }
}
ensureColumn('transactions', 'periodId', 'TEXT');
ensureColumn('movements', 'periodId', 'TEXT');
// v3.3.5: users get a role + permissions list
ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'admin'");
ensureColumn('users', 'permissions', "TEXT NOT NULL DEFAULT '[]'");
// v3.4.0: barcodes can also point at a tool (for in-house tool tracking)
ensureColumn('barcodes', 'toolId', 'TEXT');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tool_mov_tool ON tool_movements(toolId);
  CREATE INDEX IF NOT EXISTS idx_tool_mov_emp ON tool_movements(employeeId);
  CREATE INDEX IF NOT EXISTS idx_tool_mov_created ON tool_movements(createdAt);
  CREATE INDEX IF NOT EXISTS idx_barcodes_tool ON barcodes(toolId);
`);

// Backfill: any existing user from before v3.3.5 stays admin (this is the default,
// so nothing to do unless we ever want to migrate). All new admins/users from now
// on go through the new API which sets these properly.

// Now that periodId columns are guaranteed to exist, create the indexes
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_movements_period ON movements(periodId);
  CREATE INDEX IF NOT EXISTS idx_tx_period ON transactions(periodId);
`);

// Ensure there's always a "current" open period
function getCurrentPeriod() {
  let p = db.prepare('SELECT * FROM periods WHERE closedAt IS NULL ORDER BY startedAt DESC LIMIT 1').get();
  if (!p) {
    const id = crypto.randomBytes(6).toString('hex');
    const now = new Date();
    const label = now.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
    db.prepare('INSERT INTO periods (id, label, startedAt) VALUES (?, ?, ?)')
      .run(id, label, now.toISOString());
    // Backfill any orphan transactions/movements (older v3.0 data) into this opening period
    db.prepare('UPDATE transactions SET periodId = ? WHERE periodId IS NULL').run(id);
    db.prepare('UPDATE movements SET periodId = ? WHERE periodId IS NULL').run(id);
    p = db.prepare('SELECT * FROM periods WHERE id = ?').get(id);
    console.log(`Created opening period: ${label} (${id})`);
  }
  return p;
}
getCurrentPeriod();

// Periodically purge expired sessions
setInterval(() => {
  try { db.prepare('DELETE FROM sessions WHERE expiresAt < ?').run(new Date().toISOString()); }
  catch {}
}, 60 * 1000); // every minute

// ---------- App setup ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }); // 2 MB max for logos

const fixActive = (row) => row ? { ...row, active: !!row.active } : row;
const uid = () => crypto.randomBytes(6).toString('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

// ---------- Settings helpers ----------
function getSetting(key, def = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

// Defaults
if (getSetting('systemName') === null) setSetting('systemName', 'EVERTON ENGINEERING');
if (getSetting('systemSubtitle') === null) setSetting('systemSubtitle', 'Tooling Stock Management');

// ============================================================
// PERMISSIONS CATALOGUE
// ============================================================
// Permission IDs match what the frontend uses. Adding here is a one-stop change.
const ALL_PERMISSIONS = [
  'issue_stock',       // Issue Stock (scan barcodes)
  'view_dashboard',    // Dashboard
  'view_products',     // Products (read-only)
  'receive_stock',     // +Stock button on Products
  'view_operators',    // Operators (read-only)
  'view_history',      // History
  'view_reports',      // Reports + Monthly Reports
  'apply_updates',     // Settings → Updates → Update Now
];

function parsePermissions(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter(p => ALL_PERMISSIONS.includes(p)) : [];
  } catch { return []; }
}

function userHasPermission(user, perm) {
  if (!user) return false;
  if (user.role === 'admin') return true;        // admins can do everything
  return parsePermissions(user.permissions).includes(perm);
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!userHasPermission(req.user, perm)) {
      return res.status(403).json({ error: 'Permission denied: ' + perm });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    console.log(`[AUTH DEBUG] requireAdmin: no req.user on ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Not authenticated (admin check, no user)' });
  }
  if (req.user.role !== 'admin') {
    console.log(`[AUTH DEBUG] requireAdmin: user ${req.user.username} role=${req.user.role} blocked on ${req.method} ${req.path}`);
    return res.status(403).json({ error: 'Admins only' });
  }
  next();
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function getValidSession(token) {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return session;
}
function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}
function requireAuth(req, res, next) {
  const token = extractToken(req);
  const session = getValidSession(token);
  if (!session) {
    console.log(`[AUTH DEBUG] requireAuth: no valid session on ${req.method} ${req.path} (token present: ${!!token})`);
    return res.status(401).json({ error: 'Not authenticated (no valid session)' });
  }

  const user = db.prepare('SELECT id, username, role, permissions FROM users WHERE id = ?').get(session.userId);
  if (!user) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: 'User no longer exists' });
  }

  const newExpiry = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('UPDATE sessions SET expiresAt = ? WHERE token = ?').run(newExpiry, token);

  req.user = user;
  req.session = { ...session, expiresAt: newExpiry };
  next();
}

// ============================================================
// PUBLIC ENDPOINTS
// ============================================================
app.get('/api/auth/status', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  const token = extractToken(req);
  const session = getValidSession(token);
  let me = null;
  if (session) {
    const row = db.prepare('SELECT id, username, role, permissions FROM users WHERE id = ?').get(session.userId);
    if (row) {
      me = { id: row.id, username: row.username, role: row.role, permissions: parsePermissions(row.permissions) };
      const newExpiry = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      db.prepare('UPDATE sessions SET expiresAt = ? WHERE token = ?').run(newExpiry, token);
    }
  }
  res.json({
    needsSetup: userCount === 0,
    authenticated: !!me,
    user: me,
    sessionTtlMs: SESSION_TTL_MS,
    allPermissions: ALL_PERMISSIONS,
  });
});

// Public branding (so login/setup screens can show the customised name)
app.get('/api/branding', (req, res) => {
  const logoPath = path.join(UPLOAD_DIR, 'logo');
  const hasLogo = fs.existsSync(logoPath);
  res.json({
    systemName: getSetting('systemName', 'EVERTON ENGINEERING'),
    systemSubtitle: getSetting('systemSubtitle', 'Tooling Stock Management'),
    hasLogo,
    logoVersion: hasLogo ? fs.statSync(logoPath).mtimeMs : 0,
    // v3.5.0 — theme
    theme: {
      mode: getSetting('themeMode', 'dark'),                 // 'dark' | 'light'
      accent: getSetting('themeAccent', '#f59e0b'),          // primary action / highlight (default amber-500)
      success: getSetting('themeSuccess', '#10b981'),        // green / available
      warning: getSetting('themeWarning', '#f59e0b'),        // amber alerts / low stock
      info: getSetting('themeInfo', '#0ea5e9'),              // blue / updates
    },
  });
});

// Save theme (admin only)
app.put('/api/branding/theme', requireAdmin, (req, res) => {
  console.log(`[AUTH DEBUG] /branding/theme handler reached. User: ${req.user?.username} (${req.user?.role}). Body keys: ${Object.keys(req.body || {}).join(',')}`);
  const { mode, accent, success, warning, info } = req.body || {};
  const hex = /^#[0-9a-fA-F]{6}$/;
  if (mode && (mode === 'dark' || mode === 'light')) setSetting('themeMode', mode);
  if (accent && hex.test(accent)) setSetting('themeAccent', accent.toLowerCase());
  if (success && hex.test(success)) setSetting('themeSuccess', success.toLowerCase());
  if (warning && hex.test(warning)) setSetting('themeWarning', warning.toLowerCase());
  if (info && hex.test(info)) setSetting('themeInfo', info.toLowerCase());
  res.json({ ok: true });
});

app.get('/api/branding/logo', (req, res) => {
  const logoPath = path.join(UPLOAD_DIR, 'logo');
  const metaPath = path.join(UPLOAD_DIR, 'logo.meta');
  if (!fs.existsSync(logoPath)) return res.status(404).end();
  const mime = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf-8') : 'image/png';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(logoPath).pipe(res);
});

app.post('/api/auth/setup', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  if (userCount > 0) return res.status(403).json({ error: 'Setup already complete' });

  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const id = uid();
  const hash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  // First user is always an admin with full permissions
  db.prepare("INSERT INTO users (id, username, passwordHash, createdAt, role, permissions) VALUES (?, ?, ?, ?, 'admin', '[]')")
    .run(id, username.trim(), hash, now);

  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)')
    .run(token, id, now, expiresAt);
  db.prepare('UPDATE users SET lastLoginAt = ? WHERE id = ?').run(now, id);

  res.json({
    ok: true, token,
    user: { id, username: username.trim(), role: 'admin', permissions: [] },
    expiresAt,
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const ok = bcrypt.compareSync(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

  const token = newToken();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)')
    .run(token, user.id, now, expiresAt);
  db.prepare('UPDATE users SET lastLoginAt = ? WHERE id = ?').run(now, user.id);

  res.json({
    ok: true, token,
    user: {
      id: user.id, username: user.username,
      role: user.role, permissions: parsePermissions(user.permissions),
    },
    expiresAt,
  });
});

app.post('/api/auth/logout', (req, res) => {
  const token = extractToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

// ============================================================
// USER MANAGEMENT (ADMIN ONLY)
// ============================================================
// All endpoints below require the caller to be an admin, EXCEPT
// the change-own-password endpoint which any logged-in user can use.

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, username, role, permissions, createdAt, lastLoginAt FROM users ORDER BY role, username').all();
  res.json(rows.map(r => ({
    id: r.id, username: r.username,
    role: r.role, permissions: parsePermissions(r.permissions),
    createdAt: r.createdAt, lastLoginAt: r.lastLoginAt,
  })));
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, role, permissions } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim())) {
    return res.status(400).json({ error: 'Username already taken' });
  }
  const finalRole = role === 'admin' ? 'admin' : 'user';
  const filtered = Array.isArray(permissions) ? permissions.filter(p => ALL_PERMISSIONS.includes(p)) : [];
  const finalPerms = finalRole === 'admin' ? '[]' : JSON.stringify(filtered);

  const id = uid();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, username, passwordHash, createdAt, role, permissions) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, username.trim(), hash, new Date().toISOString(), finalRole, finalPerms);
  res.json({ ok: true, id });
});

// Update a user's role and permissions (admin only)
app.put('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { role, permissions } = req.body || {};
  const newRole = role === 'admin' ? 'admin' : 'user';

  // Prevent removing the last admin
  if (target.role === 'admin' && newRole !== 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'admin'").get().n;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot demote the last admin' });
  }

  const filtered = Array.isArray(permissions) ? permissions.filter(p => ALL_PERMISSIONS.includes(p)) : [];
  const newPerms = newRole === 'admin' ? '[]' : JSON.stringify(filtered);
  db.prepare('UPDATE users SET role = ?, permissions = ? WHERE id = ?').run(newRole, newPerms, target.id);

  // Invalidate target's sessions if role/permissions changed for someone OTHER than themselves
  if (req.user.id !== target.id) {
    db.prepare('DELETE FROM sessions WHERE userId = ?').run(target.id);
  }

  res.json({ ok: true });
});

app.post('/api/users/:id/password', requireAuth, (req, res) => {
  const { newPassword, currentPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Self-change: must provide current password.
  // Admin changing someone else's: allowed.
  // Non-admin trying to change someone else's: denied.
  if (req.user.id === target.id) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
    if (!bcrypt.compareSync(currentPassword, target.passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  } else {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(hash, target.id);
  if (req.user.id !== target.id) {
    db.prepare('DELETE FROM sessions WHERE userId = ?').run(target.id);
  }
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (req.user.id === req.params.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  // Don't allow deleting the last admin
  if (target.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'admin'").get().n;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// ALL DATA ENDPOINTS BELOW REQUIRE AUTH
// ============================================================
app.use('/api', (req, res, next) => {
  // Trace every request through the global API gate so we can see auth flow
  if (req.path.includes('theme') || req.path.includes('branding')) {
    console.log(`[AUTH DEBUG] global /api gate: ${req.method} ${req.path} (authHeader present: ${!!req.headers.authorization})`);
  }
  // Public endpoints: login/setup/status, health, and READ-ONLY branding (so login screen can show the logo + theme)
  if (req.path.startsWith('/auth/')) return next();
  if (req.path === '/health') return next();
  if (req.method === 'GET' && (req.path === '/branding' || req.path === '/branding/logo')) return next();
  return requireAuth(req, res, next);
});

// ============================================================
// SYSTEM SETTINGS (name, subtitle, logo)
// ============================================================
app.get('/api/system', (req, res) => {
  // Readable by any logged-in user (so the header can display the name)
  res.json({
    systemName: getSetting('systemName', 'EVERTON ENGINEERING'),
    systemSubtitle: getSetting('systemSubtitle', 'Tooling Stock Management'),
    hasLogo: fs.existsSync(path.join(UPLOAD_DIR, 'logo')),
    sessionTtlMinutes: SESSION_TTL_MS / 60000,
  });
});

app.put('/api/system', requireAdmin, (req, res) => {
  const { systemName, systemSubtitle } = req.body || {};
  if (typeof systemName === 'string') setSetting('systemName', systemName.slice(0, 100));
  if (typeof systemSubtitle === 'string') setSetting('systemSubtitle', systemSubtitle.slice(0, 200));
  res.json({ ok: true });
});

app.post('/api/system/logo', requireAdmin, logoUpload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const mime = req.file.mimetype || 'image/png';
  if (!mime.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' });
  fs.writeFileSync(path.join(UPLOAD_DIR, 'logo'), req.file.buffer);
  fs.writeFileSync(path.join(UPLOAD_DIR, 'logo.meta'), mime);
  res.json({ ok: true });
});

app.delete('/api/system/logo', requireAdmin, (req, res) => {
  try { fs.unlinkSync(path.join(UPLOAD_DIR, 'logo')); } catch {}
  try { fs.unlinkSync(path.join(UPLOAD_DIR, 'logo.meta')); } catch {}
  res.json({ ok: true });
});

// ============================================================
// PERIODS (monthly archives)
// ============================================================
function closePeriod(reason = 'manual', closedByUserId = null) {
  return db.transaction(() => {
    const current = db.prepare('SELECT * FROM periods WHERE closedAt IS NULL ORDER BY startedAt DESC LIMIT 1').get();
    if (!current) return null;

    const now = new Date();
    const totals = db.prepare(`
      SELECT COUNT(DISTINCT id) as txCount, COALESCE(SUM(totalItems), 0) as itemCount
      FROM transactions WHERE periodId = ?
    `).get(current.id);

    db.prepare(`UPDATE periods SET closedAt = ?, closedBy = ?, autoClosed = ?,
                totalTransactions = ?, totalItems = ? WHERE id = ?`)
      .run(now.toISOString(), closedByUserId, reason === 'auto' ? 1 : 0,
           totals.txCount, totals.itemCount, current.id);

    // Start a new period
    const newId = uid();
    const newLabel = now.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
    db.prepare('INSERT INTO periods (id, label, startedAt) VALUES (?, ?, ?)')
      .run(newId, newLabel, now.toISOString());

    return { closed: { ...current, closedAt: now.toISOString(), totalTransactions: totals.txCount, totalItems: totals.itemCount },
             new: { id: newId, label: newLabel, startedAt: now.toISOString() } };
  })();
}

app.get('/api/periods', requirePermission('view_reports'), (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM transactions t WHERE t.periodId = p.id) as txCount,
           (SELECT COALESCE(SUM(totalItems),0) FROM transactions t WHERE t.periodId = p.id) as itemCount
    FROM periods p ORDER BY startedAt DESC
  `).all();
  res.json(rows);
});

// /periods/current is needed by anyone who can issue stock OR view reports/history (it's lightweight metadata).
// Allow any logged-in user.
app.get('/api/periods/current', (req, res) => {
  const p = getCurrentPeriod();
  res.json(p);
});

app.post('/api/periods/close', requireAdmin, (req, res) => {
  try {
    const r = closePeriod('manual', req.user.id);
    if (!r) return res.status(400).json({ error: 'No open period to close' });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================================
// PRODUCTS
// ============================================================
// Read needs view_products. Writes are admin-only.
app.get('/api/products', requirePermission('view_products'), (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY name').all().map(fixActive));
});

app.post('/api/products', requireAdmin, (req, res) => {
  const p = req.body;
  db.prepare(`INSERT INTO products
    (id, name, sku, category, location, supplier, cost, stock, minStock, reorderQty, active)
    VALUES (@id, @name, @sku, @category, @location, @supplier, @cost, @stock, @minStock, @reorderQty, @active)`)
    .run({
      id: p.id, name: p.name, sku: p.sku || '', category: p.category || '',
      location: p.location || '', supplier: p.supplier || '', cost: Number(p.cost) || 0,
      stock: Number(p.stock) || 0, minStock: Number(p.minStock) || 0,
      reorderQty: Number(p.reorderQty) || 0, active: p.active === false ? 0 : 1,
    });
  res.json({ ok: true });
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
  const p = req.body;
  db.prepare(`UPDATE products SET
    name=@name, sku=@sku, category=@category, location=@location, supplier=@supplier,
    cost=@cost, stock=@stock, minStock=@minStock, reorderQty=@reorderQty, active=@active
    WHERE id=@id`)
    .run({
      id: req.params.id, name: p.name, sku: p.sku || '', category: p.category || '',
      location: p.location || '', supplier: p.supplier || '', cost: Number(p.cost) || 0,
      stock: Number(p.stock) || 0, minStock: Number(p.minStock) || 0,
      reorderQty: Number(p.reorderQty) || 0, active: p.active === false ? 0 : 1,
    });
  res.json({ ok: true });
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    db.prepare('DELETE FROM barcodes WHERE productId = ?').run(id);
  });
  tx(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// EMPLOYEES (operators)
// ============================================================
// Read needs view_operators OR issue_stock (the scan screen needs to look up operators).
app.get('/api/employees', (req, res) => {
  if (req.user.role === 'admin') return res.json(db.prepare('SELECT * FROM employees ORDER BY name').all().map(fixActive));
  if (userHasPermission(req.user, 'view_operators') || userHasPermission(req.user, 'issue_stock')) {
    return res.json(db.prepare('SELECT * FROM employees ORDER BY name').all().map(fixActive));
  }
  return res.status(403).json({ error: 'Permission denied' });
});

app.post('/api/employees', requireAdmin, (req, res) => {
  const e = req.body;
  db.prepare(`INSERT INTO employees (id, name, code, role, active) VALUES (@id, @name, @code, @role, @active)`)
    .run({
      id: e.id, name: e.name, code: e.code || '', role: e.role || 'operator',
      active: e.active === false ? 0 : 1,
    });
  res.json({ ok: true });
});

app.put('/api/employees/:id', requireAdmin, (req, res) => {
  const e = req.body;
  db.prepare(`UPDATE employees SET name=@name, code=@code, role=@role, active=@active WHERE id=@id`)
    .run({
      id: req.params.id, name: e.name, code: e.code || '', role: e.role || 'operator',
      active: e.active === false ? 0 : 1,
    });
  res.json({ ok: true });
});

app.delete('/api/employees/:id', requireAdmin, (req, res) => {
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM employees WHERE id = ?').run(id);
    db.prepare('DELETE FROM barcodes WHERE employeeId = ?').run(id);
  });
  tx(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// BARCODES
// ============================================================
// Read: needed by anyone scanning. Writes: admin only.
app.get('/api/barcodes', (req, res) => {
  res.json(db.prepare('SELECT * FROM barcodes').all());
});

app.post('/api/barcodes', requireAdmin, (req, res) => {
  const { value, productId, employeeId, toolId } = req.body;
  try {
    db.prepare('INSERT INTO barcodes (value, productId, employeeId, toolId) VALUES (?, ?, ?, ?)')
      .run(value, productId || null, employeeId || null, toolId || null);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Barcode already exists' });
  }
});

app.delete('/api/barcodes/:value', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM barcodes WHERE value = ?').run(req.params.value);
  res.json({ ok: true });
});

// ============================================================
// TOOLS (in-house check-out / check-in) — v3.4.0
// ============================================================
// Admin only — both reading and writing — per user request:
// "No — only Admins should handle tools"

// List all tools with computed status
app.get('/api/tools', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM tools ORDER BY name`).all();
  res.json(rows.map(t => ({ ...t, defective: !!t.defective, active: t.active !== 0 })));
});

// Single tool with full history
app.get('/api/tools/:id', requireAdmin, (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  const history = db.prepare(`
    SELECT tm.*, e.name as employeeName, e.code as employeeCode
    FROM tool_movements tm
    LEFT JOIN employees e ON e.id = tm.employeeId
    WHERE tm.toolId = ?
    ORDER BY tm.createdAt DESC
  `).all(req.params.id);
  res.json({ ...tool, defective: !!tool.defective, active: tool.active !== 0, history });
});

// Create tool
app.post('/api/tools', requireAdmin, (req, res) => {
  const t = req.body || {};
  if (!t.name) return res.status(400).json({ error: 'Name is required' });
  const id = t.id || uid();
  db.prepare(`INSERT INTO tools
    (id, name, serial, category, location, overdueAfterDays, defective, defectiveNote, active, createdAt, currentEmployeeId, checkedOutAt)
    VALUES (@id, @name, @serial, @category, @location, @overdueAfterDays, 0, NULL, 1, @createdAt, NULL, NULL)`)
    .run({
      id,
      name: t.name,
      serial: t.serial || '',
      category: t.category || '',
      location: t.location || '',
      overdueAfterDays: Number.isFinite(Number(t.overdueAfterDays)) ? Number(t.overdueAfterDays) : 1,
      createdAt: new Date().toISOString(),
    });
  // Optional initial barcode
  if (t._barcode) {
    try {
      db.prepare('INSERT INTO barcodes (value, productId, employeeId, toolId) VALUES (?, NULL, NULL, ?)').run(t._barcode, id);
    } catch {}
  }
  res.json({ ok: true, id });
});

// Update tool (admin only — not the checked-out state, that's via check-in/out endpoints)
app.put('/api/tools/:id', requireAdmin, (req, res) => {
  const t = req.body || {};
  const existing = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tool not found' });
  db.prepare(`UPDATE tools SET
    name = @name, serial = @serial, category = @category, location = @location,
    overdueAfterDays = @overdueAfterDays, active = @active
    WHERE id = @id`).run({
    id: req.params.id,
    name: t.name ?? existing.name,
    serial: t.serial ?? existing.serial,
    category: t.category ?? existing.category,
    location: t.location ?? existing.location,
    overdueAfterDays: Number.isFinite(Number(t.overdueAfterDays)) ? Number(t.overdueAfterDays) : existing.overdueAfterDays,
    active: t.active === false ? 0 : 1,
  });
  res.json({ ok: true });
});

// Delete tool (also wipes its barcodes; history is preserved as orphan rows)
app.delete('/api/tools/:id', requireAdmin, (req, res) => {
  const tx = db.transaction((id) => {
    db.prepare('DELETE FROM tools WHERE id = ?').run(id);
    db.prepare('DELETE FROM barcodes WHERE toolId = ?').run(id);
  });
  tx(req.params.id);
  res.json({ ok: true });
});

// Toggle defective flag
app.post('/api/tools/:id/defective', requireAdmin, (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  const { defective, note, employeeId } = req.body || {};
  const flagAs = defective ? 1 : 0;
  db.prepare('UPDATE tools SET defective = ?, defectiveNote = ? WHERE id = ?')
    .run(flagAs, defective ? (note || tool.defectiveNote || null) : null, req.params.id);
  db.prepare('INSERT INTO tool_movements (id, toolId, employeeId, type, notes, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uid(), req.params.id, employeeId || null, flagAs ? 'DEFECTIVE_FLAG' : 'DEFECTIVE_CLEAR', note || null, new Date().toISOString());
  res.json({ ok: true });
});

// === Core check-out / check-in (smart scan) ===
// Body: { toolBarcode, employeeBarcode?, employeeId?, notes? }
// Looks up the tool by barcode; if it's available -> checkout; if it's out -> checkin.
app.post('/api/tools/scan', requireAdmin, (req, res) => {
  const { toolBarcode, employeeBarcode, employeeId: directEmployeeId, notes } = req.body || {};
  if (!toolBarcode) return res.status(400).json({ error: 'Tool barcode required' });

  // Resolve tool
  const toolBc = db.prepare('SELECT * FROM barcodes WHERE value = ? AND toolId IS NOT NULL').get(toolBarcode);
  if (!toolBc) return res.status(404).json({ error: `Unknown tool barcode: ${toolBarcode}` });
  const tool = db.prepare('SELECT * FROM tools WHERE id = ? AND active = 1').get(toolBc.toolId);
  if (!tool) return res.status(404).json({ error: 'Tool not found or inactive' });

  // Resolve operator — either from barcode or direct ID
  let employeeId = directEmployeeId || null;
  if (!employeeId && employeeBarcode) {
    const empBc = db.prepare('SELECT * FROM barcodes WHERE value = ? AND employeeId IS NOT NULL').get(employeeBarcode);
    if (!empBc) return res.status(404).json({ error: `Unknown operator badge: ${employeeBarcode}` });
    employeeId = empBc.employeeId;
  }

  const isAvailable = tool.currentEmployeeId === null;
  const now = new Date().toISOString();

  if (isAvailable) {
    // === CHECKOUT ===
    if (tool.defective) return res.status(400).json({ error: `Tool is flagged defective: ${tool.defectiveNote || 'no reason given'}` });
    if (!employeeId) return res.status(400).json({ error: 'Operator required to check out' });
    const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(employeeId);
    if (!emp) return res.status(404).json({ error: 'Operator not found or inactive' });

    const tx = db.transaction(() => {
      db.prepare('UPDATE tools SET currentEmployeeId = ?, checkedOutAt = ? WHERE id = ?')
        .run(employeeId, now, tool.id);
      db.prepare('INSERT INTO tool_movements (id, toolId, employeeId, type, notes, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(uid(), tool.id, employeeId, 'CHECKOUT', notes || null, now);
    });
    tx();
    res.json({ ok: true, action: 'checkout', tool: { ...tool, currentEmployeeId: employeeId, checkedOutAt: now }, operator: emp });
  } else {
    // === CHECKIN ===
    // We allow check-in regardless of which operator is bringing it back
    const tx = db.transaction(() => {
      db.prepare('UPDATE tools SET currentEmployeeId = NULL, checkedOutAt = NULL WHERE id = ?').run(tool.id);
      db.prepare('INSERT INTO tool_movements (id, toolId, employeeId, type, notes, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(uid(), tool.id, employeeId || tool.currentEmployeeId, 'CHECKIN', notes || null, now);
      // If a defect note was attached on check-in, auto-flag defective
      if (notes && /defect|broken|damag|fault|not work/i.test(notes)) {
        db.prepare('UPDATE tools SET defective = 1, defectiveNote = ? WHERE id = ?').run(notes, tool.id);
      }
    });
    tx();
    const refreshed = db.prepare('SELECT * FROM tools WHERE id = ?').get(tool.id);
    res.json({ ok: true, action: 'checkin', tool: { ...refreshed, defective: !!refreshed.defective }, previouslyCheckedOutTo: tool.currentEmployeeId });
  }
});

// Recent tool movements (across all tools) — for dashboard/history view
app.get('/api/tool-movements', requireAdmin, (req, res) => {
  const { toolId, employeeId, limit } = req.query;
  const lim = Math.min(Number(limit) || 200, 1000);
  let sql = `
    SELECT tm.*, t.name as toolName, t.serial as toolSerial,
           e.name as employeeName, e.code as employeeCode
    FROM tool_movements tm
    LEFT JOIN tools t ON t.id = tm.toolId
    LEFT JOIN employees e ON e.id = tm.employeeId
    WHERE 1=1`;
  const params = [];
  if (toolId) { sql += ' AND tm.toolId = ?'; params.push(toolId); }
  if (employeeId) { sql += ' AND tm.employeeId = ?'; params.push(employeeId); }
  sql += ' ORDER BY tm.createdAt DESC LIMIT ?';
  params.push(lim);
  res.json(db.prepare(sql).all(...params));
});

// ============================================================
// TRANSACTIONS & MOVEMENTS
// ============================================================
app.get('/api/transactions', requirePermission('view_history'), (req, res) => {
  const { periodId } = req.query;
  if (periodId) {
    res.json(db.prepare('SELECT * FROM transactions WHERE periodId = ? ORDER BY createdAt DESC').all(periodId));
  } else {
    res.json(db.prepare('SELECT * FROM transactions ORDER BY createdAt DESC').all());
  }
});

app.get('/api/movements', requirePermission('view_history'), (req, res) => {
  const { periodId } = req.query;
  if (periodId) {
    res.json(db.prepare('SELECT * FROM movements WHERE periodId = ? ORDER BY createdAt DESC').all(periodId));
  } else {
    res.json(db.prepare('SELECT * FROM movements ORDER BY createdAt DESC').all());
  }
});

app.post('/api/issue', requirePermission('issue_stock'), (req, res) => {
  const { employeeId, lines, notes } = req.body;
  if (!employeeId || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'employeeId and lines required' });
  }

  const now = new Date().toISOString();
  const txId = uid();
  const period = getCurrentPeriod();

  try {
    const result = db.transaction(() => {
      const totalItems = lines.reduce((s, l) => s + l.qty, 0);
      const movements = [];

      for (const line of lines) {
        const p = db.prepare('SELECT * FROM products WHERE id = ?').get(line.productId);
        if (!p) throw new Error(`Product ${line.productId} not found`);
        if (p.stock < line.qty) throw new Error(`Not enough stock for ${p.name}`);

        const newStock = p.stock - line.qty;
        db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, p.id);

        const mvId = uid();
        db.prepare(`INSERT INTO movements
          (id, productId, employeeId, type, quantity, balanceAfter, transactionId, notes, createdAt, periodId)
          VALUES (?, ?, ?, 'ISSUE', ?, ?, ?, ?, ?, ?)`)
          .run(mvId, p.id, employeeId, -line.qty, newStock, txId, notes || '', now, period.id);

        movements.push({ id: mvId, productId: p.id, quantity: -line.qty, balanceAfter: newStock });
      }

      db.prepare(`INSERT INTO transactions
        (id, employeeId, type, status, totalItems, createdAt, confirmedAt, periodId)
        VALUES (?, ?, 'ISSUE', 'CONFIRMED', ?, ?, ?, ?)`)
        .run(txId, employeeId, totalItems, now, now, period.id);

      return { txId, totalItems, movements };
    })();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/receive', requirePermission('receive_stock'), (req, res) => {
  const { productId, qty, notes } = req.body;
  if (!productId || !qty || qty <= 0) return res.status(400).json({ error: 'productId and qty required' });

  const now = new Date().toISOString();
  const period = getCurrentPeriod();
  try {
    const result = db.transaction(() => {
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!p) throw new Error('Product not found');

      const newStock = p.stock + qty;
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, productId);

      const mvId = uid();
      const txId = uid();
      db.prepare(`INSERT INTO movements
        (id, productId, employeeId, type, quantity, balanceAfter, transactionId, notes, createdAt, periodId)
        VALUES (?, ?, NULL, 'RECEIVE', ?, ?, ?, ?, ?, ?)`)
        .run(mvId, productId, qty, newStock, txId, notes || '', now, period.id);

      return { newStock };
    })();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================================
// DETAILED HISTORY (filterable by period)
// ============================================================
app.get('/api/history/detailed', requirePermission('view_history'), (req, res) => {
  const { employeeId, periodId, from, to, limit = 500 } = req.query;
  let where = '1=1';
  const params = [];
  if (employeeId) { where += ' AND t.employeeId = ?'; params.push(employeeId); }
  if (periodId) { where += ' AND t.periodId = ?'; params.push(periodId); }
  if (from) { where += ' AND t.createdAt >= ?'; params.push(from); }
  if (to) { where += ' AND t.createdAt <= ?'; params.push(to); }

  const txs = db.prepare(`
    SELECT t.*, e.name AS employeeName, e.code AS employeeCode
    FROM transactions t
    LEFT JOIN employees e ON e.id = t.employeeId
    WHERE ${where}
    ORDER BY t.createdAt DESC
    LIMIT ?
  `).all(...params, Number(limit));

  const result = txs.map(tx => {
    const lines = db.prepare(`
      SELECT m.*, p.name AS productName, p.sku AS productSku, p.category AS productCategory
      FROM movements m
      LEFT JOIN products p ON p.id = m.productId
      WHERE m.transactionId = ?
      ORDER BY p.name
    `).all(tx.id);
    return { ...tx, lines };
  });
  res.json(result);
});

// ============================================================
// BACKUP & RESTORE
// ============================================================
function buildBackup() {
  return {
    version: 31,
    exportedAt: new Date().toISOString(),
    settings: db.prepare('SELECT * FROM settings').all(),
    products: db.prepare('SELECT * FROM products').all().map(fixActive),
    employees: db.prepare('SELECT * FROM employees').all().map(fixActive),
    barcodes: db.prepare('SELECT * FROM barcodes').all(),
    periods: db.prepare('SELECT * FROM periods').all(),
    transactions: db.prepare('SELECT * FROM transactions').all(),
    movements: db.prepare('SELECT * FROM movements').all(),
    users: db.prepare('SELECT id, username, passwordHash, createdAt, lastLoginAt FROM users').all(),
  };
}

app.get('/api/backup', requireAdmin, (req, res) => {
  const backup = buildBackup();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="everton-backup-${ts}.json"`);
  res.json(backup);
});

app.get('/api/backups/list', requireAdmin, (req, res) => {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  res.json(files);
});

app.post('/api/backups/snapshot', requireAdmin, (req, res) => {
  const backup = buildBackup();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `auto-backup-${ts}.json`;
  fs.writeFileSync(path.join(BACKUP_DIR, filename), JSON.stringify(backup, null, 2));
  const all = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
  if (all.length > 30) {
    all.slice(0, all.length - 30).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  }
  res.json({ ok: true, filename });
});

app.post('/api/restore', requireAdmin, upload.single('backup'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const data = JSON.parse(req.file.buffer.toString('utf-8'));
    if (!data.products || !data.employees) return res.status(400).json({ error: 'Invalid backup file' });

    const preBackup = buildBackup();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(BACKUP_DIR, `pre-restore-${ts}.json`), JSON.stringify(preBackup, null, 2));

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM movements').run();
      db.prepare('DELETE FROM transactions').run();
      db.prepare('DELETE FROM periods').run();
      db.prepare('DELETE FROM barcodes').run();
      db.prepare('DELETE FROM products').run();
      db.prepare('DELETE FROM employees').run();

      const insP = db.prepare(`INSERT INTO products
        (id, name, sku, category, location, supplier, cost, stock, minStock, reorderQty, active)
        VALUES (@id, @name, @sku, @category, @location, @supplier, @cost, @stock, @minStock, @reorderQty, @active)`);
      for (const p of data.products) {
        insP.run({
          id: p.id, name: p.name, sku: p.sku || '', category: p.category || '',
          location: p.location || '', supplier: p.supplier || '', cost: Number(p.cost) || 0,
          stock: Number(p.stock) || 0, minStock: Number(p.minStock) || 0,
          reorderQty: Number(p.reorderQty) || 0, active: p.active === false ? 0 : 1,
        });
      }

      const insE = db.prepare(`INSERT INTO employees (id, name, code, role, active)
        VALUES (@id, @name, @code, @role, @active)`);
      for (const e of data.employees) {
        insE.run({
          id: e.id, name: e.name, code: e.code || '', role: e.role || 'operator',
          active: e.active === false ? 0 : 1,
        });
      }

      const insB = db.prepare('INSERT INTO barcodes (value, productId, employeeId) VALUES (?, ?, ?)');
      for (const b of (data.barcodes || [])) {
        insB.run(b.value, b.productId || null, b.employeeId || null);
      }

      if (Array.isArray(data.periods)) {
        const insPer = db.prepare(`INSERT INTO periods (id, label, startedAt, closedAt, closedBy, autoClosed, totalTransactions, totalItems)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const p of data.periods) {
          insPer.run(p.id, p.label, p.startedAt, p.closedAt || null, p.closedBy || null,
            p.autoClosed || 0, p.totalTransactions || 0, p.totalItems || 0);
        }
      }

      const insT = db.prepare(`INSERT INTO transactions
        (id, employeeId, type, status, totalItems, createdAt, confirmedAt, periodId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const t of (data.transactions || [])) {
        insT.run(t.id, t.employeeId, t.type, t.status, t.totalItems, t.createdAt, t.confirmedAt, t.periodId || null);
      }

      const insM = db.prepare(`INSERT INTO movements
        (id, productId, employeeId, type, quantity, balanceAfter, transactionId, notes, createdAt, periodId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const m of (data.movements || [])) {
        insM.run(m.id, m.productId, m.employeeId, m.type, m.quantity, m.balanceAfter,
          m.transactionId, m.notes || '', m.createdAt, m.periodId || null);
      }

      if (Array.isArray(data.settings)) {
        db.prepare('DELETE FROM settings').run();
        const insS = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
        for (const s of data.settings) insS.run(s.key, s.value);
      }

      if (Array.isArray(data.users) && data.users.length > 0) {
        db.prepare('DELETE FROM sessions').run();
        db.prepare('DELETE FROM users').run();
        const insU = db.prepare('INSERT INTO users (id, username, passwordHash, createdAt, lastLoginAt) VALUES (?, ?, ?, ?, ?)');
        for (const u of data.users) {
          insU.run(u.id, u.username, u.passwordHash, u.createdAt, u.lastLoginAt || null);
        }
      }
    });
    tx();
    // Ensure a current period exists after restore
    getCurrentPeriod();
    res.json({ ok: true, restored: { products: data.products.length, employees: data.employees.length } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================================
// CLEAR
// ============================================================
app.post('/api/clear/history', requireAdmin, (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM movements').run();
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM periods').run();
  });
  tx();
  getCurrentPeriod();
  res.json({ ok: true });
});

app.post('/api/clear/all', requireAdmin, (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM movements').run();
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM periods').run();
    db.prepare('DELETE FROM barcodes').run();
    db.prepare('DELETE FROM products').run();
    db.prepare('DELETE FROM employees').run();
  });
  tx();
  getCurrentPeriod();
  res.json({ ok: true });
});

// ============================================================
// HEALTH
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '3.1.0', time: new Date().toISOString() });
});

// ============================================================
// SERVE FRONTEND
// ============================================================
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
// Serve static files; the SPA catch-all is registered AFTER all API routes (at the bottom)
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
}

// ============================================================
// AUTO-BACKUP every 6 hours
// ============================================================
setInterval(() => {
  try {
    if (db.prepare('SELECT COUNT(*) as n FROM users').get().n === 0) return;
    const backup = buildBackup();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(BACKUP_DIR, `auto-backup-${ts}.json`), JSON.stringify(backup, null, 2));
    const all = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
    if (all.length > 30) {
      all.slice(0, all.length - 30).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
    }
    console.log(`[${new Date().toISOString()}] Auto-backup saved`);
  } catch (e) {
    console.error('Auto-backup failed:', e.message);
  }
}, 6 * 60 * 60 * 1000);

// ============================================================
// AUTO-CLOSE MONTH on 1st of each month (check every 30 min)
// ============================================================
let lastMonthChecked = new Date().getMonth();
setInterval(() => {
  try {
    const now = new Date();
    const currentMonth = now.getMonth();
    if (currentMonth !== lastMonthChecked) {
      // Month rolled over
      const current = db.prepare('SELECT * FROM periods WHERE closedAt IS NULL ORDER BY startedAt DESC LIMIT 1').get();
      if (current) {
        const startedMonth = new Date(current.startedAt).getMonth();
        if (startedMonth !== currentMonth) {
          // Period was started in a previous month - close it
          const r = closePeriod('auto', null);
          if (r) console.log(`[${now.toISOString()}] Auto-closed period: ${r.closed.label} -> new period: ${r.new.label}`);
        }
      }
      lastMonthChecked = currentMonth;
    }
  } catch (e) {
    console.error('Auto-close month failed:', e.message);
  }
}, 30 * 60 * 1000); // every 30 minutes

// ============================================================
// IN-APP UPDATER API
// ============================================================
const REPO_DIR = process.env.REPO_DIR || '/opt/pos-stock-system';
const INSTALL_DIR = process.env.INSTALL_DIR || '/opt/everton-stock';
const UPDATER_LOG = path.join(DATA_DIR, 'updater.log');
const UPDATER_STATE = path.join(DATA_DIR, 'updater.state');

function readLocalVersion() {
  try {
    return fs.readFileSync(path.join(INSTALL_DIR, 'VERSION'), 'utf8').trim();
  } catch {
    try {
      return fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
    } catch {
      return 'unknown';
    }
  }
}

function readChangelog() {
  for (const p of [path.join(INSTALL_DIR, 'CHANGELOG.md'), path.join(__dirname, '..', 'CHANGELOG.md')]) {
    try { return fs.readFileSync(p, 'utf8'); } catch {}
  }
  return '';
}

function readUpdaterState() {
  try { return fs.readFileSync(UPDATER_STATE, 'utf8').trim(); } catch { return 'idle'; }
}

function readUpdaterLog(maxLines = 200) {
  try {
    const content = fs.readFileSync(UPDATER_LOG, 'utf8');
    const lines = content.split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch { return ''; }
}

// Current version + git SHA
app.get('/api/updater/version', (req, res) => {
  let sha = null;
  let branch = null;
  try {
    sha = execSync(`git -C ${REPO_DIR} rev-parse HEAD`, { encoding: 'utf8' }).trim().slice(0, 8);
    branch = execSync(`git -C ${REPO_DIR} rev-parse --abbrev-ref HEAD`, { encoding: 'utf8' }).trim();
  } catch {}
  res.json({
    version: readLocalVersion(),
    sha,
    branch,
    repoConfigured: fs.existsSync(REPO_DIR + '/.git'),
  });
});

// Check GitHub for newer version
app.get('/api/updater/check', requirePermission('apply_updates'), (req, res) => {
  if (!fs.existsSync(REPO_DIR + '/.git')) {
    return res.status(400).json({ error: 'Updater not configured. Run scripts/setup-git.sh on the server.' });
  }
  try {
    // Fetch (as everton, since the deploy key lives there)
    execSync(`git -C ${REPO_DIR} fetch origin main`, { stdio: 'pipe', timeout: 30000 });
    const remoteVersion = execSync(`git -C ${REPO_DIR} show origin/main:VERSION`, { encoding: 'utf8' }).trim();
    const localVersion = readLocalVersion();
    const localSha = execSync(`git -C ${REPO_DIR} rev-parse HEAD`, { encoding: 'utf8' }).trim();
    const remoteSha = execSync(`git -C ${REPO_DIR} rev-parse origin/main`, { encoding: 'utf8' }).trim();
    res.json({
      currentVersion: localVersion,
      latestVersion: remoteVersion,
      updateAvailable: localSha !== remoteSha,
      currentSha: localSha.slice(0, 8),
      latestSha: remoteSha.slice(0, 8),
      checkedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: 'Check failed: ' + (e.message || 'unknown') });
  }
});

// Trigger update (returns immediately, runs in background)
app.post('/api/updater/update', requirePermission('apply_updates'), (req, res) => {
  const state = readUpdaterState();
  if (state === 'running' || state === 'rolling-back') {
    return res.status(409).json({ error: 'An update is already in progress.' });
  }
  if (!fs.existsSync(REPO_DIR + '/scripts/updater.sh')) {
    return res.status(400).json({ error: 'Updater not configured. Run scripts/setup-git.sh on the server.' });
  }
  // Spawn detached so it survives if the service restarts during the update
  const child = spawn('sudo', ['-n', `${REPO_DIR}/scripts/updater.sh`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  res.json({ ok: true, message: 'Update started', startedBy: req.user.username });
});

// Trigger rollback
app.post('/api/updater/rollback', requirePermission('apply_updates'), (req, res) => {
  const state = readUpdaterState();
  if (state === 'running' || state === 'rolling-back') {
    return res.status(409).json({ error: 'An update is already in progress.' });
  }
  if (!fs.existsSync(path.join(DATA_DIR, 'previous-sha'))) {
    return res.status(400).json({ error: 'No previous version to roll back to.' });
  }
  const child = spawn('sudo', ['-n', `${REPO_DIR}/scripts/rollback.sh`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  res.json({ ok: true, message: 'Rollback started', startedBy: req.user.username });
});

// Live status + recent log
app.get('/api/updater/status', (req, res) => {
  res.json({
    state: readUpdaterState(),
    log: readUpdaterLog(200),
    hasPrevious: fs.existsSync(path.join(DATA_DIR, 'previous-sha')),
  });
});

// Dismiss the "done" / "failed" banner — resets state back to idle
app.post('/api/updater/dismiss', requirePermission('apply_updates'), (req, res) => {
  const state = readUpdaterState();
  if (state === 'running' || state === 'rolling-back') {
    return res.status(409).json({ error: 'An update is still in progress.' });
  }
  try { fs.writeFileSync(UPDATER_STATE, 'idle'); } catch {}
  res.json({ ok: true });
});

// Full changelog
app.get('/api/updater/changelog', (req, res) => {
  res.type('text/markdown').send(readChangelog());
});

// ============================================================
// SPA CATCH-ALL (must be after all /api routes)
// ============================================================
if (fs.existsSync(CLIENT_DIST)) {
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// ============================================================
// START
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`POS Stock Server v${readLocalVersion()} running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Session TTL: ${SESSION_TTL_MS / 60000} min`);
});
