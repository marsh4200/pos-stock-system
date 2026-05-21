import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  ScanLine, Package, Users, BarChart3, History, Plus, Trash2,
  AlertTriangle, Search, X, Check, Undo2, LogOut, TrendingDown, Box,
  Edit3, Volume2, VolumeX, Download, Upload, Settings as SettingsIcon,
  ChevronDown, ChevronRight, Save, RefreshCw, Loader2, Lock, UserCog,
  KeyRound, Eye, EyeOff, Calendar, CalendarCheck, Archive, Image,
  CloudDownload, RotateCcw, GitBranch, Sparkles, Wrench, ArrowDownToLine, ArrowUpFromLine, Clock
} from 'lucide-react';

// ============================================================
// AUTH / API LAYER
// ============================================================
const TOKEN_KEY = 'everton_token';
const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); };

async function apiRequest(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const r = await fetch(`/api${path}`, { ...options, headers });
  if (r.status === 401) {
    setToken(null);
    window.dispatchEvent(new Event('auth:expired'));
    throw new Error('Session expired');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const apiGet = (p) => apiRequest(p);
const apiPost = (p, body) => apiRequest(p, { method: 'POST', body });
const apiPut = (p, body) => apiRequest(p, { method: 'PUT', body });
const apiDelete = (p) => apiRequest(p, { method: 'DELETE' });

// ---------- Permissions ----------
const ALL_PERMISSIONS = [
  { id: 'issue_stock',    label: 'Issue Stock (scan barcodes)' },
  { id: 'view_dashboard', label: 'View Dashboard' },
  { id: 'view_products',  label: 'View Products (read-only)' },
  { id: 'receive_stock',  label: 'Receive Stock (+Stock button)' },
  { id: 'view_operators', label: 'View Operators (read-only)' },
  { id: 'view_history',   label: 'View History' },
  { id: 'view_reports',   label: 'View Reports + Monthly Reports' },
  { id: 'apply_updates',  label: 'Apply System Updates' },
];

function can(user, permission) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Array.isArray(user.permissions) && user.permissions.includes(permission);
}

function hasAccessTo(user, route) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const map = {
    scan: 'issue_stock',
    dashboard: 'view_dashboard',
    products: 'view_products',
    employees: 'view_operators',
    history: 'view_history',
    reports: 'view_reports',
    monthly: 'view_reports',
    tools: null,    // admin only
    users: null,    // admin only
    settings: null, // admin only
  };
  const perm = map[route];
  if (!perm) return false;
  return can(user, perm);
}

function firstAccessibleRoute(user) {
  if (!user) return 'scan';
  if (user.role === 'admin') return 'scan';
  const order = ['scan', 'dashboard', 'products', 'employees', 'history', 'reports', 'monthly'];
  for (const r of order) {
    if (hasAccessTo(user, r)) return r;
  }
  return null;
}

// ---------- Beep sounds ----------
function useBeeper() {
  const ctxRef = useRef(null);
  const enabledRef = useRef(true);
  const ensure = () => {
    if (!ctxRef.current) {
      try { ctxRef.current = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    }
    return ctxRef.current;
  };
  const tone = (freq, dur = 0.08, type = 'sine', vol = 0.15) => {
    if (!enabledRef.current) return;
    const ctx = ensure();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + dur);
  };
  return {
    success: () => tone(1200, 0.07),
    error: () => { tone(220, 0.12, 'square'); setTimeout(() => tone(180, 0.15, 'square'), 130); },
    confirm: () => { tone(880, 0.08); setTimeout(() => tone(1320, 0.12), 90); },
    employee: () => { tone(660, 0.06); setTimeout(() => tone(990, 0.1), 70); },
    setEnabled: (v) => { enabledRef.current = v; },
  };
}

function useBarcodeScanner(onScan, enabled = true) {
  const bufRef = useRef('');
  const lastKeyTs = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const handler = (e) => {
      const t = e.target;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      const now = Date.now();
      const dt = now - lastKeyTs.current;
      lastKeyTs.current = now;
      if (e.key === 'Enter') {
        if (bufRef.current.length >= 3) onScan(bufRef.current);
        bufRef.current = '';
        return;
      }
      if (dt > 100 && bufRef.current.length > 0) bufRef.current = '';
      if (e.key.length === 1) bufRef.current += e.key;
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onScan, enabled]);
}

const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
};
const uid = () => Math.random().toString(36).slice(2, 10);

// ============================================================
function ConfirmDialog({ title, message, confirmLabel = 'Delete', confirmClass = 'bg-red-500 hover:bg-red-400', onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100] p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-md">
        <div className="p-5">
          <h3 className="text-lg font-bold mb-2">{title}</h3>
          <p className="text-zinc-400 text-sm">{message}</p>
        </div>
        <div className="px-5 py-4 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-md">Cancel</button>
          <button onClick={onConfirm} className={`px-4 py-2 font-semibold rounded-md text-white ${confirmClass}`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, className = '', children }) {
  return (
    <div className={className}>
      <label className="block text-xs text-zinc-500 uppercase tracking-wide mb-1">{label}</label>
      {children}
    </div>
  );
}

// ============================================================
// BRANDING (used on login/setup/header)
// ============================================================
// ---------- Theme defaults ----------
const DEFAULT_THEME = {
  mode: 'dark',
  accent: '#f59e0b',   // amber-500
  success: '#10b981',  // emerald-500
  warning: '#f59e0b',  // amber-500
  info: '#0ea5e9',     // sky-500
};

// Convert hex (#RRGGBB) to "R G B" for use in CSS rgb(... / alpha)
function hexToRgb(hex) {
  const m = /^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(hex || '');
  if (!m) return '245 158 11';
  return `${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)}`;
}

// Lighten/darken hex by a percentage (-100..100). Used for hover states.
function shiftHex(hex, pct) {
  const m = /^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(hex || '');
  if (!m) return hex;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  const f = (v) => {
    const n = pct >= 0 ? v + (255 - v) * (pct / 100) : v + v * (pct / 100);
    return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  };
  return `#${f(r)}${f(g)}${f(b)}`;
}

// Pick black or white text for a given background hex, by luminance
function textOn(hex) {
  const m = /^#?([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(hex || '');
  if (!m) return '#000';
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#18181b' : '#ffffff';
}

// Inject CSS that overrides the Tailwind colour utilities we use throughout the app.
// This lets us re-theme without rewriting the JSX. Light/dark mode swaps the zinc scale.
function ThemeStyle({ theme }) {
  const t = { ...DEFAULT_THEME, ...(theme || {}) };
  const accent = t.accent, success = t.success, warning = t.warning, info = t.info;
  const accentDark = shiftHex(accent, -10);
  const accentLight = shiftHex(accent, 10);
  const onAccent = textOn(accent);

  const light = t.mode === 'light';
  // Zinc scale: dark uses the original Tailwind zinc; light flips it so darker = darker text
  const z = light ? {
    50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa',
    500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b',
  } : {
    50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa',
    500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b',
  };

  // In light mode, we re-map the "background" zincs (950, 900, 800) to white/light-greys
  // and the "text" zincs (100, 300, 400, 500) to dark greys — but we leave most things
  // intact so the layout doesn't break.
  const css = `
:root {
  --accent: ${accent};
  --accent-hover: ${accentLight};
  --accent-text: ${onAccent};
  --success: ${success};
  --warning: ${warning};
  --info: ${info};
}

/* === Accent (was amber-500) === */
.bg-amber-500 { background-color: ${accent} !important; }
.hover\\:bg-amber-400:hover { background-color: ${accentLight} !important; }
.bg-amber-500\\/5 { background-color: rgb(${hexToRgb(accent)} / 0.05) !important; }
.bg-amber-500\\/10 { background-color: rgb(${hexToRgb(accent)} / 0.10) !important; }
.bg-amber-500\\/20 { background-color: rgb(${hexToRgb(accent)} / 0.20) !important; }
.text-amber-500 { color: ${accent} !important; }
.text-amber-400 { color: ${accentLight} !important; }
.text-amber-300 { color: ${shiftHex(accent, 30)} !important; }
.text-amber-200 { color: ${shiftHex(accent, 50)} !important; }
.border-amber-500 { border-color: ${accent} !important; }
.border-amber-500\\/30 { border-color: rgb(${hexToRgb(accent)} / 0.30) !important; }
.border-amber-500\\/40 { border-color: rgb(${hexToRgb(accent)} / 0.40) !important; }
.focus\\:border-amber-500:focus { border-color: ${accent} !important; }
.accent-amber-500 { accent-color: ${accent} !important; }

/* Ensure text on amber-500 backgrounds stays readable for the chosen colour */
button.bg-amber-500, .bg-amber-500.text-zinc-900, .bg-amber-500.text-zinc-950 { color: ${onAccent} !important; }

/* === Success (was emerald-500) === */
.bg-emerald-500 { background-color: ${success} !important; }
.hover\\:bg-emerald-400:hover { background-color: ${shiftHex(success, 10)} !important; }
.bg-emerald-500\\/10 { background-color: rgb(${hexToRgb(success)} / 0.10) !important; }
.bg-emerald-500\\/15 { background-color: rgb(${hexToRgb(success)} / 0.15) !important; }
.bg-emerald-500\\/20 { background-color: rgb(${hexToRgb(success)} / 0.20) !important; }
.text-emerald-500 { color: ${success} !important; }
.text-emerald-400 { color: ${shiftHex(success, 10)} !important; }
.text-emerald-300 { color: ${shiftHex(success, 30)} !important; }
.text-emerald-200 { color: ${shiftHex(success, 50)} !important; }
.border-emerald-500\\/30 { border-color: rgb(${hexToRgb(success)} / 0.30) !important; }
.border-emerald-500\\/40 { border-color: rgb(${hexToRgb(success)} / 0.40) !important; }

/* === Info (was sky-500) === */
.bg-sky-500 { background-color: ${info} !important; }
.hover\\:bg-sky-400:hover { background-color: ${shiftHex(info, 10)} !important; }
.bg-sky-500\\/10 { background-color: rgb(${hexToRgb(info)} / 0.10) !important; }
.text-sky-400 { color: ${shiftHex(info, 10)} !important; }
.text-sky-300 { color: ${shiftHex(info, 30)} !important; }
.text-sky-200 { color: ${shiftHex(info, 50)} !important; }
.border-sky-500\\/30 { border-color: rgb(${hexToRgb(info)} / 0.30) !important; }
.hover\\:text-sky-300:hover { color: ${shiftHex(info, 30)} !important; }

${light ? `
/* === LIGHT MODE === flips zinc scale on backgrounds; keeps text readable */
body, .bg-zinc-950 { background-color: #ffffff !important; color: #18181b !important; }
.bg-zinc-900 { background-color: #f4f4f5 !important; }
.bg-zinc-800 { background-color: #e4e4e7 !important; }
.bg-zinc-700 { background-color: #d4d4d8 !important; }
.hover\\:bg-zinc-800:hover { background-color: #e4e4e7 !important; }
.hover\\:bg-zinc-700:hover { background-color: #d4d4d8 !important; }
.bg-zinc-800\\/40 { background-color: rgb(228 228 231 / 0.5) !important; }
.bg-black\\/50 { background-color: rgb(244 244 245) !important; }
.bg-black\\/60, .bg-black\\/70 { background-color: rgb(0 0 0 / 0.4) !important; }

.text-zinc-100 { color: #18181b !important; }
.text-zinc-200 { color: #27272a !important; }
.text-zinc-300 { color: #3f3f46 !important; }
.text-zinc-400 { color: #52525b !important; }
.text-zinc-500 { color: #71717a !important; }
.text-zinc-600 { color: #a1a1aa !important; }
.text-white { color: #18181b !important; }
.hover\\:text-white:hover { color: #18181b !important; }

.border-zinc-800 { border-color: #e4e4e7 !important; }
.border-zinc-700 { border-color: #d4d4d8 !important; }

input.input, select.input, textarea.input, .input {
  background-color: #ffffff !important;
  color: #18181b !important;
  border-color: #d4d4d8 !important;
}
` : ''}
`;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

function useBranding() {
  const [branding, setBranding] = useState({
    systemName: 'EVERTON ENGINEERING',
    systemSubtitle: 'Tooling Stock Management',
    hasLogo: false, logoVersion: 0,
    theme: DEFAULT_THEME,
  });
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/branding');
      const d = await r.json();
      setBranding({ ...d, theme: { ...DEFAULT_THEME, ...(d.theme || {}) } });
    } catch {}
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { branding, refreshBranding: refresh };
}

function HeaderLogo({ branding, size = 'lg' }) {
  const cls = size === 'lg' ? 'w-16 h-16 rounded-xl' : 'w-10 h-10 rounded-lg';
  const inner = size === 'lg' ? 'w-9 h-9' : 'w-6 h-6';
  if (branding.hasLogo) {
    return (
      <div className={`${cls} bg-zinc-900 border border-zinc-800 flex items-center justify-center overflow-hidden`}>
        <img src={`/api/branding/logo?v=${branding.logoVersion}`} alt="Logo" className="w-full h-full object-contain" />
      </div>
    );
  }
  return (
    <div className={`${cls} bg-amber-500 flex items-center justify-center`}>
      <Box className={`${inner} text-zinc-900`} />
    </div>
  );
}

// ============================================================
// SETUP SCREEN
// ============================================================
function SetupScreen({ onDone, branding }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (!username.trim() || username.length < 3) return setErr('Username must be at least 3 characters');
    if (password.length < 6) return setErr('Password must be at least 6 characters');
    if (password !== confirm) return setErr('Passwords do not match');
    setBusy(true);
    try {
      const r = await fetch('/api/auth/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Setup failed');
      setToken(data.token);
      onDone(data.user);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="mb-3"><HeaderLogo branding={branding} size="lg" /></div>
          <h1 className="text-2xl font-bold tracking-tight text-center">{branding.systemName}</h1>
          <div className="text-sm text-zinc-500">{branding.systemSubtitle} — First-Time Setup</div>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center gap-2 text-amber-400 mb-1">
            <Lock className="w-4 h-4" /><h2 className="font-semibold">Create your admin account</h2>
          </div>
          <p className="text-sm text-zinc-500 mb-5">This account will be used to log in and manage everything. You can add more admins later.</p>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Admin Username">
              <input value={username} onChange={e => setUsername(e.target.value)} className="input" autoFocus />
            </Field>
            <Field label="Password (min 6 characters)">
              <div className="relative">
                <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} className="input pr-10" />
                <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </Field>
            <Field label="Confirm Password">
              <input type={showPw ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} className="input" />
            </Field>
            {err && <div className="bg-red-500/10 border border-red-500/30 text-red-300 px-3 py-2 rounded-md text-sm">{err}</div>}
            <button type="submit" disabled={busy}
              className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-900 font-bold py-3 rounded-md flex items-center justify-center gap-2">
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
              Create Admin & Continue
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// LOGIN SCREEN
// ============================================================
function LoginScreen({ onLogin, branding }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Login failed');
      setToken(data.token);
      onLogin(data.user);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="mb-3"><HeaderLogo branding={branding} size="lg" /></div>
          <h1 className="text-2xl font-bold tracking-tight text-center">{branding.systemName}</h1>
          <div className="text-sm text-zinc-500">{branding.systemSubtitle}</div>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center gap-2 text-zinc-300 mb-5">
            <Lock className="w-4 h-4 text-amber-500" /><h2 className="font-semibold">Sign in</h2>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Username">
              <input value={username} onChange={e => setUsername(e.target.value)} className="input" autoFocus />
            </Field>
            <Field label="Password">
              <div className="relative">
                <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} className="input pr-10" />
                <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </Field>
            {err && <div className="bg-red-500/10 border border-red-500/30 text-red-300 px-3 py-2 rounded-md text-sm">{err}</div>}
            <button type="submit" disabled={busy}
              className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-900 font-bold py-3 rounded-md flex items-center justify-center gap-2">
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Lock className="w-5 h-5" />}
              Sign In
            </button>
          </form>
        </div>
        <div className="text-center text-xs text-zinc-600 mt-4">Sessions expire after 5 minutes of inactivity</div>
      </div>
    </div>
  );
}

// ============================================================
// ROOT
// ============================================================
export default function App() {
  const [stage, setStage] = useState('loading');
  const [user, setUser] = useState(null);
  const { branding, refreshBranding } = useBranding();

  // Update document title when branding changes
  useEffect(() => {
    document.title = `${branding.systemName} — ${branding.systemSubtitle}`;
  }, [branding.systemName, branding.systemSubtitle]);

  const checkAuth = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/status', {
        headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
      });
      const data = await r.json();
      if (data.needsSetup) { setStage('setup'); return; }
      if (data.authenticated) { setUser(data.user); setStage('app'); return; }
      setToken(null);
      setStage('login');
    } catch (e) { setStage('login'); }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  useEffect(() => {
    const handler = () => { setUser(null); setStage('login'); };
    window.addEventListener('auth:expired', handler);
    return () => window.removeEventListener('auth:expired', handler);
  }, []);

  if (stage === 'loading') {
    return <>
      <ThemeStyle theme={branding.theme} />
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-zinc-500" /></div>
    </>;
  }
  if (stage === 'setup') return <>
    <ThemeStyle theme={branding.theme} />
    <SetupScreen branding={branding} onDone={(u) => { setUser(u); setStage('app'); }} />
  </>;
  if (stage === 'login') return <>
    <ThemeStyle theme={branding.theme} />
    <LoginScreen branding={branding} onLogin={(u) => { setUser(u); setStage('app'); }} />
  </>;
  return <>
    <ThemeStyle theme={branding.theme} />
    <MainApp user={user} branding={branding} refreshBranding={refreshBranding}
      onLogout={() => { setToken(null); setUser(null); setStage('login'); }} />
  </>;
}

// ============================================================
// MAIN APP
// ============================================================
function MainApp({ user, branding, refreshBranding, onLogout }) {
  const [products, setProducts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [barcodes, setBarcodes] = useState([]);
  const [movements, setMovements] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [currentPeriod, setCurrentPeriod] = useState(null);
  const [soundOn, setSoundOn] = useState(true);
  const [route, setRoute] = useState(() => firstAccessibleRoute(user) || 'scan');

  // If user changes (e.g., after re-login) and they don't have access to current route, redirect
  useEffect(() => {
    if (user && !hasAccessTo(user, route)) {
      const r = firstAccessibleRoute(user);
      if (r) setRoute(r);
    }
  }, [user, route]);
  const [loading, setLoading] = useState(true);
  const [connError, setConnError] = useState(false);
  const beeper = useBeeper();

  const refresh = useCallback(async () => {
    try {
      // Each promise is wrapped so a 403 (permission denied) just returns []/null
      // instead of failing the whole refresh.
      const safe = async (p, fallback) => { try { return await apiGet(p); } catch { return fallback; } };
      const [p, e, b, m, per, cur] = await Promise.all([
        can(user, 'view_products') ? safe('/products', []) : Promise.resolve([]),
        (can(user, 'view_operators') || can(user, 'issue_stock')) ? safe('/employees', []) : Promise.resolve([]),
        safe('/barcodes', []),
        can(user, 'view_history') ? safe('/movements', []) : Promise.resolve([]),
        can(user, 'view_reports') ? safe('/periods', []) : Promise.resolve([]),
        safe('/periods/current', null),
      ]);
      setProducts(p); setEmployees(e); setBarcodes(b); setMovements(m);
      setPeriods(per); setCurrentPeriod(cur);
      setConnError(false);
    } catch (err) {
      if (err.message === 'Session expired') return;
      console.error('Refresh failed:', err);
      setConnError(true);
    } finally { setLoading(false); }
  }, [user]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { beeper.setEnabled(soundOn); }, [soundOn, beeper]);
  useEffect(() => {
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  const lowStockCount = useMemo(() => products.filter(p => p.stock <= p.minStock).length, [products]);

  const doLogout = async () => {
    try { await apiPost('/auth/logout'); } catch {}
    onLogout();
  };

  if (loading) {
    return <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center"><div className="flex items-center gap-3 text-zinc-400"><Loader2 className="w-6 h-6 animate-spin" /> Loading…</div></div>;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      <header className="bg-zinc-900 border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <HeaderLogo branding={branding} size="sm" />
          <div>
            <h1 className="text-lg font-bold tracking-tight">{branding.systemName}</h1>
            <div className="text-xs text-zinc-500 -mt-0.5">{branding.systemSubtitle}</div>
          </div>
          {currentPeriod && (
            <div className="ml-4 flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded-md px-2.5 py-1 text-xs">
              <Calendar className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-zinc-400">Period:</span>
              <span className="font-semibold">{currentPeriod.label}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {connError && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 px-3 py-1.5 rounded-md text-sm">
              <AlertTriangle className="w-4 h-4" /> Connection lost
            </div>
          )}
          {lowStockCount > 0 && (
            <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 text-amber-400 px-3 py-1.5 rounded-md text-sm">
              <AlertTriangle className="w-4 h-4" /> {lowStockCount} low stock
            </div>
          )}
          <button onClick={refresh} title="Refresh" className="p-2 rounded-md hover:bg-zinc-800 text-zinc-400">
            <RefreshCw className="w-5 h-5" />
          </button>
          <button onClick={() => setSoundOn(s => !s)} className="p-2 rounded-md hover:bg-zinc-800 text-zinc-400">
            {soundOn ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
          </button>
          <div className="h-6 w-px bg-zinc-800 mx-1"></div>
          <div className="flex items-center gap-2 bg-zinc-800 rounded-md pl-3 pr-1 py-1">
            <UserCog className="w-4 h-4 text-amber-500" />
            <span className="text-sm font-medium">{user.username}</span>
            <button onClick={doLogout} title="Logout" className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <nav className="w-56 bg-zinc-900 border-r border-zinc-800 p-3 flex flex-col gap-1">
          {can(user, 'issue_stock') && <NavBtn icon={ScanLine} label="Issue Stock" active={route==='scan'} onClick={() => setRoute('scan')} highlight />}
          {can(user, 'view_dashboard') && <NavBtn icon={BarChart3} label="Dashboard" active={route==='dashboard'} onClick={() => setRoute('dashboard')} />}
          {can(user, 'view_products') && <NavBtn icon={Package} label="Products" active={route==='products'} onClick={() => setRoute('products')} />}
          {can(user, 'view_operators') && <NavBtn icon={Users} label="Operators" active={route==='employees'} onClick={() => setRoute('employees')} />}
          {can(user, 'view_history') && <NavBtn icon={History} label="History" active={route==='history'} onClick={() => setRoute('history')} />}
          {can(user, 'view_reports') && <NavBtn icon={TrendingDown} label="Reports" active={route==='reports'} onClick={() => setRoute('reports')} />}
          {can(user, 'view_reports') && <NavBtn icon={Archive} label="Monthly Reports" active={route==='monthly'} onClick={() => setRoute('monthly')} />}
          {user?.role === 'admin' && <div className="my-2 border-t border-zinc-800"></div>}
          {user?.role === 'admin' && <NavBtn icon={Wrench} label="Check-In/Out" active={route==='tools'} onClick={() => setRoute('tools')} />}
          {user?.role === 'admin' && <NavBtn icon={UserCog} label="Accounts" active={route==='users'} onClick={() => setRoute('users')} />}
          {user?.role === 'admin' && <NavBtn icon={SettingsIcon} label="Settings" active={route==='settings'} onClick={() => setRoute('settings')} />}
          <div className="mt-auto text-xs text-zinc-600 px-2 py-2">
            v3.5.0 · Cloud + Auth · Open Source project by{" "}
            <a
              href="https://github.com/marsh4200"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:underline"
            >
              marsh4200
            </a>
          </div>
        </nav>

        <main className="flex-1 overflow-auto">
          {route === 'scan' && can(user, 'issue_stock') && <ScanScreen products={products} employees={employees} barcodes={barcodes} beeper={beeper} refresh={refresh} />}
          {route === 'dashboard' && can(user, 'view_dashboard') && <Dashboard products={products} movements={movements} employees={employees} currentPeriod={currentPeriod} />}
          {route === 'products' && can(user, 'view_products') && <ProductsScreen products={products} barcodes={barcodes} beeper={beeper} refresh={refresh} canEdit={user?.role === 'admin'} canReceive={can(user, 'receive_stock')} />}
          {route === 'employees' && can(user, 'view_operators') && <EmployeesScreen employees={employees} barcodes={barcodes} movements={movements} refresh={refresh} canEdit={user?.role === 'admin'} />}
          {route === 'history' && can(user, 'view_history') && <HistoryScreen employees={employees} periods={periods} currentPeriod={currentPeriod} />}
          {route === 'reports' && can(user, 'view_reports') && <ReportsScreen products={products} movements={movements} employees={employees} currentPeriod={currentPeriod} onMonthClosed={refresh} canCloseMonth={user?.role === 'admin'} />}
          {route === 'monthly' && can(user, 'view_reports') && <MonthlyReportsScreen periods={periods} employees={employees} products={products} />}
          {route === 'tools' && user?.role === 'admin' && <ToolsScreen employees={employees} beeper={beeper} />}
          {route === 'users' && user?.role === 'admin' && <UsersScreen currentUser={user} />}
          {route === 'settings' && user?.role === 'admin' && <SettingsScreen refresh={refresh} branding={branding} refreshBranding={refreshBranding} user={user} />}
          {!hasAccessTo(user, route) && (
            <div className="p-8 text-center text-zinc-500">You don't have access to this page.</div>
          )}
        </main>
      </div>
    </div>
  );
}

function NavBtn({ icon: Icon, label, active, onClick, highlight }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-3 px-3 py-3 rounded-md text-left text-sm font-medium transition ${
        active ? (highlight ? 'bg-amber-500 text-zinc-900' : 'bg-zinc-800 text-white')
               : 'text-zinc-400 hover:bg-zinc-800 hover:text-white'
      }`}>
      <Icon className="w-5 h-5" />
      {label}
    </button>
  );
}

// ============================================================
// SCAN SCREEN
// ============================================================
function ScanScreen({ products, employees, barcodes, beeper, refresh }) {
  const [activeEmployee, setActiveEmployee] = useState(null);
  const [scanLines, setScanLines] = useState([]);
  const [flash, setFlash] = useState(null);
  const [manualScan, setManualScan] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const triggerFlash = (type, msg) => {
    setFlash({ type, msg });
    setTimeout(() => setFlash(null), 1500);
  };

  const productsById = useMemo(() => Object.fromEntries(products.map(p => [p.id, p])), [products]);

  const handleScan = useCallback((code) => {
    const trimmed = code.trim();
    if (!trimmed) return;

    if (!activeEmployee) {
      const bc = barcodes.find(b => b.value === trimmed && b.employeeId);
      const emp = bc ? employees.find(e => e.id === bc.employeeId && e.active) : null;
      if (emp) { setActiveEmployee(emp); beeper.employee(); triggerFlash('ok', `Welcome, ${emp.name}`); }
      else { beeper.error(); triggerFlash('err', `Unknown operator code: ${trimmed}`); }
      return;
    }

    const bc = barcodes.find(b => b.value === trimmed && b.productId);
    const prod = bc ? products.find(p => p.id === bc.productId && p.active) : null;
    if (!prod) { beeper.error(); triggerFlash('err', `Unknown product barcode: ${trimmed}`); return; }

    const pendingQty = scanLines.find(l => l.productId === prod.id)?.qty || 0;
    if (prod.stock - pendingQty <= 0) { beeper.error(); triggerFlash('err', `${prod.name} — no stock available`); return; }

    setScanLines(prev => {
      const idx = prev.findIndex(l => l.productId === prod.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], qty: next[idx].qty + 1 };
        return next;
      }
      return [...prev, { productId: prod.id, qty: 1 }];
    });
    beeper.success();
    triggerFlash('ok', `${prod.name} ×${pendingQty + 1}`);
  }, [activeEmployee, barcodes, employees, products, scanLines, beeper]);

  useBarcodeScanner(handleScan, true);

  const removeLast = () => {
    setScanLines(prev => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const last = next[next.length - 1];
      if (last.qty > 1) next[next.length - 1] = { ...last, qty: last.qty - 1 };
      else next.pop();
      return next;
    });
  };

  const removeLine = (productId) => setScanLines(prev => prev.filter(l => l.productId !== productId));
  const cancelSession = () => { setActiveEmployee(null); setScanLines([]); };

  const confirmIssue = async () => {
    if (!activeEmployee || scanLines.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const totalItems = scanLines.reduce((s, l) => s + l.qty, 0);
      await apiPost('/issue', { employeeId: activeEmployee.id, lines: scanLines });
      beeper.confirm();
      triggerFlash('ok', `Issued ${totalItems} item${totalItems>1?'s':''} to ${activeEmployee.name}`);
      setActiveEmployee(null);
      setScanLines([]);
      await refresh();
    } catch (err) {
      beeper.error();
      triggerFlash('err', err.message);
    } finally { setSubmitting(false); }
  };

  const onManualSubmit = (e) => {
    e.preventDefault();
    if (manualScan.trim()) { handleScan(manualScan.trim()); setManualScan(''); }
  };

  const totalItems = scanLines.reduce((s, l) => s + l.qty, 0);

  if (!activeEmployee) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 relative">
        {flash && (
          <div className={`absolute top-8 px-6 py-3 rounded-lg text-base font-semibold ${
            flash.type === 'ok' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-red-500/20 text-red-300 border border-red-500/40'
          }`}>{flash.msg}</div>
        )}
        <div className="w-32 h-32 bg-zinc-900 border-2 border-amber-500 rounded-full flex items-center justify-center mb-8 animate-pulse">
          <ScanLine className="w-16 h-16 text-amber-500" />
        </div>
        <h2 className="text-3xl font-bold mb-2">Scan operator badge</h2>
        <p className="text-zinc-500 mb-8">Scan with USB scanner or type the operator code below</p>
        {employees.length === 0 && (
          <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 px-4 py-3 rounded-md mb-4 text-sm max-w-md text-center">
            No operators yet. Go to <b>Operators</b> to add your first one.
          </div>
        )}
        {products.length === 0 && (
          <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 px-4 py-3 rounded-md mb-4 text-sm max-w-md text-center">
            No products yet. Go to <b>Products</b> to add your tooling stock.
          </div>
        )}
        <form onSubmit={onManualSubmit} className="flex gap-2 w-full max-w-md">
          <input type="text" value={manualScan} onChange={e => setManualScan(e.target.value)}
            placeholder="Or type operator code manually…"
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded-md px-4 py-3 text-base focus:outline-none focus:border-amber-500" />
          <button type="submit" className="bg-zinc-800 hover:bg-zinc-700 px-5 rounded-md">Go</button>
        </form>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6 relative">
      {flash && (
        <div className={`fixed top-20 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-lg text-base font-semibold shadow-2xl ${
          flash.type === 'ok' ? 'bg-emerald-500 text-zinc-900' : 'bg-red-500 text-white'
        }`}>{flash.msg}</div>
      )}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-amber-500 rounded-full flex items-center justify-center text-zinc-900 font-bold text-lg">
            {activeEmployee.name.split(' ').map(n => n[0]).join('').slice(0,2)}
          </div>
          <div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide">Active Session</div>
            <div className="text-xl font-bold">{activeEmployee.name}</div>
            <div className="text-xs text-zinc-500">{activeEmployee.code} · {activeEmployee.role}</div>
          </div>
        </div>
        <button onClick={cancelSession} className="flex items-center gap-2 text-zinc-400 hover:text-white px-3 py-2 rounded-md hover:bg-zinc-800">
          <LogOut className="w-4 h-4" /> End Session
        </button>
      </div>

      <div className="bg-amber-500/5 border border-amber-500/30 rounded-lg p-4 mb-4 flex items-center gap-3">
        <ScanLine className="w-6 h-6 text-amber-500 animate-pulse" />
        <div className="text-amber-200">Scan a product barcode — each scan adds 1 to its quantity</div>
        <form onSubmit={onManualSubmit} className="ml-auto flex gap-2">
          <input type="text" value={manualScan} onChange={e => setManualScan(e.target.value)}
            placeholder="Manual barcode…"
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 text-sm w-48 focus:outline-none focus:border-amber-500" />
          <button type="submit" className="bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded-md text-sm">Add</button>
        </form>
      </div>

      <div className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden flex flex-col">
        <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between text-xs text-zinc-500 uppercase tracking-wide">
          <span>Scanned Items</span>
          <button onClick={removeLast} disabled={scanLines.length === 0}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed normal-case">
            <Undo2 className="w-4 h-4" /> Remove Last Scan
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {scanLines.length === 0 ? (
            <div className="h-full flex items-center justify-center text-zinc-600 text-sm">No items scanned yet</div>
          ) : (
            <table className="w-full">
              <thead className="bg-zinc-900 text-xs text-zinc-500 uppercase tracking-wide sticky top-0">
                <tr>
                  <th className="text-left px-4 py-2">Product</th>
                  <th className="text-left px-4 py-2">SKU</th>
                  <th className="text-right px-4 py-2">Stock</th>
                  <th className="text-right px-4 py-2">Qty</th>
                  <th className="text-right px-4 py-2">Remaining</th>
                  <th className="w-12"></th>
                </tr>
              </thead>
              <tbody>
                {scanLines.map(line => {
                  const p = productsById[line.productId];
                  if (!p) return null;
                  const remaining = p.stock - line.qty;
                  const low = remaining <= p.minStock;
                  return (
                    <tr key={line.productId} className="border-t border-zinc-800 hover:bg-zinc-800/40">
                      <td className="px-4 py-3 font-medium">{p.name}</td>
                      <td className="px-4 py-3 text-zinc-500 font-mono text-xs">{p.sku}</td>
                      <td className="px-4 py-3 text-right text-zinc-400">{p.stock}</td>
                      <td className="px-4 py-3 text-right">
                        <span className="inline-flex items-center justify-center min-w-[2.5rem] h-9 px-3 bg-amber-500 text-zinc-900 font-bold rounded-md">×{line.qty}</span>
                      </td>
                      <td className={`px-4 py-3 text-right font-semibold ${low ? 'text-amber-400' : 'text-emerald-400'}`}>{remaining}</td>
                      <td className="px-2 py-3">
                        <button onClick={() => removeLine(line.productId)} className="text-zinc-500 hover:text-red-400 p-1">
                          <X className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-4 py-4 border-t border-zinc-800 bg-zinc-900 flex items-center justify-between">
          <div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide">Total Items</div>
            <div className="text-3xl font-bold">{totalItems}</div>
          </div>
          <div className="flex gap-3">
            <button onClick={cancelSession} className="px-6 py-4 bg-zinc-800 hover:bg-zinc-700 rounded-md font-semibold">Cancel</button>
            <button onClick={confirmIssue} disabled={scanLines.length === 0 || submitting}
              className="px-8 py-4 bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-900 font-bold rounded-md flex items-center gap-2 text-lg">
              {submitting ? <Loader2 className="w-6 h-6 animate-spin" /> : <Check className="w-6 h-6" />}
              CONFIRM & ISSUE
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// DASHBOARD
// ============================================================
function Dashboard({ products, movements, employees, currentPeriod }) {
  const totalProducts = products.length;
  const totalStockValue = products.reduce((s, p) => s + p.stock * (p.cost || 0), 0);
  const lowStock = products.filter(p => p.stock <= p.minStock);
  const today = new Date(); today.setHours(0,0,0,0);
  const itemsIssuedToday = movements.filter(m => new Date(m.createdAt) >= today && m.type === 'ISSUE')
    .reduce((s, m) => s + Math.abs(m.quantity), 0);
  // Only show current period movements as "recent"
  const currentMvs = currentPeriod ? movements.filter(m => m.periodId === currentPeriod.id) : movements;
  const recent = currentMvs.slice(0, 10);
  const empById = Object.fromEntries(employees.map(e => [e.id, e]));
  const prodById = Object.fromEntries(products.map(p => [p.id, p]));

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-1">Dashboard</h2>
      {currentPeriod && <p className="text-sm text-zinc-500 mb-6">Current period: <span className="text-amber-400 font-medium">{currentPeriod.label}</span> · started {fmtDate(currentPeriod.startedAt)}</p>}

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Products" value={totalProducts} icon={Package} />
        <StatCard label="Stock Value" value={`R ${totalStockValue.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}`} icon={BarChart3} />
        <StatCard label="Items Issued Today" value={itemsIssuedToday} icon={ScanLine} />
        <StatCard label="Low Stock Items" value={lowStock.length} icon={AlertTriangle} accent={lowStock.length > 0 ? 'amber' : null} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <h3 className="font-semibold flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-500" /> Low Stock Alerts</h3>
            <span className="text-xs text-zinc-500">{lowStock.length} items</span>
          </div>
          <div className="max-h-96 overflow-auto">
            {lowStock.length === 0 ? (
              <div className="p-8 text-center text-zinc-500 text-sm">All stock levels healthy ✓</div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {lowStock.map(p => (
                    <tr key={p.id} className="border-t border-zinc-800">
                      <td className="px-4 py-2">
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-zinc-500 font-mono">{p.sku}</div>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className={`font-bold ${p.stock === 0 ? 'text-red-400' : 'text-amber-400'}`}>{p.stock}</div>
                        <div className="text-xs text-zinc-500">min {p.minStock}</div>
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-zinc-400">Reorder {p.reorderQty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800">
            <h3 className="font-semibold flex items-center gap-2"><History className="w-4 h-4" /> Recent Activity (this period)</h3>
          </div>
          <div className="max-h-96 overflow-auto">
            {recent.length === 0 ? (
              <div className="p-8 text-center text-zinc-500 text-sm">No movements yet this period</div>
            ) : (
              <ul className="divide-y divide-zinc-800">
                {recent.map(m => {
                  const p = prodById[m.productId];
                  const e = empById[m.employeeId];
                  return (
                    <li key={m.id} className="px-4 py-2.5 flex items-center justify-between text-sm">
                      <div>
                        <div className="font-medium">{p?.name || 'Unknown'}</div>
                        <div className="text-xs text-zinc-500">{e?.name || 'System'} · {fmtDateTime(m.createdAt)}</div>
                      </div>
                      <div className={`font-bold ${m.quantity < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                        {m.quantity > 0 ? '+' : ''}{m.quantity}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, accent }) {
  const accentClasses = accent === 'amber' ? 'border-amber-500/40 bg-amber-500/5' : 'border-zinc-800 bg-zinc-900';
  return (
    <div className={`border ${accentClasses} rounded-lg p-4`}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-zinc-500 uppercase tracking-wide">{label}</div>
        <Icon className={`w-4 h-4 ${accent === 'amber' ? 'text-amber-500' : 'text-zinc-600'}`} />
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

// ============================================================
// PRODUCTS (mostly unchanged from v3)
// ============================================================
function ProductsScreen({ products, barcodes, beeper, refresh, canEdit = true, canReceive = true }) {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [receiving, setReceiving] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return products.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q)
    );
  }, [products, search]);

  const saveProduct = async (data) => {
    try {
      if (data.id) {
        await apiPut(`/products/${data.id}`, data);
      } else {
        const newProd = { ...data, id: uid(), stock: Number(data.stock) || 0, active: true };
        await apiPost('/products', newProd);
        if (data._barcode) await apiPost('/barcodes', { value: data._barcode, productId: newProd.id, employeeId: null });
      }
      setEditing(null);
      await refresh();
    } catch (err) { alert('Save failed: ' + err.message); }
  };

  const addBarcode = async (productId, value) => {
    if (!value.trim()) return;
    try { await apiPost('/barcodes', { value, productId, employeeId: null }); await refresh(); }
    catch (err) { alert(err.message); }
  };

  const removeBarcode = async (value) => {
    await apiDelete(`/barcodes/${encodeURIComponent(value)}`);
    await refresh();
  };

  const receiveStock = async (productId, qty, notes) => {
    if (qty <= 0) return;
    try {
      await apiPost('/receive', { productId, qty, notes });
      beeper.confirm();
      setReceiving(null);
      await refresh();
    } catch (err) { alert(err.message); }
  };

  const deleteProduct = async (product) => {
    await apiDelete(`/products/${product.id}`);
    setDeleting(null);
    await refresh();
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">Products</h2>
        {canEdit && (
          <button onClick={() => setEditing('new')}
            className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-zinc-900 font-semibold px-4 py-2 rounded-md">
            <Plus className="w-4 h-4" /> New Product
          </button>
        )}
      </div>
      <div className="relative mb-4">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, SKU, or category…"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-md pl-10 pr-4 py-2.5 focus:outline-none focus:border-amber-500" />
      </div>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {products.length === 0 ? (
          <div className="p-12 text-center">
            <Package className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
            <div className="text-zinc-400 font-medium mb-1">No products yet</div>
            <div className="text-zinc-600 text-sm">Click "New Product" to add your first item</div>
          </div>
        ) : (
          <table className="w-full">
            <thead className="text-xs text-zinc-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3">Product</th>
                <th className="text-left px-4 py-3">SKU</th>
                <th className="text-left px-4 py-3">Category</th>
                <th className="text-right px-4 py-3">Stock</th>
                <th className="text-right px-4 py-3">Min</th>
                <th className="text-left px-4 py-3">Location</th>
                <th className="text-left px-4 py-3">Barcodes</th>
                <th className="w-44"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const bcs = barcodes.filter(b => b.productId === p.id);
                const low = p.stock <= p.minStock;
                return (
                  <tr key={p.id} className="border-t border-zinc-800 hover:bg-zinc-800/40">
                    <td className="px-4 py-3 font-medium">{p.name}</td>
                    <td className="px-4 py-3 text-zinc-500 font-mono text-xs">{p.sku}</td>
                    <td className="px-4 py-3 text-zinc-400 text-sm">{p.category}</td>
                    <td className={`px-4 py-3 text-right font-bold ${low ? 'text-amber-400' : ''}`}>{p.stock}</td>
                    <td className="px-4 py-3 text-right text-zinc-500 text-sm">{p.minStock}</td>
                    <td className="px-4 py-3 text-zinc-400 text-sm">{p.location}</td>
                    <td className="px-4 py-3 text-xs text-zinc-500 font-mono">
                      {bcs.length === 0 ? <span className="text-red-400">none</span> : `${bcs.length} barcode${bcs.length>1?'s':''}`}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 justify-end items-center">
                        {canReceive && (
                          <button onClick={() => setReceiving(p.id)}
                            className="text-xs bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 px-2 py-1 rounded">+Stock</button>
                        )}
                        {canEdit && (
                          <>
                            <button onClick={() => setEditing(p)} className="text-zinc-400 hover:text-white p-1"><Edit3 className="w-4 h-4" /></button>
                            <button onClick={() => setDeleting(p)} className="text-zinc-400 hover:text-red-400 p-1"><Trash2 className="w-4 h-4" /></button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {products.length > 0 && filtered.length === 0 && (
          <div className="p-8 text-center text-zinc-500 text-sm">No products match</div>
        )}
      </div>
      {editing && (
        <ProductModal product={editing === 'new' ? null : editing}
          barcodes={barcodes.filter(b => editing !== 'new' && b.productId === editing.id)}
          onSave={saveProduct} onClose={() => setEditing(null)}
          onAddBarcode={addBarcode} onRemoveBarcode={removeBarcode} />
      )}
      {receiving && <ReceiveStockModal product={products.find(p => p.id === receiving)} onSave={receiveStock} onClose={() => setReceiving(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete "${deleting.name}"?`}
          message="This permanently removes the product and all its barcodes. Past transaction history remains but will show this product as 'deleted product'. This cannot be undone."
          confirmLabel="Delete Product"
          onConfirm={() => deleteProduct(deleting)}
          onCancel={() => setDeleting(null)} />
      )}
    </div>
  );
}

function ProductModal({ product, barcodes, onSave, onClose, onAddBarcode, onRemoveBarcode }) {
  const [form, setForm] = useState(product || { name: '', sku: '', category: '', location: '', supplier: '', cost: 0, stock: 0, minStock: 0, reorderQty: 0, active: true, _barcode: '' });
  const [newBc, setNewBc] = useState('');
  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-auto">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-lg font-bold">{product ? 'Edit Product' : 'New Product'}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 grid grid-cols-2 gap-4">
          <Field label="Name *" className="col-span-2"><input value={form.name} onChange={e => upd('name', e.target.value)} className="input" /></Field>
          <Field label="SKU"><input value={form.sku} onChange={e => upd('sku', e.target.value)} className="input font-mono" /></Field>
          <Field label="Category"><input value={form.category} onChange={e => upd('category', e.target.value)} className="input" /></Field>
          <Field label="Location"><input value={form.location} onChange={e => upd('location', e.target.value)} className="input" /></Field>
          <Field label="Supplier"><input value={form.supplier} onChange={e => upd('supplier', e.target.value)} className="input" /></Field>
          <Field label="Cost (R)"><input type="number" step="0.01" value={form.cost} onChange={e => upd('cost', e.target.value)} className="input" /></Field>
          <Field label={product ? "Current Stock (read-only)" : "Initial Stock"}>
            <input type="number" value={form.stock} onChange={e => upd('stock', e.target.value)} className="input" disabled={!!product} />
          </Field>
          <Field label="Min Stock"><input type="number" value={form.minStock} onChange={e => upd('minStock', e.target.value)} className="input" /></Field>
          <Field label="Reorder Qty"><input type="number" value={form.reorderQty} onChange={e => upd('reorderQty', e.target.value)} className="input" /></Field>
          {!product && (
            <Field label="Initial Barcode (optional)" className="col-span-2">
              <input value={form._barcode || ''} onChange={e => upd('_barcode', e.target.value)} className="input font-mono" placeholder="Scan or type product barcode" />
            </Field>
          )}
          {product && (
            <div className="col-span-2 border-t border-zinc-800 pt-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Barcodes</div>
              <div className="flex flex-wrap gap-2 mb-2">
                {barcodes.length === 0 ? <div className="text-sm text-zinc-500">No barcodes yet</div> : barcodes.map(b => (
                  <div key={b.value} className="flex items-center gap-1 bg-zinc-800 text-sm font-mono px-2 py-1 rounded">
                    {b.value}
                    <button onClick={() => onRemoveBarcode(b.value)} className="text-zinc-500 hover:text-red-400"><X className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={newBc} onChange={e => setNewBc(e.target.value)} className="input font-mono" placeholder="Scan or type new barcode" />
                <button onClick={() => { onAddBarcode(product.id, newBc); setNewBc(''); }}
                  className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-md whitespace-nowrap text-sm">Add Barcode</button>
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-md">Cancel</button>
          <button onClick={() => form.name.trim() && onSave(form)}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-zinc-900 font-semibold rounded-md">
            {product ? 'Save Changes' : 'Create Product'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReceiveStockModal({ product, onSave, onClose }) {
  const [qty, setQty] = useState(0);
  const [notes, setNotes] = useState('');
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-md">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-lg font-bold">Receive Stock</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <div className="font-semibold">{product.name}</div>
            <div className="text-xs text-zinc-500">{product.sku} · Current stock: {product.stock}</div>
          </div>
          <Field label="Quantity Received"><input type="number" value={qty} onChange={e => setQty(Number(e.target.value))} className="input" autoFocus /></Field>
          <Field label="Notes (optional)"><input value={notes} onChange={e => setNotes(e.target.value)} className="input" placeholder="PO number, supplier ref, etc." /></Field>
        </div>
        <div className="px-5 py-4 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-md">Cancel</button>
          <button onClick={() => onSave(product.id, qty, notes)} disabled={qty <= 0}
            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-zinc-900 font-semibold rounded-md">
            Receive {qty > 0 ? `+${qty}` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// OPERATORS (unchanged)
// ============================================================
function EmployeesScreen({ employees, barcodes, movements, refresh, canEdit = true }) {
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const saveEmployee = async (data) => {
    try {
      if (data.id) {
        await apiPut(`/employees/${data.id}`, data);
      } else {
        const newEmp = { ...data, id: uid(), active: true };
        await apiPost('/employees', newEmp);
        if (data.code) await apiPost('/barcodes', { value: data.code, productId: null, employeeId: newEmp.id });
      }
      setEditing(null);
      await refresh();
    } catch (err) { alert('Save failed: ' + err.message); }
  };

  const deleteEmployee = async (emp) => {
    await apiDelete(`/employees/${emp.id}`);
    setDeleting(null);
    await refresh();
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-2xl font-bold">Operators</h2>
          <p className="text-sm text-zinc-500 mt-1">Workshop staff who scan their badge to take stock. They don't log in to this system.</p>
        </div>
        {canEdit && (
          <button onClick={() => setEditing('new')}
            className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-zinc-900 font-semibold px-4 py-2 rounded-md">
            <Plus className="w-4 h-4" /> New Operator
          </button>
        )}
      </div>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {employees.length === 0 ? (
          <div className="p-12 text-center">
            <Users className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
            <div className="text-zinc-400 font-medium mb-1">No operators yet</div>
            <div className="text-zinc-600 text-sm">Click "New Operator" to add your first one</div>
          </div>
        ) : (
          <table className="w-full">
            <thead className="text-xs text-zinc-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3">Name</th>
                <th className="text-left px-4 py-3">Code / Badge</th>
                <th className="text-left px-4 py-3">Role</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {employees.map(e => {
                const hasHistory = movements.some(m => m.employeeId === e.id);
                return (
                  <tr key={e.id} className="border-t border-zinc-800 hover:bg-zinc-800/40">
                    <td className="px-4 py-3 font-medium">{e.name}</td>
                    <td className="px-4 py-3 font-mono text-sm text-zinc-400">{e.code}</td>
                    <td className="px-4 py-3 text-sm text-zinc-400 capitalize">{e.role}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded ${e.active ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-700 text-zinc-400'}`}>
                        {e.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 justify-end">
                        {canEdit && (
                          <>
                            <button onClick={() => setEditing(e)} className="text-zinc-400 hover:text-white p-1"><Edit3 className="w-4 h-4" /></button>
                            <button onClick={() => setDeleting({ emp: e, hasHistory })} className="text-zinc-400 hover:text-red-400 p-1"><Trash2 className="w-4 h-4" /></button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {editing && <EmployeeModal employee={editing === 'new' ? null : editing} onSave={saveEmployee} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete "${deleting.emp.name}"?`}
          message={deleting.hasHistory
            ? "This operator has transaction history. Deleting removes them and their badge code, but past transactions remain (shown as 'deleted operator'). Consider Deactivating instead."
            : "This permanently removes the operator and their badge code. This cannot be undone."}
          confirmLabel="Delete Operator"
          onConfirm={() => deleteEmployee(deleting.emp)}
          onCancel={() => setDeleting(null)} />
      )}
    </div>
  );
}

function EmployeeModal({ employee, onSave, onClose }) {
  const [form, setForm] = useState(employee || { name: '', code: '', role: 'operator', active: true });
  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-md">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-lg font-bold">{employee ? 'Edit Operator' : 'New Operator'}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          <Field label="Full Name"><input value={form.name} onChange={e => upd('name', e.target.value)} className="input" /></Field>
          <Field label="Operator Code (used as badge barcode)">
            <input value={form.code} onChange={e => upd('code', e.target.value)} className="input font-mono" placeholder="e.g. EMP001 or 12345" />
          </Field>
          <Field label="Role">
            <select value={form.role} onChange={e => upd('role', e.target.value)} className="input">
              <option value="operator">Operator</option>
              <option value="supervisor">Supervisor</option>
              <option value="apprentice">Apprentice</option>
            </select>
          </Field>
          {employee && (
            <Field label="Status">
              <select value={form.active ? 'active' : 'inactive'} onChange={e => upd('active', e.target.value === 'active')} className="input">
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </Field>
          )}
        </div>
        <div className="px-5 py-4 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-md">Cancel</button>
          <button onClick={() => onSave(form)} className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-zinc-900 font-semibold rounded-md">
            {employee ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// HISTORY with period dropdown
// ============================================================
function HistoryScreen({ employees, periods, currentPeriod }) {
  const [filterEmp, setFilterEmp] = useState('');
  const [filterPeriod, setFilterPeriod] = useState(currentPeriod?.id || '');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [data, setData] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (currentPeriod && !filterPeriod) setFilterPeriod(currentPeriod.id);
  }, [currentPeriod, filterPeriod]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterEmp) params.set('employeeId', filterEmp);
      if (filterPeriod) params.set('periodId', filterPeriod);
      if (filterFrom) params.set('from', new Date(filterFrom).toISOString());
      if (filterTo) {
        const t = new Date(filterTo); t.setHours(23,59,59,999);
        params.set('to', t.toISOString());
      }
      const result = await apiGet(`/history/detailed?${params.toString()}`);
      setData(result);
    } catch (err) { console.error(err); } finally { setLoading(false); }
  }, [filterEmp, filterPeriod, filterFrom, filterTo]);

  useEffect(() => { load(); }, [load]);

  const toggle = (id) => setExpanded(e => ({ ...e, [id]: !e[id] }));

  const exportCSV = () => {
    const rows = [['Date/Time', 'Period', 'Transaction ID', 'Operator', 'Operator Code', 'Product', 'SKU', 'Category', 'Quantity', 'Balance After', 'Notes']];
    const periodLabel = periods.find(p => p.id === filterPeriod)?.label || 'All';
    data.forEach(tx => {
      tx.lines.forEach(l => {
        rows.push([
          fmtDateTime(tx.createdAt), periodLabel, tx.id, tx.employeeName || '(deleted)', tx.employeeCode || '',
          l.productName || '(deleted)', l.productSku || '', l.productCategory || '',
          Math.abs(l.quantity), l.balanceAfter, l.notes || ''
        ]);
      });
    });
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `history-${periodLabel.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0,10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const totalLines = data.reduce((s, tx) => s + tx.lines.length, 0);
  const totalItems = data.reduce((s, tx) => s + tx.lines.reduce((ss, l) => ss + Math.abs(l.quantity), 0), 0);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">Transaction History</h2>
        <button onClick={exportCSV} disabled={data.length === 0}
          className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 px-4 py-2 rounded-md text-sm">
          <Download className="w-4 h-4" /> Export Detailed CSV
        </button>
      </div>

      <div className="flex gap-3 mb-4 items-end flex-wrap">
        <Field label="Period">
          <select value={filterPeriod} onChange={e => setFilterPeriod(e.target.value)} className="input min-w-[200px]">
            <option value="">All Periods</option>
            {periods.map(p => (
              <option key={p.id} value={p.id}>
                {p.label} {!p.closedAt ? '(current)' : '(closed)'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Operator">
          <select value={filterEmp} onChange={e => setFilterEmp(e.target.value)} className="input">
            <option value="">All Operators</option>
            {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label="From"><input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} className="input" /></Field>
        <Field label="To"><input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} className="input" /></Field>
        <button onClick={() => { setFilterEmp(''); setFilterPeriod(currentPeriod?.id || ''); setFilterFrom(''); setFilterTo(''); }}
          className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-md text-sm">Reset</button>
        <div className="ml-auto text-sm text-zinc-500 self-center">
          {data.length} transactions · {totalLines} lines · {totalItems} items total
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-zinc-500" /></div>
        ) : data.length === 0 ? (
          <div className="p-12 text-center text-zinc-500 text-sm">No transactions found</div>
        ) : (
          <table className="w-full">
            <thead className="text-xs text-zinc-500 uppercase tracking-wide bg-zinc-900">
              <tr>
                <th className="w-10"></th>
                <th className="text-left px-4 py-3">Date/Time</th>
                <th className="text-left px-4 py-3">Type</th>
                <th className="text-left px-4 py-3">Operator</th>
                <th className="text-right px-4 py-3">Distinct Items</th>
                <th className="text-right px-4 py-3">Total Qty</th>
                <th className="text-left px-4 py-3 pl-6">Transaction ID</th>
              </tr>
            </thead>
            <tbody>
              {data.map(tx => {
                const totalQty = tx.lines.reduce((s, l) => s + Math.abs(l.quantity), 0);
                const isOpen = expanded[tx.id];
                return (
                  <React.Fragment key={tx.id}>
                    <tr className="border-t border-zinc-800 hover:bg-zinc-800/40 cursor-pointer" onClick={() => toggle(tx.id)}>
                      <td className="px-2 py-2.5 text-center">
                        {isOpen ? <ChevronDown className="w-4 h-4 inline text-zinc-500" /> : <ChevronRight className="w-4 h-4 inline text-zinc-500" />}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-400 text-sm">{fmtDateTime(tx.createdAt)}</td>
                      <td className="px-4 py-2.5"><span className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-300">{tx.type}</span></td>
                      <td className="px-4 py-2.5 font-medium">{tx.employeeName || <span className="text-zinc-600 italic">deleted operator</span>}</td>
                      <td className="px-4 py-2.5 text-right text-zinc-400">{tx.lines.length}</td>
                      <td className="px-4 py-2.5 text-right font-bold text-amber-400">{totalQty}</td>
                      <td className="px-4 py-2.5 pl-6 font-mono text-xs text-zinc-500">{tx.id}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-zinc-950">
                        <td></td>
                        <td colSpan={6} className="px-4 py-3">
                          <div className="border border-zinc-800 rounded-md overflow-hidden">
                            <table className="w-full text-sm">
                              <thead className="bg-zinc-900 text-xs text-zinc-500 uppercase">
                                <tr>
                                  <th className="text-left px-3 py-2">Product</th>
                                  <th className="text-left px-3 py-2">SKU</th>
                                  <th className="text-left px-3 py-2">Category</th>
                                  <th className="text-right px-3 py-2">Quantity Taken</th>
                                  <th className="text-right px-3 py-2">Stock After</th>
                                </tr>
                              </thead>
                              <tbody>
                                {tx.lines.map(l => (
                                  <tr key={l.id} className="border-t border-zinc-800">
                                    <td className="px-3 py-2 font-medium">{l.productName || <span className="text-zinc-600 italic">deleted product</span>}</td>
                                    <td className="px-3 py-2 font-mono text-xs text-zinc-500">{l.productSku}</td>
                                    <td className="px-3 py-2 text-zinc-400">{l.productCategory}</td>
                                    <td className="px-3 py-2 text-right font-bold text-amber-400">{Math.abs(l.quantity)}</td>
                                    <td className="px-3 py-2 text-right text-zinc-400">{l.balanceAfter}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ============================================================
// REPORTS - current period, with "Close Month" button
// ============================================================
function ReportsScreen({ products, movements, employees, currentPeriod, onMonthClosed, canCloseMonth = true }) {
  const [closing, setClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [message, setMessage] = useState(null);

  // Filter movements to current period only
  const periodMovements = useMemo(() =>
    currentPeriod ? movements.filter(m => m.periodId === currentPeriod.id) : movements,
    [movements, currentPeriod]);

  const usageByProduct = useMemo(() => {
    const map = {};
    periodMovements.filter(m => m.type === 'ISSUE').forEach(m => {
      map[m.productId] = (map[m.productId] || 0) + Math.abs(m.quantity);
    });
    return Object.entries(map)
      .map(([pid, qty]) => ({ product: products.find(p => p.id === pid), qty }))
      .filter(r => r.product).sort((a, b) => b.qty - a.qty);
  }, [periodMovements, products]);

  const usageByEmployee = useMemo(() => {
    const map = {};
    periodMovements.filter(m => m.type === 'ISSUE').forEach(m => {
      const k = m.employeeId;
      if (!map[k]) map[k] = { qty: 0, products: {} };
      map[k].qty += Math.abs(m.quantity);
      map[k].products[m.productId] = (map[k].products[m.productId] || 0) + Math.abs(m.quantity);
    });
    return Object.entries(map)
      .map(([eid, info]) => ({ employee: employees.find(e => e.id === eid), qty: info.qty, products: info.products }))
      .filter(r => r.employee).sort((a, b) => b.qty - a.qty);
  }, [periodMovements, employees]);

  const reorderList = products.filter(p => p.stock <= p.minStock);
  const prodById = Object.fromEntries(products.map(p => [p.id, p]));

  const exportCSV = (rows, filename) => {
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const exportReorder = () => {
    const rows = [['SKU', 'Product', 'Current Stock', 'Min Stock', 'Reorder Qty', 'Supplier']];
    reorderList.forEach(p => rows.push([p.sku, p.name, p.stock, p.minStock, p.reorderQty, p.supplier]));
    exportCSV(rows, 'reorder-list.csv');
  };

  const exportEmployeeUsage = () => {
    const rows = [['Period', 'Operator', 'Code', 'Product', 'SKU', 'Total Taken']];
    usageByEmployee.forEach(r => {
      Object.entries(r.products).forEach(([pid, qty]) => {
        const p = prodById[pid];
        rows.push([currentPeriod?.label || '', r.employee.name, r.employee.code, p?.name || '(deleted)', p?.sku || '', qty]);
      });
    });
    exportCSV(rows, `operator-usage-${(currentPeriod?.label || '').replace(/\s+/g, '-')}.csv`);
  };

  const closeMonth = async () => {
    setClosing(true);
    try {
      const r = await apiPost('/periods/close');
      setMessage({ type: 'ok', text: `Period "${r.closed.label}" closed. New period "${r.new.label}" started.` });
      setTimeout(() => setMessage(null), 5000);
      setConfirmClose(false);
      onMonthClosed && onMonthClosed();
    } catch (err) {
      setMessage({ type: 'err', text: err.message });
      setTimeout(() => setMessage(null), 5000);
    } finally { setClosing(false); }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Reports</h2>
          {currentPeriod && (
            <p className="text-sm text-zinc-500 mt-1">
              Current period: <span className="text-amber-400 font-medium">{currentPeriod.label}</span> · started {fmtDate(currentPeriod.startedAt)}
            </p>
          )}
        </div>
        {canCloseMonth && (
          <button onClick={() => setConfirmClose(true)} disabled={closing}
            className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-900 font-bold px-4 py-2.5 rounded-md">
            {closing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarCheck className="w-4 h-4" />}
            Close Month
          </button>
        )}
      </div>

      {message && (
        <div className={`px-4 py-3 rounded-md text-sm ${
          message.type === 'ok' ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'
        }`}>{message.text}</div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" /> Reorder Required (live stock)
          </h3>
          <button onClick={exportReorder} disabled={reorderList.length === 0}
            className="text-xs bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 px-3 py-1.5 rounded flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>
        {reorderList.length === 0 ? (
          <div className="p-8 text-center text-zinc-500 text-sm">No items need reordering ✓</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2">Product</th>
                <th className="text-left px-4 py-2">Supplier</th>
                <th className="text-right px-4 py-2">Current</th>
                <th className="text-right px-4 py-2">Min</th>
                <th className="text-right px-4 py-2">Reorder Qty</th>
                <th className="text-right px-4 py-2">Est. Cost</th>
              </tr>
            </thead>
            <tbody>
              {reorderList.map(p => (
                <tr key={p.id} className="border-t border-zinc-800">
                  <td className="px-4 py-2">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-zinc-500 font-mono">{p.sku}</div>
                  </td>
                  <td className="px-4 py-2 text-zinc-400">{p.supplier}</td>
                  <td className={`px-4 py-2 text-right font-bold ${p.stock === 0 ? 'text-red-400' : 'text-amber-400'}`}>{p.stock}</td>
                  <td className="px-4 py-2 text-right text-zinc-400">{p.minStock}</td>
                  <td className="px-4 py-2 text-right font-semibold">{p.reorderQty}</td>
                  <td className="px-4 py-2 text-right text-zinc-400">R {(p.reorderQty * (p.cost || 0)).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800">
            <h3 className="font-semibold">Top Products (this period)</h3>
          </div>
          {usageByProduct.length === 0 ? (
            <div className="p-8 text-center text-zinc-500 text-sm">No usage this period</div>
          ) : (
            <div className="p-4 space-y-2">
              {usageByProduct.slice(0, 10).map(r => {
                const max = usageByProduct[0].qty;
                const pct = (r.qty / max) * 100;
                return (
                  <div key={r.product.id}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="font-medium">{r.product.name}</span>
                      <span className="text-zinc-400">{r.qty}</span>
                    </div>
                    <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-500" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <h3 className="font-semibold">Usage by Operator (this period)</h3>
            <button onClick={exportEmployeeUsage} disabled={usageByEmployee.length === 0}
              className="text-xs bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 px-3 py-1.5 rounded flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" /> CSV
            </button>
          </div>
          {usageByEmployee.length === 0 ? (
            <div className="p-8 text-center text-zinc-500 text-sm">No usage this period</div>
          ) : (
            <div className="p-4 space-y-3 max-h-96 overflow-auto">
              {usageByEmployee.map(r => {
                const max = usageByEmployee[0].qty;
                const pct = (r.qty / max) * 100;
                const productList = Object.entries(r.products)
                  .map(([pid, qty]) => ({ p: prodById[pid], qty }))
                  .filter(x => x.p).sort((a, b) => b.qty - a.qty);
                return (
                  <div key={r.employee.id} className="border-b border-zinc-800 pb-2 last:border-b-0">
                    <div className="flex justify-between text-sm mb-1">
                      <span className="font-medium">{r.employee.name}</span>
                      <span className="text-zinc-400">{r.qty} items</span>
                    </div>
                    <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden mb-2">
                      <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-xs text-zinc-500 space-y-0.5 pl-2">
                      {productList.slice(0, 5).map(x => (
                        <div key={x.p.id} className="flex justify-between">
                          <span>· {x.p.name}</span>
                          <span className="font-mono">×{x.qty}</span>
                        </div>
                      ))}
                      {productList.length > 5 && (
                        <div className="text-zinc-600 italic">+ {productList.length - 5} more products…</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {confirmClose && (
        <ConfirmDialog
          title="Close the current period?"
          message={`This will close "${currentPeriod?.label}" and start a new period. Your stock levels stay the same. All current transactions move into the archived monthly report (accessible from "Monthly Reports"). Continue?`}
          confirmLabel="Yes, Close Month"
          confirmClass="bg-amber-500 hover:bg-amber-400 text-zinc-900"
          onConfirm={closeMonth}
          onCancel={() => setConfirmClose(false)} />
      )}
    </div>
  );
}

// ============================================================
// MONTHLY REPORTS - list of all archived periods
// ============================================================
function MonthlyReportsScreen({ periods, employees, products }) {
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);

  const closedPeriods = periods.filter(p => p.closedAt);
  const openPeriod = periods.find(p => !p.closedAt);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    setLoading(true);
    Promise.all([
      apiGet(`/transactions?periodId=${selected.id}`),
      apiGet(`/movements?periodId=${selected.id}`),
    ]).then(([txs, mvs]) => {
      setDetail({ transactions: txs, movements: mvs });
    }).catch(err => console.error(err)).finally(() => setLoading(false));
  }, [selected]);

  const prodById = Object.fromEntries(products.map(p => [p.id, p]));
  const empById = Object.fromEntries(employees.map(e => [e.id, e]));

  const stats = useMemo(() => {
    if (!detail) return null;
    const issues = detail.movements.filter(m => m.type === 'ISSUE');
    const byProduct = {};
    const byOperator = {};
    issues.forEach(m => {
      byProduct[m.productId] = (byProduct[m.productId] || 0) + Math.abs(m.quantity);
      if (m.employeeId) byOperator[m.employeeId] = (byOperator[m.employeeId] || 0) + Math.abs(m.quantity);
    });
    return {
      txCount: detail.transactions.length,
      itemCount: issues.reduce((s, m) => s + Math.abs(m.quantity), 0),
      topProducts: Object.entries(byProduct).map(([pid, qty]) => ({ p: prodById[pid], qty })).filter(x => x.p).sort((a, b) => b.qty - a.qty),
      topOperators: Object.entries(byOperator).map(([eid, qty]) => ({ e: empById[eid], qty })).filter(x => x.e).sort((a, b) => b.qty - a.qty),
    };
  }, [detail, prodById, empById]);

  const exportMonth = () => {
    if (!detail || !selected) return;
    const rows = [['Date/Time', 'Transaction ID', 'Operator', 'Operator Code', 'Product', 'SKU', 'Quantity', 'Balance After']];
    detail.movements.forEach(m => {
      const tx = detail.transactions.find(t => t.id === m.transactionId);
      const e = empById[m.employeeId];
      const p = prodById[m.productId];
      rows.push([
        fmtDateTime(m.createdAt), m.transactionId, e?.name || '(deleted)', e?.code || '',
        p?.name || '(deleted)', p?.sku || '', Math.abs(m.quantity), m.balanceAfter
      ]);
    });
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `report-${selected.label.replace(/\s+/g, '-')}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  if (selected) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <button onClick={() => setSelected(null)} className="text-sm text-zinc-400 hover:text-white mb-2 flex items-center gap-1">
              ← Back to all months
            </button>
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <Archive className="w-6 h-6 text-amber-500" /> {selected.label}
            </h2>
            <p className="text-sm text-zinc-500 mt-1">
              {fmtDate(selected.startedAt)} → {selected.closedAt ? fmtDate(selected.closedAt) : 'current'}
              {selected.autoClosed ? ' · auto-closed' : selected.closedAt ? ' · manually closed' : ''}
            </p>
          </div>
          <button onClick={exportMonth} disabled={!detail}
            className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 px-4 py-2 rounded-md text-sm">
            <Download className="w-4 h-4" /> Export Full CSV
          </button>
        </div>

        {loading ? (
          <div className="p-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-zinc-500" /></div>
        ) : !stats ? null : (
          <>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <StatCard label="Transactions" value={stats.txCount} icon={History} />
              <StatCard label="Total Items Issued" value={stats.itemCount} icon={ScanLine} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-zinc-800"><h3 className="font-semibold">Products Issued</h3></div>
                {stats.topProducts.length === 0 ? (
                  <div className="p-8 text-center text-zinc-500 text-sm">No activity</div>
                ) : (
                  <div className="max-h-96 overflow-auto">
                    <table className="w-full text-sm">
                      <tbody>
                        {stats.topProducts.map(x => (
                          <tr key={x.p.id} className="border-t border-zinc-800">
                            <td className="px-4 py-2">
                              <div className="font-medium">{x.p.name}</div>
                              <div className="text-xs text-zinc-500 font-mono">{x.p.sku}</div>
                            </td>
                            <td className="px-4 py-2 text-right font-bold text-amber-400">{x.qty}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-zinc-800"><h3 className="font-semibold">Operator Activity</h3></div>
                {stats.topOperators.length === 0 ? (
                  <div className="p-8 text-center text-zinc-500 text-sm">No activity</div>
                ) : (
                  <div className="max-h-96 overflow-auto">
                    <table className="w-full text-sm">
                      <tbody>
                        {stats.topOperators.map(x => (
                          <tr key={x.e.id} className="border-t border-zinc-800">
                            <td className="px-4 py-2">
                              <div className="font-medium">{x.e.name}</div>
                              <div className="text-xs text-zinc-500 font-mono">{x.e.code}</div>
                            </td>
                            <td className="px-4 py-2 text-right font-bold text-emerald-400">{x.qty}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-1">Monthly Reports</h2>
      <p className="text-sm text-zinc-500 mb-6">Archived monthly periods. Click one to see its full report.</p>

      {openPeriod && (
        <div className="bg-amber-500/5 border border-amber-500/30 rounded-lg p-4 mb-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-amber-400 uppercase tracking-wide mb-1">Current open period</div>
            <div className="font-bold">{openPeriod.label}</div>
            <div className="text-xs text-zinc-500">Started {fmtDate(openPeriod.startedAt)}</div>
          </div>
          <div className="text-xs text-zinc-500 text-right">
            Will be archived when you click "Close Month"<br />in Reports, or automatically on the 1st.
          </div>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {closedPeriods.length === 0 ? (
          <div className="p-12 text-center">
            <Archive className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
            <div className="text-zinc-400 font-medium mb-1">No archived months yet</div>
            <div className="text-zinc-600 text-sm">Close a month to archive it here</div>
          </div>
        ) : (
          <table className="w-full">
            <thead className="text-xs text-zinc-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3">Period</th>
                <th className="text-left px-4 py-3">Started</th>
                <th className="text-left px-4 py-3">Closed</th>
                <th className="text-right px-4 py-3">Transactions</th>
                <th className="text-right px-4 py-3">Items Issued</th>
                <th className="text-left px-4 py-3">Closed By</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {closedPeriods.map(p => (
                <tr key={p.id} className="border-t border-zinc-800 hover:bg-zinc-800/40 cursor-pointer" onClick={() => setSelected(p)}>
                  <td className="px-4 py-3 font-medium">{p.label}</td>
                  <td className="px-4 py-3 text-sm text-zinc-400">{fmtDate(p.startedAt)}</td>
                  <td className="px-4 py-3 text-sm text-zinc-400">{fmtDate(p.closedAt)}</td>
                  <td className="px-4 py-3 text-right font-semibold">{p.txCount}</td>
                  <td className="px-4 py-3 text-right font-bold text-amber-400">{p.itemCount}</td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {p.autoClosed ? <span className="text-zinc-400">auto</span> : 'manual'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ChevronRight className="w-4 h-4 inline text-zinc-500" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ============================================================
// USERS SCREEN (unchanged)
// ============================================================
// ============================================================
// TOOLS — in-house check-out / check-in (v3.4.0)
// ============================================================
function ToolsScreen({ employees, beeper }) {
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('scan'); // 'scan' | 'list' | 'history'
  const [message, setMessage] = useState(null);

  const refresh = useCallback(async () => {
    try { setTools(await apiGet('/tools')); }
    catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  // Auto-refresh while on screen
  useEffect(() => {
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  const showMsg = (type, text) => { setMessage({ type, text }); setTimeout(() => setMessage(null), 4000); };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2"><Wrench className="w-6 h-6 text-amber-500" /> Check-In/Out</h2>
          <p className="text-sm text-zinc-500 mt-1">Track tools that operators borrow and return — drills, grinders, etc.</p>
        </div>
        <div className="flex gap-1 bg-zinc-900 border border-zinc-800 rounded-md p-1">
          <button onClick={() => setTab('scan')}
            className={`px-4 py-1.5 rounded text-sm font-medium ${tab === 'scan' ? 'bg-amber-500 text-zinc-900' : 'text-zinc-400 hover:text-white'}`}>
            Scan
          </button>
          <button onClick={() => setTab('list')}
            className={`px-4 py-1.5 rounded text-sm font-medium ${tab === 'list' ? 'bg-amber-500 text-zinc-900' : 'text-zinc-400 hover:text-white'}`}>
            Tool List
          </button>
          <button onClick={() => setTab('history')}
            className={`px-4 py-1.5 rounded text-sm font-medium ${tab === 'history' ? 'bg-amber-500 text-zinc-900' : 'text-zinc-400 hover:text-white'}`}>
            History
          </button>
        </div>
      </div>

      {message && (
        <div className={`mb-4 px-4 py-3 rounded-md text-sm ${
          message.type === 'ok' ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'
        }`}>{message.text}</div>
      )}

      {loading ? (
        <div className="p-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-zinc-500" /></div>
      ) : (
        <>
          {tab === 'scan' && <ToolsScanTab tools={tools} employees={employees} beeper={beeper} onChange={refresh} showMsg={showMsg} />}
          {tab === 'list' && <ToolsListTab tools={tools} employees={employees} onChange={refresh} showMsg={showMsg} />}
          {tab === 'history' && <ToolsHistoryTab tools={tools} employees={employees} />}
        </>
      )}
    </div>
  );
}

// ----- SCAN TAB (badge → tool, auto checkout/checkin) -----
function ToolsScanTab({ tools, employees, beeper, onChange, showMsg }) {
  const [activeOperator, setActiveOperator] = useState(null);
  const [pendingCheckin, setPendingCheckin] = useState(null); // tool object awaiting optional note
  const [checkinNote, setCheckinNote] = useState('');
  const [manualScan, setManualScan] = useState('');
  const [flash, setFlash] = useState(null);

  const triggerFlash = (type, msg) => { setFlash({ type, msg }); setTimeout(() => setFlash(null), 1800); };

  // Currently-out tools, for display
  const outTools = tools.filter(t => t.currentEmployeeId);
  const empById = Object.fromEntries(employees.map(e => [e.id, e]));

  const submitScan = async (code) => {
    const trimmed = code.trim();
    if (!trimmed) return;

    // No active operator yet → treat scan as operator badge
    if (!activeOperator) {
      const emp = employees.find(em => em.code === trimmed && em.active);
      if (emp) {
        setActiveOperator(emp);
        beeper.employee();
        triggerFlash('ok', `Operator: ${emp.name}`);
      } else {
        beeper.error();
        triggerFlash('err', `Unknown operator badge: ${trimmed}`);
      }
      return;
    }

    // Have an operator → treat scan as tool barcode
    try {
      const result = await apiPost('/tools/scan', { toolBarcode: trimmed, employeeId: activeOperator.id });
      if (result.action === 'checkout') {
        beeper.confirm();
        triggerFlash('ok', `✓ Checked OUT: ${result.tool.name}`);
        await onChange();
      } else if (result.action === 'checkin') {
        beeper.success();
        // Prompt for optional defect note
        setPendingCheckin({ tool: result.tool, previousEmployeeId: result.previouslyCheckedOutTo });
        await onChange();
      }
    } catch (e) {
      beeper.error();
      triggerFlash('err', e.message);
    }
  };

  useBarcodeScanner(submitScan, true);

  const submitManual = (e) => {
    e.preventDefault();
    if (manualScan.trim()) { submitScan(manualScan.trim()); setManualScan(''); }
  };

  const finishCheckin = async (defective) => {
    if (!pendingCheckin) return;
    try {
      if (checkinNote.trim() || defective) {
        // Update the most recent CHECKIN movement with the note via /tools/:id/defective (if defective)
        // Or simpler: just re-call defective endpoint when needed
        if (defective) {
          await apiPost(`/tools/${pendingCheckin.tool.id}/defective`, {
            defective: true,
            note: checkinNote.trim() || 'Marked defective on return',
            employeeId: activeOperator?.id,
          });
        }
      }
      triggerFlash('ok', `✓ Checked IN: ${pendingCheckin.tool.name}${defective ? ' (flagged defective)' : ''}`);
      setPendingCheckin(null);
      setCheckinNote('');
      await onChange();
    } catch (e) {
      triggerFlash('err', e.message);
    }
  };

  const skipCheckinNote = () => { setPendingCheckin(null); setCheckinNote(''); };

  const endSession = () => { setActiveOperator(null); setPendingCheckin(null); setCheckinNote(''); };

  if (!activeOperator) {
    return (
      <div className="relative">
        {flash && (
          <div className={`fixed top-24 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-lg text-base font-semibold shadow-2xl ${
            flash.type === 'ok' ? 'bg-emerald-500 text-zinc-900' : 'bg-red-500 text-white'
          }`}>{flash.msg}</div>
        )}
        <div className="flex flex-col items-center justify-center py-16">
          <div className="w-28 h-28 bg-zinc-900 border-2 border-amber-500 rounded-full flex items-center justify-center mb-6 animate-pulse">
            <Wrench className="w-14 h-14 text-amber-500" />
          </div>
          <h3 className="text-2xl font-bold mb-1">Scan operator badge</h3>
          <p className="text-zinc-500 mb-6">Then scan a tool barcode to check it out or in</p>
          <form onSubmit={submitManual} className="flex gap-2 w-full max-w-md">
            <input value={manualScan} onChange={e => setManualScan(e.target.value)}
              placeholder="Or type operator code manually…"
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded-md px-4 py-3 text-base focus:outline-none focus:border-amber-500" />
            <button type="submit" className="bg-zinc-800 hover:bg-zinc-700 px-5 rounded-md">Go</button>
          </form>
        </div>
        {outTools.length > 0 && (
          <div className="mt-8 max-w-3xl mx-auto">
            <h4 className="text-sm font-semibold text-zinc-300 mb-2 flex items-center gap-2">
              <ArrowUpFromLine className="w-4 h-4 text-red-400" /> Currently out ({outTools.length})
            </h4>
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="text-xs text-zinc-500 uppercase tracking-wide">
                  <tr><th className="text-left px-3 py-2">Tool</th><th className="text-left px-3 py-2">With</th><th className="text-right px-3 py-2">Since</th></tr>
                </thead>
                <tbody>
                  {outTools.map(t => {
                    const e = empById[t.currentEmployeeId];
                    const outFor = Date.now() - new Date(t.checkedOutAt).getTime();
                    const days = outFor / 86400000;
                    const overdue = days > (t.overdueAfterDays || 1);
                    return (
                      <tr key={t.id} className="border-t border-zinc-800">
                        <td className="px-3 py-2 font-medium">{t.name}</td>
                        <td className="px-3 py-2 text-zinc-400">{e?.name || '—'}</td>
                        <td className={`px-3 py-2 text-right text-xs ${overdue ? 'text-red-400 font-bold' : 'text-zinc-500'}`}>
                          {fmtRelative(t.checkedOutAt)} {overdue && '⚠️'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Active operator — ready to scan tools
  return (
    <div className="relative">
      {flash && (
        <div className={`fixed top-24 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-lg text-base font-semibold shadow-2xl ${
          flash.type === 'ok' ? 'bg-emerald-500 text-zinc-900' : 'bg-red-500 text-white'
        }`}>{flash.msg}</div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-amber-500 rounded-full flex items-center justify-center text-zinc-900 font-bold text-lg">
            {activeOperator.name.split(' ').map(n => n[0]).join('').slice(0,2)}
          </div>
          <div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide">Active Session</div>
            <div className="text-xl font-bold">{activeOperator.name}</div>
            <div className="text-xs text-zinc-500">{activeOperator.code} · {activeOperator.role}</div>
          </div>
        </div>
        <button onClick={endSession} className="flex items-center gap-2 text-zinc-400 hover:text-white px-3 py-2 rounded-md hover:bg-zinc-800">
          <LogOut className="w-4 h-4" /> End Session
        </button>
      </div>

      <div className="bg-amber-500/5 border border-amber-500/30 rounded-lg p-4 mb-4 flex items-center gap-3">
        <Wrench className="w-6 h-6 text-amber-500 animate-pulse" />
        <div className="text-amber-200">Scan a tool barcode — system will auto check it out or in</div>
        <form onSubmit={submitManual} className="ml-auto flex gap-2">
          <input value={manualScan} onChange={e => setManualScan(e.target.value)}
            placeholder="Manual tool barcode…"
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-1.5 text-sm w-56 focus:outline-none focus:border-amber-500" />
          <button type="submit" className="bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded-md text-sm">Scan</button>
        </form>
      </div>

      {/* Check-in note prompt */}
      {pendingCheckin && (
        <div className="bg-emerald-500/10 border border-emerald-500/40 rounded-lg p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <ArrowDownToLine className="w-5 h-5 text-emerald-400" />
            <div className="font-semibold text-emerald-200">{pendingCheckin.tool.name} checked IN</div>
          </div>
          <div className="text-sm text-zinc-400 mb-2">Add a note? (optional — leave blank if everything's fine)</div>
          <textarea value={checkinNote} onChange={e => setCheckinNote(e.target.value)}
            rows={2} className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
            placeholder="e.g. 'chuck wobbly', 'missing battery', 'all good'" />
          <div className="mt-3 flex gap-2">
            <button onClick={() => finishCheckin(false)}
              className="flex-1 px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-900 font-semibold rounded">Save Note & Continue</button>
            <button onClick={() => finishCheckin(true)}
              className="px-4 py-2 bg-red-500/30 hover:bg-red-500/40 text-red-200 font-semibold rounded flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Flag Defective
            </button>
            <button onClick={skipCheckinNote}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded">Skip</button>
          </div>
        </div>
      )}

      {/* Currently checked out to this operator */}
      <div>
        <h4 className="text-sm font-semibold text-zinc-300 mb-2">Currently with {activeOperator.name}</h4>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {tools.filter(t => t.currentEmployeeId === activeOperator.id).length === 0 ? (
            <div className="p-6 text-center text-zinc-500 text-sm">No tools checked out to this operator.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-zinc-500 uppercase tracking-wide">
                <tr><th className="text-left px-4 py-2">Tool</th><th className="text-left px-4 py-2">Serial</th><th className="text-right px-4 py-2">Since</th></tr>
              </thead>
              <tbody>
                {tools.filter(t => t.currentEmployeeId === activeOperator.id).map(t => {
                  const outFor = Date.now() - new Date(t.checkedOutAt).getTime();
                  const overdue = outFor / 86400000 > (t.overdueAfterDays || 1);
                  return (
                    <tr key={t.id} className="border-t border-zinc-800">
                      <td className="px-4 py-2 font-medium">{t.name}</td>
                      <td className="px-4 py-2 text-zinc-500 font-mono text-xs">{t.serial || '—'}</td>
                      <td className={`px-4 py-2 text-right ${overdue ? 'text-red-400 font-bold' : 'text-zinc-400'}`}>
                        {fmtRelative(t.checkedOutAt)} {overdue && '⚠️ overdue'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ----- LIST TAB (add/edit/delete tools, view status) -----
function ToolsListTab({ tools, employees, onChange, showMsg }) {
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [search, setSearch] = useState('');

  const empById = Object.fromEntries(employees.map(e => [e.id, e]));

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return tools.filter(t =>
      t.name.toLowerCase().includes(q) ||
      (t.serial || '').toLowerCase().includes(q) ||
      (t.category || '').toLowerCase().includes(q)
    );
  }, [tools, search]);

  const saveTool = async (data) => {
    try {
      if (data.id) await apiPut(`/tools/${data.id}`, data);
      else await apiPost('/tools', data);
      setEditing(null);
      await onChange();
      showMsg('ok', data.id ? 'Tool updated' : 'Tool created');
    } catch (err) { showMsg('err', err.message); }
  };

  const deleteTool = async () => {
    try { await apiDelete(`/tools/${deleting.id}`); setDeleting(null); await onChange(); showMsg('ok', 'Tool deleted'); }
    catch (err) { showMsg('err', err.message); }
  };

  const clearDefective = async (tool) => {
    try { await apiPost(`/tools/${tool.id}/defective`, { defective: false }); await onChange(); showMsg('ok', `${tool.name} marked OK`); }
    catch (err) { showMsg('err', err.message); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search tools…"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-md pl-10 pr-4 py-2 focus:outline-none focus:border-amber-500" />
        </div>
        <button onClick={() => setEditing('new')}
          className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-zinc-900 font-semibold px-4 py-2 rounded-md">
          <Plus className="w-4 h-4" /> New Tool
        </button>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {tools.length === 0 ? (
          <div className="p-12 text-center">
            <Wrench className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
            <div className="text-zinc-400 font-medium mb-1">No tools yet</div>
            <div className="text-zinc-600 text-sm">Click "New Tool" to add your first one</div>
          </div>
        ) : (
          <table className="w-full">
            <thead className="text-xs text-zinc-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3">Tool</th>
                <th className="text-left px-4 py-3">Serial</th>
                <th className="text-left px-4 py-3">Category</th>
                <th className="text-left px-4 py-3">Location</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-right px-4 py-3">Overdue After</th>
                <th className="w-44"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => {
                const holder = empById[t.currentEmployeeId];
                const outFor = t.checkedOutAt ? (Date.now() - new Date(t.checkedOutAt).getTime()) / 86400000 : 0;
                const overdue = outFor > (t.overdueAfterDays || 1);
                return (
                  <tr key={t.id} className="border-t border-zinc-800 hover:bg-zinc-800/40">
                    <td className="px-4 py-3 font-medium">{t.name}</td>
                    <td className="px-4 py-3 text-zinc-500 font-mono text-xs">{t.serial || '—'}</td>
                    <td className="px-4 py-3 text-zinc-400 text-sm">{t.category || '—'}</td>
                    <td className="px-4 py-3 text-zinc-400 text-sm">{t.location || '—'}</td>
                    <td className="px-4 py-3 text-sm">
                      {t.defective ? (
                        <div>
                          <span className="text-xs bg-red-500/20 text-red-300 px-2 py-0.5 rounded">DEFECTIVE</span>
                          {t.defectiveNote && <div className="text-xs text-zinc-500 mt-1 italic">"{t.defectiveNote}"</div>}
                        </div>
                      ) : holder ? (
                        <div>
                          <span className={`text-xs px-2 py-0.5 rounded ${overdue ? 'bg-red-500/20 text-red-300' : 'bg-amber-500/20 text-amber-300'}`}>
                            OUT{overdue && ' · OVERDUE'}
                          </span>
                          <div className="text-xs text-zinc-400 mt-1">with {holder.name} · {fmtRelative(t.checkedOutAt)}</div>
                        </div>
                      ) : (
                        <span className="text-xs bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded">AVAILABLE</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-zinc-400">{t.overdueAfterDays || 1}d</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 justify-end items-center">
                        {t.defective && (
                          <button onClick={() => clearDefective(t)}
                            className="text-xs bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 px-2 py-1 rounded">
                            Mark OK
                          </button>
                        )}
                        <button onClick={() => setEditing(t)} className="text-zinc-400 hover:text-white p-1"><Edit3 className="w-4 h-4" /></button>
                        <button onClick={() => setDeleting(t)} className="text-zinc-400 hover:text-red-400 p-1"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editing && <ToolEditor tool={editing === 'new' ? null : editing} onSave={saveTool} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete "${deleting.name}"?`}
          message="The tool and its barcodes are removed. History is kept but will show this as a deleted tool. Cannot be undone."
          confirmLabel="Delete Tool"
          onConfirm={deleteTool}
          onCancel={() => setDeleting(null)} />
      )}
    </div>
  );
}

function ToolEditor({ tool, onSave, onClose }) {
  const [form, setForm] = useState(tool || {
    name: '', serial: '', category: '', location: '', overdueAfterDays: 1, _barcode: '',
  });
  const [barcodes, setBarcodes] = useState([]);
  const [newBc, setNewBc] = useState('');

  const isEdit = !!tool;

  useEffect(() => {
    if (!tool) return;
    // Fetch tool's barcodes
    apiGet('/barcodes').then(all => {
      setBarcodes(all.filter(b => b.toolId === tool.id));
    }).catch(() => {});
  }, [tool]);

  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const addBarcode = async () => {
    if (!newBc.trim() || !tool) return;
    try {
      await apiPost('/barcodes', { value: newBc.trim(), toolId: tool.id });
      const all = await apiGet('/barcodes');
      setBarcodes(all.filter(b => b.toolId === tool.id));
      setNewBc('');
    } catch (e) { alert(e.message); }
  };

  const removeBarcode = async (value) => {
    await apiDelete(`/barcodes/${encodeURIComponent(value)}`);
    const all = await apiGet('/barcodes');
    setBarcodes(all.filter(b => b.toolId === tool.id));
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-2xl max-h-[90vh] overflow-auto">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-lg font-bold">{tool ? `Edit "${form.name}"` : 'New Tool'}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 grid grid-cols-2 gap-4">
          <Field label="Tool Name *" className="col-span-2">
            <input value={form.name} onChange={e => upd('name', e.target.value)} className="input" placeholder="e.g. Cordless Drill 18V" />
          </Field>
          <Field label="Serial / Asset Tag">
            <input value={form.serial} onChange={e => upd('serial', e.target.value)} className="input font-mono" />
          </Field>
          <Field label="Category">
            <input value={form.category} onChange={e => upd('category', e.target.value)} className="input" placeholder="Power Tools, Hand Tools, etc." />
          </Field>
          <Field label="Storage Location">
            <input value={form.location} onChange={e => upd('location', e.target.value)} className="input" placeholder="Shelf A2, Cabinet 3, etc." />
          </Field>
          <Field label="Overdue After (days)">
            <input type="number" min="1" value={form.overdueAfterDays} onChange={e => upd('overdueAfterDays', Number(e.target.value) || 1)} className="input" />
          </Field>

          {!isEdit && (
            <Field label="Initial Barcode (optional)" className="col-span-2">
              <input value={form._barcode || ''} onChange={e => upd('_barcode', e.target.value)}
                className="input font-mono" placeholder="Scan or type the barcode you'll stick on this tool" />
            </Field>
          )}

          {isEdit && (
            <div className="col-span-2 border-t border-zinc-800 pt-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Barcodes</div>
              <div className="flex flex-wrap gap-2 mb-2">
                {barcodes.length === 0 ? (
                  <div className="text-sm text-red-400">⚠️ No barcodes — this tool can't be scanned</div>
                ) : barcodes.map(b => (
                  <div key={b.value} className="flex items-center gap-1 bg-zinc-800 text-sm font-mono px-2 py-1 rounded">
                    {b.value}
                    <button onClick={() => removeBarcode(b.value)} className="text-zinc-500 hover:text-red-400"><X className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={newBc} onChange={e => setNewBc(e.target.value)}
                  className="input font-mono" placeholder="Scan or type a new barcode" />
                <button onClick={addBarcode}
                  className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-md whitespace-nowrap text-sm">Add Barcode</button>
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-md">Cancel</button>
          <button onClick={() => form.name.trim() && onSave(isEdit ? { ...form, id: tool.id } : form)}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-zinc-900 font-semibold rounded-md">
            {isEdit ? 'Save Changes' : 'Create Tool'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----- HISTORY TAB -----
function ToolsHistoryTab({ tools, employees }) {
  const [filterTool, setFilterTool] = useState('');
  const [filterEmp, setFilterEmp] = useState('');
  const [movements, setMovements] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterTool) params.set('toolId', filterTool);
      if (filterEmp) params.set('employeeId', filterEmp);
      params.set('limit', '500');
      setMovements(await apiGet(`/tool-movements?${params.toString()}`));
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [filterTool, filterEmp]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div className="flex gap-3 mb-4 items-end flex-wrap">
        <Field label="Tool">
          <select value={filterTool} onChange={e => setFilterTool(e.target.value)} className="input min-w-[200px]">
            <option value="">All tools</option>
            {tools.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Operator">
          <select value={filterEmp} onChange={e => setFilterEmp(e.target.value)} className="input min-w-[200px]">
            <option value="">All operators</option>
            {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <button onClick={() => { setFilterTool(''); setFilterEmp(''); }}
          className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-md text-sm">Reset</button>
        <div className="ml-auto text-sm text-zinc-500 self-center">{movements.length} events</div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-zinc-500" /></div>
        ) : movements.length === 0 ? (
          <div className="p-12 text-center text-zinc-500 text-sm">No events found</div>
        ) : (
          <table className="w-full">
            <thead className="text-xs text-zinc-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2">When</th>
                <th className="text-left px-4 py-2">Action</th>
                <th className="text-left px-4 py-2">Tool</th>
                <th className="text-left px-4 py-2">Operator</th>
                <th className="text-left px-4 py-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {movements.map(m => (
                <tr key={m.id} className="border-t border-zinc-800 hover:bg-zinc-800/40">
                  <td className="px-4 py-2 text-xs text-zinc-400">{fmtDateTime(m.createdAt)}</td>
                  <td className="px-4 py-2">
                    {m.type === 'CHECKOUT' && <span className="text-xs bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded inline-flex items-center gap-1"><ArrowUpFromLine className="w-3 h-3" /> OUT</span>}
                    {m.type === 'CHECKIN' && <span className="text-xs bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded inline-flex items-center gap-1"><ArrowDownToLine className="w-3 h-3" /> IN</span>}
                    {m.type === 'DEFECTIVE_FLAG' && <span className="text-xs bg-red-500/20 text-red-300 px-2 py-0.5 rounded">DEFECTIVE</span>}
                    {m.type === 'DEFECTIVE_CLEAR' && <span className="text-xs bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded">CLEARED</span>}
                  </td>
                  <td className="px-4 py-2 font-medium">{m.toolName || <span className="text-zinc-600 italic">deleted tool</span>}</td>
                  <td className="px-4 py-2 text-zinc-400">{m.employeeName || '—'}</td>
                  <td className="px-4 py-2 text-zinc-400 text-sm italic">{m.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Format a date as relative time ("2h ago", "3d ago")
function fmtRelative(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function UsersScreen({ currentUser }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // { mode: 'add'|'edit', accountType: 'admin'|'user', account?: {} }
  const [changingPw, setChangingPw] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [message, setMessage] = useState(null);

  const load = async () => {
    try { setAccounts(await apiGet('/users')); }
    catch (err) { console.error(err); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const showMsg = (type, text) => { setMessage({ type, text }); setTimeout(() => setMessage(null), 4000); };

  const saveAccount = async (data) => {
    try {
      if (editing.mode === 'add') {
        await apiPost('/users', data);
        showMsg('ok', `${data.role === 'admin' ? 'Admin' : 'User'} "${data.username}" created`);
      } else {
        // update role/permissions
        await apiPut(`/users/${editing.account.id}`, { role: data.role, permissions: data.permissions });
        showMsg('ok', `Account "${data.username}" updated`);
      }
      setEditing(null);
      await load();
    } catch (err) { showMsg('err', err.message); throw err; }
  };

  const changePassword = async (userId, newPassword, currentPassword) => {
    try {
      await apiPost(`/users/${userId}/password`, { newPassword, currentPassword });
      showMsg('ok', 'Password updated');
      setChangingPw(null);
    } catch (err) { showMsg('err', err.message); throw err; }
  };

  const deleteAccount = async () => {
    try {
      await apiDelete(`/users/${deleting.id}`);
      showMsg('ok', `Account "${deleting.username}" deleted`);
      setDeleting(null);
      await load();
    } catch (err) { showMsg('err', err.message); setDeleting(null); }
  };

  const admins = accounts.filter(a => a.role === 'admin');
  const users = accounts.filter(a => a.role !== 'admin');

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Accounts</h2>
        <p className="text-sm text-zinc-500 mt-1">People who can log in. Workshop staff who only scan badges are managed under Operators.</p>
      </div>

      {message && (
        <div className={`mb-4 px-4 py-3 rounded-md text-sm ${
          message.type === 'ok' ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'
        }`}>{message.text}</div>
      )}

      {loading ? (
        <div className="p-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-zinc-500" /></div>
      ) : (
        <div className="space-y-6">
          {/* Admins section */}
          <AccountSection
            title="Admins"
            description="Full access to everything in the system."
            accentClass="text-amber-400"
            icon={UserCog}
            accounts={admins}
            currentUser={currentUser}
            onAdd={() => setEditing({ mode: 'add', accountType: 'admin' })}
            onEdit={(acc) => setEditing({ mode: 'edit', accountType: 'admin', account: acc })}
            onChangePassword={setChangingPw}
            onDelete={setDeleting}
            addButtonLabel="New Admin"
          />

          {/* Users section */}
          <AccountSection
            title="Users"
            description="Limited access — only the permissions you tick when creating the account."
            accentClass="text-sky-400"
            icon={UserCog}
            accounts={users}
            currentUser={currentUser}
            onAdd={() => setEditing({ mode: 'add', accountType: 'user' })}
            onEdit={(acc) => setEditing({ mode: 'edit', accountType: 'user', account: acc })}
            onChangePassword={setChangingPw}
            onDelete={setDeleting}
            addButtonLabel="New User"
          />
        </div>
      )}

      {editing && (
        <AccountEditor
          editing={editing}
          onSave={saveAccount}
          onClose={() => setEditing(null)}
        />
      )}
      {changingPw && <ChangePasswordModal user={changingPw} isSelf={changingPw.id === currentUser.id} onSave={changePassword} onClose={() => setChangingPw(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete "${deleting.username}"?`}
          message="They will no longer be able to log in. Any current sessions will end immediately."
          confirmLabel="Delete"
          onConfirm={deleteAccount}
          onCancel={() => setDeleting(null)} />
      )}
    </div>
  );
}

function AccountSection({ title, description, accentClass, icon: Icon, accounts, currentUser, onAdd, onEdit, onChangePassword, onDelete, addButtonLabel }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className={`text-lg font-semibold flex items-center gap-2 ${accentClass}`}>
            <Icon className="w-5 h-5" /> {title} <span className="text-zinc-500 text-sm font-normal">({accounts.length})</span>
          </h3>
          <p className="text-xs text-zinc-500">{description}</p>
        </div>
        <button onClick={onAdd}
          className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-zinc-900 font-semibold px-3 py-1.5 rounded-md text-sm">
          <Plus className="w-4 h-4" /> {addButtonLabel}
        </button>
      </div>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {accounts.length === 0 ? (
          <div className="p-6 text-center text-zinc-500 text-sm">None yet.</div>
        ) : (
          <table className="w-full">
            <thead className="text-xs text-zinc-500 uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2">Username</th>
                <th className="text-left px-4 py-2">Permissions</th>
                <th className="text-left px-4 py-2">Last login</th>
                <th className="w-44"></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(u => (
                <tr key={u.id} className="border-t border-zinc-800 hover:bg-zinc-800/40">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{u.username}</span>
                      {u.id === currentUser.id && <span className="text-xs bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded">you</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">
                    {u.role === 'admin'
                      ? <span className="text-amber-400">Full access</span>
                      : u.permissions && u.permissions.length > 0
                        ? `${u.permissions.length} permission${u.permissions.length === 1 ? '' : 's'}`
                        : <span className="text-red-400">No permissions</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400">{fmtDateTime(u.lastLoginAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1 justify-end items-center">
                      <button onClick={() => onEdit(u)} title="Edit role / permissions"
                        className="text-zinc-400 hover:text-white p-1"><Edit3 className="w-4 h-4" /></button>
                      <button onClick={() => onChangePassword(u)}
                        className="text-xs bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded flex items-center gap-1"
                        title={u.id === currentUser.id ? 'Change Password' : 'Reset Password'}>
                        <KeyRound className="w-3.5 h-3.5" />
                      </button>
                      {u.id !== currentUser.id && (
                        <button onClick={() => onDelete(u)} className="text-zinc-400 hover:text-red-400 p-1">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function AccountEditor({ editing, onSave, onClose }) {
  const isAdd = editing.mode === 'add';
  const initialRole = editing.accountType || (editing.account?.role || 'user');
  const initialPerms = editing.account?.permissions || [];

  const [username, setUsername] = useState(editing.account?.username || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [role, setRole] = useState(initialRole);
  const [permissions, setPermissions] = useState(initialPerms);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const togglePerm = (id) => {
    setPermissions(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  };

  const submit = async () => {
    setErr(null);
    if (isAdd) {
      if (!username.trim() || username.length < 3) return setErr('Username must be at least 3 characters');
      if (password.length < 6) return setErr('Password must be at least 6 characters');
      if (password !== confirm) return setErr('Passwords do not match');
    }
    setBusy(true);
    try {
      await onSave({
        username: username.trim(),
        password: isAdd ? password : undefined,
        role,
        permissions: role === 'admin' ? [] : permissions,
      });
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-lg max-h-[90vh] overflow-auto">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-lg font-bold">
            {isAdd ? (role === 'admin' ? 'New Admin' : 'New User') : `Edit "${username}"`}
          </h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          <Field label="Username">
            <input value={username} onChange={e => setUsername(e.target.value)} className="input" autoFocus disabled={!isAdd} />
          </Field>

          {isAdd && (
            <>
              <Field label="Password (min 6 characters)">
                <div className="relative">
                  <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} className="input pr-10" />
                  <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </Field>
              <Field label="Confirm Password">
                <input type={showPw ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} className="input" />
              </Field>
            </>
          )}

          <Field label="Account Type">
            <div className="flex gap-2">
              <button onClick={() => setRole('user')}
                className={`flex-1 px-4 py-2 rounded-md border text-sm font-medium ${
                  role === 'user' ? 'border-sky-500 bg-sky-500/10 text-sky-200' : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
                }`}>User</button>
              <button onClick={() => setRole('admin')}
                className={`flex-1 px-4 py-2 rounded-md border text-sm font-medium ${
                  role === 'admin' ? 'border-amber-500 bg-amber-500/10 text-amber-200' : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
                }`}>Admin</button>
            </div>
          </Field>

          {role === 'admin' ? (
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-200 rounded p-3 text-sm">
              Admins have full access to everything. No permissions to tick.
            </div>
          ) : (
            <Field label="Permissions">
              <div className="space-y-1 bg-zinc-950 border border-zinc-800 rounded-md p-3">
                {ALL_PERMISSIONS.map(perm => (
                  <label key={perm.id} className="flex items-center gap-2 py-1 cursor-pointer hover:bg-zinc-900 px-2 rounded">
                    <input
                      type="checkbox"
                      checked={permissions.includes(perm.id)}
                      onChange={() => togglePerm(perm.id)}
                      className="w-4 h-4 accent-amber-500"
                    />
                    <span className="text-sm">{perm.label}</span>
                  </label>
                ))}
                {permissions.length === 0 && (
                  <div className="text-xs text-red-400 mt-2 px-2">⚠️ User won't be able to do anything until you tick at least one box.</div>
                )}
              </div>
            </Field>
          )}

          {err && <div className="bg-red-500/10 border border-red-500/30 text-red-300 px-3 py-2 rounded-md text-sm">{err}</div>}
        </div>
        <div className="px-5 py-4 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-md">Cancel</button>
          <button onClick={submit} disabled={busy}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-900 font-semibold rounded-md flex items-center gap-2">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {isAdd ? `Create ${role === 'admin' ? 'Admin' : 'User'}` : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangePasswordModal({ user, isSelf, onSave, onClose }) {
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(null);
    if (isSelf && !currentPw) return setErr('Current password is required');
    if (newPw.length < 6) return setErr('New password must be at least 6 characters');
    if (newPw !== confirm) return setErr('Passwords do not match');
    setBusy(true);
    try { await onSave(user.id, newPw, isSelf ? currentPw : undefined); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-md">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-lg font-bold">{isSelf ? 'Change Your Password' : `Reset Password for "${user.username}"`}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          {!isSelf && (
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 px-3 py-2 rounded-md text-sm">
              Their active sessions will be ended. They'll need to log in again with the new password.
            </div>
          )}
          {isSelf && (
            <Field label="Current Password">
              <input type={showPw ? 'text' : 'password'} value={currentPw} onChange={e => setCurrentPw(e.target.value)} className="input" autoFocus />
            </Field>
          )}
          <Field label="New Password (min 6 characters)">
            <div className="relative">
              <input type={showPw ? 'text' : 'password'} value={newPw} onChange={e => setNewPw(e.target.value)} className="input pr-10" autoFocus={!isSelf} />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </Field>
          <Field label="Confirm New Password">
            <input type={showPw ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} className="input" />
          </Field>
          {err && <div className="bg-red-500/10 border border-red-500/30 text-red-300 px-3 py-2 rounded-md text-sm">{err}</div>}
        </div>
        <div className="px-5 py-4 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-md">Cancel</button>
          <button onClick={submit} disabled={busy}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-900 font-semibold rounded-md flex items-center gap-2">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} {isSelf ? 'Update Password' : 'Reset Password'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SETTINGS - branding+logo, backup/restore, danger zone
// ============================================================
// ============================================================
// UpdatesSection — in-app updater UI
// ============================================================
function UpdatesSection() {
  const [version, setVersion] = useState(null);
  const [versionError, setVersionError] = useState(null);
  const [versionLoaded, setVersionLoaded] = useState(false);
  const [check, setCheck] = useState(null);
  const [status, setStatus] = useState({ state: 'idle', log: '', hasPrevious: false });
  const [checking, setChecking] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [changelog, setChangelog] = useState('');
  const [showChangelog, setShowChangelog] = useState(false);

  // Post-reload "Update successful" banner — set in sessionStorage right before
  // the auto-reload fires after an update.
  const [justUpdated, setJustUpdated] = useState(() => {
    try {
      if (sessionStorage.getItem('updater:justFinished') === '1') {
        sessionStorage.removeItem('updater:justFinished');
        return true;
      }
    } catch {}
    return false;
  });
  useEffect(() => {
    if (!justUpdated) return;
    const t = setTimeout(() => {
      setJustUpdated(false);
      // Also clear the server-side "done" state so the UPDATE SUCCESSFUL block + log
      // also disappear, since the user has clearly seen the result by now.
      apiPost('/updater/dismiss').then(() => {
        setStatus(s => ({ ...s, state: 'idle' }));
      }).catch(() => {});
    }, 6000);
    return () => clearTimeout(t);
  }, [justUpdated]);

  const refreshVersion = async () => {
    try {
      const v = await apiGet('/updater/version');
      setVersion(v);
      setVersionError(null);
    } catch (e) {
      setVersionError(e.message);
    } finally {
      setVersionLoaded(true);
    }
  };
  const refreshStatus = async () => {
    try {
      const s = await apiGet('/updater/status');
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    refreshVersion();
    refreshStatus();
  }, []);

  // Track whether the user actually triggered an update in this session,
  // so we can auto-reload when the state transitions from running -> done.
  const [didTrigger, setDidTrigger] = useState(false);

  // While running, poll status every 2s.
  // The service WILL restart during step 6 — polls fail for ~5s while it comes back.
  // We keep polling regardless; once the service is back, we'll see the final state.
  useEffect(() => {
    if (status.state === 'running' || status.state === 'rolling-back') {
      const id = setInterval(refreshStatus, 2000);
      return () => clearInterval(id);
    }
    if (status.state === 'done' || status.state === 'failed') {
      refreshVersion();
    }
  }, [status.state]);

  // When the user triggers an update and we then see state become "done" OR
  // when version SHA changes (clear sign the new code is running),
  // auto-reload after a moment to load the new frontend JS.
  useEffect(() => {
    if (!didTrigger) return;
    if (status.state === 'done') {
      try { sessionStorage.setItem('updater:justFinished', '1'); } catch {}
      const t = setTimeout(() => window.location.reload(), 1500);
      return () => clearTimeout(t);
    }
  }, [didTrigger, status.state]);

  // Safety net: if we've been "running" for >45s, the update almost certainly
  // finished (typical update takes ~15-20s). Force a page reload, which loads the
  // new JS bundle AND picks up the "done" state from the server.
  useEffect(() => {
    if (status.state !== 'running' && status.state !== 'rolling-back') return;
    const timer = setTimeout(() => {
      // Remember that we just did an update so the post-reload page can show a banner
      try { sessionStorage.setItem('updater:justFinished', '1'); } catch {}
      window.location.reload();
    }, 45 * 1000);
    return () => clearTimeout(timer);
  }, [status.state]);

  const doCheck = async () => {
    setChecking(true);
    setCheck(null);
    try {
      const r = await apiGet('/updater/check');
      setCheck(r);
    } catch (e) {
      setCheck({ error: e.message });
    } finally {
      setChecking(false);
    }
  };

  const doUpdate = async () => {
    setConfirm(null);
    setShowLog(true);
    setDidTrigger(true);
    try {
      await apiPost('/updater/update');
      setStatus({ state: 'running', log: '', hasPrevious: false });
      setTimeout(refreshStatus, 500);
    } catch (e) {
      alert('Failed to start update: ' + e.message);
      setDidTrigger(false);
    }
  };

  const doRollback = async () => {
    setConfirm(null);
    setShowLog(true);
    setDidTrigger(true);
    try {
      await apiPost('/updater/rollback');
      setStatus({ state: 'rolling-back', log: '', hasPrevious: status.hasPrevious });
      setTimeout(refreshStatus, 500);
    } catch (e) {
      alert('Failed to start rollback: ' + e.message);
      setDidTrigger(false);
    }
  };

  const loadChangelog = async () => {
    try {
      const r = await fetch('/api/updater/changelog', { headers: { 'Authorization': `Bearer ${getToken()}` } });
      setChangelog(await r.text());
      setShowChangelog(true);
    } catch {}
  };

  const dismissStatus = async () => {
    try {
      await apiPost('/updater/dismiss');
      setStatus(s => ({ ...s, state: 'idle' }));
    } catch {}
  };

  const isRunning = status.state === 'running' || status.state === 'rolling-back';
  const isFresh = status.state === 'done';
  const isFailed = status.state === 'failed';

  // Track when the running state began, so we can show "Reload" button after a while
  const [runningSince, setRunningSince] = useState(null);
  const [showReload, setShowReload] = useState(false);
  useEffect(() => {
    if (isRunning && !runningSince) setRunningSince(Date.now());
    if (!isRunning) { setRunningSince(null); setShowReload(false); }
  }, [isRunning, runningSince]);
  useEffect(() => {
    if (!isRunning) return;
    const t = setTimeout(() => setShowReload(true), 10 * 1000);
    return () => clearTimeout(t);
  }, [isRunning]);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 max-w-3xl">
      <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
        <CloudDownload className="w-5 h-5 text-sky-400" /> Updates
      </h3>
      <p className="text-sm text-zinc-400 mb-5">
        Pull the latest version of the system from GitHub. Your data is backed up automatically before each update.
      </p>

      {justUpdated && (
        <div className="p-4 bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 rounded mb-4 flex items-center gap-3 animate-pulse">
          <Check className="w-6 h-6 flex-shrink-0" />
          <div>
            <div className="font-bold">Update successful!</div>
            <div className="text-xs text-emerald-300/80">You're now running v{version?.version || '...'}</div>
          </div>
        </div>
      )}

      {versionLoaded && versionError && (
        <div className="p-4 bg-red-500/10 border border-red-500/30 text-red-200 rounded text-sm mb-4">
          ⚠️ Could not load version info: {versionError}
        </div>
      )}

      {versionLoaded && !versionError && version && !version.repoConfigured && (
        <div className="p-4 bg-amber-500/10 border border-amber-500/30 text-amber-200 rounded text-sm mb-4">
          ⚠️ Updater not configured on the server yet. Run <code className="bg-zinc-950 px-1 rounded">sudo bash /opt/pos-stock-system/scripts/bootstrap-updater.sh</code> as root.
        </div>
      )}

      {/* Current version row */}
      <div className="flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded-lg p-4 mb-3">
        <div>
          <div className="text-xs text-zinc-500 uppercase tracking-wide">Current version</div>
          <div className="text-2xl font-bold text-zinc-100 mt-1">v{version?.version || '…'}</div>
          {version?.sha && (
            <div className="text-xs text-zinc-500 mt-1 flex items-center gap-1">
              <GitBranch className="w-3 h-3" /> {version.branch || 'main'} · {version.sha}
            </div>
          )}
        </div>
        <button onClick={loadChangelog}
          className="text-sm text-sky-400 hover:text-sky-300 underline">
          View changelog
        </button>
      </div>

      {/* Check button */}
      {!isRunning && (
        <button onClick={doCheck} disabled={checking || !version?.repoConfigured}
          className="w-full flex items-center justify-center gap-2 p-3 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-md font-medium mb-3">
          {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {checking ? 'Checking GitHub…' : 'Check for Updates'}
        </button>
      )}

      {/* Check result */}
      {check?.error && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-300 rounded text-sm mb-3">
          {check.error}
        </div>
      )}
      {check && !check.error && !check.updateAvailable && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 rounded text-sm mb-3 flex items-center gap-2">
          <Check className="w-4 h-4" /> You're on the latest version (v{check.currentVersion}).
        </div>
      )}
      {check && !check.error && check.updateAvailable && !isRunning && (
        <div className="bg-sky-500/10 border border-sky-500/30 rounded-lg p-4 mb-3">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-5 h-5 text-sky-300" />
            <div className="font-semibold text-sky-200">Update available: v{check.latestVersion}</div>
          </div>
          <div className="text-xs text-zinc-400 mb-3">
            {check.currentSha} → {check.latestSha}
          </div>
          <button onClick={() => setConfirm('update')}
            className="w-full p-3 bg-sky-500 hover:bg-sky-400 text-zinc-950 font-bold rounded-md">
            Update Now
          </button>
        </div>
      )}

      {/* Running state */}
      {isRunning && (
        <div className="bg-zinc-950 border border-sky-500/30 rounded-lg p-4 mb-3">
          <div className="flex items-center gap-2 mb-3">
            <Loader2 className="w-5 h-5 animate-spin text-sky-400" />
            <div className="font-semibold text-sky-200">
              {status.state === 'rolling-back' ? 'Rolling back…' : 'Updating…'}
            </div>
          </div>
          <div className="text-xs text-amber-300 mb-3">⚠️ This takes about a minute. The app will briefly disconnect while it restarts — that's normal.</div>
          <pre className="bg-black/50 rounded p-3 text-xs text-zinc-300 max-h-64 overflow-auto whitespace-pre-wrap">{status.log || 'Starting…'}</pre>
          {showReload && (
            <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded">
              <div className="text-sm text-amber-200 mb-2">
                Taking longer than expected? The update may have finished but the page lost connection while the service restarted.
              </div>
              <button onClick={() => window.location.reload()}
                className="w-full p-2 bg-amber-500 hover:bg-amber-400 text-zinc-900 font-semibold rounded">
                Reload the page
              </button>
            </div>
          )}
        </div>
      )}

      {/* Done / Failed */}
      {isFresh && !isRunning && (
        <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded mb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Check className="w-6 h-6 text-emerald-300" />
              <div>
                <div className="text-emerald-200 font-bold text-base">UPDATE SUCCESSFUL</div>
                {version?.version && <div className="text-xs text-emerald-300 mt-0.5">Now running v{version.version}</div>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setShowLog(s => !s)} className="text-xs text-emerald-300 underline">{showLog ? 'Hide' : 'Show'} log</button>
              <button onClick={dismissStatus}
                className="text-xs bg-emerald-500/30 hover:bg-emerald-500/40 text-emerald-100 px-3 py-1 rounded">
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
      {isFailed && (
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded mb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-6 h-6 text-red-300" />
              <div>
                <div className="text-red-200 font-bold text-base">UPDATE FAILED</div>
                <div className="text-xs text-red-300 mt-0.5">You can roll back below or check the log.</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setShowLog(s => !s)} className="text-xs text-red-300 underline">{showLog ? 'Hide' : 'Show'} log</button>
              <button onClick={dismissStatus}
                className="text-xs bg-red-500/30 hover:bg-red-500/40 text-red-100 px-3 py-1 rounded">
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
      {showLog && !isRunning && status.log && (
        <pre className="bg-black/50 rounded p-3 text-xs text-zinc-300 max-h-64 overflow-auto whitespace-pre-wrap mb-3">{status.log}</pre>
      )}

      {/* Rollback */}
      {status.hasPrevious && !isRunning && (
        <div className="mt-4 pt-4 border-t border-zinc-800">
          <button onClick={() => setConfirm('rollback')}
            className="text-sm flex items-center gap-2 text-amber-300 hover:text-amber-200">
            <RotateCcw className="w-4 h-4" /> Roll back to previous version
          </button>
        </div>
      )}

      {/* Confirms */}
      {confirm === 'update' && (
        <ConfirmDialog
          title={`Update to v${check?.latestVersion}?`}
          message="This pulls the latest code from GitHub, rebuilds the frontend, and restarts the service. Your data is backed up automatically. The app will briefly disconnect (~1-2 min)."
          confirmLabel="Yes, Update Now"
          confirmClass="bg-sky-500 hover:bg-sky-400 text-zinc-950"
          onConfirm={doUpdate}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'rollback' && (
        <ConfirmDialog
          title="Roll back to previous version?"
          message="This will undo the last update. Your data is preserved. The app will briefly disconnect while it rebuilds."
          confirmLabel="Yes, Roll Back"
          confirmClass="bg-amber-500 hover:bg-amber-400 text-zinc-900"
          onConfirm={doRollback}
          onCancel={() => setConfirm(null)}
        />
      )}

      {/* Changelog modal */}
      {showChangelog && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-zinc-800">
              <h3 className="text-lg font-semibold">Changelog</h3>
              <button onClick={() => setShowChangelog(false)} className="text-zinc-400 hover:text-zinc-200"><X className="w-5 h-5" /></button>
            </div>
            <pre className="p-6 overflow-auto text-sm text-zinc-300 whitespace-pre-wrap">{changelog || 'No changelog available.'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// AppearanceSection — theme + colour customization (v3.5.0)
// ============================================================
function AppearanceSection({ branding, refreshBranding, showMsg }) {
  const t = branding.theme || DEFAULT_THEME;
  const [mode, setMode] = useState(t.mode || 'dark');
  const [accent, setAccent] = useState(t.accent || DEFAULT_THEME.accent);
  const [success, setSuccess] = useState(t.success || DEFAULT_THEME.success);
  const [warning, setWarning] = useState(t.warning || DEFAULT_THEME.warning);
  const [info, setInfo] = useState(t.info || DEFAULT_THEME.info);
  const [busy, setBusy] = useState(false);

  // Re-sync when branding updates externally
  useEffect(() => {
    const x = branding.theme || DEFAULT_THEME;
    setMode(x.mode || 'dark');
    setAccent(x.accent || DEFAULT_THEME.accent);
    setSuccess(x.success || DEFAULT_THEME.success);
    setWarning(x.warning || DEFAULT_THEME.warning);
    setInfo(x.info || DEFAULT_THEME.info);
  }, [branding.theme]);

  const save = async () => {
    setBusy(true);
    try {
      await apiPut('/branding/theme', { mode, accent, success, warning, info });
      await refreshBranding();
      showMsg('ok', 'Appearance updated');
    } catch (e) {
      showMsg('err', e.message);
    } finally { setBusy(false); }
  };

  const resetDefaults = async () => {
    setBusy(true);
    try {
      await apiPut('/branding/theme', { ...DEFAULT_THEME });
      await refreshBranding();
      showMsg('ok', 'Reset to defaults');
    } catch (e) { showMsg('err', e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 max-w-3xl">
      <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
        <Sparkles className="w-5 h-5" style={{ color: accent }} /> Appearance
      </h3>
      <p className="text-sm text-zinc-400 mb-5">
        Change the look of the app. Customisations apply system-wide and are visible to everyone.
      </p>

      {/* Mode toggle */}
      <Field label="Theme Mode">
        <div className="flex gap-2">
          <button onClick={() => setMode('dark')}
            className={`flex-1 px-4 py-2 rounded-md border text-sm font-medium ${
              mode === 'dark' ? 'border-zinc-500 bg-zinc-800 text-white' : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
            }`}>🌙 Dark</button>
          <button onClick={() => setMode('light')}
            className={`flex-1 px-4 py-2 rounded-md border text-sm font-medium ${
              mode === 'light' ? 'border-zinc-500 bg-zinc-800 text-white' : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
            }`}>☀️ Light</button>
        </div>
      </Field>

      <div className="mt-5 grid grid-cols-2 gap-4">
        <ColourPicker label="Accent / Primary"
          help="Buttons, highlights, the Issue Stock button. (Was amber.)"
          value={accent} onChange={setAccent} />
        <ColourPicker label="Success"
          help="Green ✓ marks, 'Available', confirmations. (Was emerald.)"
          value={success} onChange={setSuccess} />
        <ColourPicker label="Warning"
          help="Low-stock alerts, 'OUT' badges, overdue. (Was amber.)"
          value={warning} onChange={setWarning} />
        <ColourPicker label="Info / Updates"
          help="Update buttons, info badges. (Was sky blue.)"
          value={info} onChange={setInfo} />
      </div>

      {/* Live preview */}
      <div className="mt-6 p-4 border border-zinc-800 rounded-md bg-zinc-950">
        <div className="text-xs text-zinc-500 uppercase tracking-wide mb-3">Preview</div>
        <div className="flex flex-wrap gap-2 items-center">
          <button style={{ background: accent, color: textOn(accent) }}
            className="px-4 py-2 font-semibold rounded-md text-sm">Primary Button</button>
          <span style={{ background: 'rgb(' + hexToRgb(success) + ' / 0.2)', color: shiftHex(success, 30) }}
            className="text-xs px-2 py-1 rounded">Available</span>
          <span style={{ background: 'rgb(' + hexToRgb(warning) + ' / 0.2)', color: shiftHex(warning, 30) }}
            className="text-xs px-2 py-1 rounded">Low Stock · 3</span>
          <button style={{ background: info, color: textOn(info) }}
            className="px-3 py-1.5 font-semibold rounded-md text-xs">Update Now</button>
          <span className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-300">Defective (always red)</span>
        </div>
      </div>

      <div className="mt-5 flex gap-2">
        <button onClick={save} disabled={busy}
          className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-900 font-semibold rounded-md flex items-center gap-2">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          Save Appearance
        </button>
        <button onClick={resetDefaults} disabled={busy}
          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md">
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}

function ColourPicker({ label, help, value, onChange }) {
  return (
    <Field label={label}>
      <div className="flex gap-2 items-center">
        <input type="color" value={value} onChange={e => onChange(e.target.value)}
          className="h-10 w-14 bg-transparent border border-zinc-700 rounded cursor-pointer" />
        <input type="text" value={value}
          onChange={e => { const v = e.target.value; if (/^#?[0-9a-fA-F]{0,6}$/.test(v)) onChange(v.startsWith('#') ? v : '#' + v); }}
          className="input font-mono uppercase" maxLength={7} />
      </div>
      {help && <div className="text-xs text-zinc-500 mt-1">{help}</div>}
    </Field>
  );
}

function SettingsScreen({ refresh, branding, refreshBranding }) {
  const [confirm, setConfirm] = useState(null);
  const [backups, setBackups] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const fileRef = useRef(null);
  const logoRef = useRef(null);

  const [name, setName] = useState(branding.systemName);
  const [subtitle, setSubtitle] = useState(branding.systemSubtitle);

  useEffect(() => { setName(branding.systemName); setSubtitle(branding.systemSubtitle); }, [branding.systemName, branding.systemSubtitle]);

  const loadBackups = async () => {
    try { setBackups(await apiGet('/backups/list')); } catch (err) { console.error(err); }
  };
  useEffect(() => { loadBackups(); }, []);

  const showMsg = (type, text) => { setMessage({ type, text }); setTimeout(() => setMessage(null), 4000); };

  const saveBranding = async () => {
    setBusy(true);
    try {
      await apiPut('/system', { systemName: name, systemSubtitle: subtitle });
      await refreshBranding();
      showMsg('ok', 'Branding updated');
    } catch (err) { showMsg('err', err.message); } finally { setBusy(false); }
  };

  const uploadLogo = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { showMsg('err', 'Please upload an image file'); return; }
    if (file.size > 2 * 1024 * 1024) { showMsg('err', 'Logo must be under 2 MB'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('logo', file);
      const r = await fetch('/api/system/logo', {
        method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: fd,
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Upload failed');
      await refreshBranding();
      showMsg('ok', 'Logo uploaded');
    } catch (err) { showMsg('err', err.message); } finally { setBusy(false); if (logoRef.current) logoRef.current.value = ''; }
  };

  const removeLogo = async () => {
    try { await apiDelete('/system/logo'); await refreshBranding(); showMsg('ok', 'Logo removed'); }
    catch (err) { showMsg('err', err.message); }
  };

  const downloadBackup = async () => {
    try {
      const r = await fetch('/api/backup', { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!r.ok) throw new Error('Download failed');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const filename = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'everton-backup.json';
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { showMsg('err', err.message); }
  };

  const snapshotNow = async () => {
    setBusy(true);
    try { const r = await apiPost('/backups/snapshot'); showMsg('ok', `Saved: ${r.filename}`); await loadBackups(); }
    catch (err) { showMsg('err', err.message); } finally { setBusy(false); }
  };

  const handleRestore = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('backup', file);
      const r = await fetch('/api/restore', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: fd });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || 'Restore failed');
      showMsg('ok', `Restored ${result.restored.products} products and ${result.restored.employees} operators`);
      await refresh();
      await refreshBranding();
      await loadBackups();
    } catch (err) { showMsg('err', err.message); }
    finally { setBusy(false); setConfirm(null); if (fileRef.current) fileRef.current.value = ''; }
  };

  const clearAll = async () => { await apiPost('/clear/all'); setConfirm(null); await refresh(); showMsg('ok', 'Everything cleared'); };
  const clearHistory = async () => { await apiPost('/clear/history'); setConfirm(null); await refresh(); showMsg('ok', 'History cleared'); };

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-2xl font-bold">Settings</h2>

      {message && (
        <div className={`px-4 py-3 rounded-md text-sm ${
          message.type === 'ok' ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'
        }`}>{message.text}</div>
      )}

      {/* Branding */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 max-w-3xl">
        <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
          <Image className="w-5 h-5 text-amber-400" /> Branding
        </h3>
        <p className="text-sm text-zinc-400 mb-5">Customize the company name, subtitle, and logo shown across the app.</p>

        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-4">
            <Field label="System Name">
              <input value={name} onChange={e => setName(e.target.value)} className="input" placeholder="EVERTON ENGINEERING" />
            </Field>
            <Field label="Subtitle">
              <input value={subtitle} onChange={e => setSubtitle(e.target.value)} className="input" placeholder="Tooling Stock Management" />
            </Field>
            <button onClick={saveBranding} disabled={busy}
              className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-900 font-semibold rounded-md">
              Save Name & Subtitle
            </button>
          </div>

          <div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Logo</div>
            <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 flex items-center justify-center mb-3" style={{ height: 140 }}>
              {branding.hasLogo ? (
                <img src={`/api/branding/logo?v=${branding.logoVersion}`} alt="Logo" className="max-w-full max-h-full object-contain" />
              ) : (
                <div className="text-zinc-600 text-sm">No logo</div>
              )}
            </div>
            <input ref={logoRef} type="file" accept="image/*" onChange={uploadLogo} className="hidden" />
            <div className="flex gap-2">
              <button onClick={() => logoRef.current?.click()} disabled={busy}
                className="flex-1 text-sm bg-zinc-800 hover:bg-zinc-700 px-3 py-2 rounded">
                {branding.hasLogo ? 'Replace' : 'Upload'}
              </button>
              {branding.hasLogo && (
                <button onClick={removeLogo} disabled={busy}
                  className="text-sm bg-red-500/20 hover:bg-red-500/30 text-red-300 px-3 py-2 rounded">
                  Remove
                </button>
              )}
            </div>
            <div className="text-xs text-zinc-600 mt-2">Max 2 MB. PNG with transparent background works best.</div>
          </div>
        </div>
      </div>

      {/* Appearance */}
      <AppearanceSection branding={branding} refreshBranding={refreshBranding} showMsg={showMsg} />

      {/* Updates */}
      <UpdatesSection />

      {/* Backup & Restore */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 max-w-3xl">
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <Save className="w-5 h-5 text-emerald-400" /> Backup & Restore
        </h3>
        <p className="text-sm text-zinc-400 mb-4">
          The server auto-saves a snapshot every 6 hours (last 30 kept). You can also download a backup file now,
          or upload an old backup to restore everything. A safety snapshot is taken before any restore.
        </p>
        <div className="grid grid-cols-2 gap-3 mb-6">
          <button onClick={downloadBackup} disabled={busy}
            className="flex items-center justify-center gap-2 p-4 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 rounded-md font-medium">
            <Download className="w-5 h-5" /> Download Backup File
          </button>
          <button onClick={() => setConfirm('restore')} disabled={busy}
            className="flex items-center justify-center gap-2 p-4 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded-md font-medium">
            <Upload className="w-5 h-5" /> Restore from File
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".json" onChange={handleRestore} className="hidden" />

        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-zinc-300">Server-side Backups</div>
          <button onClick={snapshotNow} disabled={busy}
            className="text-xs bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded flex items-center gap-1.5">
            <Save className="w-3.5 h-3.5" /> Snapshot Now
          </button>
        </div>
        <div className="bg-zinc-950 border border-zinc-800 rounded-md max-h-64 overflow-auto">
          {backups.length === 0 ? (
            <div className="p-4 text-center text-zinc-500 text-sm">No server backups yet</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-zinc-500 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-3 py-2">Filename</th>
                  <th className="text-left px-3 py-2">Created</th>
                  <th className="text-right px-3 py-2">Size</th>
                </tr>
              </thead>
              <tbody>
                {backups.map(b => (
                  <tr key={b.name} className="border-t border-zinc-800">
                    <td className="px-3 py-1.5 font-mono text-xs">{b.name}</td>
                    <td className="px-3 py-1.5 text-zinc-400 text-xs">{fmtDateTime(b.modifiedAt)}</td>
                    <td className="px-3 py-1.5 text-right text-zinc-500 text-xs">{(b.size / 1024).toFixed(1)} KB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="text-xs text-zinc-500 mt-2">
          Server backups are stored in <span className="font-mono">data/backups/</span> on your cloud server.
          SSH in to copy them off-server for extra safety.
        </p>
      </div>

      {/* Danger Zone */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 max-w-3xl">
        <h3 className="text-lg font-semibold mb-4 text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5" /> Danger Zone
        </h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 bg-zinc-950 border border-zinc-800 rounded-md">
            <div className="mr-4">
              <div className="font-medium">Clear Transaction History</div>
              <div className="text-sm text-zinc-500">Removes all movements, transactions, AND monthly archives. Stock levels and admins are kept.</div>
            </div>
            <button onClick={() => setConfirm('history')}
              className="px-4 py-2 bg-red-500/20 text-red-300 hover:bg-red-500/30 rounded-md font-medium text-sm whitespace-nowrap">
              Clear History
            </button>
          </div>
          <div className="flex items-center justify-between p-4 bg-zinc-950 border border-zinc-800 rounded-md">
            <div className="mr-4">
              <div className="font-medium">Reset Everything</div>
              <div className="text-sm text-zinc-500">Wipes all products, operators, barcodes, history, and archives. Admins and backups are kept.</div>
            </div>
            <button onClick={() => setConfirm('all')}
              className="px-4 py-2 bg-red-500 text-white hover:bg-red-400 rounded-md font-medium text-sm whitespace-nowrap">
              Reset Everything
            </button>
          </div>
        </div>
      </div>

      {confirm === 'history' && (
        <ConfirmDialog title="Clear all transaction history?"
          message="This permanently deletes every movement, transaction, AND monthly archive. Current stock levels are NOT changed. This cannot be undone."
          confirmLabel="Clear History" onConfirm={clearHistory} onCancel={() => setConfirm(null)} />
      )}
      {confirm === 'all' && (
        <ConfirmDialog title="Reset entire system?"
          message="This deletes products, operators, barcodes, transactions, history, and monthly archives. Admin accounts, branding, and server backups are kept. This cannot be undone."
          confirmLabel="Yes, Wipe Everything" onConfirm={clearAll} onCancel={() => setConfirm(null)} />
      )}
      {confirm === 'restore' && (
        <ConfirmDialog title="Restore from backup file?"
          message="This will REPLACE all current data with the contents of the backup file. A safety snapshot is taken automatically first. Continue?"
          confirmLabel="Yes, Choose File"
          confirmClass="bg-amber-500 hover:bg-amber-400 text-zinc-900"
          onConfirm={() => { fileRef.current?.click(); }} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}
