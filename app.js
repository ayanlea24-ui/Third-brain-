require('dotenv').config({ override: true });

const express = require('express');
const mongoose = require('mongoose');
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const xlsx = require('xlsx');
const apn = require('apn');
const { buildWorkspaceStoreApiJs } = require('./workspace-store');

const WORKSPACE_STORE_API_JS = buildWorkspaceStoreApiJs();

const app = express();
const port = Number(process.env.PORT || 3110);

/** ---- Route performance instrumentation (set ROUTE_TIMING_DETAIL=0 to disable detail; ROUTE_TIMING_ALL=1 for all routes) ---- */
const routeTimingAls = new AsyncLocalStorage();
const ROUTE_TIMING_DETAIL = String(process.env.ROUTE_TIMING_DETAIL || '1').trim().toLowerCase() !== '0';
const ROUTE_TIMING_ALL = String(process.env.ROUTE_TIMING_ALL || '').trim().toLowerCase() === '1';
const ROUTE_TIMING_SLOW_MS = Math.max(0, Number(process.env.ROUTE_TIMING_SLOW_MS) || 200);

function routeTimingWantsDetail(req) {
  if (ROUTE_TIMING_ALL) return true;
  if (!ROUTE_TIMING_DETAIL) return false;
  const p = req.path || '';
  if (req.method === 'POST' && p === '/login') return true;
  if (req.method === 'GET' && (p === '/test-engine' || p === '/test-engine/question-start')) return true;
  return false;
}

function createRouteTimingStore(req) {
  const hr = process.hrtime.bigint();
  return {
    key: `${req.method} ${req.originalUrl || req.url || ''}`.slice(0, 240),
    path: req.path || '',
    method: req.method || 'GET',
    startedAt: Date.now(),
    hr0: hr,
    _lastHr: hr,
    checkpoints: [],
    queryCount: 0,
    dbWallMs: 0,
    queries: [],
    responseBytes: 0,
    loggedSend: false
  };
}

function routeTimingCheckpoint(label) {
  const s = routeTimingAls.getStore();
  if (!s) return;
  const now = process.hrtime.bigint();
  const ms = Math.round(Number(now - s._lastHr) / 1e6 * 100) / 100;
  s.checkpoints.push({ label: String(label || ''), ms });
  s._lastHr = now;
}

function installRouteTimingMongoHooks() {
  if (mongoose.__radRouteTimingInstalled) return;
  mongoose.__radRouteTimingInstalled = true;
  const recordQuery = (store, t0, col, op) => {
    const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6 * 100) / 100;
    if (!store) return;
    store.queryCount += 1;
    store.dbWallMs += ms;
    if (store.queries.length < 80) store.queries.push({ col: col || '?', op: String(op || '?'), ms });
    if (ms >= ROUTE_TIMING_SLOW_MS) {
      console.log(`[ROUTE][SLOW-QUERY] ${col}.${String(op)} ${ms}ms`);
    }
  };
  const patchExec = (proto, fallbackOp) => {
    const orig = proto.exec;
    proto.exec = function routeTimingPatchedExec(...args) {
      const store = routeTimingAls.getStore();
      const t0 = process.hrtime.bigint();
      const col = this.model && this.model.collection && this.model.collection.name;
      const op = this.op || fallbackOp;
      try {
        const out = orig.apply(this, args);
        if (out && typeof out.then === 'function') {
          return out.then(
            (r) => {
              recordQuery(store, t0, col, op);
              return r;
            },
            (e) => {
              recordQuery(store, t0, col, op);
              throw e;
            }
          );
        }
        recordQuery(store, t0, col, op);
        return out;
      } catch (e) {
        recordQuery(store, t0, col, op);
        throw e;
      }
    };
  };
  patchExec(mongoose.Query.prototype, 'query');
  if (mongoose.Aggregate && mongoose.Aggregate.prototype && typeof mongoose.Aggregate.prototype.exec === 'function') {
    patchExec(mongoose.Aggregate.prototype, 'aggregate');
  }
}

installRouteTimingMongoHooks();

function logRouteTimingDetail(req, res) {
  const s = routeTimingAls.getStore();
  if (!s || s._summaryLogged) return;
  s._summaryLogged = true;
  const total = Date.now() - s.startedAt;
  const kb = s.responseBytes > 0 ? Math.round(s.responseBytes / 102.4) / 10 : 0;
  const cps = s.checkpoints || [];
  const cpLines = cps.map((c) => `  - ${c.label}: ${c.ms}ms`).join('\n');
  const qLines = (s.queries || []).slice(0, 20).map((q) => `    ${q.col}.${q.op} ${q.ms}ms`).join('\n');
  const afterFinish = cps.find((c) => c.label === 'after_response_finish');
  const beforeSend = cps.find((c) => c.label === 'before_res.send');
  const sendPhaseMs = afterFinish && beforeSend ? afterFinish.ms : null;
  const dbSum = Math.round(s.dbWallMs * 10) / 10;
  const otherWall = Math.max(0, Math.round((total - dbSum) * 10) / 10);
  console.log(
    `[ROUTE] ${s.key}\n` +
      `- total: ${total}ms\n` +
      `- db (sum of exec durations): ${dbSum}ms  (note: can exceed wall time if queries overlap)\n` +
      `- queries: ${s.queryCount}\n` +
      (sendPhaseMs != null ? `- response send/finish (after before_res.send): ${sendPhaseMs}ms\n` : '') +
      `- other wall (approx total − db sum): ${otherWall}ms  (routing, sync work, waits, send)\n` +
      (cpLines ? `- checkpoints:\n${cpLines}\n` : '') +
      (qLines ? `- query log (first 20):\n${qLines}\n` : '') +
      `- response size: ${kb}kb (${s.responseBytes} bytes)`
  );
}
/** ---- end route timing helpers ---- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const HELP_GRID_UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads', 'help-grid');
const HELP_GRID_MANIFEST_PATH = path.join(HELP_GRID_UPLOAD_DIR, 'manifest.json');

function ensureHelpGridUploadDir() {
  try {
    fs.mkdirSync(HELP_GRID_UPLOAD_DIR, { recursive: true });
  } catch (err) {
    console.warn('[help-grid media] mkdir:', err && err.message ? err.message : err);
  }
}

function readHelpGridManifest() {
  try {
    const raw = fs.readFileSync(HELP_GRID_MANIFEST_PATH, 'utf8');
    const j = JSON.parse(raw);
    return {
      grid1: typeof j.grid1 === 'string' ? j.grid1 : '',
      grid2: typeof j.grid2 === 'string' ? j.grid2 : ''
    };
  } catch (e) {
    return { grid1: '', grid2: '' };
  }
}

function writeHelpGridManifest(next) {
  ensureHelpGridUploadDir();
  fs.writeFileSync(HELP_GRID_MANIFEST_PATH, JSON.stringify(next, null, 2), 'utf8');
}

function helpGridExtFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/png') return '.png';
  if (m === 'image/gif') return '.gif';
  if (m === 'image/webp') return '.webp';
  return '';
}

function helpGridExtFromOriginalName(name) {
  const n = String(name || '').toLowerCase();
  const m = n.match(/\.([a-z0-9]+)$/i);
  if (!m) return '';
  const ext = '.' + m[1].toLowerCase();
  if (ext === '.jpeg') return '.jpg';
  if (['.jpg', '.png', '.gif', '.webp'].includes(ext)) return ext;
  return '';
}

function helpGridPublicUrl(filename) {
  if (!filename || /[/\\]/.test(filename)) return '';
  const rel = '/uploads/help-grid/' + filename;
  const abs = path.join(HELP_GRID_UPLOAD_DIR, filename);
  let v = '';
  try {
    v = String(fs.statSync(abs).mtimeMs);
  } catch (e) {
    /* missing file */
  }
  return v ? `${rel}?v=${encodeURIComponent(v)}` : rel;
}

function getHelpGridUrlsForLanding() {
  const m = readHelpGridManifest();
  return {
    grid1: m.grid1 ? helpGridPublicUrl(m.grid1) : '',
    grid2: m.grid2 ? helpGridPublicUrl(m.grid2) : ''
  };
}

const legacyMongoUri = 'mongodb+srv://mac45:v47JmiGYELJymsMf@cluster0.rwhns6e.mongodb.net/rrradss';
const mongoUri = String(process.env.MONGODB_URI || '').trim() || legacyMongoUri;
const APNS_KEY_ID = String(process.env.APNS_KEY_ID || '').trim();
const APNS_TEAM_ID = String(process.env.APNS_TEAM_ID || '').trim();
const APNS_BUNDLE_ID = String(process.env.APNS_BUNDLE_ID || '').trim();
let apnProvider = null;

function resolveLandingPreviewImagePath(index) {
  const envKeys = ['LANDING_PREVIEW_PATH_0', 'LANDING_PREVIEW_PATH_1', 'LANDING_PREVIEW_PATH_2'];
  const fromEnv = String(process.env[envKeys[index]] || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);
  const base = path.join(process.cwd(), 'public', 'landing-preview', String(index));
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const full = base + ext;
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function buildLandingPreviewSvg(index) {
  const titles = ['Question practice', 'Quiz setup', 'Sign in'];
  const title = titles[index] || 'Radstudy';
  const accent = index === 1 ? '#6a3551' : index === 2 ? '#4d2840' : '#5d2e46';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<svg xmlns="http://www.w3.org/2000/svg" width="920" height="580" viewBox="0 0 920 580" role="img" aria-label="${title} preview">` +
    '<defs><linearGradient id="lpg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#faf7f9"/><stop offset="1" stop-color="#ebe3e8"/></linearGradient></defs>' +
    '<rect width="920" height="580" rx="18" fill="url(#lpg)"/>' +
    `<rect x="0" y="0" width="920" height="52" rx="18" fill="${accent}"/>` +
    '<rect x="0" y="40" width="920" height="12" fill="' +
    accent +
    '"/>' +
    `<text x="28" y="34" fill="#fff" font-family="system-ui,Segoe UI,sans-serif" font-size="17" font-weight="700">${title}</text>` +
    '<rect x="28" y="84" width="560" height="468" rx="10" fill="#fff" stroke="#e0d6dc" stroke-width="2"/>' +
    '<rect x="612" y="84" width="280" height="468" rx="10" fill="#fff" stroke="#e0d6dc" stroke-width="2"/>' +
    '<rect x="52" y="118" width="320" height="14" rx="4" fill="#d8ccd4"/>' +
    '<rect x="52" y="148" width="480" height="12" rx="3" fill="#efe8ec"/>' +
    '<rect x="52" y="172" width="460" height="12" rx="3" fill="#efe8ec"/>' +
    '<rect x="52" y="210" width="500" height="120" rx="6" fill="#f7f2f5" stroke="#e5d9e0"/>' +
    '<rect x="52" y="352" width="240" height="14" rx="4" fill="#d8ccd4"/>' +
    '<rect x="52" y="384" width="500" height="36" rx="6" fill="#faf7f9" stroke="#e5d9e0"/>' +
    '<rect x="52" y="436" width="500" height="36" rx="6" fill="#faf7f9" stroke="#e5d9e0"/>' +
    '<rect x="52" y="488" width="500" height="36" rx="6" fill="#faf7f9" stroke="#e5d9e0"/>' +
    '<rect x="636" y="118" width="232" height="12" rx="3" fill="#efe8ec"/>' +
    '<rect x="636" y="142" width="200" height="12" rx="3" fill="#efe8ec"/>' +
    '<rect x="636" y="188" width="232" height="280" rx="8" fill="#f7f2f5" stroke="#e5d9e0"/>' +
    '</svg>'
  );
}

mongoose.set('bufferCommands', false);

mongoose.connection.on('error', (err) => {
  console.error('MongoDB error:', err.message);
});

function isMongoConnected() {
  return mongoose.connection.readyState === 1;
}

let mongoReconnectTimer = null;
let mongoReconnectAttempts = 0;

async function connectMongo() {
  if (!mongoUri || !String(mongoUri).trim()) {
    console.warn('⚠️  MONGODB_URI is empty — set it in .env (see .env.example)');
    return false;
  }
  if (isMongoConnected()) return true;
  if (mongoose.connection.readyState === 2) return false;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect().catch(() => {});
  }
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 15000
  });
  console.log('✅ MongoDB connected (' + mongoUriLabel(mongoUri) + ', database: rrradss)');
  return true;
}

function scheduleMongoReconnect() {
  if (mongoReconnectTimer) return;
  const delayMs = Math.min(60000, 10000 + mongoReconnectAttempts * 5000);
  mongoReconnectAttempts += 1;
  mongoReconnectTimer = setTimeout(async () => {
    mongoReconnectTimer = null;
    if (isMongoConnected()) {
      mongoReconnectAttempts = 0;
      return;
    }
    try {
      await connectMongo();
      mongoReconnectAttempts = 0;
    } catch (err) {
      if (mongoReconnectAttempts <= 2 || mongoReconnectAttempts % 6 === 0) {
        console.error('❌ MongoDB still offline:', err.message.split('\n')[0]);
      }
      scheduleMongoReconnect();
    }
  }, delayMs);
}

function logMongoWhitelistHelp() {
  console.error(
    '   Atlas unreachable from this network (port 27017 times out). Try: phone hotspot, disable VPN/firewall,\n' +
      '   confirm Cluster0 is in the same Atlas project as Network Access, and cluster is not Paused.\n' +
      '   Dev workaround: MONGODB_URI=mongodb://127.0.0.1:27017/rrradss in .env (local MongoDB is running).'
  );
}

function mongoUriLabel(uri) {
  const s = String(uri || '');
  if (s.startsWith('mongodb://127.0.0.1') || s.startsWith('mongodb://localhost')) {
    return 'local MongoDB';
  }
  const m = s.match(/@([^/]+)/);
  return m ? m[1] : 'MongoDB';
}

async function startMongo() {
  console.log('MongoDB target: ' + mongoUriLabel(mongoUri));
  console.log('Connecting…');
  try {
    await connectMongo();
    mongoReconnectAttempts = 0;
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message.split('\n')[0]);
    logMongoWhitelistHelp();
    scheduleMongoReconnect();
  }
}

function initApnProvider() {
  try {
    if (apnProvider) return apnProvider;
    if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_BUNDLE_ID) {
      console.warn('⚠️ APNs disabled: missing APNS_KEY_ID, APNS_TEAM_ID, or APNS_BUNDLE_ID in .env');
      return null;
    }
    const production = String(process.env.APNS_PRODUCTION || '').trim().toLowerCase() === 'true';
    const keyBase64 = String(process.env.APNS_KEY_BASE64 || '').trim();
    const keyPath = String(process.env.APNS_KEY_PATH || '').trim();
    let key = null;
    if (keyBase64) {
      key = Buffer.from(keyBase64, 'base64');
      console.log('🔔 APNs using APNS_KEY_BASE64');
    } else if (keyPath) {
      if (!fs.existsSync(keyPath)) {
        console.error(`APNs key file not found at APNS_KEY_PATH: ${keyPath}`);
        return null;
      }
      key = keyPath;
      console.log(`🔔 APNs using key file: ${keyPath}`);
    }
    if (!key) {
      console.warn('⚠️ APNs disabled: missing APNS key (APNS_KEY_BASE64 or APNS_KEY_PATH).');
      return null;
    }
    apnProvider = new apn.Provider({
      token: { key, keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID },
      production
    });
    console.log('🔔 APNs provider loaded');
    return apnProvider;
  } catch (err) {
    console.error('APNs init failed:', err && err.message ? err.message : err);
    return null;
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  req._routeWallStart = Date.now();
  let wallDone = false;
  const wallOnce = () => {
    if (wallDone) return;
    wallDone = true;
    const ms = Date.now() - req._routeWallStart;
    if (!routeTimingWantsDetail(req)) {
      console.log(`[ROUTE] ${req.method} ${req.path || ''} → ${ms}ms`);
    }
  };
  res.on('finish', wallOnce);
  res.on('close', wallOnce);
  next();
});
app.use(express.static(path.join(process.cwd(), 'public')));

function injectGlobalScreenTransition(html) {
  return html;
}

app.use((req, res, next) => {
  const originalSend = res.send.bind(res);
  res.send = function sendWithGlobalTransition(body) {
    const contentType = String(res.get('Content-Type') || '');
    const isHtmlLike =
      typeof body === 'string' &&
      (contentType.includes('text/html') ||
        /^\s*<!doctype html/i.test(body) ||
        /<html[\s>]/i.test(body));
    const finalBody = isHtmlLike ? injectGlobalScreenTransition(body) : body;
    return originalSend(finalBody);
  };
  next();
});

app.use((req, res, next) => {
  if (!routeTimingWantsDetail(req)) return next();
  const store = createRouteTimingStore(req);
  routeTimingCheckpoint('detail_middleware_enter');
  const originalSend = res.send.bind(res);
  res.send = function routeTimingWrappedSend(body) {
    if (!store.loggedSend) {
      routeTimingCheckpoint('before_res.send');
      store.loggedSend = true;
    }
    try {
      if (typeof body === 'string') store.responseBytes += Buffer.byteLength(body, 'utf8');
      else if (Buffer.isBuffer(body)) store.responseBytes += body.length;
      else if (body != null) store.responseBytes += Buffer.byteLength(String(body), 'utf8');
    } catch (_) {
      /* ignore */
    }
    return originalSend(body);
  };
  let detailDone = false;
  const detailOnce = () => {
    if (detailDone) return;
    detailDone = true;
    routeTimingCheckpoint('after_response_finish');
    logRouteTimingDetail(req, res);
  };
  res.on('finish', detailOnce);
  res.on('close', detailOnce);
  routeTimingAls.run(store, () => next());
});

const USER_ROLES = ['trial', 'user', 'admin'];
const STUDENT_STATUS_VALUES = [
  'studying_not_registered',
  'registered_exam',
  'exam_completed_unsuccessful',
  'exam_completed_successful'
];

function createStudentNumber() {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `RS-${stamp}-${rand}`;
}

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function pickRowValue(row, keys) {
  const rowKeys = Object.keys(row || {});
  for (const wanted of keys) {
    const found = rowKeys.find((k) => String(k).trim().toLowerCase() === wanted.toLowerCase());
    if (found) return row[found];
  }
  return '';
}

function parseCorrectOptionValue(raw, options) {
  const v = String(raw || '').trim();
  if (!v) return -1;
  const upper = v.toUpperCase();
  const letterMap = { A: 0, B: 1, C: 2, D: 3 };
  if (Object.prototype.hasOwnProperty.call(letterMap, upper)) return letterMap[upper];
  const n = Number.parseInt(v, 10);
  if (!Number.isNaN(n)) {
    if (n >= 1 && n <= options.length) return n - 1; // human-friendly 1-based
    if (n >= 0 && n < options.length) return n;      // already 0-based
  }
  const textIdx = options.findIndex((o) => o.toLowerCase() === v.toLowerCase());
  return textIdx;
}

function hashAdminPassword(v) {
  return require('crypto').createHash('sha256').update(String(v || '')).digest('hex');
}

function parseCookies(req) {
  const raw = req.headers && req.headers.cookie ? req.headers.cookie : '';
  const out = {};
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    out[k] = decodeURIComponent(val);
  });
  return out;
}

function setCookie(res, key, value, maxAgeSec) {
  const parts = [`${key}=${encodeURIComponent(String(value))}`, 'Path=/', `Max-Age=${maxAgeSec}`, 'HttpOnly', 'SameSite=Lax'];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, key) {
  res.append('Set-Cookie', `${key}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

const questionAttemptTracker = new Map();

function getRequestUserKey(req) {
  if (req && req.actor && req.actor.actorId) {
    return req.actor.isGuest ? `guest:${req.actor.actorId}` : `user:${req.actor.actorId}`;
  }
  const cookies = parseCookies(req);
  if (cookies.uid) return `uid:${cookies.uid}`;
  if (cookies.admin_uid) return `admin:${cookies.admin_uid}`;
  if (cookies.guest_id) return `guest:${cookies.guest_id}`;
  return 'anon:pending';
}

function bumpQuestionAttempt(userKey, questionId) {
  const key = `${userKey}::${questionId}`;
  const next = (questionAttemptTracker.get(key) || 0) + 1;
  questionAttemptTracker.set(key, next);
  return next;
}

/**
 * Resolve admin session from `admin_uid` cookie (separate from regular `uid` login).
 * Memoized per request so middleware + handlers share one DB read.
 */
async function getAdminFromReq(req) {
  if (req.adminSessionChecked) return req.adminUser || null;
  req.adminSessionChecked = true;
  const cookies = parseCookies(req);
  const adminId = cookies.admin_uid || '';
  if (!adminId) {
    req.adminUser = null;
    return null;
  }
  const admin = await User.findById(adminId).lean();
  if (!admin || admin.role !== 'admin' || admin.isEnabled === false) {
    req.adminUser = null;
    return null;
  }
  req.adminUser = admin;
  return admin;
}

/** Block non-admin sessions from any `/admin/*` HTML or action except login, signup, and logout. */
async function requireAdminWebSession(req, res, next) {
  const rel = req.path || '';
  const method = String(req.method || 'GET').toUpperCase();
  if (rel === '/login' || rel === '/signup') return next();
  if (rel === '/logout' && method === 'POST') return next();
  const admin = await getAdminFromReq(req);
  if (!admin) return res.redirect(302, '/admin/login');
  next();
}

/** Same check for `/api/admin/*` JSON (no cookie sharing with regular user `uid`). */
async function requireAdminApiSession(req, res, next) {
  const allowUnauthAnalytics = String(process.env.IOS_ALLOW_UNAUTH_ANALYTICS || '')
    .trim()
    .toLowerCase() === 'true';
  if (allowUnauthAnalytics) return next();

  const nativeSecret = String(process.env.IOS_NATIVE_ADMIN_SECRET || '').trim();
  if (nativeSecret) {
    const header = String(req.get('X-Radstudy-iOS-Secret') || req.get('x-radstudy-ios-secret') || '').trim();
    if (header && header === nativeSecret) return next();
  }

  const admin = await getAdminFromReq(req);
  if (!admin) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

function normalizeApnsToken(raw) {
  return String(raw || '')
    .trim()
    .replace(/[<>\s]/g, '')
    .toLowerCase();
}

async function sendNewAccountPushNotification(user) {
  try {
    const provider = initApnProvider();
    if (!provider) return;
    const admins = await User.find({ role: 'admin', isEnabled: { $ne: false } })
      .select('iosPushTokens email')
      .lean();
    const tokens = Array.from(new Set(
      admins.flatMap((a) => Array.isArray(a.iosPushTokens) ? a.iosPushTokens : [])
    ))
      .map(normalizeApnsToken)
      .filter(Boolean);
    if (!tokens.length) {
      console.log('🔔 APNs skip: no admin device tokens registered.');
      return;
    }
    const note = new apn.Notification();
    note.topic = APNS_BUNDLE_ID;
    note.alert = {
      title: 'New account created',
      body: `${user && user.name ? user.name : 'New user'} (${user && user.email ? user.email : 'no-email'})`
    };
    note.sound = 'default';
    note.payload = {
      type: 'new_account',
      userId: String((user && user._id) || ''),
      role: String((user && user.role) || '')
    };
    const result = await provider.send(note, tokens);
    const failed = Array.isArray(result.failed) ? result.failed : [];
    if (failed.length) {
      console.warn('🔔 APNs failed tokens:', failed.map((f) => f.device).filter(Boolean).join(', '));
    }
    console.log(`🔔 APNs sent: ${result.sent.length} ok, ${failed.length} failed`);
  } catch (err) {
    console.error('sendNewAccountPushNotification failed:', err && err.message ? err.message : err);
  }
}

async function sendUserLoginPushNotification(user) {
  try {
    if (!user) return;
    const title = 'User login';
    const body = `${user && user.name ? user.name : 'User'} (${user && user.email ? user.email : 'no-email'}) logged in`;
    const result = await sendPushToAdminDevices({
      title,
      body,
      payload: {
        type: 'user_login',
        userId: String((user && user._id) || ''),
        role: String((user && user.role) || '')
      }
    });
    if (!result.ok) {
      console.log(`[push] user login push skipped: ${result.reason || 'unknown'}`);
      return;
    }
    console.log(`[push] user login push sent=${result.sent} failed=${result.failed}`);
  } catch (err) {
    console.error('sendUserLoginPushNotification failed:', err && err.message ? err.message : err);
  }
}

const DAILY_USER_SUMMARY_TIME_ZONE = String(process.env.DAILY_USER_SUMMARY_TIME_ZONE || 'America/Toronto').trim() || 'America/Toronto';
const DAILY_USER_SUMMARY_HOUR = Math.min(23, Math.max(0, Number(process.env.DAILY_USER_SUMMARY_HOUR || 12) || 12));
let dailyUserSummaryTimer = null;

function zonedDateParts(date, timeZone = DAILY_USER_SUMMARY_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const out = {};
  parts.forEach((p) => {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  });
  if (out.hour === 24) out.hour = 0;
  return out;
}

function timeZoneOffsetMs(date, timeZone = DAILY_USER_SUMMARY_TIME_ZONE) {
  const p = zonedDateParts(date, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour || 0, p.minute || 0, p.second || 0);
  return asUTC - date.getTime();
}

function localTimeToUtcDate({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = DAILY_USER_SUMMARY_TIME_ZONE) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = timeZoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset);
}

function addLocalDays(parts, days) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function localDayKey(parts) {
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-');
}

function nextDailyUserSummaryAt(now = new Date()) {
  const today = zonedDateParts(now);
  let target = localTimeToUtcDate({
    year: today.year,
    month: today.month,
    day: today.day,
    hour: DAILY_USER_SUMMARY_HOUR,
    minute: 0,
    second: 0
  });
  if (target.getTime() <= now.getTime() + 1000) {
    const tomorrow = addLocalDays(today, 1);
    target = localTimeToUtcDate({
      year: tomorrow.year,
      month: tomorrow.month,
      day: tomorrow.day,
      hour: DAILY_USER_SUMMARY_HOUR,
      minute: 0,
      second: 0
    });
  }
  return target;
}

function yesterdayLocalWindow(now = new Date()) {
  const today = zonedDateParts(now);
  const yesterday = addLocalDays(today, -1);
  const start = localTimeToUtcDate({ ...yesterday, hour: 0, minute: 0, second: 0 });
  const end = localTimeToUtcDate({ year: today.year, month: today.month, day: today.day, hour: 0, minute: 0, second: 0 });
  return { start, end, dayKey: localDayKey(yesterday) };
}

async function sendDailyUserSummaryPushNotification(now = new Date()) {
  try {
    if (mongoose.connection.readyState !== 1) {
      console.log('[push] daily user summary skipped: MongoDB not connected');
      return;
    }
    const { start, end, dayKey } = yesterdayLocalWindow(now);
    const userQuery = { role: { $ne: 'admin' }, isAnonymous: { $ne: true } };
    const [totalUsers, newUsersYesterday] = await Promise.all([
      User.countDocuments(userQuery),
      User.countDocuments({
        ...userQuery,
        createdAt: { $gte: start, $lt: end }
      })
    ]);
    const result = await sendPushToAdminDevices({
      title: 'Daily user summary',
      body: `Total users: ${totalUsers}. New yesterday: ${newUsersYesterday}.`,
      threadId: 'rs-daily-user-summary',
      collapseId: `rs-daily-user-summary-${dayKey}`,
      interruptionLevel: 'active',
      payload: {
        type: 'daily_user_summary',
        dayKey,
        totalUsers,
        newUsersYesterday,
        timeZone: DAILY_USER_SUMMARY_TIME_ZONE
      }
    });
    if (!result.ok) {
      console.log(`[push] daily user summary skipped: ${result.reason || 'unknown'}`);
      return;
    }
    console.log(`[push] daily user summary ${dayKey}: total=${totalUsers}, new=${newUsersYesterday}, sent=${result.sent}, failed=${result.failed}`);
  } catch (err) {
    console.error('sendDailyUserSummaryPushNotification failed:', err && err.message ? err.message : err);
  }
}

function scheduleDailyUserSummaryPush() {
  if (String(process.env.DISABLE_DAILY_USER_SUMMARY_PUSH || '').trim().toLowerCase() === 'true') {
    console.log('[push] daily user summary disabled by DISABLE_DAILY_USER_SUMMARY_PUSH=true');
    return;
  }
  if (dailyUserSummaryTimer) clearTimeout(dailyUserSummaryTimer);
  const nextAt = nextDailyUserSummaryAt();
  const delayMs = Math.max(1000, nextAt.getTime() - Date.now());
  console.log(`[push] daily user summary scheduled for ${nextAt.toISOString()} (${DAILY_USER_SUMMARY_TIME_ZONE})`);
  dailyUserSummaryTimer = setTimeout(async () => {
    await sendDailyUserSummaryPushNotification(new Date());
    scheduleDailyUserSummaryPush();
  }, delayMs);
  if (typeof dailyUserSummaryTimer.unref === 'function') dailyUserSummaryTimer.unref();
}

/** firstName / lastName / country / province / school for iOS Live Activity + admin payloads (guest → empty). */
function liveSessionLearnerPayloadExtras(user) {
  if (!user || typeof user !== 'object') {
    return {
      learnerFirstName: '',
      learnerLastName: '',
      learnerCountry: '',
      learnerProvince: '',
      learnerSchool: ''
    };
  }
  const schoolRaw = String(user.school || '').trim();
  const hospitalRaw = String(user.hospitalOrClinic || '').trim();
  const schoolLine = schoolRaw || hospitalRaw;
  const provinceRaw = String(user.provinceOrState || '').trim();
  return {
    learnerFirstName: String(user.firstName || '').trim().slice(0, 100),
    learnerLastName: String(user.lastName || '').trim().slice(0, 100),
    learnerCountry: String(user.country || '').trim().slice(0, 100),
    learnerProvince: provinceRaw ? provinceRaw.slice(0, 80) : '',
    learnerSchool: schoolLine ? schoolLine.slice(0, 120) : ''
  };
}

async function sendExamLifecyclePush({
  user,
  phase,
  mode,
  isSimulation,
  examName,
  scorePercent,
  total,
  answered,
  correct,
  incorrect,
  sessionId
}) {
  try {
    const sid = String(sessionId || '').trim();
    const collapseId = sid ? `rs-live-${sid}`.slice(0, 64) : 'rs-live';
    const threadId = sid ? `rs-live-${sid}` : 'rs-live';
    const displayName = user && user.name ? String(user.name) : user && user.email ? String(user.email) : 'Guest';
    const email = user && user.email ? String(user.email) : '';
    const emailBit = email ? ` (${email})` : '';
    const modeLabel = isSimulation ? 'Simulation' : (String(mode || 'quiz').toLowerCase() === 'test' ? 'Test' : 'Quiz');
    const title = phase === 'start' ? 'Live session' : 'Session finished';
    const subtitle = examName ? String(examName) : `${modeLabel} · Radstudy`;
    const body =
      phase === 'start'
        ? `${displayName}${emailBit} started ${modeLabel.toLowerCase()}${examName ? ` · ${examName}` : ''}`
        : `${displayName}${emailBit} finished ${modeLabel.toLowerCase()} · ${Math.max(0, Number(scorePercent) || 0)}%${
            examName ? ` · ${examName}` : ''
          }`;
    const result = await sendPushToAdminDevices({
      title,
      subtitle,
      body,
      threadId,
      collapseId,
      interruptionLevel: phase === 'start' ? 'time-sensitive' : 'active',
      payload: {
        type: 'live_session',
        phase,
        sessionId: sid,
        learnerName: displayName,
        ...liveSessionLearnerPayloadExtras(user),
        userId: user && user._id ? String(user._id) : '',
        role: user && user.role ? String(user.role) : '',
        mode: String(mode || ''),
        isSimulation: !!isSimulation,
        examName: String(examName || ''),
        scorePercent: Math.max(0, Number(scorePercent) || 0),
        total: Math.max(0, Number(total) || 0),
        answered: Math.max(0, Number(answered) || 0),
        correct: Math.max(0, Number(correct) || 0),
        incorrect: Math.max(0, Number(incorrect) || 0)
      }
    });
    if (!result.ok) {
      console.log(`[push] exam ${phase} push skipped: ${result.reason || 'unknown'}`);
      return;
    }
    console.log(`[push] exam ${phase} live push sent=${result.sent} failed=${result.failed}`);
  } catch (err) {
    console.error('sendExamLifecyclePush failed:', err && err.message ? err.message : err);
  }
}

/** Debounce live session progress pushes per session (ms since last progress ping). Keep small so milestone pings are not skipped (45s caused “stuck at 2/n” when 50% was throttled then never re-crossed). */
const liveSessionAdminPushThrottle = new Map();
const LIVE_PROGRESS_PUSH_MIN_GAP_MS = 2500;

async function sendPushToAdminDevices({
  title,
  body,
  payload = {},
  subtitle,
  threadId,
  collapseId,
  interruptionLevel
}) {
  const provider = initApnProvider();
  if (!provider) {
    console.log('[push] provider not ready');
    return { ok: false, reason: 'provider_not_ready', sent: 0, failed: 0 };
  }
  const admins = await User.find({ role: 'admin', isEnabled: { $ne: false } })
    .select('iosPushTokens')
    .lean();
  const tokens = Array.from(new Set(
    admins.flatMap((a) => Array.isArray(a.iosPushTokens) ? a.iosPushTokens : [])
  ))
    .map(normalizeApnsToken)
    .filter(Boolean);
  console.log(`[push] admins=${admins.length}, tokens=${tokens.length}, title="${String(title || '').slice(0, 60)}"`);
  if (!tokens.length) {
    console.log('[push] no admin tokens found');
    return { ok: false, reason: 'no_tokens', sent: 0, failed: 0 };
  }
  const note = new apn.Notification();
  note.topic = APNS_BUNDLE_ID;
  note.title = String(title || 'Radstudy');
  if (subtitle) note.subtitle = String(subtitle);
  note.body = String(body || '');
  note.sound = 'default';
  note.payload = { ...payload };
  if (payload && payload.type === 'live_session') {
    note.contentAvailable = true;
  }
  if (threadId) note.threadId = String(threadId).slice(0, 128);
  if (collapseId) note.collapseId = String(collapseId).slice(0, 64);
  const il = String(interruptionLevel || '').trim().toLowerCase();
  if (['passive', 'active', 'time-sensitive', 'critical'].includes(il)) {
    note.aps['interruption-level'] = il;
  }
  const result = await provider.send(note, tokens);
  const sent = Array.isArray(result.sent) ? result.sent.length : 0;
  const failed = Array.isArray(result.failed) ? result.failed.length : 0;
  console.log(`[push] APNs result sent=${sent} failed=${failed}`);
  if (failed) {
    const failedDevices = (result.failed || []).map((f) => String(f && f.device || '')).filter(Boolean);
    if (failedDevices.length) console.log(`[push] failed devices: ${failedDevices.join(', ')}`);
  }
  return { ok: true, sent, failed };
}

const UserSchema = new mongoose.Schema({
  role: { type: String, enum: USER_ROLES, default: 'user', required: true },
  email: { type: String, trim: true, lowercase: true, index: true, sparse: true },
  name: { type: String, trim: true, default: '' },
  firstName: { type: String, trim: true, default: '' },
  lastName: { type: String, trim: true, default: '' },
  school: { type: String, trim: true, default: '' },
  city: { type: String, trim: true, default: '' },
  country: { type: String, trim: true, default: '' },
  provinceOrState: { type: String, trim: true, default: '' },
  currentLocation: { type: String, enum: ['', 'in_canada', 'outside_canada'], default: '' },
  personalRegion: { type: String, enum: ['local', 'international'], default: 'local' },
  studentStatus: { type: String, enum: STUDENT_STATUS_VALUES, default: 'studying_not_registered' },
  expectedExamDate: { type: Date, default: null },
  /** Optional: which registration window a studying user is targeting (same keys as registrationWindowKey when registered). */
  expectedRegistrationWindowKey: { type: String, trim: true, default: '' },
  /** Optional: which exam sitting a studying user is targeting (same keys as examSittingKey when registered). */
  expectedExamSittingKey: { type: String, trim: true, default: '' },
  attemptsTaken: { type: Number, min: 0, default: 0 },
  registrationWindowKey: { type: String, trim: true, default: '' },
  examSittingKey: { type: String, trim: true, default: '' },
  hospitalOrClinic: { type: String, trim: true, default: '' },
  careerRegion: { type: String, enum: ['local', 'international'], default: 'local' },
  careerFocus: { type: String, enum: ['', 'hospital_canada', 'international_placement', 'exploring'], default: '' },
  adminPasswordHash: { type: String, default: '' },
  studentNumber: { type: String, trim: true, unique: true, sparse: true },
  isAnonymous: { type: Boolean, default: false },
  guestId: { type: String, trim: true, unique: true, sparse: true },
  lastActive: { type: Date, default: Date.now },
  isEnabled: { type: Boolean, default: true },
  iosPushTokens: { type: [String], default: [] },
  analytics: {
    loginCount: { type: Number, default: 0 },
    firstLoginAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    activeDayKeys: { type: [String], default: [] },
    quizStartedCount: { type: Number, default: 0 },
    quizCompletedCount: { type: Number, default: 0 },
    simulationStartedCount: { type: Number, default: 0 },
    simulationCompletedCount: { type: Number, default: 0 },
    questionsAnsweredCount: { type: Number, default: 0 },
    correctAnswersCount: { type: Number, default: 0 },
    incorrectAnswersCount: { type: Number, default: 0 },
    totalStudySeconds: { type: Number, default: 0 }
  }
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', UserSchema);

const QuestionSchema = new mongoose.Schema({
  questionText: { type: String, required: true, trim: true },
  options: {
    type: [String],
    validate: {
      validator: (v) => Array.isArray(v) && v.length >= 2,
      message: 'At least two options are required.'
    }
  },
  correctOption: { type: Number, required: true, min: 0 },
  explanation: { type: String, default: '' },
  category: { type: String, default: '' },
  competency: { type: String, default: '' },
  learningObjective: { type: String, default: '' },
  questionNumber: { type: Number, unique: true, sparse: true },
  optionSelectionCounts: { type: [Number], default: [] },
  totalSelections: { type: Number, default: 0 },
  imageUrl: { type: String, default: '' },
  isEnabled: { type: Boolean, default: true },
  isSimulation: { type: Boolean, default: false },
  isTrial: { type: Boolean, default: false },
  examName: { type: String, default: '' },
  difficulty: { type: String, default: '' },
  keywords: { type: String, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

const Question = mongoose.models.Question || mongoose.model('Question', QuestionSchema);

function computeOptionDistributionPercents(optionsLength, rawCounts) {
  const size = Math.max(0, Number(optionsLength) || 0);
  const counts = Array.from({ length: size }, (_, i) => {
    const v = Array.isArray(rawCounts) ? Number(rawCounts[i]) : 0;
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  });
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (!total) return Array.from({ length: size }, () => 0);
  return counts.map((n) => Math.round((n / total) * 100));
}

const UserSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  role: { type: String, default: 'user' },
  sessionId: { type: String, required: true },
  mode: { type: String, enum: ['practice', 'test', 'simulation', 'trial', 'unknown'], default: 'unknown' },
  isSimulation: { type: Boolean, default: false },
  examName: { type: String, default: '' },
  sourceRoute: { type: String, default: '' },
  startedAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  durationSeconds: { type: Number, default: 0 },
  totalQuestions: { type: Number, default: 0 },
  questionsAnswered: { type: Number, default: 0 },
  correctAnswers: { type: Number, default: 0 },
  incorrectAnswers: { type: Number, default: 0 },
  completed: { type: Boolean, default: false },
  scorePercent: { type: Number, default: 0 },
  flaggedQuestionsCount: { type: Number, default: 0 },
  highlightedQuestionsCount: { type: Number, default: 0 },
  questionIntervalsSeconds: { type: [Number], default: [] },
  lastQuestionAnsweredAt: { type: Date, default: null },
  endedPrematurely: { type: Boolean, default: false },
  endReason: { type: String, default: '' },
  userNameSnapshot: { type: String, default: '' },
  userEmailSnapshot: { type: String, default: '' }
}, { timestamps: true });
UserSessionSchema.index({ userId: 1, sessionId: 1 }, { unique: true });
const UserSession = mongoose.models.UserSession || mongoose.model('UserSession', UserSessionSchema);

const UserActivitySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: false, default: null },
  actorId: { type: String, default: '', index: true },
  isGuest: { type: Boolean, default: false, index: true },
  role: { type: String, default: 'user' },
  type: { type: String, index: true, required: true },
  sessionId: { type: String, default: '' },
  mode: { type: String, default: '' },
  isSimulation: { type: Boolean, default: false },
  examName: { type: String, default: '' },
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null },
  isCorrect: { type: Boolean, default: null },
  durationSeconds: { type: Number, default: 0 },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  at: { type: Date, default: Date.now, index: true }
}, { timestamps: true });
const UserActivity = mongoose.models.UserActivity || mongoose.model('UserActivity', UserActivitySchema);

const AppSessionSchema = new mongoose.Schema({
  appSessionId: { type: String, required: true, unique: true, index: true },
  actorId: { type: String, required: true, index: true },
  isGuest: { type: Boolean, required: true },
  startedAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });
const AppSession = mongoose.models.AppSession || mongoose.model('AppSession', AppSessionSchema);

const TestSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  actorId: { type: String, required: true, index: true },
  isGuest: { type: Boolean, required: true },
  type: { type: String, enum: ['practice', 'test', 'simulation', 'trial'], required: true },
  mode: { type: String, default: '' },
  isSimulation: { type: Boolean, default: false },
  examName: { type: String, default: '' },
  sourceRoute: { type: String, default: '' },
  startedAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  durationSeconds: { type: Number, default: 0 },
  totalQuestions: { type: Number, default: 0 },
  progress: { type: Number, default: 0 },
  questionsAnswered: { type: Number, default: 0 },
  correctAnswers: { type: Number, default: 0 },
  incorrectAnswers: { type: Number, default: 0 },
  completed: { type: Boolean, default: false },
  scorePercent: { type: Number, default: 0 },
  flaggedQuestionsCount: { type: Number, default: 0 },
  highlightedQuestionsCount: { type: Number, default: 0 },
  questionIntervalsSeconds: { type: [Number], default: [] },
  lastQuestionAnsweredAt: { type: Date, default: null },
  endedPrematurely: { type: Boolean, default: false },
  endReason: { type: String, default: '' },
  userNameSnapshot: { type: String, default: '' },
  userEmailSnapshot: { type: String, default: '' }
}, { timestamps: true });
TestSessionSchema.index({ actorId: 1, sessionId: 1 }, { unique: true });
const TestSession = mongoose.models.TestSession || mongoose.model('TestSession', TestSessionSchema);

const ActorDailyEventSchema = new mongoose.Schema({
  actorId: { type: String, required: true, index: true },
  dayKey: { type: String, required: true, index: true },
  event: { type: String, required: true, index: true },
  route: { type: String, default: '' },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  at: { type: Date, default: Date.now }
}, { timestamps: true });
ActorDailyEventSchema.index({ actorId: 1, dayKey: 1, event: 1 }, { unique: true });
const ActorDailyEvent = mongoose.models.ActorDailyEvent || mongoose.model('ActorDailyEvent', ActorDailyEventSchema);

const SIMULATION_LOCK_GLOBAL_KEY = '__all__';
const SimulationLockSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  examName: { type: String, default: '' },
  locked: { type: Boolean, default: false },
  note: { type: String, default: '' },
  lockedAt: { type: Date, default: null },
  lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });
const SimulationLock = mongoose.models.SimulationLock || mongoose.model('SimulationLock', SimulationLockSchema);

const SECOND_BRAIN_TOPIC_SLUGS = [
  'logical-reasoning',
  'thinking-in-systems',
  'data-analytics',
  'career',
  'current-situation'
];

const SecondBrainReflectionSchema = new mongoose.Schema(
  {
    topic: { type: String, required: true, enum: SECOND_BRAIN_TOPIC_SLUGS, index: true },
    kind: {
      type: String,
      required: true,
      enum: ['read', 'learned', 'lesson', 'insight', 'comment', 'application']
    },
    title: { type: String, default: '' },
    body: { type: String, required: true }
  },
  { timestamps: true }
);
SecondBrainReflectionSchema.index({ topic: 1, createdAt: -1 });
const SecondBrainReflection =
  mongoose.models.SecondBrainReflection ||
  mongoose.model('SecondBrainReflection', SecondBrainReflectionSchema);

const SECOND_BRAIN_ENTRY_DELETE_RE = new RegExp(
  '^/(' + SECOND_BRAIN_TOPIC_SLUGS.join('|') + ')/entry/([^/]+)/delete$'
);
const SECOND_BRAIN_ENTRY_EDIT_RE = new RegExp(
  '^/(' + SECOND_BRAIN_TOPIC_SLUGS.join('|') + ')/entry/([^/]+)/edit$'
);

function normalizeSimulationLockKey(raw) {
  return String(raw || '').trim().toLowerCase();
}

async function loadSimulationLockState() {
  try {
    const docs = await SimulationLock.find({}).lean();
    const state = {
      global: { locked: false, note: '', lockedAt: null },
      byExam: new Map()
    };
    docs.forEach((doc) => {
      const key = normalizeSimulationLockKey(doc.key);
      if (!key) return;
      if (key === SIMULATION_LOCK_GLOBAL_KEY) {
        state.global = {
          locked: !!doc.locked,
          note: String(doc.note || ''),
          lockedAt: doc.lockedAt || doc.updatedAt || null
        };
        return;
      }
      state.byExam.set(key, {
        locked: !!doc.locked,
        note: String(doc.note || ''),
        examName: String(doc.examName || doc.key || ''),
        lockedAt: doc.lockedAt || doc.updatedAt || null
      });
    });
    return state;
  } catch (err) {
    console.error('loadSimulationLockState failed:', err && err.message ? err.message : err);
    return { global: { locked: false, note: '', lockedAt: null }, byExam: new Map() };
  }
}

/** Returns `{ locked, scope, note }` if simulation is locked for the given exam (or globally). */
async function getSimulationLockForExam(examName) {
  const state = await loadSimulationLockState();
  if (state.global.locked) return { locked: true, scope: 'global', note: state.global.note || '' };
  const key = normalizeSimulationLockKey(examName);
  if (key && state.byExam.has(key)) {
    const entry = state.byExam.get(key);
    if (entry.locked) return { locked: true, scope: 'exam', note: entry.note || '', examName: entry.examName };
  }
  return { locked: false };
}

function currentDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function toObjectIdMaybe(v) {
  const id = String(v || '').trim();
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

function createGuestTrackingId() {
  return `guest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Real user: uid/admin cookie. Guest: guest_id only (no User document). Sets guest_id when missing. */
function assignActorForRequest(req, res) {
  const cookies = parseCookies(req);
  const adminObjectId = toObjectIdMaybe(cookies.admin_uid);
  if (adminObjectId) {
    return { actorId: String(adminObjectId), userId: adminObjectId, isGuest: false, role: 'admin' };
  }
  const userObjectId = toObjectIdMaybe(cookies.uid);
  if (userObjectId) {
    return { actorId: String(userObjectId), userId: userObjectId, isGuest: false, role: 'user' };
  }
  let guestId = String(cookies.guest_id || '').trim();
  if (!guestId) {
    guestId = createGuestTrackingId();
    if (res) setCookie(res, 'guest_id', guestId, 60 * 60 * 24 * 400);
  }
  return { actorId: guestId, userId: null, isGuest: true, role: 'guest' };
}

function peekActorFromCookies(req) {
  const cookies = parseCookies(req);
  const adminObjectId = toObjectIdMaybe(cookies.admin_uid);
  if (adminObjectId) {
    return { actorId: String(adminObjectId), userId: adminObjectId, isGuest: false, role: 'admin' };
  }
  const userObjectId = toObjectIdMaybe(cookies.uid);
  if (userObjectId) {
    return { actorId: String(userObjectId), userId: userObjectId, isGuest: false, role: 'user' };
  }
  const guestId = String(cookies.guest_id || '').trim();
  if (guestId) return { actorId: guestId, userId: null, isGuest: true, role: 'guest' };
  return null;
}

function getRequestActor(req) {
  if (req && req.actor) return req.actor;
  return peekActorFromCookies(req);
}

async function recordActorDailyUnique(actor, event, { route = '', meta = {} } = {}) {
  if (!actor || !actor.actorId || !event) return;
  const dayKey = currentDayKey();
  try {
    await ActorDailyEvent.create({
      actorId: actor.actorId,
      dayKey,
      event: String(event).trim(),
      route: String(route || '').trim(),
      meta: meta && typeof meta === 'object' ? meta : {},
      at: new Date()
    });
  } catch (err) {
    if (err && err.code === 11000) return;
    console.error('recordActorDailyUnique failed:', err && err.message ? err.message : err);
  }
}

function resolveTestSessionType({ isTrial, isSimulation, mode }) {
  if (isTrial) return 'trial';
  if (isSimulation) return 'simulation';
  const m = String(mode || '').toLowerCase();
  if (m === 'trial') return 'trial';
  if (m === 'test') return 'test';
  return 'practice';
}

function userSessionModeFromParts({ isTrial, isSimulation, mode }) {
  if (isTrial) return 'trial';
  if (isSimulation) return 'simulation';
  const m = String(mode || '').toLowerCase();
  if (m === 'test') return 'test';
  return 'practice';
}

async function appendUserActivity(req, payload) {
  try {
    const actor = getRequestActor(req);
    if (!actor || !actor.actorId || !payload || !payload.type) return;
    const doc = {
      actorId: actor.actorId,
      isGuest: !!actor.isGuest,
      role: actor.role || 'user',
      type: String(payload.type || '').trim(),
      sessionId: String(payload.sessionId || '').trim(),
      mode: String(payload.mode || '').trim(),
      isSimulation: !!payload.isSimulation,
      examName: String(payload.examName || '').trim(),
      questionId: payload.questionId && mongoose.Types.ObjectId.isValid(String(payload.questionId)) ? payload.questionId : null,
      isCorrect: typeof payload.isCorrect === 'boolean' ? payload.isCorrect : null,
      durationSeconds: Number(payload.durationSeconds || 0),
      meta: payload.meta || {},
      at: new Date()
    };
    if (actor.userId) doc.userId = actor.userId;
    await UserActivity.create(doc);
  } catch (err) {
    console.error('appendUserActivity failed:', err && err.message ? err.message : err);
  }
}

async function recordLoginAnalytics(user) {
  try {
    if (!user || !user._id) return;
    const dayKey = currentDayKey();
    const existing = user.analytics || {};
    const firstLoginAt = existing.firstLoginAt || new Date();
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          'analytics.firstLoginAt': firstLoginAt,
          'analytics.lastLoginAt': new Date()
        },
        $inc: { 'analytics.loginCount': 1 },
        $addToSet: { 'analytics.activeDayKeys': dayKey }
      }
    );
  } catch (err) {
    console.error('recordLoginAnalytics failed:', err && err.message ? err.message : err);
  }
}

async function ensureStudySession(req, { sessionId, mode, isSimulation, isTrial, examName, totalQuestions, sourceRoute }) {
  try {
    const actor = getRequestActor(req);
    const sid = String(sessionId || '').trim();
    if (!actor || !actor.actorId || !sid) return null;
    const trial = !!isTrial;
    const testType = resolveTestSessionType({ isTrial: trial, isSimulation, mode });
    const tot = Math.max(0, Number(totalQuestions || 0));
    const now = new Date();

    let ts = await TestSession.findOne({ actorId: actor.actorId, sessionId: sid });
    if (!ts && isSimulation) {
      try {
        const lock = await getSimulationLockForExam(String(examName || '').trim());
        if (lock.locked) {
          console.log('[ensureStudySession] simulation locked, blocking new session', {
            sessionId: sid,
            scope: lock.scope,
            examName: String(examName || '').trim()
          });
          return null;
        }
      } catch (lockErr) {
        console.error('[ensureStudySession] simulation lock check failed:', lockErr && lockErr.message ? lockErr.message : lockErr);
        return null;
      }
    }
    const createdTestSession = !ts;
    if (!ts) {
      ts = await TestSession.create({
        sessionId: sid,
        actorId: actor.actorId,
        isGuest: !!actor.isGuest,
        type: testType,
        mode: String(mode || ''),
        isSimulation: !!isSimulation,
        examName: String(examName || ''),
        sourceRoute: String(sourceRoute || ''),
        startedAt: now,
        lastSeenAt: now,
        totalQuestions: tot
      });
      if (testType === 'trial') {
        await recordActorDailyUnique(actor, 'trial_user', { route: '/trial', meta: { sessionId: sid } });
      }
    } else {
      ts.lastSeenAt = now;
      if (!ts.totalQuestions && tot > 0) ts.totalQuestions = tot;
      await ts.save();
    }

    if (actor.isGuest || !actor.userId) {
      if (createdTestSession) {
        await appendUserActivity(req, {
          type: isSimulation ? 'simulation_start' : 'quiz_start',
          sessionId: sid,
          mode,
          isSimulation,
          examName,
          meta: { totalQuestions: tot, testType, actorId: actor.actorId }
        });
        await sendExamLifecyclePush({
          user: null,
          phase: 'start',
          mode,
          isSimulation,
          examName,
          total: tot,
          sessionId: sid
        });
      }
      return ts;
    }

    const actorUser = await User.findById(actor.userId)
      .select('name email role firstName lastName country school provinceOrState hospitalOrClinic')
      .lean();
    const usMode = userSessionModeFromParts({ isTrial: trial, isSimulation, mode });
    let session = await UserSession.findOne({ userId: actor.userId, sessionId: sid });
    if (!session) {
      session = await UserSession.create({
        userId: actor.userId,
        role: actor.role || 'user',
        sessionId: sid,
        mode: usMode,
        isSimulation: !!isSimulation,
        examName: String(examName || ''),
        sourceRoute: String(sourceRoute || ''),
        startedAt: now,
        lastSeenAt: now,
        totalQuestions: tot,
        userNameSnapshot: String((actorUser && actorUser.name) || ''),
        userEmailSnapshot: String((actorUser && actorUser.email) || '')
      });
      const startedInc = isSimulation
        ? { 'analytics.simulationStartedCount': 1 }
        : { 'analytics.quizStartedCount': 1 };
      await User.updateOne(
        { _id: actor.userId },
        {
          $inc: startedInc,
          $addToSet: { 'analytics.activeDayKeys': currentDayKey() }
        }
      );
      await appendUserActivity(req, {
        type: isSimulation ? 'simulation_start' : 'quiz_start',
        sessionId: sid,
        mode,
        isSimulation,
        examName,
        meta: { totalQuestions: tot, testType }
      });
      await sendExamLifecyclePush({
        user: actorUser,
        phase: 'start',
        mode,
        isSimulation,
        examName,
        total: tot,
        sessionId: sid
      });
      return session;
    }
    session.lastSeenAt = now;
    if (!session.totalQuestions && tot > 0) {
      session.totalQuestions = tot;
    }
    if (!session.userNameSnapshot && actorUser && actorUser.name) session.userNameSnapshot = String(actorUser.name);
    if (!session.userEmailSnapshot && actorUser && actorUser.email) session.userEmailSnapshot = String(actorUser.email);
    await session.save();
    return session;
  } catch (err) {
    console.error('ensureStudySession failed:', err && err.message ? err.message : err);
    return null;
  }
}

async function recordStudyAttempt(req, { sessionId, questionId, isCorrect, mode, isSimulation, examName, flaggedCount, highlightedCount, questionDurationSeconds }) {
  try {
    const actor = getRequestActor(req);
    const sid = String(sessionId || '').trim();
    if (!actor || !actor.actorId || !sid) return;
    const now = new Date();
    const safeDuration = Math.max(1, Math.min(600, Number(questionDurationSeconds || 0) || 0));
    const safeFlagged = Math.max(0, Number(flaggedCount || 0) || 0);
    const safeHighlighted = Math.max(0, Number(highlightedCount || 0) || 0);

    const ts = await TestSession.findOne({ actorId: actor.actorId, sessionId: sid });
    if (!ts) return;
    const beforeAnswered = Math.max(0, Number(ts.questionsAnswered || 0));
    const beforeCorrect = Math.max(0, Number(ts.correctAnswers || 0));
    const beforeIncorrect = Math.max(0, Number(ts.incorrectAnswers || 0));
    const intervalsTs = Array.isArray(ts.questionIntervalsSeconds) ? ts.questionIntervalsSeconds.slice() : [];
    if (safeDuration > 0) intervalsTs.push(safeDuration);
    ts.lastSeenAt = now;
    ts.questionsAnswered = beforeAnswered + 1;
    ts.correctAnswers = beforeCorrect + (isCorrect ? 1 : 0);
    ts.incorrectAnswers = beforeIncorrect + (isCorrect ? 0 : 1);
    ts.flaggedQuestionsCount = Math.max(Number(ts.flaggedQuestionsCount || 0), safeFlagged);
    ts.highlightedQuestionsCount = Math.max(Number(ts.highlightedQuestionsCount || 0), safeHighlighted);
    ts.questionIntervalsSeconds = intervalsTs.slice(-20);
    ts.lastQuestionAnsweredAt = now;
    const tq = Math.max(0, Number(ts.totalQuestions || 0));
    ts.progress = tq > 0 ? Math.round((Math.min(ts.questionsAnswered, tq) / tq) * 100) : 0;
    await ts.save();
    const runningPercent = ts.questionsAnswered > 0
      ? Math.round((ts.correctAnswers / ts.questionsAnswered) * 100)
      : 0;
    console.log('[score-debug] recordStudyAttempt persisted', {
      at: new Date().toISOString(),
      actorId: actor.actorId,
      sessionId: sid,
      questionId: String(questionId || ''),
      isCorrect,
      mode,
      isSimulation: !!isSimulation,
      examName: examName || null,
      before: { answered: beforeAnswered, correct: beforeCorrect, incorrect: beforeIncorrect },
      after: { answered: ts.questionsAnswered, correct: ts.correctAnswers, incorrect: ts.incorrectAnswers },
      totalQuestions: tq,
      progressPercent: ts.progress,
      runningAccuracyPercent: runningPercent
    });

    if (!actor.isGuest && actor.userId) {
      const session = await UserSession.findOne({ userId: actor.userId, sessionId: sid });
      if (session) {
        const tsTq = Math.max(0, Number(ts.totalQuestions || 0));
        if (tsTq >= 1 && (!session.totalQuestions || Number(session.totalQuestions) < 1)) {
          session.totalQuestions = tsTq;
        }
        const intervals = Array.isArray(session.questionIntervalsSeconds) ? session.questionIntervalsSeconds.slice() : [];
        if (safeDuration > 0) intervals.push(safeDuration);
        session.lastSeenAt = now;
        session.questionsAnswered = Math.max(0, Number(session.questionsAnswered || 0)) + 1;
        session.correctAnswers = Math.max(0, Number(session.correctAnswers || 0)) + (isCorrect ? 1 : 0);
        session.incorrectAnswers = Math.max(0, Number(session.incorrectAnswers || 0)) + (isCorrect ? 0 : 1);
        session.flaggedQuestionsCount = Math.max(Number(session.flaggedQuestionsCount || 0), safeFlagged);
        session.highlightedQuestionsCount = Math.max(Number(session.highlightedQuestionsCount || 0), safeHighlighted);
        session.questionIntervalsSeconds = intervals.slice(-20);
        session.lastQuestionAnsweredAt = now;
        await session.save();
        try {
          const qa = Math.max(0, Number(session.questionsAnswered || 0));
          const tq = Math.max(0, Number(session.totalQuestions || 0));
          if (tq >= 1 && qa >= 2 && sid) {
            const prevAns = qa - 1;
            const curPct = Math.floor((qa / tq) * 100);
            const prevPct = tq > 0 ? Math.floor((prevAns / tq) * 100) : 0;
            const crossedMilestone = [25, 50, 70].some((m) => prevPct < m && curPct >= m);
            const decilePing = tq >= 15 && qa >= 10 && qa % 10 === 0;
            if (crossedMilestone || decilePing) {
              const throttleKey = `prog:${sid}`;
              const tMs = Date.now();
              const lastMs = liveSessionAdminPushThrottle.get(throttleKey) || 0;
              if (tMs - lastMs >= LIVE_PROGRESS_PUSH_MIN_GAP_MS) {
                liveSessionAdminPushThrottle.set(throttleKey, tMs);
                const u = await User.findById(actor.userId)
                  .select('name email firstName lastName country school provinceOrState hospitalOrClinic')
                  .lean();
                const disp = u && u.name ? String(u.name).trim() : u && u.email ? String(u.email) : 'User';
                const nameCountry = liveSessionLearnerPayloadExtras(u);
                const modeLabel = session.isSimulation
                  ? 'Simulation'
                  : (String(session.mode || '').toLowerCase().includes('test') ? 'Test' : 'Quiz');
                const ex = String(session.examName || '').trim();
                await sendPushToAdminDevices({
                  title: 'Live session',
                  subtitle: ex || modeLabel,
                  body: `${disp} · ${qa}/${tq} (${curPct}%)`,
                  threadId: `rs-live-${sid}`,
                  collapseId: `rs-live-${sid}`.slice(0, 64),
                  interruptionLevel: 'active',
                  payload: {
                    type: 'live_session',
                    phase: 'progress',
                    sessionId: sid,
                    learnerName: disp,
                    ...nameCountry,
                    userId: String(actor.userId),
                    questionsAnswered: qa,
                    totalQuestions: tq,
                    answered: qa,
                    total: tq,
                    progressPercent: curPct,
                    isSimulation: !!session.isSimulation,
                    examName: ex
                  }
                });
              }
            }
          }
        } catch (pushErr) {
          console.error('[push] live progress failed:', pushErr && pushErr.message ? pushErr.message : pushErr);
        }
        await User.updateOne(
          { _id: actor.userId },
          {
            $inc: {
              'analytics.questionsAnsweredCount': 1,
              'analytics.correctAnswersCount': isCorrect ? 1 : 0,
              'analytics.incorrectAnswersCount': isCorrect ? 0 : 1
            },
            $addToSet: { 'analytics.activeDayKeys': currentDayKey() }
          }
        );
      }
    }
    await appendUserActivity(req, {
      type: isSimulation ? 'simulation_attempt' : 'quiz_attempt',
      sessionId: sid,
      questionId,
      isCorrect,
      mode,
      isSimulation,
      examName,
      durationSeconds: safeDuration > 0 ? safeDuration : 0,
      meta: {
        flaggedCount: safeFlagged,
        highlightedCount: safeHighlighted
      }
    });
  } catch (err) {
    console.error('recordStudyAttempt failed:', err && err.message ? err.message : err);
  }
}

async function completeStudySession(req, { sessionId, mode, isSimulation, isTrial, examName, total, answered, correct, incorrect, endedPrematurely, endReason }) {
  try {
    const actor = getRequestActor(req);
    const sid = String(sessionId || '').trim();
    if (!actor || !actor.actorId || !sid) return;
    const end = new Date();

    const ts = await TestSession.findOne({ actorId: actor.actorId, sessionId: sid });
    const testSessionAlreadyCompleted = !!(ts && ts.completed);
    if (ts && !ts.completed) {
      const startTs = ts.startedAt ? new Date(ts.startedAt) : end;
      const durationSecondsTs = Math.max(0, Math.round((end.getTime() - startTs.getTime()) / 1000));
      const urlAnsweredTs = Math.max(0, Number(answered || 0));
      const urlCorrectTs = Math.max(0, Number(correct || 0));
      const urlIncorrectTs = Math.max(0, Number(incorrect || 0));
      const dbAnsweredTs = Math.max(0, Number(ts.questionsAnswered || 0));
      const dbCorrectTs = Math.max(0, Number(ts.correctAnswers || 0));
      const dbIncorrectTs = Math.max(0, Number(ts.incorrectAnswers || 0));
      const safeAnsweredTs = Math.max(urlAnsweredTs, dbAnsweredTs);
      const safeCorrectTs = Math.max(urlCorrectTs, dbCorrectTs);
      const safeIncorrectTs = Math.max(urlIncorrectTs, dbIncorrectTs);
      const safeTotalTs = Math.max(Number(total || 0), Number(ts.totalQuestions || 0));
      const scorePercentTs = safeAnsweredTs > 0 ? Math.round((safeCorrectTs / safeAnsweredTs) * 100) : 0;
      const prematureTs = !!endedPrematurely || (safeTotalTs > 0 && safeAnsweredTs < safeTotalTs);
      const stageQueryParams = {
        total: Number(total || 0),
        answered: Number(answered || 0),
        correct: Number(correct || 0),
        incorrect: Number(incorrect || 0)
      };
      const stageDbValues = {
        totalQuestions: Number(ts.totalQuestions || 0),
        questionsAnswered: Number(ts.questionsAnswered || 0),
        correctAnswers: Number(ts.correctAnswers || 0),
        incorrectAnswers: Number(ts.incorrectAnswers || 0)
      };
      console.log('[score-debug] completeStudySession reconcile', {
        at: new Date().toISOString(),
        actorId: actor.actorId,
        sessionId: sid,
        mode: String(mode || ''),
        isSimulation: !!isSimulation,
        isTrial: !!isTrial,
        examName: examName || null,
        endedByUser: !!endedPrematurely,
        endReason: String(endReason || ''),
        queryParams: stageQueryParams,
        dbBeforeReconcile: stageDbValues,
        reconciled: {
          safeTotal: safeTotalTs,
          safeAnswered: safeAnsweredTs,
          safeCorrect: safeCorrectTs,
          scorePercent: scorePercentTs,
          formula: 'round(safeCorrect / safeAnswered * 100)',
          premature: prematureTs
        }
      });
      ts.mode = String(mode || ts.mode || '');
      ts.isSimulation = !!isSimulation;
      if (examName) ts.examName = String(examName);
      ts.totalQuestions = safeTotalTs;
      ts.questionsAnswered = safeAnsweredTs;
      ts.correctAnswers = safeCorrectTs;
      ts.incorrectAnswers = safeIncorrectTs;
      ts.completed = true;
      ts.endedPrematurely = prematureTs;
      ts.endReason = String(endReason || (prematureTs ? 'user_ended_early' : 'completed_all_questions'));
      ts.lastSeenAt = end;
      ts.endedAt = end;
      ts.durationSeconds = durationSecondsTs;
      ts.scorePercent = scorePercentTs;
      ts.progress = safeTotalTs > 0 ? Math.round((Math.min(safeAnsweredTs, safeTotalTs) / safeTotalTs) * 100) : 0;
      if (isTrial || ts.type === 'trial') ts.type = 'trial';
      await ts.save();
    }

    if (actor.isGuest || !actor.userId) {
      if (ts && !testSessionAlreadyCompleted) {
        const safeTotal = Math.max(Number(total || 0), Number(ts.totalQuestions || 0));
        const safeAnswered = Math.max(0, Number(answered || ts.questionsAnswered || 0));
        const safeCorrect = Math.max(0, Number(correct || ts.correctAnswers || 0));
        const scorePercent = safeAnswered > 0 ? Math.round((safeCorrect / safeAnswered) * 100) : 0;
        const premature = !!endedPrematurely || (safeTotal > 0 && safeAnswered < safeTotal);
        await appendUserActivity(req, {
          type: premature
            ? (isSimulation ? 'simulation_end_premature' : 'quiz_end_premature')
            : (isSimulation ? 'simulation_complete' : 'quiz_complete'),
          sessionId: sid,
          mode,
          isSimulation,
          examName,
          durationSeconds: ts.durationSeconds || 0,
          meta: {
            total: safeTotal,
            answered: safeAnswered,
            correct: safeCorrect,
            incorrect: Math.max(0, Number(incorrect || 0)),
            scorePercent,
            endedPrematurely: premature,
            endReason: String(endReason || (premature ? 'user_ended_early' : 'completed_all_questions'))
          }
        });
        await sendExamLifecyclePush({
          user: null,
          phase: 'complete',
          mode,
          isSimulation,
          examName,
          scorePercent,
          total,
          answered,
          correct,
          incorrect,
          sessionId: sid
        });
      }
      return;
    }

    const session = await UserSession.findOne({ userId: actor.userId, sessionId: sid });
    if (!session) return;
    if (session.completed) return;
    const start = session.startedAt ? new Date(session.startedAt) : end;
    const durationSeconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
    const safeAnswered = Math.max(0, Number(answered || session.questionsAnswered || 0));
    const safeCorrect = Math.max(0, Number(correct || session.correctAnswers || 0));
    const safeTotal = Math.max(Number(total || 0), Number(session.totalQuestions || 0));
    const scorePercent = safeAnswered > 0 ? Math.round((safeCorrect / safeAnswered) * 100) : 0;
    const premature = !!endedPrematurely || (safeTotal > 0 && safeAnswered < safeTotal);
    const usMode = userSessionModeFromParts({ isTrial: !!isTrial, isSimulation, mode });
    session.mode = String(usMode || session.mode || 'unknown');
    session.isSimulation = !!isSimulation;
    if (examName) session.examName = String(examName);
    session.totalQuestions = safeTotal;
    session.questionsAnswered = Math.max(Number(session.questionsAnswered || 0), safeAnswered);
    session.correctAnswers = Math.max(Number(session.correctAnswers || 0), safeCorrect);
    session.incorrectAnswers = Math.max(Number(session.incorrectAnswers || 0), Math.max(0, Number(incorrect || 0)));
    session.completed = true;
    session.endedPrematurely = premature;
    session.endReason = String(endReason || (premature ? 'user_ended_early' : 'completed_all_questions'));
    session.lastSeenAt = end;
    session.endedAt = end;
    session.durationSeconds = durationSeconds;
    session.scorePercent = scorePercent;
    await session.save();
    const completionInc = isSimulation
      ? { 'analytics.simulationCompletedCount': 1 }
      : { 'analytics.quizCompletedCount': 1 };
    await User.updateOne(
      { _id: actor.userId },
      {
        $inc: {
          ...completionInc,
          'analytics.totalStudySeconds': durationSeconds
        },
        $addToSet: { 'analytics.activeDayKeys': currentDayKey() }
      }
    );
    await appendUserActivity(req, {
      type: premature
        ? (isSimulation ? 'simulation_end_premature' : 'quiz_end_premature')
        : (isSimulation ? 'simulation_complete' : 'quiz_complete'),
      sessionId: sid,
      mode,
      isSimulation,
      examName,
      durationSeconds,
      meta: {
        total: safeTotal,
        answered: safeAnswered,
        correct: safeCorrect,
        incorrect: Math.max(0, Number(incorrect || 0)),
        scorePercent,
        endedPrematurely: premature,
        endReason: String(endReason || (premature ? 'user_ended_early' : 'completed_all_questions'))
      }
    });
    const actorUser = await User.findById(actor.userId)
      .select('name email role firstName lastName country school provinceOrState hospitalOrClinic')
      .lean();
    await sendExamLifecyclePush({
      user: actorUser,
      phase: 'complete',
      mode,
      isSimulation,
      examName,
      scorePercent,
      total,
      answered,
      correct,
      incorrect,
      sessionId: sid
    });
  } catch (err) {
    console.error('completeStudySession failed:', err && err.message ? err.message : err);
  }
}

async function allocateQuestionNumbers(count) {
  const n = Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0;
  if (!n) return [];
  const latest = await Question.findOne({ questionNumber: { $exists: true, $ne: null } })
    .sort({ questionNumber: -1 })
    .select('questionNumber')
    .lean();
  const nextFromLatest = latest && Number.isFinite(Number(latest.questionNumber)) ? Number(latest.questionNumber) + 1 : 100000;
  const start = Math.max(100000, nextFromLatest);
  return Array.from({ length: n }, (_, i) => start + i);
}

async function backfillMissingQuestionNumbers() {
  const missing = await Question.find({
    $or: [
      { questionNumber: { $exists: false } },
      { questionNumber: null }
    ]
  }).sort({ createdAt: 1, _id: 1 }).select('_id').lean();
  if (!missing.length) return 0;
  const nextNumbers = await allocateQuestionNumbers(missing.length);
  for (let i = 0; i < missing.length; i += 1) {
    await Question.updateOne({ _id: missing[i]._id }, { $set: { questionNumber: nextNumbers[i] } });
  }
  return missing.length;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** For HTML double-quoted attributes (e.g. src, data-*); avoids breaking URLs vs escHtml's &gt; etc. */
function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

/** Same strip layout and styles as /exam-calm for marketing and guide pages. */
const STRIP_GUIDE_PAGE_STYLES = `<style>
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  html, body { max-width: 100%; overflow-x: hidden; overflow-x: clip; }
  img, video, iframe { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre, code { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  body.exam-calm-page {
    margin: 0;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #1e293b;
    background: #f5f6f8;
  }
  main.exam-calm-main {
    flex: 1 1 auto;
    width: 100%;
    max-width: 100vw;
    overflow-x: hidden;
    padding-bottom: max(24px, env(safe-area-inset-bottom, 0px));
  }
  .exam-calm-top {
    background: #f5f6f8;
    border-bottom: 1px solid #e7ebf0;
    padding: 14px clamp(16px, 4vw, 28px);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .exam-calm-top-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
  }
  .exam-calm-top-brand a {
    color: #0f2f63;
    font-weight: 800;
    font-size: 14px;
    text-decoration: none;
  }
  .exam-calm-top-brand a:hover { color: #5e354c; text-decoration: underline; }
  .exam-calm-top-sep { color: #94a3b8; margin: 0 6px; font-weight: 600; }
  .exam-calm-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    align-items: center;
    font-size: 13px;
  }
  .exam-calm-nav--routes { font-size: 12px; }
  .exam-calm-nav-link {
    color: #0f2f63;
    font-weight: 700;
    text-decoration: none;
    white-space: nowrap;
  }
  .exam-calm-nav-link:hover { color: #5e354c; text-decoration: underline; }
  .exam-calm-nav-link.is-active { color: #5e354c; text-decoration: underline; }
  .exam-calm-strip { padding: clamp(32px, 5.5vw, 56px) clamp(16px, 4vw, 40px); }
  .exam-calm-strip--bar { background: #f5f6f8; color: #15263d; }
  .exam-calm-strip--paper { background: #ffffff; color: #334155; }
  .exam-calm-strip--plum {
    background-color: #4a2c40;
    background-image:
      linear-gradient(90deg, rgba(72, 46, 62, 0.65) 0%, transparent 22%, transparent 78%, rgba(72, 46, 62, 0.65) 100%),
      radial-gradient(ellipse 90% 70% at 50% 45%, #5a3a52 0%, #4a2c40 48%, #352030 100%);
    color: rgba(255, 255, 255, 0.94);
    border-top: 1px solid rgba(243, 189, 103, 0.22);
  }
  .exam-calm-inner {
    width: 100%;
    max-width: min(820px, 94vw);
    margin: 0 auto;
    padding-inline: clamp(0px, 1.5vw, 12px);
  }
  .exam-calm-strip h1 {
    margin: 0 0 12px;
    font-size: clamp(1.65rem, 4vw, 2.15rem);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.15;
  }
  .exam-calm-strip--bar h1 { color: #15263d; }
  .exam-calm-strip--paper h2,
  .exam-calm-strip--bar h2 {
    margin: 0 0 12px;
    font-size: 1.15rem;
    font-weight: 700;
    color: #0f2f63;
  }
  .exam-calm-strip--paper h2 { color: #0f2f63; }
  .exam-calm-lead {
    margin: 0;
    font-size: clamp(1.05rem, 2.2vw, 1.22rem);
    line-height: 1.58;
    color: #475569;
    max-width: 68ch;
  }
  .exam-calm-strip--bar .exam-calm-lead { color: #4b5563; }
  .exam-calm-strip p {
    margin: 0 0 16px;
    font-size: clamp(0.9375rem, 1.5vw, 1.0625rem);
    line-height: 1.68;
    max-width: 72ch;
  }
  .exam-calm-strip p:last-child { margin-bottom: 0; }
  .exam-calm-strip--plum p { color: rgba(255, 255, 255, 0.88); }
  .exam-calm-strip--plum h2 { color: #f3bd67; }
  .exam-calm-strip h3 {
    margin: 22px 0 10px;
    font-size: clamp(1rem, 1.4vw, 1.08rem);
    font-weight: 700;
    color: #0f2f63;
  }
  .exam-calm-strip--plum h3 { color: #f0c47a; }
  .exam-calm-strip ul {
    margin: 0 0 18px;
    padding-left: 1.25rem;
    font-size: clamp(0.9375rem, 1.5vw, 1.0625rem);
    line-height: 1.65;
    max-width: 72ch;
  }
  .exam-calm-strip li { margin-bottom: 10px; }
  .exam-calm-strip--plum ul { color: rgba(255, 255, 255, 0.88); }
  .exam-calm-note {
    margin-top: 18px;
    padding-top: 16px;
    border-top: 1px solid rgba(15, 47, 99, 0.12);
    font-size: 0.8125rem;
    color: #64748b;
    line-height: 1.5;
  }
  .exam-calm-strip--plum .exam-calm-note { border-top-color: rgba(255, 255, 255, 0.18); color: rgba(255, 255, 255, 0.72); }
  .exam-calm-strip--plum a { color: #f3bd67; font-weight: 700; text-decoration: none; }
  .exam-calm-strip--plum a:hover { text-decoration: underline; color: #ffd992; }
  .exam-calm-strip--paper a,
  .exam-calm-strip--bar a { color: #5e354c; font-weight: 700; text-decoration: none; }
  .exam-calm-strip--paper a:hover,
  .exam-calm-strip--bar a:hover { text-decoration: underline; }
  /* iPhone / touch: safe areas, no horizontal scroll, readable inputs */
  html {
    -webkit-text-size-adjust: 100%;
  }
  body.exam-calm-page {
    overflow-x: hidden;
    max-width: 100vw;
    padding-left: env(safe-area-inset-left, 0px);
    padding-right: env(safe-area-inset-right, 0px);
    padding-bottom: max(0px, env(safe-area-inset-bottom, 0px));
  }
  .exam-calm-top {
    padding-left: max(14px, env(safe-area-inset-left, 0px));
    padding-right: max(14px, env(safe-area-inset-right, 0px));
    padding-top: max(10px, env(safe-area-inset-top, 0px));
  }
  @media (max-width: 480px) {
    .exam-calm-nav-link {
      white-space: normal;
      line-height: 1.35;
    }
  }
  @media (pointer: coarse) {
    .exam-calm-nav-link,
    .exam-calm-top-brand a {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
    }
  }
  @media (max-width: 520px) {
    body.exam-calm-page:not(.admin-route) input[type='text'],
    body.exam-calm-page:not(.admin-route) input[type='email'],
    body.exam-calm-page:not(.admin-route) input[type='password'],
    body.exam-calm-page:not(.admin-route) input[type='search'],
    body.exam-calm-page:not(.admin-route) input[type='tel'],
    body.exam-calm-page:not(.admin-route) input[type='number'],
    body.exam-calm-page:not(.admin-route) select,
    body.exam-calm-page:not(.admin-route) textarea {
      font-size: 16px;
    }
  }
</style>`;

function stripGuideSiteHeader(activePath) {
  const cur = String(activePath || '');
  const link = (href, label) => {
    const act = cur === href ? ' is-active' : '';
    return `<a class="exam-calm-nav-link${act}" href="${escAttr(href)}">${escHtml(label)}</a>`;
  };
  const primary = [
    ['/about-us', 'About Us'],
    ['/contact-us', 'Contact Us'],
    ['/test-engine-guide', 'Test Engine'],
    ['/login', 'Sign in']
  ]
    .map(([h, l]) => link(h, l))
    .join('');
  const routes = [
    ['/overview', 'Overview'],
    ['/custom-practice', 'Custom practice'],
    ['/question-bank', 'Question bank'],
    ['/mock-exams', 'Mock exams'],
    ['/profile', 'Profile'],
    ['/performance/sessions', 'All sessions'],
    ['/performance/practice', 'Practice performance'],
    ['/performance/test', 'Test performance'],
    ['/performance/test-session', 'Test session'],
    ['/performance/trial', 'Trial performance'],
    ['/performance/simulation', 'Simulation performance'],
    ['/performance', 'Performance'],
    ['/learning-plan', 'Learning plan'],
    ['/sample-quiz', 'Sample quiz'],
    ['/exam-calm', 'Calm before the exam']
  ]
    .map(([h, l]) => link(h, l))
    .join('');
  return `<header class="exam-calm-top" role="banner">
  <div class="exam-calm-top-row">
    <div class="exam-calm-top-brand"><a href="/">Radstudy</a><span class="exam-calm-top-sep" aria-hidden="true">·</span><a href="/">Home</a></div>
    <nav class="exam-calm-nav exam-calm-nav--primary" aria-label="Primary">${primary}</nav>
  </div>
  <nav class="exam-calm-nav exam-calm-nav--routes" aria-label="What Radstudy offers">${routes}</nav>
</header>`;
}

function renderStripGuidePage({ title, metaDescription, activePath, mainInnerHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="description" content="${escAttr(metaDescription || '')}" />
  <title>${escHtml(title)}</title>
  ${STRIP_GUIDE_PAGE_STYLES}
</head>
<body class="exam-calm-page">
${stripGuideSiteHeader(activePath || '')}
<main class="exam-calm-main">
${mainInnerHtml}
</main>
</body>
</html>`;
}

function sendLearningGridGuidePage(res, { title, metaDescription, mainInnerHtml }) {
  res.type('html').send(
    renderStripGuidePage({
      title,
      metaDescription,
      activePath: '/learning-plan',
      mainInnerHtml
    })
  );
}

/** Admin HTML: Inter + unified slate/royal-blue chrome (aligned with analytics workspace). */
const ADMIN_APP_CHROME_STYLES = `<style id="admin-app-chrome">
  body.exam-calm-page.admin-route {
    color: #4b5563;
    font-size: 0.875rem;
    line-height: 1.65;
    -webkit-text-size-adjust: 100%;
    background: #f9fafb;
    font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  /* Unify legacy plum/gold inline link colors on admin pages (overrides style="color:#f3bd67") */
  body.exam-calm-page.admin-route header.top a[style*='f3bd67'],
  body.exam-calm-page.admin-route a[style*='f3bd67'] {
    color: #93c5fd !important;
  }
  body.exam-calm-page.admin-route > header.top { flex: 0 0 auto; }
  body.exam-calm-page.admin-route > main.layout,
  body.exam-calm-page.admin-route > main.shell,
  body.exam-calm-page.admin-route > main.wrap,
  body.exam-calm-page.admin-route > .wrap {
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
    max-width: 100vw;
    overflow-x: auto;
    padding-bottom: max(16px, env(safe-area-inset-bottom, 0px));
    box-sizing: border-box;
  }
  body.exam-calm-page.admin-route.admin-auth {
    justify-content: center;
    align-items: center;
    padding: 20px 16px;
  }
  body.exam-calm-page.admin-route.admin-auth .card,
  body.exam-calm-page.admin-route.admin-auth form.card {
    width: min(440px, 92vw);
    background: #fff;
    border: 1px solid #e7ebf0;
    border-radius: 12px;
    padding: 20px;
    box-sizing: border-box;
  }
  body.exam-calm-page.admin-route.admin-auth h1 {
    margin: 0 0 12px;
    color: #15263d;
    font-size: 1.35rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  body.exam-calm-page.admin-route.admin-auth label {
    display: block;
    font-size: 12px;
    font-weight: 700;
    margin: 10px 0 6px;
    color: #6b7280;
  }
  body.exam-calm-page.admin-route.admin-auth input {
    width: 100%;
    padding: 11px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    box-sizing: border-box;
  }
  body.exam-calm-page.admin-route.admin-auth button {
    margin-top: 14px;
    width: 100%;
    padding: 12px 14px;
    border: 1px solid #1e40af;
    border-radius: 999px;
    background: linear-gradient(100deg, #2563eb 0%, #1d4ed8 100%);
    color: #ffffff;
    font-weight: 800;
    letter-spacing: 0.02em;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(37, 99, 235, 0.35);
  }
  body.exam-calm-page.admin-route.admin-auth button:hover {
    background: linear-gradient(100deg, #1d4ed8 0%, #1e40af 100%);
  }
  body.exam-calm-page.admin-route.admin-auth .links {
    margin-top: 10px;
    font-size: 13px;
  }
  body.exam-calm-page.admin-route.admin-auth .links a {
    color: #1d4ed8;
    font-weight: 600;
    text-decoration: none;
  }
  body.exam-calm-page.admin-route.admin-auth .links a:hover {
    color: #1e40af;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .top {
    background-color: #111827;
    background-image: linear-gradient(180deg, #1e293b 0%, #111827 100%);
    color: rgba(255, 255, 255, 0.92);
    border-bottom: 1px solid rgba(59, 130, 246, 0.22);
    padding: 14px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .top strong {
    font-weight: 800;
    letter-spacing: 0.01em;
  }
  .top a {
    color: #93c5fd;
    text-decoration: none;
    font-weight: 700;
  }
  .top a:hover {
    color: #bfdbfe;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
    gap: 12px;
    padding: 12px;
  }
  .layout.layout-constrained {
    max-width: 1400px;
    margin-left: auto;
    margin-right: auto;
  }
  .side {
    background: #fff;
    border: 1px solid #e7ebf0;
    border-radius: 10px;
    padding: 10px;
    align-self: start;
    position: sticky;
    top: 10px;
  }
  .side h3 {
    margin: 4px 6px 8px;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
    font-weight: 700;
  }
  .side a {
    display: block;
    text-decoration: none;
    color: #1d4ed8;
    padding: 9px 10px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
  }
  .side a:hover {
    background: #eff6ff;
    color: #1e40af;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .side a.active {
    background: #1e3a5f;
    color: rgba(255, 255, 255, 0.95);
    border: 1px solid rgba(59, 130, 246, 0.35);
    text-decoration: none;
  }
  .side details {
    margin: 2px 0;
  }
  .side summary {
    list-style: none;
    cursor: pointer;
    color: #1d4ed8;
    padding: 9px 10px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
  }
  .side summary::-webkit-details-marker {
    display: none;
  }
  .side summary:hover {
    background: #eff6ff;
    color: #1e40af;
  }
  .side details[open] > summary {
    background: #e0e7ff;
  }
  .side-subnav {
    margin: 2px 0 8px 14px;
    padding-left: 8px;
    border-left: 2px solid #e5e7eb;
  }
  .side-subnav a {
    font-size: 12px;
    font-weight: 600;
    padding: 7px 8px;
  }
  .main {
    min-width: 0;
  }
  .main .title {
    margin: 0 0 12px;
    color: #15263d;
    font-size: clamp(1.25rem, 2.5vw, 1.35rem);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .wrap {
    padding: 14px;
    max-width: 960px;
    margin: 0 auto;
  }
  .shell {
    padding: 14px;
    min-height: 0;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }
  .card {
    background: #fff;
    border: 1px solid #e7ebf0;
    border-radius: 10px;
    padding: 12px;
  }
  .card + .card {
    margin-top: 12px;
  }
  .card span {
    display: block;
    font-size: 0.8125rem;
    color: #6b7280;
    line-height: 1.45;
  }
  .card strong {
    display: block;
    margin-top: 4px;
    font-size: 24px;
    color: #15263d;
    font-weight: 800;
    letter-spacing: -0.02em;
  }
  .section {
    background: #fff;
    border: 1px solid #e7ebf0;
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 12px;
    margin-top: 12px;
    min-width: 0;
  }
  .section h2 {
    margin: 0 0 10px;
    color: #15263d;
    font-size: 1.125rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .split {
    display: grid;
    grid-template-columns: 1.4fr 0.8fr;
    gap: 12px;
  }
  .kpis {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .muted {
    font-size: 0.8125rem;
    color: #6b7280;
    line-height: 1.45;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .actions a,
  .actions button {
    display: inline-flex;
    text-decoration: none;
    border: 1px solid #1e40af;
    background: #1d4ed8;
    color: rgba(255, 255, 255, 0.95);
    border-radius: 7px;
    padding: 8px 12px;
    font-weight: 700;
    font-size: 13px;
    cursor: pointer;
  }
  .actions a:hover,
  .actions button:hover {
    filter: brightness(1.06);
  }
  .actions a.active {
    background: #1e40af;
    border-color: #1e3a8a;
    color: #fff;
  }
  .actions a.secondary,
  .actions button.secondary {
    background: #fff;
    color: #1d4ed8;
    border-color: #e5e7eb;
  }
  .actions a.secondary:hover,
  .actions button.secondary:hover {
    color: #1e40af;
    border-color: #bfdbfe;
    filter: none;
  }
  .actions form {
    margin: 0;
  }
  .actions .danger,
  button.danger {
    background: #8d2f3d;
    border-color: #7a2834;
  }
  button.warn {
    background: #a0671e;
    border-color: #8b5817;
  }
  .table-wrap {
    width: 100%;
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    background: #fff;
    border: 1px solid #e7ebf0;
    border-radius: 10px;
    overflow: hidden;
  }
  th,
  td {
    font-size: 0.875rem;
    text-align: left;
    padding: 10px;
    border-bottom: 1px solid #e5e7eb;
    vertical-align: top;
  }
  th {
    background: #f9fafb;
    color: #475569;
    font-weight: 700;
  }
  td form {
    margin: 0;
  }
  form {
    margin: 0;
  }
  button {
    border: 1px solid #1e40af;
    background: #1d4ed8;
    color: #ffffff;
    border-radius: 7px;
    padding: 8px 12px;
    font-weight: 700;
    cursor: pointer;
  }
  .top button {
    border: 1px solid rgba(255, 255, 255, 0.45);
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
  }
  .hg-hint {
    font-size: 13px;
    color: #6b7280;
    line-height: 1.45;
    margin: 0 0 10px;
  }
  .hg-ok {
    font-size: 13px;
    color: #2d6a3f;
    font-weight: 700;
    margin: 0 0 12px;
  }
  .hg-preview {
    margin: 8px 0 12px;
    border: 1px solid #e7ebf0;
    border-radius: 8px;
    overflow: hidden;
    background: #f9fafb;
    max-width: 440px;
  }
  .hg-preview img {
    display: block;
    width: 100%;
    max-height: 160px;
    object-fit: cover;
  }
  .hg-preview p {
    margin: 0;
    padding: 6px 10px;
    font-size: 12px;
    color: #6b7280;
  }
  .hg-form label {
    display: block;
    font-size: 12px;
    font-weight: 700;
    margin: 10px 0 6px;
    color: #475569;
  }
  .hg-form input[type='file'] {
    width: 100%;
    max-width: 480px;
    padding: 8px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: #fff;
    box-sizing: border-box;
  }
  .hg-form button {
    margin-top: 12px;
    border: 1px solid #1e40af;
    background: #1d4ed8;
    color: rgba(255, 255, 255, 0.95);
    border-radius: 8px;
    padding: 9px 14px;
    font-weight: 700;
    cursor: pointer;
  }
  .hg-form button:hover {
    filter: brightness(1.06);
  }
  .hg-sep {
    margin: 20px 0;
    border: none;
    border-top: 1px solid #e7ebf0;
  }
  .hg-delete-btn {
    background: #c2473a;
    color: #fff;
    border: 1px solid #a63629;
    border-radius: 8px;
    padding: 7px 12px;
    font-weight: 700;
    cursor: pointer;
    font-size: 13px;
  }
  .hg-delete-btn:hover {
    filter: brightness(1.06);
  }
  .filter {
    display: grid;
    grid-template-columns: 1fr 180px auto;
    gap: 8px;
    align-items: end;
    margin-bottom: 10px;
  }
  .filter input,
  .filter select {
    width: 100%;
    padding: 10px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: #fff;
    box-sizing: border-box;
  }
  .filter button {
    border: 1px solid #1e40af;
    background: #1d4ed8;
    color: rgba(255, 255, 255, 0.95);
    border-radius: 8px;
    padding: 10px 12px;
    font-weight: 700;
    cursor: pointer;
  }
  .filter button:hover {
    filter: brightness(1.06);
  }
  .sub-group {
    margin-top: 10px;
  }
  .sub-group-title {
    font-size: 11px;
    font-weight: 700;
    color: #6b7280;
    padding: 0 8px 4px;
  }
  .meta {
    margin: 0 0 10px;
    color: #6b7280;
    font-size: 13px;
    line-height: 1.45;
  }
  .row-actions {
    display: grid;
    grid-template-columns: 1fr;
    gap: 4px;
    align-items: stretch;
  }
  .row-link-btn,
  .btn-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    border: 1px solid #1e40af;
    background: #1d4ed8;
    color: rgba(255, 255, 255, 0.95);
    border-radius: 6px;
    padding: 4px 6px;
    font-weight: 700;
    font-size: 10px;
    line-height: 1.1;
    min-height: 20px;
  }
  .row-link-btn {
    padding: 6px 8px;
    font-size: 11px;
  }
  .row-link-btn:hover {
    filter: brightness(1.08);
  }
  td button {
    width: 100%;
    border: 1px solid #1e40af;
    background: #1d4ed8;
    color: rgba(255, 255, 255, 0.95);
    border-radius: 6px;
    padding: 4px 6px;
    font-weight: 700;
    font-size: 10px;
    line-height: 1.1;
    min-height: 20px;
    cursor: pointer;
  }
  td button:hover {
    filter: brightness(1.08);
  }
  th:last-child,
  td:last-child {
    width: 112px;
    min-width: 112px;
  }
  .toggle-switch {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 5px;
    padding: 3px 5px;
    min-height: 20px;
    border-radius: 999px;
    transition: background 0.15s, border-color 0.15s;
  }
  .toggle-track {
    width: 22px;
    height: 12px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.28);
    display: inline-flex;
    align-items: center;
    padding: 1px;
  }
  .toggle-switch .toggle-knob {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #fff;
    display: inline-block;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
    transform: translateX(0);
    transition: transform 0.16s ease;
  }
  .toggle-switch .toggle-label {
    font-size: 10px;
    font-weight: 700;
  }
  .toggle-switch.on {
    background: #1f7a42;
    border-color: #196437;
  }
  .toggle-switch.off {
    background: #64748b;
    border-color: #475569;
  }
  .toggle-switch.on .toggle-knob {
    transform: translateX(10px);
  }
  .domain-card {
    background: #fff;
    border: 1px solid #e7ebf0;
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 12px;
  }
  .domain-card h2 {
    margin: 0 0 8px;
    color: #15263d;
    font-size: 18px;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: baseline;
  }
  .domain-card h2 small {
    font-size: 12px;
    color: #6b7280;
    font-weight: 600;
  }
  .parent-list details {
    border: 1px solid #e7ebf0;
    border-radius: 8px;
    padding: 8px 10px;
    margin-top: 8px;
    background: #f9fafb;
  }
  .parent-list summary {
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-weight: 700;
    color: #1d4ed8;
  }
  .parent-list ul {
    list-style: none;
    padding: 6px 0 0;
    margin: 0;
  }
  .parent-list li {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px dashed #e5e7eb;
    font-size: 13px;
  }
  .parent-list li:last-child {
    border-bottom: none;
  }
  .parent-list strong {
    color: #15263d;
  }
  .route-board {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin: 0 0 12px;
  }
  .route-board a {
    display: inline-flex;
    text-decoration: none;
    border: 1px solid #e5e7eb;
    background: #fff;
    color: #1d4ed8;
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 12px;
    font-weight: 600;
  }
  .route-board a:hover {
    color: #1e40af;
    border-color: #bfdbfe;
  }
  .route-board a.active {
    border-color: rgba(59, 130, 246, 0.45);
    background: #1e3a5f;
    color: rgba(255, 255, 255, 0.95);
  }
  label {
    display: block;
    font-size: 12px;
    font-weight: 700;
    margin: 10px 0 6px;
    color: #475569;
  }
  select,
  input[type='text'],
  input[type='search'],
  input[type='email'],
  input[type='password'],
  input[type='file'],
  textarea {
    width: 100%;
    padding: 10px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: #fff;
    font: inherit;
    box-sizing: border-box;
  }
  textarea {
    min-height: 110px;
    resize: vertical;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .grid3 {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }
  .image-panel {
    margin-top: 10px;
    padding: 10px;
    border: 1px dashed #e5e7eb;
    border-radius: 10px;
    background: #f9fafb;
  }
  .image-preview {
    margin-top: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 120px;
    border: 1px solid #e7ebf0;
    border-radius: 8px;
    background: #fff;
  }
  .image-preview img {
    max-width: 100%;
    max-height: 220px;
    object-fit: contain;
  }
  .image-empty {
    font-size: 12px;
    color: #6b7280;
  }
  .helper {
    margin: 0 0 12px;
    color: #6b7280;
    font-size: 13px;
    line-height: 1.45;
  }
  .btn {
    display: inline-flex;
    text-decoration: none;
    border: 1px solid #e5e7eb;
    background: #fff;
    color: #1d4ed8;
    border-radius: 8px;
    padding: 9px 12px;
    font-size: 12px;
    font-weight: 600;
    margin-top: 12px;
  }
  .btn:hover {
    color: #1e40af;
    border-color: #bfdbfe;
  }
  code {
    background: #f1f5f9;
    padding: 2px 6px;
    border-radius: 6px;
    color: #334155;
    font-size: 0.8125em;
  }
  @media (max-width: 1180px) {
    .cards {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .split {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 980px) {
    .layout {
      grid-template-columns: 1fr;
    }
    .side {
      position: static;
    }
    .cards,
    .kpis {
      grid-template-columns: 1fr 1fr;
    }
    .grid3 {
      grid-template-columns: 1fr 1fr;
    }
    .shell {
      padding: 10px;
    }
    .card {
      padding: 14px;
    }
  }
  @media (max-width: 860px) {
    .cards,
    .kpis {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 760px) {
    .grid,
    .grid3 {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 680px) {
    .cards {
      grid-template-columns: 1fr;
    }
    .top {
      padding: 12px;
      align-items: flex-start;
    }
    .top form {
      width: 100%;
    }
    .top form button {
      width: 100%;
    }
    .actions a,
    .actions button {
      width: 100%;
      justify-content: center;
    }
    .side a,
    .side summary {
      padding: 11px 10px;
      font-size: 14px;
    }
    .filter {
      grid-template-columns: 1fr;
    }
  }
  body.admin-users-page th:last-child,
  body.admin-users-page td:last-child {
    width: auto;
    min-width: 240px;
  }
  body.admin-users-page .row-actions {
    gap: 6px;
  }
  body.admin-users-page .row-actions form {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px;
  }
  body.admin-users-page table th,
  body.admin-users-page table td {
    font-size: 12px;
    padding: 9px;
  }
  body.admin-profiles-list-page .filter {
    grid-template-columns: 1fr auto;
  }
  body.admin-profiles-list-page table {
    min-width: 760px;
  }
  body.admin-profile-detail-page table.profile-kv th {
    width: 220px;
  }
  body.admin-profile-detail-page table.profile-kv {
    min-width: 680px;
  }
  body.admin-questions-page .layout {
    grid-template-columns: 260px minmax(0, 1fr);
  }
  body.admin-questions-page .cards {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
  body.admin-simulation-page .cards {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  body.admin-simulation-page .layout,
  body.admin-sim-exam-new-page .layout,
  body.admin-simulation-exams-page .layout {
    grid-template-columns: 260px minmax(0, 1fr);
  }
  body.admin-question-new-page .layout,
  body.admin-questions-upload-page .layout {
    grid-template-columns: 240px minmax(0, 1fr);
  }
  body.admin-simulation-upload-page textarea[name='payload'] {
    min-height: 220px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  body.admin-questions-upload-page textarea[name='payload'] {
    min-height: 300px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  body.admin-edit-question-page .card {
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  }
  body.admin-edit-question-page .top {
    padding: 14px 18px;
  }
  @media (max-width: 1200px) {
    body.admin-questions-page .card strong {
      font-size: 20px;
    }
    body.admin-questions-page .card span {
      font-size: 11px;
    }
  }
  @media (max-width: 980px) {
    body.admin-questions-page .cards {
      grid-template-columns: 1fr 1fr;
    }
  }
  @media (max-width: 680px) {
    body.admin-questions-page .cards {
      grid-template-columns: 1fr;
    }
  }
  body.admin-push-page main.wrap {
    padding: 18px clamp(16px, 4vw, 28px);
  }
  /* iPhone: notch + home indicator, comfortable tap targets */
  body.exam-calm-page.admin-route {
    overflow-x: hidden;
    max-width: 100vw;
    padding-left: env(safe-area-inset-left, 0px);
    padding-right: env(safe-area-inset-right, 0px);
  }
  body.exam-calm-page.admin-route > header.top {
    padding-top: max(14px, env(safe-area-inset-top, 0px));
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
  }
  @media (max-width: 520px) {
    body.exam-calm-page.admin-route input[type='text'],
    body.exam-calm-page.admin-route input[type='email'],
    body.exam-calm-page.admin-route input[type='password'],
    body.exam-calm-page.admin-route input[type='search'],
    body.exam-calm-page.admin-route input[type='number'],
    body.exam-calm-page.admin-route select,
    body.exam-calm-page.admin-route textarea {
      font-size: 16px;
    }
  }
  @media (pointer: coarse) {
    body.exam-calm-page.admin-route .top a,
    body.exam-calm-page.admin-route button,
    body.exam-calm-page.admin-route .btn,
    body.exam-calm-page.admin-route input[type='submit'] {
      min-height: 44px;
    }
  }

  /* ---- Analytics workspace (DAT One Freight–style: charcoal rail, royal blue CTAs, light canvas) ---- */
  body.exam-calm-page.admin-route.admin-analytics-workspace {
    min-height: 100vh;
    margin: 0;
    display: flex;
    flex-direction: column;
    background: #111827;
    color: #4b5563;
  }
  body.admin-analytics-workspace > header.top {
    display: none;
  }
  body.admin-analytics-workspace main.layout.admin-analytics-shell,
  body.admin-analytics-workspace main.admin-analytics-shell {
    display: grid;
    grid-template-columns: 256px minmax(0, 1fr);
    gap: 0;
    flex: 1;
    min-height: 0;
    padding: 0;
    margin: 0;
    width: 100%;
    max-width: none;
    overflow: hidden;
  }
  body.admin-analytics-workspace aside.side.analytics-side {
    background: #111827;
    border: none;
    border-right: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0;
    padding: 0;
    align-self: stretch;
    position: relative;
    top: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  body.admin-analytics-workspace .analytics-nav-brand {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 16px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  body.admin-analytics-workspace .analytics-nav-logo {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    background: #000000;
    color: #fff;
    font-weight: 800;
    font-size: 14px;
    letter-spacing: -0.03em;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
  }
  body.admin-analytics-workspace .analytics-nav-brand-text {
    min-width: 0;
  }
  body.admin-analytics-workspace .analytics-nav-title {
    display: block;
    color: #fff;
    font-weight: 800;
    font-size: 15px;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }
  body.admin-analytics-workspace .analytics-nav-sub {
    display: block;
    font-size: 11px;
    font-weight: 600;
    color: #9ca3af;
    margin-top: 4px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    line-height: 1.25;
  }
  body.admin-analytics-workspace .analytics-nav-links {
    padding: 8px 0 16px;
    flex: 1;
    overflow-y: auto;
  }
  body.admin-analytics-workspace .analytics-nav-section {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #6b7280;
    padding: 14px 16px 6px;
  }
  body.admin-analytics-workspace .analytics-nav-section:first-of-type {
    padding-top: 10px;
  }
  body.admin-analytics-workspace .analytics-nav-hint {
    font-size: 12px;
    line-height: 1.45;
    color: #9ca3af;
    padding: 0 16px 10px;
    margin: 0;
  }
  body.admin-analytics-workspace aside.side.analytics-side a.analytics-nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #e5e7eb;
    padding: 10px 16px;
    border-radius: 0;
    font-size: 13px;
    font-weight: 600;
    margin: 0;
    border: none;
    text-decoration: none;
  }
  body.admin-analytics-workspace aside.side.analytics-side a.analytics-nav-item .analytics-nav-svg {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    opacity: 0.88;
    stroke: currentColor;
  }
  body.admin-analytics-workspace aside.side.analytics-side a.analytics-nav-item:hover {
    background: rgba(255, 255, 255, 0.06);
    color: #fff;
    text-decoration: none;
  }
  body.admin-analytics-workspace aside.side.analytics-side a.analytics-nav-item:hover .analytics-nav-svg {
    opacity: 1;
  }
  body.admin-analytics-workspace aside.side.analytics-side a.analytics-nav-item.active {
    background: #1e3a5f;
    color: #fff;
    text-decoration: none;
  }
  body.admin-analytics-workspace aside.side.analytics-side a.analytics-nav-item.active .analytics-nav-svg {
    opacity: 1;
    color: #fff;
  }
  body.admin-analytics-workspace aside.side.analytics-side details.analytics-nav-money {
    margin: 0;
    border: none;
  }
  body.admin-analytics-workspace aside.side.analytics-side details.analytics-nav-money > summary.analytics-nav-money-sum {
    list-style: none;
    cursor: pointer;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #9ca3af;
    padding: 10px 16px 8px;
    user-select: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  body.admin-analytics-workspace aside.side.analytics-side details.analytics-nav-money > summary.analytics-nav-money-sum::-webkit-details-marker {
    display: none;
  }
  body.admin-analytics-workspace aside.side.analytics-side details.analytics-nav-money > summary.analytics-nav-money-sum::after {
    content: "";
    flex-shrink: 0;
    width: 0;
    height: 0;
    margin-left: auto;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-top: 5px solid #6b7280;
    transition: transform 0.15s ease;
  }
  body.admin-analytics-workspace aside.side.analytics-side details.analytics-nav-money[open] > summary.analytics-nav-money-sum::after {
    transform: rotate(180deg);
  }
  body.admin-analytics-workspace aside.side.analytics-side details.analytics-nav-money > summary.analytics-nav-money-sum:hover {
    color: #d1d5db;
  }
  body.admin-analytics-workspace aside.side.analytics-side .analytics-nav-money-body {
    padding: 0 0 6px;
    display: flex;
    flex-direction: column;
  }
  body.admin-analytics-workspace aside.side.analytics-side .analytics-nav-money-body a.analytics-nav-item {
    padding-left: 22px;
    font-size: 13px;
  }
  body.admin-analytics-workspace aside.side.analytics-side a.analytics-nav-item.analytics-nav-item--sub {
    padding-left: 22px;
    font-size: 13px;
  }
  body.admin-analytics-workspace .admin-canvas {
    background: #f9fafb;
    min-width: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: auto;
  }
  body.admin-analytics-workspace .analytics-toolbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 16px 20px;
    background: #fff;
    border-bottom: 1px solid #e5e7eb;
    box-shadow: 0 1px 0 rgba(17, 24, 39, 0.04);
  }
  body.admin-analytics-workspace .analytics-toolbar h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 800;
    color: #111827;
    letter-spacing: -0.02em;
  }
  body.admin-analytics-workspace .analytics-toolbar .sub {
    margin: 4px 0 0;
    font-size: 12px;
    color: #6b7280;
    line-height: 1.4;
  }
  body.admin-analytics-workspace .analytics-toolbar-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  body.admin-analytics-workspace .analytics-toolbar-actions button {
    border: 1px solid #e5e7eb;
    background: #fff;
    color: #111827;
    border-radius: 6px;
    padding: 8px 14px;
    font-weight: 700;
    font-size: 13px;
    cursor: pointer;
  }
  body.admin-analytics-workspace .analytics-toolbar-actions button:hover {
    background: #f9fafb;
    border-color: #d1d5db;
  }
  body.admin-analytics-workspace .analytics-toolbar-actions a.link-pill {
    border: 1px solid #1d4ed8;
    background: #1d4ed8;
    color: #fff;
    border-radius: 6px;
    padding: 8px 14px;
    font-weight: 700;
    font-size: 13px;
    text-decoration: none;
  }
  body.admin-analytics-workspace .analytics-toolbar-actions a.link-pill:hover {
    background: #1e40af;
    border-color: #1e40af;
    color: #fff;
  }
  body.admin-analytics-workspace .da-subnav {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
  body.admin-analytics-workspace .da-subnav a.link-pill.is-active {
    background: #1d4ed8;
    border-color: #1d4ed8;
    color: #fff;
  }
  body.admin-analytics-workspace .da-subnav a.link-pill.is-active:hover {
    background: #1e40af;
    border-color: #1e40af;
    color: #fff;
  }
  body.admin-analytics-workspace .analytics-body {
    padding: 16px 20px 24px;
    flex: 1;
  }
  body.admin-analytics-workspace .analytics-summary-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 12px;
    margin-bottom: 14px;
  }
  body.admin-analytics-workspace .analytics-summary-cards .card strong {
    color: #111827;
  }
  body.admin-analytics-workspace .analytics-summary-cards .card strong a:hover {
    color: #1d4ed8;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  body.admin-analytics-workspace .analytics-summary-cards .card,
  body.admin-analytics-workspace .analytics-panel .card {
    border-radius: 6px;
    border: 1px solid #e5e7eb;
    box-shadow: 0 1px 2px rgba(17, 24, 39, 0.04);
    background: #fff;
  }
  body.admin-analytics-workspace .analytics-panel {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    box-shadow: 0 1px 2px rgba(17, 24, 39, 0.05);
    padding: 16px;
    margin-bottom: 14px;
  }
  body.admin-analytics-workspace .analytics-panel h2 {
    margin: 0 0 10px;
    font-size: 14px;
    font-weight: 800;
    color: #111827;
  }
  body.admin-analytics-workspace .analytics-filter-panel form.analytics-filter-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 0;
  }
  body.admin-analytics-workspace .analytics-filter-grid {
    display: grid;
    grid-template-columns: minmax(200px, 2fr) repeat(3, minmax(140px, 1fr)) auto auto;
    gap: 12px;
    align-items: end;
  }
  @media (max-width: 1200px) {
    body.admin-analytics-workspace .analytics-filter-grid {
      grid-template-columns: 1fr 1fr;
    }
  }
  @media (max-width: 640px) {
    body.admin-analytics-workspace .analytics-filter-grid {
      grid-template-columns: 1fr;
    }
  }
  body.admin-analytics-workspace .analytics-filter-panel label span {
    display: block;
    font-size: 11px;
    font-weight: 700;
    color: #6b7280;
    margin: 0 0 6px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  body.admin-analytics-workspace .analytics-filter-panel input,
  body.admin-analytics-workspace .analytics-filter-panel select {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    background: #fff;
    font-size: 13px;
    box-sizing: border-box;
  }
  body.admin-analytics-workspace .btn-search {
    border: 1px solid #1d4ed8;
    background: #1d4ed8;
    color: #fff;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: 12px;
    padding: 10px 20px;
    border-radius: 6px;
    cursor: pointer;
    min-height: 42px;
  }
  body.admin-analytics-workspace .btn-search:hover {
    background: #1e40af;
    border-color: #1e40af;
  }
  body.admin-analytics-workspace .btn-reset {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #e5e7eb;
    background: #f3f4f6;
    color: #374151;
    font-weight: 700;
    font-size: 13px;
    padding: 10px 16px;
    border-radius: 6px;
    text-decoration: none;
    min-height: 42px;
    box-sizing: border-box;
  }
  body.admin-analytics-workspace .btn-reset:hover {
    border-color: #d1d5db;
    color: #111827;
    background: #e5e7eb;
  }
  body.admin-analytics-workspace .analytics-quick-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding-top: 4px;
    border-top: 1px dashed #e5e7eb;
    margin-top: 4px;
  }
  body.admin-analytics-workspace .analytics-quick-filters span.hint {
    font-size: 11px;
    font-weight: 700;
    color: #9ca3af;
    margin-right: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  body.admin-analytics-workspace .chip-link {
    display: inline-flex;
    align-items: center;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid #e5e7eb;
    background: #f3f4f6;
    color: #374151;
    font-size: 12px;
    font-weight: 700;
    text-decoration: none;
  }
  body.admin-analytics-workspace .chip-link:hover {
    background: #e5e7eb;
    border-color: #d1d5db;
    color: #111827;
  }
  body.admin-analytics-workspace .analytics-results-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px 0 14px;
    border-bottom: 1px solid #e5e7eb;
    margin-bottom: 10px;
  }
  body.admin-analytics-workspace .analytics-results-bar .count {
    font-size: 14px;
    font-weight: 800;
    color: #111827;
  }
  body.admin-analytics-workspace .analytics-results-bar .count em {
    font-style: normal;
    color: #6b7280;
    font-weight: 600;
  }
  body.admin-analytics-workspace .analytics-results-bar .sort-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  body.admin-analytics-workspace .analytics-results-bar .sort-row label {
    font-size: 12px;
    color: #6b7280;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  body.admin-analytics-workspace .analytics-results-bar select {
    padding: 6px 10px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    font-size: 12px;
    background: #fff;
    color: #111827;
  }
  body.admin-analytics-workspace .analytics-icon-btn {
    border: 1px solid #e5e7eb;
    background: #fff;
    border-radius: 6px;
    width: 36px;
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 16px;
    padding: 0;
    color: #374151;
  }
  body.admin-analytics-workspace .analytics-icon-btn:hover {
    background: #f9fafb;
    border-color: #d1d5db;
  }
  body.admin-analytics-workspace .analytics-table-panel {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(17, 24, 39, 0.05);
  }
  body.admin-analytics-workspace .analytics-table-panel .table-wrap {
    overflow-x: auto;
  }
  body.admin-analytics-workspace .analytics-table-panel table {
    border: none;
    border-radius: 0;
  }
  body.admin-analytics-workspace .analytics-table-panel th {
    background: #f9fafb;
    color: #4b5563;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid #e5e7eb;
    padding: 10px 12px;
    white-space: nowrap;
  }
  body.admin-analytics-workspace .analytics-table-panel td {
    border-bottom: 1px solid #e5e7eb;
    padding: 10px 12px;
    font-size: 13px;
    color: #111827;
  }
  /* Zebra rows (DAT-style: white / light gray alternation) */
  body.admin-analytics-workspace .admin-canvas table tbody tr:nth-child(odd) td {
    background: #ffffff;
  }
  body.admin-analytics-workspace .admin-canvas table tbody tr:nth-child(even) td {
    background: #f5f7f9;
  }
  body.admin-analytics-workspace .admin-canvas table tbody tr:hover td {
    background: #eef2f7;
  }
  body.admin-analytics-workspace .analytics-table-panel a {
    color: #2563eb;
    font-weight: 700;
    text-decoration: none;
  }
  body.admin-analytics-workspace .analytics-table-panel a:hover {
    color: #1d4ed8;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  body.admin-analytics-workspace .analytics-muted {
    font-size: 12px;
    color: #6b7280;
    margin: 0 0 12px;
    line-height: 1.45;
  }
  body.admin-analytics-workspace .analytics-panel.split {
    display: grid;
    grid-template-columns: 1.35fr 0.75fr;
    gap: 16px;
    align-items: start;
  }
  body.admin-analytics-workspace .analytics-panel .kpis {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  }
  body.admin-analytics-workspace .analytics-panel .kpis .card span:last-child {
    font-size: 11px;
    color: #6b7280;
    margin-top: 4px;
  }
  @media (max-width: 960px) {
    body.admin-analytics-workspace .analytics-panel.split {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 900px) {
    body.admin-analytics-workspace main.layout.admin-analytics-shell,
    body.admin-analytics-workspace main.admin-analytics-shell {
      grid-template-columns: 1fr;
    }
    body.admin-analytics-workspace aside.side.analytics-side {
      min-height: auto;
      border-right: none;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
  }

  /* Activity desk — finance-style 3-column learner activity board */
  body.admin-analytics-workspace .activity-desk-toolbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 12px 16px;
    background: #fff;
    border-bottom: 1px solid #e5e7eb;
  }
  body.admin-analytics-workspace .activity-desk-toolbar h1 {
    margin: 0;
    font-size: 17px;
    font-weight: 800;
    color: #111827;
    letter-spacing: -0.02em;
  }
  body.admin-analytics-workspace .activity-desk-toolbar .sub {
    margin: 4px 0 0;
    font-size: 12px;
    color: #6b7280;
  }
  body.admin-analytics-workspace .activity-desk-wrap {
    display: grid;
    grid-template-columns: 272px minmax(0, 1fr) 300px;
    gap: 0;
    min-height: calc(100vh - 52px);
    background: #fff;
  }
  body.admin-analytics-workspace .activity-desk-left {
    border-right: 1px solid #e5e7eb;
    background: #fafafa;
    overflow-y: auto;
    max-height: calc(100vh - 52px);
  }
  body.admin-analytics-workspace .activity-desk-left-head {
    padding: 12px 14px 8px;
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    border-bottom: 1px solid #e5e7eb;
    background: #f3f4f6;
  }
  body.admin-analytics-workspace .activity-desk-user-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid #ececec;
    text-decoration: none;
    color: inherit;
  }
  body.admin-analytics-workspace .activity-desk-user-row:hover {
    background: #f0f9ff;
  }
  body.admin-analytics-workspace .activity-desk-user-row .u-meta {
    min-width: 0;
  }
  body.admin-analytics-workspace .activity-desk-user-row .u-name {
    font-size: 13px;
    font-weight: 700;
    color: #111827;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  body.admin-analytics-workspace .activity-desk-user-row .u-email {
    font-size: 11px;
    color: #64748b;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  body.admin-analytics-workspace .activity-desk-user-row .u-stat {
    text-align: right;
    font-size: 12px;
    font-weight: 700;
    color: #111827;
  }
  body.admin-analytics-workspace .activity-desk-user-row .u-delta {
    font-size: 11px;
    font-weight: 700;
  }
  body.admin-analytics-workspace .activity-desk-user-row .u-delta.pos {
    color: #15803d;
  }
  body.admin-analytics-workspace .activity-desk-user-row .u-delta.neg {
    color: #b91c1c;
  }
  body.admin-analytics-workspace .activity-desk-center {
    padding: 16px 18px 24px;
    overflow-y: auto;
    max-height: calc(100vh - 52px);
    background: #fff;
  }
  body.admin-analytics-workspace .activity-desk-hero {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }
  body.admin-analytics-workspace .activity-desk-hero h2 {
    margin: 0;
    font-size: 22px;
    font-weight: 800;
    color: #111827;
    letter-spacing: -0.02em;
  }
  body.admin-analytics-workspace .activity-desk-hero .delta {
    font-size: 14px;
    font-weight: 700;
  }
  body.admin-analytics-workspace .activity-desk-hero .delta.pos {
    color: #15803d;
  }
  body.admin-analytics-workspace .activity-desk-hero .delta.neg {
    color: #b91c1c;
  }
  body.admin-analytics-workspace .activity-desk-sub {
    font-size: 13px;
    color: #64748b;
    margin-bottom: 14px;
  }
  body.admin-analytics-workspace .activity-desk-chart-card {
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    background: #fff;
    padding: 12px 14px 8px;
    margin-bottom: 16px;
  }
  body.admin-analytics-workspace .activity-desk-chart-dates {
    box-sizing: border-box;
  }
  body.admin-analytics-workspace .activity-desk-chart-dates span {
    display: block;
    font-size: 10px;
    font-weight: 600;
    color: #64748b;
    text-align: center;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-top: 2px;
  }
  body.admin-analytics-workspace .activity-desk-chart-xcounts {
    box-sizing: border-box;
  }
  body.admin-analytics-workspace .activity-desk-chart-xcounts span {
    display: block;
    font-size: 9px;
    font-weight: 700;
    text-align: center;
    line-height: 1.15;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-top: 1px;
    letter-spacing: -0.02em;
  }
  body.admin-analytics-workspace .activity-desk-chart-hover {
    line-height: 0;
  }
  body.admin-analytics-workspace .activity-desk-chart-tooltip {
    position: fixed;
    min-width: 188px;
    max-width: 280px;
    padding: 10px 12px;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    box-shadow: 0 12px 40px rgba(15, 23, 42, 0.14);
    font-size: 12px;
    line-height: 1.45;
    pointer-events: none;
    text-align: left;
    z-index: 200;
  }
  body.admin-analytics-workspace .activity-desk-chart-tabs {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid #f1f5f9;
    align-items: center;
  }
  body.admin-analytics-workspace .activity-desk-chart-tabs a {
    font-size: 11px;
    font-weight: 700;
    color: #64748b;
    padding: 5px 10px;
    border-radius: 6px;
    background: #f8fafc;
    text-decoration: none;
    border: 1px solid transparent;
  }
  body.admin-analytics-workspace .activity-desk-chart-tabs a:hover {
    background: #f1f5f9;
    color: #334155;
  }
  body.admin-analytics-workspace .activity-desk-chart-tabs a.is-on {
    background: #dbeafe;
    color: #1d4ed8;
    border-color: #bfdbfe;
  }
  body.admin-analytics-workspace .activity-desk-metrics {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
    margin-bottom: 18px;
  }
  body.admin-analytics-workspace .activity-desk-metrics article {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 10px 12px;
    background: #fafafa;
  }
  body.admin-analytics-workspace .activity-desk-metrics article span {
    display: block;
    font-size: 11px;
    font-weight: 700;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  body.admin-analytics-workspace .activity-desk-metrics article strong {
    display: block;
    margin-top: 4px;
    font-size: 18px;
    font-weight: 800;
    color: #111827;
  }
  body.admin-analytics-workspace .activity-desk-related h3 {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 800;
    color: #374151;
  }
  body.admin-analytics-workspace .activity-desk-related-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 10px;
  }
  body.admin-analytics-workspace .activity-desk-mini {
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    padding: 10px 12px;
    background: #fff;
  }
  body.admin-analytics-workspace .activity-desk-mini .t {
    font-size: 12px;
    font-weight: 700;
    color: #111827;
  }
  body.admin-analytics-workspace .activity-desk-mini .v {
    font-size: 15px;
    font-weight: 800;
    color: #111827;
    margin: 2px 0 4px;
  }
  body.admin-analytics-workspace .activity-desk-mini .spark {
    margin-top: 6px;
    display: flex;
    justify-content: flex-end;
  }
  body.admin-analytics-workspace .activity-desk-right {
    border-left: 1px solid #e5e7eb;
    background: #fafafa;
    padding: 14px 14px 20px;
    overflow-y: auto;
    max-height: calc(100vh - 52px);
  }
  body.admin-analytics-workspace .activity-desk-ai {
    background: linear-gradient(180deg, #eff6ff 0%, #f8fafc 100%);
    border: 1px solid #bfdbfe;
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 14px;
    font-size: 12px;
    color: #1e3a8a;
    line-height: 1.45;
  }
  body.admin-analytics-workspace .activity-desk-ai strong {
    display: block;
    margin-bottom: 6px;
    font-size: 13px;
  }
  body.admin-analytics-workspace .activity-desk-prompts h4 {
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
  }
  body.admin-analytics-workspace .activity-desk-prompts a {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #1d4ed8;
    text-decoration: none;
    padding: 6px 0;
    border-bottom: 1px solid #e5e7eb;
  }
  body.admin-analytics-workspace .activity-desk-prompts a:hover {
    text-decoration: underline;
  }
  body.admin-analytics-workspace .activity-desk-recent h4 {
    margin: 16px 0 8px;
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
  }
  body.admin-analytics-workspace .activity-desk-recent ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  body.admin-analytics-workspace .activity-desk-recent li {
    font-size: 12px;
    color: #334155;
    padding: 6px 0;
    border-bottom: 1px solid #e5e7eb;
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  body.admin-analytics-workspace .activity-desk-ask {
    margin-top: 18px;
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid #e5e7eb;
    border-radius: 999px;
    padding: 8px 12px;
    background: #fff;
    font-size: 12px;
    color: #94a3b8;
  }
  @media (max-width: 1180px) {
    body.admin-analytics-workspace .activity-desk-wrap {
      grid-template-columns: 240px minmax(0, 1fr);
    }
    body.admin-analytics-workspace .activity-desk-right {
      display: none;
    }
  }
  @media (max-width: 900px) {
    body.admin-analytics-workspace .activity-desk-wrap {
      grid-template-columns: 1fr;
    }
    body.admin-analytics-workspace .activity-desk-left {
      max-height: 280px;
      border-right: none;
      border-bottom: 1px solid #e5e7eb;
    }
  }
</style>`;

function renderAdminHtml(title, innerHtml, opts) {
  const bodyClass = (opts && opts.bodyClass) || 'admin-route';
  const headExtra = (opts && opts.headExtra) || '';
  const analyticsInterFont = bodyClass.includes('admin-route')
    ? `<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escHtml(title)}</title>
  ${analyticsInterFont}
  ${STRIP_GUIDE_PAGE_STYLES}
  ${ADMIN_APP_CHROME_STYLES}
  ${headExtra}
</head>
<body class="exam-calm-page ${bodyClass}">
${innerHtml}
</body>
</html>`;
}

const QUESTION_IMAGE_DIR = path.join(process.cwd(), 'public', 'question-images');

async function ensureQuestionImageDir() {
  await fs.promises.mkdir(QUESTION_IMAGE_DIR, { recursive: true });
}

const ROLE_VIDEO_SVG =
  '<path d="M11 13 L11 27 L23 20 Z"/><rect x="25" y="11" width="10" height="18" rx="1.5"/>';

const EQUIPMENT_ITEMS = [
  { label: 'Role Video', inner: ROLE_VIDEO_SVG },
  {
    label: 'X-Ray Console',
    inner:
      '<rect x="6" y="8" width="28" height="18" rx="2"/><path d="M14 26v6h12v-6"/><line x1="12" y1="14" x2="28" y2="14"/>'
  },
  {
    label: 'X-Ray Tube Head',
    inner:
      '<rect x="7" y="15" width="12" height="10" rx="1"/><path d="M19 16 L33 11 L33 29 L19 24 Z"/>'
  },
  {
    label: 'Portable X-Ray Unit',
    inner:
      '<rect x="10" y="14" width="20" height="12" rx="1"/><circle cx="16" cy="30" r="3"/><circle cx="26" cy="30" r="3"/><path d="M17 14v-5h8v5"/>'
  },
  { label: 'Role Video', inner: ROLE_VIDEO_SVG },
  {
    label: 'Ultrasound Unit',
    inner:
      '<rect x="9" y="10" width="15" height="12" rx="1"/><rect x="24" y="12" width="9" height="13" rx="1"/><path d="M20 22v10"/><path d="M13 32h16"/>'
  },
  {
    label: 'Ultrasound Transducers',
    inner:
      '<path d="M11 30V17"/><path d="M8 17h6"/><path d="M20 30V15"/><path d="M17 15h6"/><path d="M29 30V18"/><path d="M26 18h6"/>'
  },
  {
    label: 'The Patient',
    inner:
      '<path d="M7 31h26"/><circle cx="20" cy="11" r="3.5"/><path d="M16 16h8"/><path d="M18 18v9"/><path d="M14 28h12"/>'
  },
  { label: 'Role Video', inner: ROLE_VIDEO_SVG },
  {
    label: 'Treatment Console',
    inner:
      '<rect x="6" y="11" width="28" height="17" rx="2"/><circle cx="13" cy="19" r="2.5"/><circle cx="20" cy="19" r="2.5"/><circle cx="27" cy="19" r="2.5"/><line x1="11" y1="25" x2="29" y2="25"/>'
  },
  {
    label: 'Linear Accelerator',
    inner:
      '<path d="M7 24 Q20 5 33 24"/><line x1="7" y1="29" x2="33" y2="29" stroke-width="2.2"/>'
  }
];

const EQUIPMENT_BG_SLOTS = [
  { x: 7, y: 20, r: -12, s: 1.25 },
  { x: 91, y: 18, r: 14, s: 1.05 },
  { x: 5, y: 56, r: -18, s: 1.15 },
  { x: 86, y: 48, r: 8, s: 1.0 },
  { x: 50, y: 10, r: 0, s: 0.88 },
  { x: 24, y: 40, r: -14, s: 1.12 },
  { x: 74, y: 66, r: 16, s: 1.08 },
  { x: 40, y: 54, r: -8, s: 1.18 },
  { x: 58, y: 86, r: 11, s: 0.92 },
  { x: 14, y: 90, r: -10, s: 0.95 },
  { x: 68, y: 12, r: -6, s: 1.2 }
];

function buildEquipmentBgHtml(spanClass, withTitles) {
  return EQUIPMENT_ITEMS.map((item, i) => {
    const p = EQUIPMENT_BG_SLOTS[i] || { x: 50, y: 50, r: 0, s: 1 };
    const t = withTitles ? ` title="${escHtml(item.label)}"` : '';
    return `<span class="${spanClass}" style="left:${p.x}%;top:${p.y}%;transform:translate(-50%,-50%) rotate(${p.r}deg) scale(${p.s})"${t} aria-hidden="true"><svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${item.inner}</svg></span>`;
  }).join('');
}

/** Canadian post-secondary names for signup (not exhaustive; includes Other). */
const SIGNUP_CANADIAN_SCHOOLS = `Algoma University
Athabasca University
Bishop's University
Brock University
Cape Breton University
Capilano University
Carleton University
Concordia University
Dalhousie University
Fanshawe College
George Brown College
Humber College
Kwantlen Polytechnic University
Lakehead University
Laurentian University
McGill University
McMaster University
Memorial University of Newfoundland
Mount Royal University
Nipissing University
Northern Alberta Institute of Technology (NAIT)
Nova Scotia Community College
Ontario Tech University
Queen's University
Red River College Polytechnic
Ryerson University (TMU)
Saskatchewan Polytechnic
Seneca College
Simon Fraser University
St. Clair College
Thompson Rivers University
Toronto Metropolitan University
Trent University
University of Alberta
University of British Columbia
University of Calgary
University of Guelph
University of Lethbridge
University of Manitoba
University of New Brunswick
University of Northern British Columbia
University of Ontario Institute of Technology
University of Ottawa
University of Prince Edward Island
University of Regina
University of Saskatchewan
University of Toronto
University of Victoria
University of Waterloo
University of Windsor
University of Winnipeg
Vancouver Island University
Western University
Wilfrid Laurier University
York University`
  .trim()
  .split(/\n+/)
  .map((s) => s.trim())
  .filter(Boolean);

const SIGNUP_CA_PROVINCES = [
  ['AB', 'Alberta'],
  ['BC', 'British Columbia'],
  ['MB', 'Manitoba'],
  ['NB', 'New Brunswick'],
  ['NL', 'Newfoundland and Labrador'],
  ['NS', 'Nova Scotia'],
  ['NT', 'Northwest Territories'],
  ['NU', 'Nunavut'],
  ['ON', 'Ontario'],
  ['PE', 'Prince Edward Island'],
  ['QC', 'Quebec'],
  ['SK', 'Saskatchewan'],
  ['YT', 'Yukon']
];

const SIGNUP_US_STATES = [
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['DC', 'District of Columbia'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming']
];

/** Full country picklist when international + current location is outside Canada (~100+ common jurisdictions). */
const SIGNUP_OUTSIDE_CANADA_COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Angola', 'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan',
  'Bahamas', 'Bahrain', 'Bangladesh', 'Belarus', 'Belgium', 'Belize', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Bulgaria',
  'Cambodia', 'Cameroon', 'Canada', 'Chile', 'China', 'Colombia', 'Costa Rica', 'Croatia', 'Cyprus', 'Czech Republic',
  'Denmark', 'Dominican Republic',
  'Ecuador', 'Egypt', 'El Salvador', 'Estonia', 'Ethiopia',
  'Finland', 'France',
  'Georgia', 'Germany', 'Ghana', 'Greece', 'Guatemala',
  'Haiti', 'Honduras', 'Hong Kong', 'Hungary',
  'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy',
  'Jamaica', 'Japan', 'Jordan',
  'Kazakhstan', 'Kenya', 'Kuwait', 'Kyrgyzstan',
  'Latvia', 'Lebanon', 'Libya', 'Lithuania', 'Luxembourg',
  'Malaysia', 'Maldives', 'Malta', 'Mauritius', 'Mexico', 'Moldova', 'Mongolia', 'Morocco', 'Myanmar',
  'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua', 'Nigeria', 'North Macedonia', 'Norway',
  'Oman',
  'Pakistan', 'Panama', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal',
  'Qatar',
  'Romania', 'Russia', 'Rwanda',
  'Saudi Arabia', 'Senegal', 'Serbia', 'Singapore', 'Slovakia', 'Slovenia', 'Somalia', 'South Africa', 'South Korea', 'Spain', 'Sri Lanka', 'Sudan', 'Sweden', 'Switzerland', 'Syria',
  'Taiwan', 'Tanzania', 'Thailand', 'Trinidad and Tobago', 'Tunisia', 'Turkey',
  'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan',
  'Venezuela', 'Vietnam',
  'Yemen',
  'Zambia', 'Zimbabwe'
].sort((a, b) => a.localeCompare(b, 'en'));

/** CAMRT-style exam sittings + registration windows (keys for signup; confirm on camrt.ca). */
const CAMRT_SIGNUP_EXAM_ROWS = [
  {
    sittingKey: 'sit_2026_05',
    sitting: 'May 11 – 12, 2026',
    registration: 'January 26 – March 6, 2026',
    regKey: 'reg_2026_01_26__03_06'
  },
  {
    sittingKey: 'sit_2026_09',
    sitting: 'September 14 – 15, 2026',
    registration: 'June 1 – July 10, 2026',
    regKey: 'reg_2026_06_01__07_10'
  },
  {
    sittingKey: 'sit_2027_01',
    sitting: 'January 11 – 12, 2027',
    registration: 'Sept 28 – Nov 6, 2026',
    regKey: 'reg_2026_09_28__11_06'
  }
];

function buildSignupFormHtml() {
  const schoolOpts = SIGNUP_CANADIAN_SCHOOLS.map(
    (s) => `<option value="${escAttr(s)}">${escHtml(s)}</option>`
  ).join('\n            ');
  const provOpts = SIGNUP_CA_PROVINCES.map(
    ([code, label]) => `<option value="${escAttr(code)}">${escHtml(label)}</option>`
  ).join('\n            ');
  const usOpts = SIGNUP_US_STATES.map(
    ([code, label]) => `<option value="${escAttr(code)}">${escHtml(label)}</option>`
  ).join('\n            ');
  const regOpts = CAMRT_SIGNUP_EXAM_ROWS.map(
    (r) => `<option value="${escAttr(r.regKey)}">${escHtml(r.registration)}</option>`
  ).join('\n            ');
  const sitOpts = CAMRT_SIGNUP_EXAM_ROWS.map(
    (r) => `<option value="${escAttr(r.sittingKey)}">${escHtml(r.sitting)}</option>`
  ).join('\n            ');
  const outsideCountryOpts = SIGNUP_OUTSIDE_CANADA_COUNTRIES.map(
    (c) => `<option value="${escAttr(c)}">${escHtml(c)}</option>`
  ).join('\n            ');
  return `<form class="signup-form" id="signup-main-form" method="post" action="/signup" autocomplete="on">
      <h2 class="signup-title">👤 Personal Information</h2>
      <fieldset class="signup-fieldset">
        <legend class="signup-legend">🎓 Graduate</legend>
        <p class="signup-inline-label" id="signup-personal-region-h">Who is signing up? <span style="color:#b45309">(required)</span></p>
        <div class="signup-seg signup-seg--2 signup-intl-stack" role="radiogroup" aria-labelledby="signup-personal-region-h">
          <div class="signup-seg-inner">
            <span class="signup-seg-thumb" aria-hidden="true"></span>
            <label class="signup-seg-item">
              <input id="signup-pr-local" type="radio" name="personalRegion" value="local" class="signup-seg-input" required checked />
              <span class="signup-seg-text">Canadian graduate</span>
            </label>
            <label class="signup-seg-item">
              <input id="signup-pr-intl" type="radio" name="personalRegion" value="international" class="signup-seg-input" />
              <span class="signup-seg-text">International student</span>
            </label>
          </div>
        </div>
        <label class="signup-label">First name <input type="text" name="firstName" id="signup-first" required autocomplete="given-name" /></label>
        <label class="signup-label">Last name <input type="text" name="lastName" id="signup-last" required autocomplete="family-name" /></label>
        <label class="signup-label">Email <input type="email" name="email" id="signup-email" required autocomplete="email" /></label>
        <div id="signup-block-canadian">
          <label class="signup-label">School (Canada) <span style="color:#b45309">*</span>
            <select name="schoolCanadian" id="signup-school-ca">
              <option value="">Select your institution…</option>
            ${schoolOpts}
              <option value="__other__">Other (specify below)</option>
            </select>
          </label>
          <label class="signup-label" id="signup-school-other-wrap" style="display:none">Institution name (other)
            <input type="text" name="schoolOther" id="signup-school-other" autocomplete="organization" />
          </label>
          <div id="signup-canada-city-prov">
            <label class="signup-label">Province / territory
              <select name="provinceCanada" id="signup-prov-ca">
                <option value="">Select…</option>
            ${provOpts}
              </select>
            </label>
          </div>
        </div>
        <div id="signup-block-international" style="display:none">
          <label class="signup-label">Current location <span style="color:#b45309">*</span>
            <select name="currentLocation" id="signup-current-loc" required>
              <option value="in_canada" selected>Yes — I am in Canada now</option>
              <option value="outside_canada">No — I am outside Canada</option>
            </select>
          </label>
          <div id="signup-intl-country-cat-wrap">
            <label class="signup-label">Country category <span style="color:#b45309">*</span>
              <select name="countryCategory" id="signup-country-cat">
                <option value="CA">Canada</option>
                <option value="US">United States</option>
                <option value="OTHER">Other country</option>
              </select>
            </label>
            <label class="signup-label" id="signup-country-other-wrap" style="display:none">Country name
              <input type="text" name="countryOtherName" id="signup-country-other" autocomplete="country-name" />
            </label>
          </div>
          <div id="signup-intl-outside-wrap" style="display:none">
            <label class="signup-label">Country <span style="color:#b45309">*</span>
              <select name="countryOutsideCanada" id="signup-country-outside">
                <option value="">Select your country…</option>
            ${outsideCountryOpts}
                <option value="__other__">Other (specify)</option>
              </select>
            </label>
            <label class="signup-label" id="signup-country-outside-other-wrap" style="display:none">Country name
              <input type="text" name="countryOutsideCanadaOther" id="signup-country-outside-other" autocomplete="country-name" />
            </label>
          </div>
          <div id="signup-intl-ca-fields">
            <label class="signup-label">Province / territory
              <select name="provinceIntlCA" id="signup-prov-intl-ca">
                <option value="">Select…</option>
            ${provOpts}
              </select>
            </label>
          </div>
          <div id="signup-intl-us-fields" style="display:none">
            <label class="signup-label">State
              <select name="stateUS" id="signup-state-us">
                <option value="">Select…</option>
            ${usOpts}
              </select>
            </label>
          </div>
        </div>
      </fieldset>
      <h2 class="signup-title">🎓 Exam Information <span style="color:#b45309">(required)</span></h2>
      <fieldset class="signup-fieldset">
        <legend class="signup-legend" id="signup-student-status-heading">Exam registration status</legend>
        <p class="signup-inline-label" id="signup-student-status-label">Which applies to you? <span style="color:#b45309">*</span></p>
        <div class="signup-seg signup-seg--exam2" role="radiogroup" aria-labelledby="signup-student-status-label">
          <div class="signup-seg-inner">
            <span class="signup-seg-thumb" aria-hidden="true"></span>
            <label class="signup-seg-item">
              <input id="signup-ss-r1" type="radio" name="studentStatus" value="studying_not_registered" class="signup-seg-input" required checked />
              <span class="signup-seg-text">Studying · not registered</span>
            </label>
            <label class="signup-seg-item">
              <input id="signup-ss-r2" type="radio" name="studentStatus" value="registered_exam" class="signup-seg-input" />
              <span class="signup-seg-text">Registered · sitting booked</span>
            </label>
          </div>
        </div>
        <div id="signup-registered-only" style="display:none;margin-top:12px">
          <label class="signup-label">Exam sitting (national test dates) <span style="color:#b45309">*</span>
            <select name="examSittingKey" id="signup-exam-sitting">
              <option value="">Select your exam sitting…</option>
            ${sitOpts}
            </select>
          </label>
          <label class="signup-label">Registration period (when you registered) <span style="color:#b45309">*</span>
            <select name="registrationWindowKey" id="signup-reg-window">
              <option value="">Select the period you registered in…</option>
            ${regOpts}
            </select>
          </label>
        </div>
      </fieldset>
      <div class="signup-actions">
        <button type="submit" class="signup-submit">Create account</button>
      </div>
    </form>`;
}

/** Shared emoji + equipment layers for /login and /signup. */
function buildAuthPageDecoHtml() {
  const deco = [
    { sym: '🩻', x: 10, y: 16, r: -12, s: 1.05 },
    { sym: '🦴', x: 84, y: 12, r: 14, s: 1.1 },
    { sym: '☢️', x: 22, y: 62, r: -8, s: 0.95 },
    { sym: '🏥', x: 76, y: 44, r: 6, s: 1.0 },
    { sym: '⚕️', x: 48, y: 10, r: 0, s: 0.92 },
    { sym: '🩺', x: 90, y: 58, r: -16, s: 1.08 },
    { sym: '🫁', x: 14, y: 84, r: 10, s: 0.98 },
    { sym: '🦷', x: 58, y: 76, r: -6, s: 0.88 },
    { sym: '🩻', x: 36, y: 30, r: 22, s: 0.82 },
    { sym: '🦴', x: 68, y: 22, r: -5, s: 0.9 },
    { sym: '☢️', x: 6, y: 42, r: 18, s: 0.78 },
    { sym: '🏥', x: 52, y: 50, r: 160, s: 0.72 },
    { sym: '🩺', x: 88, y: 86, r: 12, s: 0.85 },
    { sym: '🫁', x: 42, y: 88, r: -10, s: 0.8 },
    { sym: '🦷', x: 72, y: 72, r: -20, s: 0.8 },
    { sym: '⚕️', x: 28, y: 48, r: 8, s: 0.88 },
    { sym: '🩻', x: 94, y: 28, r: -14, s: 0.75 },
    { sym: '🦴', x: 50, y: 94, r: 4, s: 0.82 },
    { sym: '🧠', x: 4, y: 68, r: -22, s: 0.78 },
    { sym: '🫀', x: 32, y: 8, r: 6, s: 0.72 },
    { sym: '💉', x: 96, y: 46, r: 16, s: 0.74 },
    { sym: '📋', x: 20, y: 28, r: -4, s: 0.68 },
    { sym: '🚑', x: 62, y: 8, r: -8, s: 0.76 },
    { sym: '🤕', x: 78, y: 58, r: 11, s: 0.7 },
    { sym: '🩹', x: 46, y: 22, r: 24, s: 0.65 },
    { sym: '☢️', x: 54, y: 36, r: -18, s: 0.62 },
    { sym: '🏥', x: 2, y: 18, r: 5, s: 0.68 },
    { sym: '🩻', x: 70, y: 38, r: 9, s: 0.7 },
    { sym: '🫁', x: 38, y: 70, r: -12, s: 0.74 },
    { sym: '🦷', x: 86, y: 74, r: 7, s: 0.66 },
    { sym: '⚕️', x: 14, y: 52, r: -16, s: 0.64 },
    { sym: '🦴', x: 60, y: 64, r: 19, s: 0.6 },
    { sym: '🩺', x: 26, y: 76, r: -7, s: 0.72 },
    { sym: '🧠', x: 92, y: 14, r: 14, s: 0.58 }
  ];
  const iconsHtml = deco
    .map(
      (d) =>
        `<span class="deco-emoji" style="left:${d.x}%;top:${d.y}%;transform:translate(-50%,-50%) rotate(${d.r}deg) scale(${d.s})" aria-hidden="true">${d.sym}</span>`
    )
    .join('');
  const equipmentBgHtml = buildEquipmentBgHtml('deco-equip', true);
  return { iconsHtml, equipmentBgHtml };
}

function isSecondBrainEntryDeletePath(p, method) {
  if (String(method || '').toUpperCase() !== 'POST') return false;
  return SECOND_BRAIN_ENTRY_DELETE_RE.test(String(p || ''));
}

function isSecondBrainEntryEditPath(p, method) {
  const meth = String(method || '').toUpperCase();
  if (meth !== 'GET' && meth !== 'POST') return false;
  return SECOND_BRAIN_ENTRY_EDIT_RE.test(String(p || ''));
}

function isSecondBrainGuestPath(p, method) {
  const meth = String(method || 'GET').toUpperCase();
  if (isSecondBrainEntryDeletePath(p, meth)) return true;
  if (isSecondBrainEntryEditPath(p, meth)) return true;
  for (let i = 0; i < SECOND_BRAIN_TOPIC_SLUGS.length; i += 1) {
    const slug = SECOND_BRAIN_TOPIC_SLUGS[i];
    const base = '/' + slug;
    if (p === base && meth === 'GET') return true;
    if (slug === 'career' && p === base + '/log' && meth === 'GET') return true;
    if (p === base + '/new' && (meth === 'GET' || meth === 'POST')) return true;
  }
  return false;
}

function isGuestAllowedRequest(req) {
  const a = req.actor;
  if (!a || !a.isGuest) return true;
  const p = req.path || '';
  const method = String(req.method || 'GET').toUpperCase();
  // Guest sessions (e.g. iOS app with only app_sid) must reach these routes; they apply their own auth.
  if (p.startsWith('/api/admin')) return true;
  if (p.startsWith('/api/ios/')) return true;
  if (p.startsWith('/admin')) return false;
  if (p.startsWith('/uploads/')) return true;
  if (p === '/assets/landing-preview' || p.startsWith('/assets/landing-preview/')) return true;
  if (isSecondBrainGuestPath(p, method)) return true;
  if (method === 'GET' && p === '/monthly-expenses') return true;
  if (method === 'GET' && p === '/income') return true;
  if (method === 'GET' && p === '/cashflow') return true;
  if (method === 'GET' && p === '/saving') return true;
  if (method === 'GET' && p === '/tickets') return true;
  if (method === 'GET' && p === '/debt-tracker') return true;
  if (method === 'GET' && p === '/marriage-cost') return true;
  if (method === 'GET' && p === '/projected-date') return true;
  if (method === 'GET' && p === '/dashboard') return true;
  if (
    method === 'GET' &&
    (p === '/daily-tasks' ||
      p === '/daily-tasks/completed' ||
      p === '/daily-task-personal' ||
      p === '/daily-task-personal/completed' ||
      p === '/studying-medical-physics' ||
      p === '/studying-medical-physics/completed' ||
      p === '/studying-medical-physics/career-overview' ||
      p === '/work-planning' ||
      p === '/work-planning/completed' ||
      p === '/priority' ||
      p === '/todolist' ||
      p === '/todolist/calendar' ||
      p === '/data-analytics/learning' ||
      p.startsWith('/data-analytics/learning/') ||
      p === '/data-analytics/overview' ||
      p === '/data-analytics/high-yield-activity' ||
      p === '/data-analytics/job-board' ||
      p.startsWith('/data-analytics/job-board/') ||
      p === '/function')
  )
    return true;
  if (method === 'GET' && p === '/wealth') return true;
  if (
    method === 'GET' &&
    (p === '/' ||
      p === '/login' ||
      p === '/sign-in' ||
      p === '/signup' ||
      p === '/contact-us')
  )
    return true;
  if (method === 'GET' && p === '/performance') return true;
  if (method === 'GET' && p === '/profile') return true;
  if (method === 'POST' && (p === '/login' || p === '/signup' || p === '/logout')) return true;
  if (p === '/trial' || p.startsWith('/trial/')) return true;
  if (p.startsWith('/test-engine')) {
    return String((req.query && req.query.trial) || '').trim() === '1';
  }
  if (p === '/api/test-engine/counts' && method === 'GET') return true;
  if (p === '/api/test-engine/attempt' && method === 'POST') return true;
  if (p.startsWith('/api/board-store/') && (method === 'GET' || method === 'PUT')) return true;
  if (p.startsWith('/api/todolist/') && method === 'GET') return true;
  if (p.startsWith('/api/resumes')) return true;
  return false;
}

/** Throttle AppSession writes (same semantics for reads; lastSeenAt may lag by this window). */
const APP_SESSION_TOUCH_INTERVAL_MS = Math.max(0, Number(process.env.APP_SESSION_TOUCH_INTERVAL_MS) || 25000);
const appSessionLastDbTouch = new Map();

app.use((req, res, next) => {
  req.actor = assignActorForRequest(req, res);
  const cookies = parseCookies(req);
  const crypto = require('crypto');
  let appSid = String(cookies.app_sid || '').trim();
  if (!appSid) {
    appSid = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    setCookie(res, 'app_sid', appSid, 60 * 60 * 24 * 180);
  }
  req.appSessionId = appSid;
  if (!isMongoConnected()) {
    return next();
  }
  const now = Date.now();
  if (APP_SESSION_TOUCH_INTERVAL_MS > 0) {
    const last = appSessionLastDbTouch.get(appSid) || 0;
    if (now - last < APP_SESSION_TOUCH_INTERVAL_MS) {
      return next();
    }
  }
  AppSession.findOneAndUpdate(
    { appSessionId: appSid },
    {
      $set: {
        actorId: req.actor.actorId,
        isGuest: req.actor.isGuest,
        lastSeenAt: new Date(),
        isActive: true
      },
      $setOnInsert: { startedAt: new Date() }
    },
    { upsert: true }
  )
    .then(() => {
      if (APP_SESSION_TOUCH_INTERVAL_MS > 0) {
        const t = Date.now();
        appSessionLastDbTouch.set(appSid, t);
        if (appSessionLastDbTouch.size > 8000) {
          const cutoff = t - APP_SESSION_TOUCH_INTERVAL_MS * 3;
          for (const [k, v] of appSessionLastDbTouch) {
            if (v < cutoff) appSessionLastDbTouch.delete(k);
          }
        }
      }
      next();
    })
    .catch((err) => {
      console.error('AppSession touch failed:', err && err.message ? err.message : err);
      next();
    });
});

app.use((req, res, next) => {
  if (!isGuestAllowedRequest(req)) {
    const method = String(req.method || 'GET').toUpperCase();
    const p = req.path || '';
    if (method === 'GET' && p.startsWith('/performance/')) {
      const nextPath = String(req.originalUrl || p).split('?')[0] || p;
      return res.redirect(302, `/login?next=${encodeURIComponent(nextPath)}`);
    }
    return res.status(403).type('html').send(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/><title>Sign in to continue</title></head><body style="font-family:system-ui,sans-serif;padding:max(16px,env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) max(16px,env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));max-width:560px;margin:0 auto">' +
        '<h1 style="font-size:1.25rem">Practice and exams require an account</h1>' +
        '<p>Guests can use the free trial only. <a href="/trial/start">Start trial</a> or <a href="/signup">create an account</a>.</p>' +
        '<p><a href="/login">Sign in</a></p></body></html>'
    );
  }
  next();
});

const SECOND_BRAIN_CSS = `
  :root {
    --sb-bg: #0f1419;
    --sb-surface: #1a222d;
    --sb-border: #2d3a4a;
    --sb-text: #e8eef5;
    --sb-muted: #8b9cb0;
    --sb-accent: #6ee7b7;
    --sb-accent2: #7dd3fc;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, ui-serif, serif;
    background: radial-gradient(1200px 600px at 20% -10%, #1e2a3a 0%, var(--sb-bg) 55%);
    color: var(--sb-text);
    line-height: 1.5;
  }
  a { color: var(--sb-accent2); }
  .sb-wrap { max-width: 880px; margin: 0 auto; padding: clamp(20px, 4vw, 40px); }
  .sb-banner {
    text-align: center;
    padding: clamp(28px, 5vw, 48px) 20px;
    border: 1px solid var(--sb-border);
    border-radius: 16px;
    background: linear-gradient(165deg, var(--sb-surface) 0%, #141c26 100%);
    box-shadow: 0 24px 48px rgba(0,0,0,.35);
  }
  .sb-banner h1 {
    margin: 0 0 8px;
    font-size: clamp(1.75rem, 4vw, 2.35rem);
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .sb-banner .tag { color: var(--sb-accent); font-size: 0.95rem; letter-spacing: 0.12em; text-transform: uppercase; }
  .sb-banner p { margin: 12px 0 0; color: var(--sb-muted); font-size: 1.05rem; max-width: 36em; margin-left: auto; margin-right: auto; }
  .sb-time-section { margin-top: 2rem; }
  .sb-time-section:first-of-type { margin-top: 1.75rem; }
  .sb-time-heading {
    margin: 0 0 8px;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--sb-accent);
  }
  .sb-time-lead {
    margin: 0 0 14px;
    font-size: 0.95rem;
    color: var(--sb-muted);
    line-height: 1.45;
    max-width: 40em;
  }
  .sb-grid {
    display: grid;
    gap: 16px;
    margin-top: 28px;
  }
  @media (min-width: 640px) { .sb-grid { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); } }
  .sb-card {
    display: block;
    padding: 22px 20px;
    border-radius: 12px;
    border: 1px solid var(--sb-border);
    background: var(--sb-surface);
    text-decoration: none;
    color: inherit;
    transition: border-color .2s, transform .15s;
  }
  .sb-card:hover { border-color: var(--sb-accent); transform: translateY(-2px); }
  .sb-card h2 { margin: 0 0 8px; font-size: 1.15rem; font-weight: 600; color: var(--sb-accent2); }
  .sb-card span { font-size: 0.9rem; color: var(--sb-muted); }
`;

function renderSecondBrainPage(title, innerHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <title>${escHtml(title)}</title>
  <style>${SECOND_BRAIN_CSS}</style>
</head>
<body>
  <div class="sb-wrap">${innerHtml}</div>
</body>
</html>`;
}

function dataAnalyticsSubNavHtml(activePath) {
  const ap = String(activePath || '');
  const overviewActive =
    ap === '/data-analytics/overview' || ap.startsWith('/data-analytics/overview/');
  const learnActive =
    !overviewActive &&
    (ap === '/data-analytics/learning' || ap.startsWith('/data-analytics/learning/'));
  const notesActive =
    !learnActive &&
    !overviewActive &&
    (ap === '/data-analytics' ||
      (ap.startsWith('/data-analytics/') &&
        !ap.startsWith('/data-analytics/learning') &&
        !ap.startsWith('/data-analytics/overview')));
  return (
    '<nav class="da-subnav" aria-label="Data analytics sections">' +
    '<a class="link-pill da-subnav-pill' +
    (notesActive ? ' is-active' : '') +
    '" href="/data-analytics">Notes &amp; log</a>' +
    '<a class="link-pill da-subnav-pill' +
    (learnActive ? ' is-active' : '') +
    '" href="/data-analytics/learning">Learning track</a>' +
    '<a class="link-pill da-subnav-pill' +
    (overviewActive ? ' is-active' : '') +
    '" href="/data-analytics/overview">Overview</a>' +
    '</nav>'
  );
}

function medicalPhysicsSubNavHtml(activePath) {
  const ap = String(activePath || '');
  const overviewActive =
    ap === '/studying-medical-physics/career-overview' ||
    ap.startsWith('/studying-medical-physics/career-overview/');
  const boardActive =
    !overviewActive &&
    (ap === '/studying-medical-physics' ||
      (ap.startsWith('/studying-medical-physics/') &&
        !ap.startsWith('/studying-medical-physics/career-overview')));
  return (
    '<nav class="da-subnav" aria-label="Studying medical physics sections">' +
    '<a class="link-pill da-subnav-pill' +
    (boardActive ? ' is-active' : '') +
    '" href="/studying-medical-physics">Study board</a>' +
    '<a class="link-pill da-subnav-pill' +
    (overviewActive ? ' is-active' : '') +
    '" href="/studying-medical-physics/career-overview">Career overview</a>' +
    '</nav>'
  );
}

function thirdBrainWorkspaceSidebar(activePath) {
  const ap = String(activePath || '');
  const nav = (href, label) => {
    const isActive = ap === href || ap.startsWith(href + '/');
    return (
      '<a href="' +
      escAttr(href) +
      '" class="analytics-nav-item' +
      (isActive ? ' active' : '') +
      '"><span class="analytics-nav-txt">' +
      escHtml(label) +
      '</span></a>'
    );
  };
  return (
    '<aside class="side analytics-side">' +
    '<div class="analytics-nav-brand">' +
    '<div class="analytics-nav-logo" aria-hidden="true">T</div>' +
    '<div class="analytics-nav-brand-text">' +
    '<span class="analytics-nav-title">Third brain</span>' +
    '<span class="analytics-nav-sub">' +
    escHtml('Money workspace') +
    '</span>' +
    '</div></div>' +
    '<nav class="analytics-nav-links" aria-label="Third brain">' +
    nav('/', 'Home') +
    nav('/dashboard', 'Dashboard') +
    '<div class="analytics-nav-section">Money</div>' +
    nav('/monthly-expenses', 'Monthly expenses') +
    nav('/income', 'Income') +
    nav('/cashflow', 'Cashflow') +
    nav('/saving', 'Saving') +
    nav('/tickets', 'Tickets') +
    nav('/debt-tracker', 'Debt tracker') +
    nav('/marriage-cost', 'Marriage cost') +
    nav('/projected-date', 'Projected date') +
    '</nav></aside>'
  );
}

function renderSecondBrainWorkspace(title, activePath, canvasInnerHtml) {
  return renderAdminHtml(
    title,
    '<main class="layout admin-analytics-shell">' +
      thirdBrainWorkspaceSidebar(activePath) +
      '<div class="admin-canvas">' +
      canvasInnerHtml +
      '</div></main>',
    { bodyClass: 'admin-route admin-analytics-workspace' }
  );
}

const SECOND_BRAIN_KIND_LABELS = {
  read: 'Something I read',
  learned: 'Something I learned',
  lesson: 'Lesson',
  insight: 'Insight',
  comment: 'My comment / reflection',
  application: 'Where I applied it'
};

const SECOND_BRAIN_REFLECTION_STYLES = `<style>
  .sb-reflection-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    list-style: none;
    padding: 0;
    margin: 16px 0 0;
  }
  details.sb-log-entry {
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    background: #fafafa;
    overflow: hidden;
  }
  details.sb-log-entry[open] > summary {
    border-bottom: 1px solid #e5e7eb;
    background: #fff;
  }
  details.sb-log-entry > summary {
    list-style: none;
    cursor: pointer;
    position: relative;
    padding: 12px 2.25rem 12px 16px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    user-select: none;
  }
  details.sb-log-entry > summary::-webkit-details-marker { display: none; }
  details.sb-log-entry > summary::after {
    content: '';
    position: absolute;
    right: 14px;
    top: 50%;
    margin-top: -5px;
    width: 0.5rem;
    height: 0.5rem;
    border-right: 2px solid #64748b;
    border-bottom: 2px solid #64748b;
    transform: rotate(45deg);
    transition: transform 0.15s ease;
  }
  details.sb-log-entry:not([open]) > summary::after {
    transform: rotate(-45deg);
  }
  .sb-log-entry-summary-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    font-size: 0.85rem;
    color: #64748b;
    align-items: baseline;
  }
  .sb-log-entry-inner {
    padding: 14px 16px 16px;
    background: #fafafa;
  }
  .sb-reflection-meta { display: flex; flex-wrap: wrap; gap: 8px 14px; font-size: 0.85rem; color: #64748b; margin-bottom: 6px; }
  .sb-reflection-kind { font-weight: 600; color: #334155; }
  .sb-reflection-title { font-weight: 600; margin-bottom: 6px; color: #0f172a; font-size: 0.95rem; }
  .sb-reflection-body { white-space: pre-wrap; line-height: 1.45; color: #1e293b; font-size: 0.95rem; }
  .sb-reflection-form textarea { min-height: 120px; resize: vertical; font-family: inherit; }
  .sb-reflections-heading { font-size: 1.1rem; margin: 20px 0 10px; color: #0f172a; }
  .sb-kind-filters .chip-link.sb-chip-active { font-weight: 700; border-color: #c9a24a; color: #1e293b; }
  details.sb-collapsible {
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    background: #fff;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  }
  details.sb-collapsible + details.sb-collapsible { margin-top: 16px; }
  details.sb-collapsible > summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px 14px;
    padding: 14px 16px;
    font-weight: 600;
    font-size: 1.05rem;
    color: #0f172a;
    user-select: none;
  }
  details.sb-collapsible > summary::-webkit-details-marker { display: none; }
  details.sb-collapsible > summary::after {
    content: '';
    width: 0.55rem;
    height: 0.55rem;
    border-right: 2px solid #64748b;
    border-bottom: 2px solid #64748b;
    transform: rotate(45deg);
    transition: transform 0.18s ease;
    flex-shrink: 0;
  }
  details.sb-collapsible:not([open]) > summary::after { transform: rotate(-45deg); }
  details.sb-collapsible .sb-collapsible-body { padding: 0 16px 16px; }
  .sb-collapsible-title { flex: 1; min-width: 0; }
  .sb-collapsible-hint { font-weight: 400; font-size: 0.82rem; color: #64748b; }
  .sb-collapsible-meta { font-weight: 500; font-size: 0.82rem; color: #64748b; white-space: nowrap; }
  .sb-reflection-actions {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #e5e7eb;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  a.sb-reflection-edit {
    font: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid #cbd5e1;
    background: #f8fafc;
    color: #1e40af;
    text-decoration: none;
    cursor: pointer;
  }
  a.sb-reflection-edit:hover {
    background: #eff6ff;
    border-color: #93c5fd;
  }
  button.sb-reflection-delete {
    font: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid #fecaca;
    background: #fef2f2;
    color: #b91c1c;
    cursor: pointer;
  }
  button.sb-reflection-delete:hover {
    background: #fee2e2;
  }
</style>`;

async function listSecondBrainReflections(topicSlug, kindFilter) {
  if (!isMongoConnected()) return [];
  const q = { topic: topicSlug };
  const k = String(kindFilter || '').trim();
  if (k && Object.prototype.hasOwnProperty.call(SECOND_BRAIN_KIND_LABELS, k)) {
    q.kind = k;
  }
  return SecondBrainReflection.find(q).sort({ createdAt: -1 }).limit(200).lean();
}

function renderSecondBrainReflectionRows(rows, kindFilter, topicSlug) {
  if (!rows.length) {
    const msg = kindFilter
      ? 'No entries for this type yet—try another filter or add a new note.'
      : 'Nothing logged yet—use Add note to capture your first thought.';
    return '<p class="analytics-muted">' + escHtml(msg) + '</p>';
  }
  return (
    '<div class="sb-reflection-list" role="list">' +
    rows
      .map((r) => {
        const id = String(r && r._id ? r._id : '');
        const label = SECOND_BRAIN_KIND_LABELS[r.kind] || r.kind;
        const when = r.createdAt ? new Date(r.createdAt).toLocaleString() : '';
        const title = String(r.title || '').trim();
        const body = escHtml(String(r.body || ''));
        const deleteAction = '/' + topicSlug + '/entry/' + encodeURIComponent(id) + '/delete';
        const editHref =
          '/' + topicSlug + '/entry/' + encodeURIComponent(id) + '/edit' +
          (kindFilter ? '?returnKind=' + encodeURIComponent(kindFilter) : '');
        const titleLine = title
          ? '<span class="sb-reflection-title" style="margin:0;font-size:0.92rem">' + escHtml(title) + '</span>'
          : '';
        return (
          '<details class="sb-log-entry" open role="listitem">' +
          '<summary>' +
          '<div class="sb-log-entry-summary-row">' +
          '<span class="sb-reflection-kind">' +
          escHtml(label) +
          '</span>' +
          '<span>' +
          escHtml(when) +
          '</span></div>' +
          titleLine +
          '</summary>' +
          '<div class="sb-log-entry-inner">' +
          '<div class="sb-reflection-body">' +
          body +
          '</div>' +
          '<div class="sb-reflection-actions">' +
          '<a class="sb-reflection-edit" href="' +
          escAttr(editHref) +
          '">Edit</a>' +
          '<form method="post" action="' +
          escAttr(deleteAction) +
          '" onsubmit="return confirm(&quot;Delete this entry? This cannot be undone.&quot;);">' +
          '<input type="hidden" name="returnKind" value="' +
          escAttr(String(kindFilter || '')) +
          '" />' +
          '<button type="submit" class="sb-reflection-delete">Delete</button>' +
          '</form></div></div></details>'
        );
      })
      .join('') +
    '</div>'
  );
}

function thirdBrainReflectionFlashHtml(flash) {
  if (flash === 'saved') {
    return '<p class="analytics-muted" style="color:#166534;margin:0 0 12px">Saved.</p>';
  }
  if (flash === 'empty') {
    return '<p class="analytics-muted" style="color:#b45309;margin:0 0 12px">Pick a type and write something in Notes before saving.</p>';
  }
  if (flash === 'db') {
    return '<p class="analytics-muted" style="color:#b91c1c;margin:0 0 12px">Could not save—check MongoDB connection.</p>';
  }
  return '';
}

function thirdBrainReviewFlashBanner(flash) {
  if (flash === 'deleted') {
    return '<p class="analytics-muted" style="color:#166534;margin:0 0 14px">Entry deleted.</p>';
  }
  if (flash === 'updated') {
    return '<p class="analytics-muted" style="color:#166534;margin:0 0 14px">Entry updated.</p>';
  }
  if (flash === 'gone') {
    return '<p class="analytics-muted" style="color:#b45309;margin:0 0 14px">That entry was not found (it may have been deleted already).</p>';
  }
  if (flash === 'badid') {
    return '<p class="analytics-muted" style="color:#b91c1c;margin:0 0 14px">Invalid entry id.</p>';
  }
  if (flash === 'db') {
    return '<p class="analytics-muted" style="color:#b91c1c;margin:0 0 14px">Something went wrong with the database—try again or check your connection.</p>';
  }
  return '';
}

function thirdBrainReviewRedirect(topicSlug, returnKind, flashKey) {
  const params = new URLSearchParams();
  if (returnKind && Object.prototype.hasOwnProperty.call(SECOND_BRAIN_KIND_LABELS, returnKind)) {
    params.set('kind', returnKind);
  }
  if (flashKey) params.set('flash', flashKey);
  const qs = params.toString();
  const base = topicSlug === 'career' ? '/career/log' : '/' + topicSlug;
  return qs ? base + '?' + qs : base;
}

function buildSecondBrainReflectionForm(topicSlug, flash, postPath, values, submitLabel, hiddenFields) {
  const v = values || {};
  const sk = String(v.kind || '').trim();
  const st = String(v.title != null ? v.title : '');
  const sb = String(v.body != null ? v.body : '');
  const h = hiddenFields || {};
  const hiddenHtml = Object.keys(h)
    .map((key) => '<input type="hidden" name="' + escAttr(key) + '" value="' + escAttr(String(h[key] ?? '')) + '" />')
    .join('');
  const options = Object.entries(SECOND_BRAIN_KIND_LABELS)
    .map(([k, lab]) => {
      const sel = sk === k ? ' selected' : '';
      return '<option value="' + escAttr(k) + '"' + sel + '>' + escHtml(lab) + '</option>';
    })
    .join('');
  const submitText = submitLabel || 'Save entry';
  return (
    thirdBrainReflectionFlashHtml(flash) +
    '<form class="sb-reflection-form analytics-filter-form" method="post" action="' +
    escAttr(postPath) +
    '">' +
    hiddenHtml +
    '<div class="analytics-filter-grid">' +
    '<label><span>Type</span><select name="kind" required>' +
    options +
    '</select></label>' +
    '<label style="grid-column:1/-1"><span>Short label (optional)</span><input type="text" name="title" maxlength="200" value="' +
    escAttr(st) +
    '" placeholder="e.g. Article title, book chapter" /></label>' +
    '<label style="grid-column:1/-1"><span>Notes</span><textarea name="body" rows="6" required placeholder="What you read, what you learned, an insight, or how you will apply it…">' +
    escHtml(sb) +
    '</textarea></label>' +
    '</div>' +
    '<button type="submit" class="btn-search">' +
    escHtml(submitText) +
    '</button>' +
    '</form>'
  );
}

async function handleSecondBrainEntryDelete(topicSlug, req, res) {
  if (!SECOND_BRAIN_TOPIC_SLUGS.includes(topicSlug)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const id = String((req.params && req.params.id) || '').trim();
  const returnKind = String((req.body && req.body.returnKind) || '').trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.redirect(302, thirdBrainReviewRedirect(topicSlug, returnKind, 'badid'));
  }
  try {
    if (!isMongoConnected()) throw new Error('db down');
    const result = await SecondBrainReflection.deleteOne({ _id: id, topic: topicSlug });
    if (!result.deletedCount) {
      return res.redirect(302, thirdBrainReviewRedirect(topicSlug, returnKind, 'gone'));
    }
    return res.redirect(302, thirdBrainReviewRedirect(topicSlug, returnKind, 'deleted'));
  } catch (err) {
    console.error('SecondBrainReflection delete:', err && err.message ? err.message : err);
    return res.redirect(302, thirdBrainReviewRedirect(topicSlug, returnKind, 'db'));
  }
}

async function handleSecondBrainReflectionPost(topicSlug, req, res) {
  if (!SECOND_BRAIN_TOPIC_SLUGS.includes(topicSlug)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const kind = String((req.body && req.body.kind) || '').trim();
  const title = String((req.body && req.body.title) || '').trim().slice(0, 200);
  const body = String((req.body && req.body.body) || '').trim();
  const allowedKinds = new Set(Object.keys(SECOND_BRAIN_KIND_LABELS));
  if (!allowedKinds.has(kind) || !body) {
    return res.redirect(302, `/${topicSlug}/new?flash=empty`);
  }
  try {
    if (!isMongoConnected()) throw new Error('db down');
    await SecondBrainReflection.create({ topic: topicSlug, kind, title, body });
    return res.redirect(302, `/${topicSlug}/new?flash=saved`);
  } catch (err) {
    console.error('SecondBrainReflection create:', err && err.message ? err.message : err);
    return res.redirect(302, `/${topicSlug}/new?flash=db`);
  }
}

function thirdBrainKindFilterHtml(topicSlug, currentKind, basePathOverride) {
  const base =
    basePathOverride && String(basePathOverride).trim() ? String(basePathOverride).trim() : '/' + topicSlug;
  const chip = (label, kindParam) => {
    const href = kindParam ? `${base}?kind=${encodeURIComponent(kindParam)}` : base;
    const active = kindParam ? currentKind === kindParam : !currentKind;
    const cls = 'chip-link' + (active ? ' sb-chip-active' : '');
    return '<a class="' + cls + '" href="' + escAttr(href) + '">' + escHtml(label) + '</a>';
  };
  const kindChips = Object.entries(SECOND_BRAIN_KIND_LABELS)
    .map(([k, lab]) => chip(lab, k))
    .join('');
  return (
    '<div class="analytics-quick-filters sb-kind-filters" style="margin-top:12px;flex-wrap:wrap">' +
    '<span class="hint">Type</span>' +
    chip('All', '') +
    kindChips +
    '</div>'
  );
}

async function sendSecondBrainTopicReviewPage(req, res, topicSlug, cfg) {
  const kindParam = String((req.query && req.query.kind) || '').trim();
  const kindFilter =
    kindParam && Object.prototype.hasOwnProperty.call(SECOND_BRAIN_KIND_LABELS, kindParam) ? kindParam : '';
  let rows = [];
  try {
    rows = await listSecondBrainReflections(topicSlug, kindFilter);
  } catch (err) {
    console.error('listSecondBrainReflections:', err && err.message ? err.message : err);
  }
  const listHtml = renderSecondBrainReflectionRows(rows, kindFilter, topicSlug);
  const filterBase =
    cfg.reviewFilterBasePath && String(cfg.reviewFilterBasePath).trim()
      ? String(cfg.reviewFilterBasePath).trim()
      : '/' + topicSlug;
  const filterHtml = thirdBrainKindFilterHtml(topicSlug, kindFilter, filterBase);
  const topicPath =
    cfg.sidebarActivePath && String(cfg.sidebarActivePath).trim()
      ? String(cfg.sidebarActivePath).trim()
      : '/' + topicSlug;
  const reviewFlash = String((req.query && req.query.flash) || '').trim();
  const flashBanner = thirdBrainReviewFlashBanner(reviewFlash);
  const logMeta =
    kindFilter && SECOND_BRAIN_KIND_LABELS[kindFilter]
      ? SECOND_BRAIN_KIND_LABELS[kindFilter] + ' · ' + rows.length + ' shown'
      : rows.length + (rows.length === 1 ? ' entry' : ' entries');
  const boardPill =
    cfg.boardHref && String(cfg.boardHref).trim()
      ? '<a class="link-pill" href="' +
        escAttr(String(cfg.boardHref).trim()) +
        '">' +
        escHtml(cfg.boardLabel && String(cfg.boardLabel).trim() ? String(cfg.boardLabel).trim() : 'Board') +
        '</a>'
      : '';
  const dataAnalyticsSubNav =
    topicSlug === 'data-analytics' ? dataAnalyticsSubNavHtml(topicPath) : '';
  const canvas =
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>' +
    escHtml(cfg.displayTitle) +
    '</h1>' +
    '<p class="sub">' +
    escHtml(cfg.sub) +
    '</p>' +
    dataAnalyticsSubNav +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    boardPill +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="' +
    escAttr('/' + topicSlug + '/new') +
    '">Add note</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel" style="padding:0;border:none;background:transparent;box-shadow:none">' +
    SECOND_BRAIN_REFLECTION_STYLES +
    flashBanner +
    '<details class="sb-collapsible" open>' +
    '<summary><span class="sb-collapsible-title">' +
    escHtml('Guides & type filters') +
    '</span><span class="sb-collapsible-hint">' +
    escHtml('Click to minimize') +
    '</span></summary>' +
    '<div class="sb-collapsible-body">' +
    '<p class="analytics-muted" style="margin-top:0">' +
    escHtml(cfg.reviewIntro) +
    '</p>' +
    filterHtml +
    '</div></details>' +
    '<details class="sb-collapsible" open style="margin-top:16px">' +
    '<summary><span class="sb-collapsible-title">' +
    escHtml('Your log') +
    '</span><span class="sb-collapsible-meta">' +
    escHtml(logMeta) +
    '</span><span class="sb-collapsible-hint" style="flex-basis:100%;margin-top:2px">' +
    escHtml('Each entry is its own card—expanded by default; click the bar to collapse.') +
    '</span></summary>' +
    '<div class="sb-collapsible-body">' +
    listHtml +
    '</div></details>' +
    '</div></div>';
  res.type('html').send(renderSecondBrainWorkspace(cfg.htmlTitle, topicPath, canvas));
}

async function sendSecondBrainTopicComposePage(req, res, topicSlug, cfg) {
  const flash = String((req.query && req.query.flash) || '').trim();
  const postPath = '/' + topicSlug + '/new';
  const formHtml = buildSecondBrainReflectionForm(topicSlug, flash, postPath);
  const activePath = postPath;
  const reviewPath =
    cfg.reviewLogPath && String(cfg.reviewLogPath).trim()
      ? String(cfg.reviewLogPath).trim()
      : '/' + topicSlug;
  const canvas =
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>' +
    escHtml(cfg.composeHeading) +
    '</h1>' +
    '<p class="sub">' +
    escHtml('Collapse the panel below anytime—the title bar stays visible.') +
    '</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="' +
    escAttr(reviewPath) +
    '">Review log</a>' +
    '<a class="link-pill" href="/">Home</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel" style="padding:0;border:none;background:transparent;box-shadow:none">' +
    SECOND_BRAIN_REFLECTION_STYLES +
    '<details class="sb-collapsible" open>' +
    '<summary><span class="sb-collapsible-title">' +
    escHtml('Write & save') +
    '</span><span class="sb-collapsible-hint">' +
    escHtml('Click to minimize') +
    '</span></summary>' +
    '<div class="sb-collapsible-body">' +
    '<p class="analytics-muted" style="margin-top:0">' +
    escHtml(cfg.composeSub) +
    '</p>' +
    formHtml +
    '</div></details>' +
    '</div></div>';
  res.type('html').send(renderSecondBrainWorkspace(cfg.composeHtmlTitle, activePath, canvas));
}

function thirdBrainEntryEditUrl(topicSlug, id, returnKind, flash) {
  const p = new URLSearchParams();
  if (returnKind && Object.prototype.hasOwnProperty.call(SECOND_BRAIN_KIND_LABELS, returnKind)) {
    p.set('returnKind', returnKind);
  }
  if (flash) p.set('flash', flash);
  const qs = p.toString();
  return '/' + topicSlug + '/entry/' + encodeURIComponent(id) + '/edit' + (qs ? '?' + qs : '');
}

async function sendSecondBrainEntryEditPage(req, res, topicSlug, cfg) {
  if (!SECOND_BRAIN_TOPIC_SLUGS.includes(topicSlug)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const id = String((req.params && req.params.id) || '').trim();
  const returnKind = String((req.query && req.query.returnKind) || '').trim();
  const flash = String((req.query && req.query.flash) || '').trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.redirect(302, thirdBrainReviewRedirect(topicSlug, returnKind, 'badid'));
  }
  try {
    if (!isMongoConnected()) throw new Error('db down');
    const doc = await SecondBrainReflection.findOne({ _id: id, topic: topicSlug }).lean();
    if (!doc) {
      return res.redirect(302, thirdBrainReviewRedirect(topicSlug, returnKind, 'gone'));
    }
    const entryPath = '/' + topicSlug + '/entry/' + encodeURIComponent(id) + '/edit';
    const rk =
      returnKind && Object.prototype.hasOwnProperty.call(SECOND_BRAIN_KIND_LABELS, returnKind)
        ? returnKind
        : '';
    const formHtml = buildSecondBrainReflectionForm(
      topicSlug,
      flash,
      entryPath,
      { kind: doc.kind, title: doc.title || '', body: doc.body || '' },
      'Save changes',
      { returnKind: rk }
    );
    const canvas =
      '<div class="analytics-toolbar">' +
      '<div>' +
      '<h1>' +
      escHtml('Edit entry') +
      '</h1>' +
      '<p class="sub">' +
      escHtml('Change type, label, or notes—updates appear on your review log.') +
      '</p>' +
      '</div>' +
      '<div class="analytics-toolbar-actions">' +
      '<a class="link-pill" href="' +
      escAttr('/' + topicSlug) +
      '">Review log</a>' +
      '<a class="link-pill" href="/">Home</a>' +
      '</div></div>' +
      '<div class="analytics-body">' +
      '<div class="analytics-panel" style="padding:0;border:none;background:transparent;box-shadow:none">' +
      SECOND_BRAIN_REFLECTION_STYLES +
      '<details class="sb-collapsible" open>' +
      '<summary><span class="sb-collapsible-title">' +
      escHtml('Entry editor') +
      '</span><span class="sb-collapsible-hint">' +
      escHtml('Click to minimize') +
      '</span></summary>' +
      '<div class="sb-collapsible-body">' +
      formHtml +
      '</div></details>' +
      '</div></div>';
    const htmlTitle = 'Edit entry — ' + cfg.editTopicLabel + ' — Third brain';
    res.type('html').send(renderSecondBrainWorkspace(htmlTitle, entryPath, canvas));
  } catch (err) {
    console.error('sendSecondBrainEntryEditPage:', err && err.message ? err.message : err);
    return res.redirect(302, thirdBrainReviewRedirect(topicSlug, returnKind, 'db'));
  }
}

async function handleSecondBrainEntryEditPost(topicSlug, req, res) {
  if (!SECOND_BRAIN_TOPIC_SLUGS.includes(topicSlug)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const id = String((req.params && req.params.id) || '').trim();
  const returnKind = String((req.body && req.body.returnKind) || '').trim();
  const kind = String((req.body && req.body.kind) || '').trim();
  const title = String((req.body && req.body.title) || '').trim().slice(0, 200);
  const body = String((req.body && req.body.body) || '').trim();
  const allowedKinds = new Set(Object.keys(SECOND_BRAIN_KIND_LABELS));
  if (!mongoose.Types.ObjectId.isValid(id) || !allowedKinds.has(kind) || !body) {
    return res.redirect(302, thirdBrainEntryEditUrl(topicSlug, id, returnKind, 'empty'));
  }
  try {
    if (!isMongoConnected()) throw new Error('db down');
    const result = await SecondBrainReflection.updateOne(
      { _id: id, topic: topicSlug },
      { $set: { kind, title, body } }
    );
    if (!result.matchedCount) {
      return res.redirect(302, thirdBrainReviewRedirect(topicSlug, returnKind, 'gone'));
    }
    return res.redirect(302, thirdBrainReviewRedirect(topicSlug, returnKind, 'updated'));
  } catch (err) {
    console.error('SecondBrainReflection update:', err && err.message ? err.message : err);
    return res.redirect(302, thirdBrainReviewRedirect(topicSlug, returnKind, 'db'));
  }
}

const MONTHLY_EXPENSES_STORAGE_KEY = 'thirdBrainMonthlyExpensesV1';

const MONTHLY_EXPENSES_DEFAULT_ROWS = [
  ['Rent (1-bedroom apartment)', 2200],
  ['Utilities (hydro/heat/water)', 150],
  ['Internet', 80],
  ['Phone bill', 70],
  ['Groceries', 500],
  ['Transportation (TTC)', 156],
  ['Tenant insurance', 35],
  ['Eating out / coffee', 250],
  ['Gym / subscriptions', 60],
  ['Health / personal care', 100],
  ['Clothing', 100],
  ['Entertainment / social', 200],
  ['Miscellaneous', 150],
  ['Emergency savings contribution', 300]
];

/** Preset labels for one-click rows (amount defaults to 0; you fill in the cost). */
const MONTHLY_EXPENSE_QUICK_LABELS = [
  'Car payment / lease',
  'Car insurance',
  'Gas / fuel',
  'Parking / tolls',
  'Vehicle maintenance',
  'Pet',
  'Childcare',
  'Other (rename me)'
];

function monthlyExpensesDefaultTotalCad() {
  let s = 0;
  for (let i = 0; i < MONTHLY_EXPENSES_DEFAULT_ROWS.length; i += 1) {
    s += Number(MONTHLY_EXPENSES_DEFAULT_ROWS[i][1]) || 0;
  }
  return s;
}

function buildMonthlyExpensesDefaultRowsHtml() {
  let html = '';
  for (let i = 0; i < MONTHLY_EXPENSES_DEFAULT_ROWS.length; i += 1) {
    const label = MONTHLY_EXPENSES_DEFAULT_ROWS[i][0];
    const amt = MONTHLY_EXPENSES_DEFAULT_ROWS[i][1];
    html +=
      '<tr>' +
      '<td><input class="monthly-exp-label" type="text" autocomplete="off" value="' +
      escAttr(label) +
      '"/></td>' +
      '<td><input class="monthly-exp-amount" type="number" min="0" step="0.01" inputmode="decimal" value="' +
      escAttr(String(amt)) +
      '"/></td>' +
      '<td><button type="button" class="monthly-exp-remove">Remove</button></td>' +
      '</tr>';
  }
  return html;
}

function buildMonthlyExpenseQuickAddHtml() {
  let h =
    '<div class="monthly-exp-quick" id="monthly-exp-quick">' +
    '<span class="monthly-exp-quick-label">Quick add a row (car, pets, etc.)</span>' +
    '<div class="monthly-exp-quick-btns" role="group" aria-label="Quick add expense rows">';
  for (let i = 0; i < MONTHLY_EXPENSE_QUICK_LABELS.length; i += 1) {
    const lab = MONTHLY_EXPENSE_QUICK_LABELS[i];
    h +=
      '<button type="button" class="monthly-exp-preset" data-label="' +
      escAttr(lab) +
      '">' +
      escHtml(lab) +
      '</button>';
  }
  h += '</div></div>';
  return h;
}

function buildMonthlyExpensesWorkspaceHtml() {
  const initialTotal = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(
    monthlyExpensesDefaultTotalCad()
  );
  const tbodyHtml = buildMonthlyExpensesDefaultRowsHtml();
  const expStyles =
    '<style>' +
    '.monthly-exp-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.monthly-exp-total-card{border:1px solid #c9a24a55;border-radius:12px;padding:16px 20px;margin-bottom:20px;background:linear-gradient(135deg,#fffbeb,#fff);}' +
    '.monthly-exp-total-card .monthly-exp-total-label{font-size:13px;font-weight:600;color:#92400e;margin:0 0 6px;letter-spacing:0.02em;text-transform:uppercase;}' +
    '.monthly-exp-total-card #monthly-exp-total{font-size:1.85rem;font-weight:800;color:#0f172a;margin:0;letter-spacing:-0.02em;}' +
    '.monthly-exp-table-wrap{overflow:auto;border:1px solid #e5e7eb;border-radius:10px;}' +
    '.monthly-exp-table{width:100%;border-collapse:collapse;min-width:520px;font-size:14px;}' +
    '.monthly-exp-table th{text-align:left;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#334155;font-weight:700;}' +
    '.monthly-exp-table th:nth-child(2){text-align:right;width:9rem;}' +
    '.monthly-exp-table th:nth-child(3){width:5.5rem;text-align:center;}' +
    '.monthly-exp-table td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle;}' +
    '.monthly-exp-table td:nth-child(2){text-align:right;}' +
    '.monthly-exp-table td:nth-child(3){text-align:center;}' +
    '.monthly-exp-table tr:last-child td{border-bottom:none;}' +
    '.monthly-exp-label,.monthly-exp-amount{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;}' +
    '.monthly-exp-amount{text-align:right;max-width:11rem;margin-left:auto;display:block;}' +
    '.monthly-exp-remove{border:1px solid #e5e7eb;background:#fff;color:#64748b;border-radius:6px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;}' +
    '.monthly-exp-remove:hover{background:#f8fafc;color:#0f172a;border-color:#cbd5e1;}' +
    '.monthly-exp-actions{margin-top:16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;}' +
    '.monthly-exp-hint{margin:0 0 16px;font-size:13px;color:#64748b;line-height:1.45;}' +
    '.monthly-exp-quick{margin:0 0 16px;padding:14px 16px;border:1px dashed #cbd5e1;border-radius:10px;background:#f8fafc;}' +
    '.monthly-exp-quick-label{display:block;font-size:13px;font-weight:700;color:#334155;margin:0 0 10px;}' +
    '.monthly-exp-quick-btns{display:flex;flex-wrap:wrap;gap:8px;}' +
    '.monthly-exp-preset{border:1px solid #e2e8f0;background:#fff;color:#0f172a;border-radius:999px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font:inherit;}' +
    '.monthly-exp-preset:hover{border-color:#1d4ed8;color:#1d4ed8;background:#eff6ff;}' +
    '.monthly-exp-actions button{border:1px solid #e5e7eb;background:#fff;color:#111827;border-radius:6px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;font:inherit;}' +
    '.monthly-exp-actions button:hover{background:#f9fafb;border-color:#d1d5db;}' +
    '#monthly-exp-add{border-color:#1d4ed8;background:#1d4ed8;color:#fff;}' +
    '#monthly-exp-add:hover{background:#1e40af;border-color:#1e40af;color:#fff;}' +
    '.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}' +
    '</style>';
  const script =
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var SK=' +
    JSON.stringify(MONTHLY_EXPENSES_STORAGE_KEY) +
    ';' +
    'var tb=document.getElementById("monthly-exp-tbody");' +
    'var totalEl=document.getElementById("monthly-exp-total");' +
    'if(!tb||!totalEl)return;' +
    'function fmt(n){return new Intl.NumberFormat("en-CA",{style:"currency",currency:"CAD"}).format(n);}' +
    'function parseNum(v){var x=parseFloat(String(v).replace(/,/g,""));return isFinite(x)?x:0;}' +
    'function recalc(){var sum=0;var inputs=tb.querySelectorAll(".monthly-exp-amount");for(var i=0;i<inputs.length;i++){sum+=parseNum(inputs[i].value);}totalEl.textContent=fmt(sum);}' +
    'function rowsFromDom(){var out=[];var trs=tb.querySelectorAll("tr");for(var j=0;j<trs.length;j++){var tr=trs[j];var lab=tr.querySelector(".monthly-exp-label");var amt=tr.querySelector(".monthly-exp-amount");if(lab&&amt)out.push({label:String(lab.value||""),amount:String(amt.value||"")});}return out;}' +
    'function save(){wsPut(SK,rowsFromDom());}' +
    'function loadRows(rows){if(!rows||!rows.length)return;tb.innerHTML="";for(var k=0;k<rows.length;k++){tb.appendChild(makeRow(rows[k].label,rows[k].amount));}}' +
    'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");}' +
    'function makeRow(label,amount){var tr=document.createElement("tr");tr.innerHTML="<td><input class=\\"monthly-exp-label\\" type=\\"text\\" autocomplete=\\"off\\" value=\\""+esc(label)+"\\"/></td><td><input class=\\"monthly-exp-amount\\" type=\\"number\\" min=\\"0\\" step=\\"0.01\\" inputmode=\\"decimal\\" value=\\""+esc(amount)+"\\"/></td><td><button type=\\"button\\" class=\\"monthly-exp-remove\\">Remove</button></td>";return tr;}' +
    'function addPresetRow(lab){tb.appendChild(makeRow(lab||"","0"));var inputs=tb.querySelectorAll(".monthly-exp-amount");if(inputs.length){var last=inputs[inputs.length-1];try{last.focus();last.select();}catch(e){}}onInput();}' +
    'function onInput(){recalc();save();}' +
    'tb.addEventListener("input",function(ev){var t=ev.target;if(t&&(t.classList.contains("monthly-exp-amount")||t.classList.contains("monthly-exp-label")))onInput();});' +
    'tb.addEventListener("change",function(ev){var t=ev.target;if(t&&(t.classList.contains("monthly-exp-amount")||t.classList.contains("monthly-exp-label")))onInput();});' +
    'tb.addEventListener("click",function(ev){var t=ev.target;if(t&&t.classList&&t.classList.contains("monthly-exp-remove")){var tr=t.closest&&t.closest("tr");if(tr&&tr.parentNode===tb){tr.remove();onInput();}}});' +
    'document.getElementById("monthly-exp-add").addEventListener("click",function(){addPresetRow("");});' +
    'var qk=document.getElementById("monthly-exp-quick");' +
    'if(qk)qk.addEventListener("click",function(ev){var b=ev.target.closest&&ev.target.closest(".monthly-exp-preset");if(!b)return;var lab=b.getAttribute("data-label");addPresetRow(lab==null?"":lab);});' +
    'document.getElementById("monthly-exp-reset").addEventListener("click",function(){if(!confirm("Reset to default rows and amounts? This clears saved data in the database."))return;wsPut(SK,[]);location.reload();});' +
    'wsGet(SK,function(err,rows){loadRows(rows);recalc();save();});' +
    '})();<' +
    '/script>';
  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Monthly expenses</h1>' +
    '<p class="sub">All figures are monthly, in Canadian dollars. The total updates as you type.</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/income">Income</a>' +
    '<a class="link-pill" href="/cashflow">Cashflow</a>' +
    '<a class="link-pill" href="/current-situation">Current situation</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel monthly-exp-panel">' +
    expStyles +
    '<p class="monthly-exp-hint">Your table is saved in MongoDB. Use quick-add or <strong>Add blank row</strong> for car, pets, or anything else; then enter the monthly amount. Reset defaults restores the starter list.</p>' +
    '<div class="monthly-exp-total-card">' +
    '<p class="monthly-exp-total-label">Monthly total (CAD)</p>' +
    '<p id="monthly-exp-total">' +
    escHtml(initialTotal) +
    '</p>' +
    '</div>' +
    buildMonthlyExpenseQuickAddHtml() +
    '<div class="monthly-exp-table-wrap">' +
    '<table class="monthly-exp-table" aria-describedby="monthly-exp-caption">' +
    '<caption id="monthly-exp-caption" style="caption-side:top;text-align:left;padding:0 0 10px;font-weight:600;color:#0f172a">Expense line items</caption>' +
    '<thead><tr><th scope="col">Expense</th><th scope="col">Monthly cost (CAD)</th><th scope="col"><span class="visually-hidden">Remove</span></th></tr></thead>' +
    '<tbody id="monthly-exp-tbody">' +
    tbodyHtml +
    '</tbody></table></div>' +
    '<div class="monthly-exp-actions">' +
    '<button type="button" id="monthly-exp-add">Add blank row</button>' +
    '<button type="button" id="monthly-exp-reset">Reset defaults</button>' +
    '</div>' +
    script +
    '</div></div>'
  );
}

const INCOME_STORAGE_KEY = 'thirdBrainIncomeV1';
const CASHFLOW_COMMENT_STORAGE_KEY = 'thirdBrainCashflowCommentV1';
const CASHFLOW_KPI_STORAGE_KEY = 'thirdBrainCashflowKpiV1';
const SAVING_STORAGE_KEY = 'thirdBrainSavingV1';
const TICKETS_STORAGE_KEY = 'thirdBrainTicketsV1';
const DEBT_TRACKER_STORAGE_KEY = 'thirdBrainDebtTrackerV1';
const MARRIAGE_COST_STORAGE_KEY = 'thirdBrainMarriageCostV1';
const PROJECTED_DATE_STORAGE_KEY = 'thirdBrainProjectedDatesV1';
const CAREER_PATHS_STORAGE_KEY = 'thirdBrainCareerPathsV1';
const DAILY_TASKS_STORAGE_KEY = 'thirdBrainDailyTasksV4';
const DAILY_TASKS_COMPLETED_STORAGE_KEY = 'thirdBrainDailyTasksCompletedV1';
const PRIORITY_STORAGE_KEY = 'thirdBrainPriorityV1';
const DAILY_TASKS_PERSONAL_STORAGE_KEY = 'thirdBrainDailyTasksPersonalV1';
const DAILY_TASKS_PERSONAL_COMPLETED_STORAGE_KEY = 'thirdBrainDailyTasksPersonalCompletedV1';
const WORK_PLANNING_TASKS_STORAGE_KEY = 'thirdBrainWorkPlanningTasksV1';
const WORK_PLANNING_TASKS_COMPLETED_STORAGE_KEY = 'thirdBrainWorkPlanningTasksCompletedV1';
const MEDICAL_PHYSICS_STORAGE_KEY = 'thirdBrainStudyingMedicalPhysicsV1';
const MEDICAL_PHYSICS_COMPLETED_STORAGE_KEY = 'thirdBrainStudyingMedicalPhysicsCompletedV1';
const TODOLIST_STORAGE_KEY = 'thirdBrainTodolistV1';

const BOARD_WORKSPACE_STORE_KEYS = new Set([
  MONTHLY_EXPENSES_STORAGE_KEY,
  INCOME_STORAGE_KEY,
  CASHFLOW_COMMENT_STORAGE_KEY,
  CASHFLOW_KPI_STORAGE_KEY,
  SAVING_STORAGE_KEY,
  TICKETS_STORAGE_KEY,
  DEBT_TRACKER_STORAGE_KEY,
  MARRIAGE_COST_STORAGE_KEY,
  PROJECTED_DATE_STORAGE_KEY
]);

const ThirdBrainBoardStoreSchema = new mongoose.Schema(
  {
    boardKey: { type: String, required: true, unique: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
  },
  { timestamps: true }
);

const ThirdBrainBoardStore =
  mongoose.models.ThirdBrainBoardStore ||
  mongoose.model('ThirdBrainBoardStore', ThirdBrainBoardStoreSchema);

async function getBoardWorkspacePayload(boardKey) {
  if (!isMongoConnected()) throw new Error('db down');
  const doc = await ThirdBrainBoardStore.findOne({ boardKey }).lean();
  return doc && doc.payload != null ? doc.payload : null;
}

async function setBoardWorkspacePayload(boardKey, payload) {
  if (!isMongoConnected()) throw new Error('db down');
  const existed = await ThirdBrainBoardStore.findOne({ boardKey }).select('_id').lean();
  await ThirdBrainBoardStore.findOneAndUpdate(
    { boardKey },
    { $set: { payload } },
    { upsert: true, new: true }
  );
  console.log(
    `[board-store] ${existed ? 'updated' : 'inserted'} boardKey=${boardKey} (${typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? Object.keys(payload).length + ' keys' : Array.isArray(payload) ? payload.length + ' items' : typeof payload})`
  );
}

function buildBoardStorePersistenceJs() {
  return (
    WORKSPACE_STORE_API_JS +
    'var _boardPersistActiveTimer=null;var _boardPersistDoneTimer=null;var _activeStoreCache=null;var _doneStoreCache=null;' +
    'function boardStoreReadLocal(key){return wsReadLocalOnce(key);}' +
    'function boardStorePut(key,payload){if(key===DONE_KEY)_doneStoreCache=payload;else _activeStoreCache=payload;wsPut(key,payload);}' +
    'function boardStoreFetch(key,cb){wsGet(key,cb);}' +
    'function boardStoreLoadKey(key,cb){boardStoreFetch(key,function(err,data){if(!data){data=boardStoreReadLocal(key);if(data)boardStorePut(key,data);}if(key===DONE_KEY)_doneStoreCache=data;else _activeStoreCache=data;cb(data);});}'
  );
}
const TODOLIST_STATUSES = [
  ['not_started', 'Not started'],
  ['in_progress', 'In progress'],
  ['done', 'Done'],
  ['skipped', 'Skipped']
];

function normalizeTodolistDay(day) {
  if (!day || typeof day !== 'object') {
    return { tasks: [], notes: '', notesOpen: false, overviewCollapsed: false };
  }
  const tasks = Array.isArray(day.tasks) ? day.tasks : [];
  return {
    tasks: tasks.map((t) => {
      if (!t || typeof t !== 'object') return t;
      if (typeof t.notes !== 'string') t.notes = '';
      if (typeof t.notesOpen !== 'boolean') t.notesOpen = false;
      return t;
    }),
    notes: typeof day.notes === 'string' ? day.notes : '',
    notesOpen: !!day.notesOpen,
    overviewCollapsed: !!day.overviewCollapsed
  };
}

function normalizeTodolistStore(payload) {
  if (!payload || typeof payload !== 'object') {
    return { version: 2, days: {} };
  }
  if (payload.version === 2 && payload.days && typeof payload.days === 'object' && !Array.isArray(payload.days)) {
    const days = {};
    for (const [date, day] of Object.entries(payload.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) days[date] = normalizeTodolistDay(day);
    }
    return { version: 2, days };
  }
  if (payload.date) {
    const date = String(payload.date).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return {
        version: 2,
        days: { [date]: normalizeTodolistDay(payload) }
      };
    }
  }
  return { version: 2, days: {} };
}

function getTodolistDayFromStore(payload, dateStr) {
  const store = normalizeTodolistStore(payload);
  const day = store.days[dateStr];
  if (!day) return null;
  return { date: dateStr, ...day };
}

function summarizeTodolistDay(day) {
  const tasks = Array.isArray(day && day.tasks) ? day.tasks : [];
  let doneCount = 0;
  let inProgressCount = 0;
  let skippedCount = 0;
  for (const t of tasks) {
    const st = String((t && t.status) || 'not_started');
    if (st === 'done') doneCount += 1;
    else if (st === 'in_progress') inProgressCount += 1;
    else if (st === 'skipped') skippedCount += 1;
  }
  return {
    taskCount: tasks.length,
    doneCount,
    inProgressCount,
    skippedCount,
    hasNotes: !!(day && day.notes && String(day.notes).trim())
  };
}

function buildTodolistCalendarMonth(payload, year, month) {
  const store = normalizeTodolistStore(payload);
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  const result = {};
  for (const [date, day] of Object.entries(store.days)) {
    if (!date.startsWith(prefix)) continue;
    result[date] = summarizeTodolistDay(day);
  }
  return result;
}

const PERSONAL_BOARD_CATEGORIES = [
  ['gym', 'Gym'],
  ['hair', 'Hair routine'],
  ['clothes', 'Clothes'],
  ['food', 'Food'],
  ['teeth', 'Teeth'],
  ['skin', 'Skin'],
  ['accessories', 'Accessories I wear'],
  ['home', 'Home'],
  ['dating', 'Dating']
];
const WORK_PLANNING_CATEGORIES = [
  ['current_job', 'Current job'],
  ['step2', 'Step 2'],
  ['step3', 'Step 3'],
  ['step4', 'Step 4'],
  ['business', 'Business'],
  ['millionaire', 'Millionaire'],
  ['independence', 'Independence']
];
const MEDICAL_PHYSICS_CATEGORIES = [
  ['courses_before_master', 'Courses before master'],
  ['master_program_list', 'Master program list'],
  ['master_program_requirement', 'Master program requirement']
];

const PERSONAL_STATUS_TAB_LABELS = {
  active: 'Waiting',
  next: 'Boarding',
  done: 'Departed',
  flagged: 'Flagged',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  filterAria: 'Station filter',
  filterTitle: {
    active: 'Incomplete tasks',
    next: 'Next tasks',
    done: 'Complete tasks',
    flagged: 'Flagged tasks',
    daily: 'Daily repeat',
    weekly: 'Weekly repeat',
    monthly: 'Once a month'
  },
  stackNextAria: 'Boarding tasks by date',
  emptyNext: 'No boarding tasks — tap the status button until a task shows Boarding.',
  totalNext: 'Boarding total (CAD):'
};

const WORK_PLANNING_STATUS_TAB_LABELS = {
  active: 'Backlog',
  next: 'In progress',
  done: 'Done',
  flagged: 'Priority',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  filterAria: 'Status filter',
  filterTitle: {
    active: 'Backlog tasks',
    next: 'In-progress tasks',
    done: 'Completed tasks',
    flagged: 'Priority tasks',
    daily: 'Daily repeat',
    weekly: 'Weekly repeat',
    monthly: 'Once a month'
  },
  stackNextAria: 'In-progress tasks by date',
  emptyNext: 'No in-progress tasks — tap the status button until a task shows In progress.',
  totalNext: 'In progress total (CAD):'
};

/** Shared styles for Priority note panel. */
const SECOND_BRAIN_NOTE_PANEL_STYLES =
  '<style>' +
  '.pr-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
  '.pr-hint{margin:0 0 16px;font-size:14px;color:#475569;line-height:1.55;max-width:52em;}' +
  '.pr-label{display:block;font-size:13px;font-weight:700;color:#334155;margin:0 0 8px;}' +
  '.pr-field{width:100%;max-width:100%;min-height:220px;box-sizing:border-box;padding:14px 16px;border:1px solid #e2e8f0;border-radius:10px;font:inherit;font-size:15px;line-height:1.5;color:#0f172a;background:#fff;resize:vertical;}' +
  '.pr-field:focus{outline:none;border-color:#1d4ed8;box-shadow:0 0 0 3px rgba(29,78,216,0.15);}' +
  '.pr-note{margin:10px 0 0;font-size:12px;color:#64748b;}' +
  '</style>';

function buildIncomeFrequencyOptionsHtml(selected) {
  const opts = [
    ['monthly', 'Monthly'],
    ['biweekly', 'Biweekly (26 pays / year)'],
    ['weekly', 'Weekly'],
    ['annual', 'Annual (÷12)']
  ];
  let h = '';
  const sel = String(selected || 'monthly').trim();
  for (let i = 0; i < opts.length; i += 1) {
    const v = opts[i][0];
    const isSel = v === sel ? ' selected' : '';
    h += '<option value="' + escAttr(v) + '"' + isSel + '>' + escHtml(opts[i][1]) + '</option>';
  }
  return h;
}

function buildIncomeLineRowHtml(label, amount, frequency) {
  return (
    '<tr>' +
    '<td><input class="inc-line-label" type="text" autocomplete="off" placeholder="Optional label" value="' +
    escAttr(label) +
    '"/></td>' +
    '<td><input class="inc-line-amount" type="number" min="0" step="0.01" inputmode="decimal" value="' +
    escAttr(String(amount)) +
    '"/></td>' +
    '<td><select class="inc-line-frequency" aria-label="Pay frequency">' +
    buildIncomeFrequencyOptionsHtml(frequency) +
    '</select></td>' +
    '<td class="inc-line-mo-wrap"><span class="inc-line-mo">—</span></td>' +
    '<td><button type="button" class="inc-line-remove">Remove line</button></td>' +
    '</tr>'
  );
}

function buildIncomeSourceBlockHtml(name, lines, open) {
  const linesArr = Array.isArray(lines) && lines.length ? lines : [{ label: '', amount: '0', frequency: 'monthly' }];
  let linesHtml = '';
  for (let i = 0; i < linesArr.length; i += 1) {
    const L = linesArr[i];
    linesHtml += buildIncomeLineRowHtml(
      L.label != null ? String(L.label) : '',
      L.amount != null ? String(L.amount) : '0',
      L.frequency || 'monthly'
    );
  }
  const openAttr = open ? ' open' : '';
  const title = name && String(name).trim() ? String(name).trim() : 'Income source';
  return (
    '<details class="income-src"' +
    openAttr +
    '>' +
    '<summary class="income-src-sum">' +
    '<span class="income-src-sum-title">' +
    escHtml(title) +
    '</span>' +
    '<span class="income-src-sum-sub">≈ ' +
    escHtml('$0.00') +
    ' /mo</span>' +
    '</summary>' +
    '<div class="income-src-body">' +
    '<label class="income-src-name-label">Source name' +
    '<input class="income-src-name" type="text" autocomplete="organization" value="' +
    escAttr(name != null ? String(name) : '') +
    '"/></label>' +
    '<div class="income-lines-wrap">' +
    '<table class="income-lines-table">' +
    '<thead><tr><th scope="col">Pay / stream</th><th scope="col">Amount (CAD)</th><th scope="col">How often</th><th scope="col">≈ Monthly</th><th scope="col"><span class="visually-hidden">Remove</span></th></tr></thead>' +
    '<tbody class="income-lines-tbody">' +
    linesHtml +
    '</tbody></table></div>' +
    '<div class="income-src-actions">' +
    '<button type="button" class="income-add-line">Add pay line</button>' +
    '<button type="button" class="income-remove-src">Remove source</button>' +
    '</div></div></details>'
  );
}

function buildIncomeDefaultSourcesHtml() {
  return buildIncomeSourceBlockHtml(
    'Primary income',
    [{ label: '', amount: '0', frequency: 'monthly' }],
    true
  );
}

function buildIncomeWorkspaceHtml() {
  const initialZero = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(0);
  const sourcesHtml = buildIncomeDefaultSourcesHtml();
  const incomeStyles =
    '<style>' +
    '.income-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.income-total-card{border:1px solid #15803d55;border-radius:12px;padding:16px 20px;margin-bottom:20px;background:linear-gradient(135deg,#ecfdf5,#fff);}' +
    '.income-total-card .income-total-label{font-size:13px;font-weight:600;color:#166534;margin:0 0 6px;letter-spacing:0.02em;text-transform:uppercase;}' +
    '.income-total-card #income-total-gr{font-size:1.85rem;font-weight:800;color:#0f172a;margin:0;letter-spacing:-0.02em;}' +
    '.income-hint{margin:0 0 16px;font-size:13px;color:#64748b;line-height:1.45;}' +
    '#income-sources-root{display:flex;flex-direction:column;gap:0;}' +
    'details.income-src{border:1px solid #e5e7eb;border-radius:12px;background:#fff;margin-bottom:12px;overflow:hidden;}' +
    'details.income-src > summary.income-src-sum{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 16px;background:#f8fafc;font-weight:600;color:#0f172a;font-size:14px;user-select:none;}' +
    'details.income-src > summary.income-src-sum::-webkit-details-marker{display:none;}' +
    '.income-src-sum-title{min-width:0;word-break:break-word;}' +
    '.income-src-sum-sub{font-size:13px;font-weight:700;color:#15803d;white-space:nowrap;}' +
    '.income-src-body{padding:16px;border-top:1px solid #e5e7eb;}' +
    '.income-src-name-label{display:block;font-size:13px;font-weight:600;color:#334155;margin-bottom:14px;}' +
    '.income-src-name{display:block;width:100%;max-width:440px;margin-top:6px;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;}' +
    '.income-lines-wrap{overflow:auto;border:1px solid #e5e7eb;border-radius:10px;}' +
    '.income-lines-table{width:100%;border-collapse:collapse;min-width:560px;font-size:14px;}' +
    '.income-lines-table th{text-align:left;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#334155;font-weight:700;}' +
    '.income-lines-table th:nth-child(2),.income-lines-table td:nth-child(2){text-align:right;width:9rem;}' +
    '.income-lines-table th:nth-child(4),.income-lines-table td:nth-child(4){text-align:right;font-variant-numeric:tabular-nums;}' +
    '.income-lines-table td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle;}' +
    '.income-lines-table tr:last-child td{border-bottom:none;}' +
    '.inc-line-label,.inc-line-amount{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;}' +
    '.inc-line-amount{text-align:right;max-width:11rem;margin-left:auto;display:block;}' +
    '.inc-line-frequency{width:100%;max-width:15rem;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;background:#fff;}' +
    '.inc-line-remove,.income-src-actions button{border:1px solid #e5e7eb;background:#fff;color:#64748b;border-radius:6px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;font:inherit;}' +
    '.inc-line-remove:hover,.income-src-actions button:hover{background:#f8fafc;color:#0f172a;border-color:#cbd5e1;}' +
    '.income-src-actions{margin-top:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;}' +
    '.income-global-actions{margin-top:16px;display:flex;flex-wrap:wrap;gap:10px;}' +
    '.income-global-actions button{border:1px solid #e5e7eb;background:#fff;color:#111827;border-radius:6px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;font:inherit;}' +
    '.income-global-actions button:hover{background:#f9fafb;border-color:#d1d5db;}' +
    '#income-add-source{border-color:#15803d;background:#15803d;color:#fff;}' +
    '#income-add-source:hover{background:#166534;border-color:#166534;color:#fff;}' +
    '.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}' +
    '</style>';
  const incomeScript =
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var SK=' +
    JSON.stringify(INCOME_STORAGE_KEY) +
    ';' +
    'var root=document.getElementById("income-sources-root");' +
    'var totalEl=document.getElementById("income-total-gr");' +
    'if(!root||!totalEl)return;' +
    'function fmt(n){return new Intl.NumberFormat("en-CA",{style:"currency",currency:"CAD"}).format(n);}' +
    'function parseNum(v){var x=parseFloat(String(v).replace(/,/g,""));return isFinite(x)?x:0;}' +
    'function toMo(a,f){var v=parseNum(a);if(f==="biweekly")return v*26/12;if(f==="weekly")return v*52/12;if(f==="annual")return v/12;return v;}' +
    'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");}' +
    'function freqOpts(sel){var o=[["monthly","Monthly"],["biweekly","Biweekly (26 pays / year)"],["weekly","Weekly"],["annual","Annual (÷12)"]];var h="",i;for(i=0;i<o.length;i++){h+="<option value=\\""+o[i][0]+"\\""+(sel===o[i][0]?" selected":"")+">"+o[i][1]+"</option>";}return h;}' +
    'function lineTr(lab,amt,freq){var tr=document.createElement("tr");tr.innerHTML="<td><input class=\\"inc-line-label\\" type=\\"text\\" autocomplete=\\"off\\" placeholder=\\"Optional label\\" value=\\""+esc(lab)+"\\"/></td><td><input class=\\"inc-line-amount\\" type=\\"number\\" min=\\"0\\" step=\\"0.01\\" inputmode=\\"decimal\\" value=\\""+esc(amt)+"\\"/></td><td><select class=\\"inc-line-frequency\\" aria-label=\\"Pay frequency\\">"+freqOpts(freq)+"</select></td><td class=\\"inc-line-mo-wrap\\"><span class=\\"inc-line-mo\\">—</span></td><td><button type=\\"button\\" class=\\"inc-line-remove\\">Remove line</button></td>";return tr;}' +
    'function makeSource(data){var det=document.createElement("details");det.className="income-src";det.open=true;var lines=data&&data.lines&&data.lines.length?data.lines:[{label:"",amount:"0",frequency:"monthly"}];var name=String(data&&data.name!=null?data.name:"");var tbh="";for(var j=0;j<lines.length;j++){var L=lines[j];tbh+=lineTr(L.label||"",String(L.amount!=null?L.amount:"0"),L.frequency||"monthly").outerHTML;}det.innerHTML="<summary class=\\"income-src-sum\\"><span class=\\"income-src-sum-title\\"></span><span class=\\"income-src-sum-sub\\"></span></summary><div class=\\"income-src-body\\"><label class=\\"income-src-name-label\\">Source name<input class=\\"income-src-name\\" type=\\"text\\" autocomplete=\\"organization\\" value=\\""+esc(name)+"\\"/></label><div class=\\"income-lines-wrap\\"><table class=\\"income-lines-table\\"><thead><tr><th scope=\\"col\\">Pay / stream</th><th scope=\\"col\\">Amount (CAD)</th><th scope=\\"col\\">How often</th><th scope=\\"col\\">≈ Monthly</th><th scope=\\"col\\"><span class=\\"visually-hidden\\">Remove</span></th></tr></thead><tbody class=\\"income-lines-tbody\\">"+tbh+"</tbody></table></div><div class=\\"income-src-actions\\"><button type=\\"button\\" class=\\"income-add-line\\">Add pay line</button><button type=\\"button\\" class=\\"income-remove-src\\">Remove source</button></div></div>";return det;}' +
    'function readData(){var out={sources:[]};var blocks=root.querySelectorAll("details.income-src");for(var b=0;b<blocks.length;b++){var det=blocks[b];var nm=det.querySelector(".income-src-name");var name=nm?String(nm.value||""):"";var lines=[];det.querySelectorAll(".income-lines-tbody tr").forEach(function(tr){var lab=tr.querySelector(".inc-line-label");var amt=tr.querySelector(".inc-line-amount");var fr=tr.querySelector(".inc-line-frequency");if(lab&&amt&&fr)lines.push({label:String(lab.value||""),amount:String(amt.value||""),frequency:String(fr.value||"monthly")});});out.sources.push({name:name,lines:lines});}return out;}' +
    'function save(){wsPut(SK,readData());}' +
    'function renderFromData(d){root.innerHTML="";var list=d&&d.sources&&d.sources.length?d.sources:[{name:"Primary income",lines:[{label:"",amount:"0",frequency:"monthly"}]}];for(var i=0;i<list.length;i++){root.appendChild(makeSource(list[i]));}recalc();}' +
    'function subtotalFor(det){var sum=0;det.querySelectorAll(".income-lines-tbody tr").forEach(function(tr){var amt=tr.querySelector(".inc-line-amount");var fr=tr.querySelector(".inc-line-frequency");if(amt&&fr)sum+=toMo(amt.value,fr.value);});return sum;}' +
    'function recalc(){var grand=0;var blocks=root.querySelectorAll("details.income-src");for(var i=0;i<blocks.length;i++){var det=blocks[i];det.querySelectorAll(".income-lines-tbody tr").forEach(function(tr){var amt=tr.querySelector(".inc-line-amount");var fr=tr.querySelector(".inc-line-frequency");var mo=tr.querySelector(".inc-line-mo");if(amt&&fr&&mo)mo.textContent=fmt(toMo(amt.value,fr.value));});var st=subtotalFor(det);grand+=st;var subEl=det.querySelector(".income-src-sum-sub");if(subEl)subEl.textContent="≈ "+fmt(st)+" /mo";var nm=det.querySelector(".income-src-name");var tit=det.querySelector(".income-src-sum-title");if(tit&&nm){var t=String(nm.value||"").trim();tit.textContent=t||"Income source";}}totalEl.textContent=fmt(grand);}' +
    'function onChange(){recalc();save();}' +
    'root.addEventListener("input",function(ev){var t=ev.target;if(t&&(t.classList.contains("income-src-name")||t.classList.contains("inc-line-label")||t.classList.contains("inc-line-amount")))onChange();});' +
    'root.addEventListener("change",function(ev){var t=ev.target;if(t&&(t.classList.contains("inc-line-frequency")||t.classList.contains("inc-line-amount")||t.classList.contains("income-src-name")))onChange();});' +
    'root.addEventListener("click",function(ev){var t=ev.target;var det=t.closest&&t.closest("details.income-src");if(!det)return;if(t.classList.contains("income-add-line")){var tb=det.querySelector(".income-lines-tbody");if(tb){tb.appendChild(lineTr("","0","biweekly"));onChange();}return;}if(t.classList.contains("inc-line-remove")){var tr=t.closest&&t.closest("tr");var tb2=det.querySelector(".income-lines-tbody");if(tr&&tb2&&tr.parentNode===tb2){var n=tb2.querySelectorAll("tr").length;if(n<=1)return;tr.remove();onChange();}return;}if(t.classList.contains("income-remove-src")){var nblk=root.querySelectorAll("details.income-src").length;if(nblk<=1){alert("Keep at least one income source.");return;}det.remove();onChange();}});' +
    'document.getElementById("income-add-source").addEventListener("click",function(){root.appendChild(makeSource({name:"",lines:[{label:"",amount:"0",frequency:"monthly"}]}));var all=root.querySelectorAll("details.income-src");if(all.length){all[all.length-1].open=true;try{var inp=all[all.length-1].querySelector(".income-src-name");if(inp){inp.focus();}}catch(e){}}onChange();});' +
    'document.getElementById("income-reset").addEventListener("click",function(){if(!confirm("Clear saved income in the database and reload the default layout?"))return;wsPut(SK,null);location.reload();});' +
    'wsGet(SK,function(err,d){renderFromData(d);});' +
    '})();<' +
    '/script>';
  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Income</h1>' +
    '<p class="sub">Expand each source to add pay lines (for example two biweekly deposits). Totals convert to a monthly equivalent in CAD.</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/monthly-expenses">Monthly expenses</a>' +
    '<a class="link-pill" href="/cashflow">Cashflow</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel income-panel">' +
    incomeStyles +
    '<p class="income-hint">Saved only in this browser (local storage). <strong>Add pay line</strong> defaults to <strong>biweekly</strong> so you can model two pays per source; change the dropdown per line as needed.</p>' +
    '<div class="income-total-card">' +
    '<p class="income-total-label">Total monthly equivalent (CAD)</p>' +
    '<p id="income-total-gr">' +
    escHtml(initialZero) +
    '</p>' +
    '</div>' +
    '<div id="income-sources-root">' +
    sourcesHtml +
    '</div>' +
    '<div class="income-global-actions">' +
    '<button type="button" id="income-add-source">Add income source</button>' +
    '<button type="button" id="income-reset">Reset to default</button>' +
    '</div>' +
    incomeScript +
    '</div></div>'
  );
}

function buildCashflowWorkspaceHtml() {
  const zeroFmt = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(0);
  const moExpEmptyStoreCad = monthlyExpensesDefaultTotalCad();
  const cfStyles =
    '<style>' +
    '.cf-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.cf-hint{margin:0 0 18px;font-size:13px;color:#64748b;line-height:1.5;max-width:52em;}' +
    '.cf-kpi-grid{display:grid;gap:14px;grid-template-columns:1fr;}@media(min-width:720px){.cf-kpi-grid{grid-template-columns:repeat(3,1fr);}}' +
    '.cf-kpi{border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;background:#f8fafc;}' +
    '.cf-kpi-income{border-color:#bbf7d0;background:linear-gradient(165deg,#ecfdf5,#f8fafc);}' +
    '.cf-kpi-exp{border-color:#fecaca;background:linear-gradient(165deg,#fef2f2,#f8fafc);}' +
    '.cf-kpi-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;margin:0 0 8px;}' +
    '.cf-kpi-val{font-size:1.65rem;font-weight:800;color:#0f172a;margin:0;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;}' +
    '.cf-net-pos{border-color:#86efac;background:linear-gradient(165deg,#ecfdf5,#fff);}' +
    '.cf-net-pos .cf-kpi-val{color:#166534;}' +
    '.cf-net-neg{border-color:#fca5a5;background:linear-gradient(165deg,#fef2f2,#fff);}' +
    '.cf-net-neg .cf-kpi-val{color:#b91c1c;}' +
    '.cf-chart-block{margin-top:22px;padding-top:20px;border-top:1px solid #e5e7eb;}' +
    '.cf-chart-heading{margin:0 0 4px;font-size:15px;font-weight:800;color:#0f172a;letter-spacing:-0.02em;}' +
    '.cf-chart-sub{margin:0 0 16px;font-size:12px;color:#64748b;line-height:1.4;}' +
    '.cf-hbar{display:flex;align-items:center;gap:12px;margin-bottom:12px;}' +
    '.cf-hbar-lab{flex:0 0 6.25rem;font-size:13px;font-weight:600;color:#475569;}' +
    '.cf-hbar-track{flex:1;min-width:0;height:28px;background:#f1f5f9;border-radius:9px;overflow:hidden;border:1px solid #e2e8f0;}' +
    '.cf-hbar-fill{height:100%;width:0%;border-radius:8px;transition:width .3s ease,background-color .2s ease;}' +
    '.cf-hbar-inc{background:linear-gradient(90deg,#15803d,#22c55e);}' +
    '.cf-hbar-exp{background:linear-gradient(90deg,#ea580c,#fb7185);}' +
    '.cf-hbar-netpos{background:linear-gradient(90deg,#166534,#4ade80);}' +
    '.cf-hbar-netneg{background:linear-gradient(90deg,#991b1b,#f87171);}' +
    '.cf-comment-block{margin-top:22px;padding-top:18px;border-top:1px solid #e5e7eb;}' +
    '.cf-comment-label{display:block;font-size:13px;font-weight:700;color:#334155;margin:0 0 8px;}' +
    '.cf-comment-field{width:100%;max-width:100%;min-height:100px;box-sizing:border-box;padding:12px 14px;border:1px solid #e2e8f0;border-radius:10px;font:inherit;font-size:14px;line-height:1.45;color:#0f172a;background:#fff;resize:vertical;}' +
    '.cf-comment-field:focus{outline:none;border-color:#1d4ed8;box-shadow:0 0 0 3px rgba(29,78,216,0.15);}' +
    '.cf-comment-note{margin:8px 0 0;font-size:12px;color:#64748b;}' +
    '.cf-formula{margin:18px 0 0;font-size:13px;color:#475569;line-height:1.45;}' +
    '</style>';
  const cfScript =
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var _cfIncome=null,_cfExpenses=null;' +
    'var SKI=' +
    JSON.stringify(INCOME_STORAGE_KEY) +
    ';' +
    'var SKE=' +
    JSON.stringify(MONTHLY_EXPENSES_STORAGE_KEY) +
    ';' +
    'var SKC=' +
    JSON.stringify(CASHFLOW_COMMENT_STORAGE_KEY) +
    ';' +
    'var SKK=' +
    JSON.stringify(CASHFLOW_KPI_STORAGE_KEY) +
    ';' +
    'var elI=document.getElementById("cf-income");' +
    'var elE=document.getElementById("cf-expenses");' +
    'var elN=document.getElementById("cf-net");' +
    'var elNetCard=document.getElementById("cf-net-card");' +
    'var ta=document.getElementById("cf-comment");' +
    'var commentTimer=null;' +
    'if(!elI||!elE||!elN||!elNetCard)return;' +
    'function loadComment(){if(!ta)return;var d=_cfComment;if(d==null)return;var v=(d&&d.text!=null)?String(d.text):(typeof d==="string"?d:"");ta.value=v;}' +
    'function flushComment(){if(!ta)return;if(commentTimer){clearTimeout(commentTimer);commentTimer=null;}_cfComment={text:ta.value};wsPut(SKC,_cfComment);}' +
    'function scheduleCommentSave(){if(!ta)return;if(commentTimer)clearTimeout(commentTimer);commentTimer=setTimeout(function(){commentTimer=null;flushComment();},400);}' +
    'var _cfComment=null;' +
    'function fmt(n){return new Intl.NumberFormat("en-CA",{style:"currency",currency:"CAD"}).format(n);}' +
    'function parseNum(v){var x=parseFloat(String(v).replace(/,/g,""));return isFinite(x)?x:0;}' +
    'function toMo(a,f){var v=parseNum(a);if(f==="biweekly")return v*26/12;if(f==="weekly")return v*52/12;if(f==="annual")return v/12;return v;}' +
    'function readIncome(){var d=_cfIncome;if(!d||!d.sources||!d.sources.length)return 0;var sum=0;var s,i,src,lines,L;for(s=0;s<d.sources.length;s++){src=d.sources[s];lines=src&&src.lines?src.lines:[];for(i=0;i<lines.length;i++){L=lines[i];sum+=toMo(L&&L.amount,L&&L.frequency||"monthly");}}return sum;}' +
    'function readExpenses(){var rows=_cfExpenses;if(!rows||!Array.isArray(rows))return ' +
    String(moExpEmptyStoreCad) +
    ';var sum=0;var i;for(i=0;i<rows.length;i++){sum+=parseNum(rows[i]&&rows[i].amount);}return sum;}' +
    'function dataSig(){return JSON.stringify(_cfIncome||null)+"\\n"+JSON.stringify(_cfExpenses||null);}' +
    'function persistKpi(inc,exp,net){wsPut(SKK,{income:inc,expenses:exp,net:net,sig:dataSig()});}' +
    'function updateChart(inc,exp,net){var m=Math.max(inc,exp,Math.abs(net),1);function pct(v){v=Math.max(0,v);return Math.min(100,Math.round((v/m)*1000)/10);}var bi=document.getElementById("cf-hbar-inc");var be=document.getElementById("cf-hbar-exp");var bn=document.getElementById("cf-hbar-net");if(bi)bi.style.width=pct(inc)+"%";if(be)be.style.width=pct(exp)+"%";if(bn){bn.style.width=pct(Math.abs(net))+"%";bn.className="cf-hbar-fill "+(net>=0?"cf-hbar-netpos":"cf-hbar-netneg");}}' +
    'function render(){var inc=readIncome();var exp=readExpenses();var net=inc-exp;elI.textContent=fmt(inc);elE.textContent=fmt(exp);elN.textContent=fmt(net);elNetCard.className="cf-kpi cf-net "+(net>=0?"cf-net-pos":"cf-net-neg");updateChart(inc,exp,net);persistKpi(inc,exp,net);}' +
    'function boot(){render();loadComment();}' +
    'var _cfBoot=3;function cfReady(){if(--_cfBoot>0)return;boot();}' +
    'wsGet(SKI,function(e,d){_cfIncome=d;cfReady();});wsGet(SKE,function(e,d){_cfExpenses=d;cfReady();});wsGet(SKC,function(e,d){_cfComment=d;cfReady();});' +
    'if(ta){ta.addEventListener("input",scheduleCommentSave);ta.addEventListener("blur",flushComment);}' +
    'document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"){wsGet(SKI,function(e,d){_cfIncome=d;});wsGet(SKE,function(e,d){_cfExpenses=d;});render();}});' +
    '})();<' +
    '/script>';
  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Cashflow</h1>' +
    '<p class="sub">Monthly income (equivalent) minus monthly expenses from this browser’s saved tables.</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/income">Income</a>' +
    '<a class="link-pill" href="/monthly-expenses">Monthly expenses</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel cf-panel">' +
    cfStyles +
    '<p class="cf-hint">Numbers are read from the same <strong>Income</strong> and <strong>Monthly expenses</strong> data in MongoDB. Income uses the same monthly-equivalent rules as the Income page (biweekly × 26 ÷ 12, etc.). Expenses are summed as entered (each line is a monthly amount). Refresh this page after editing elsewhere. Your <strong>Comment</strong> is also saved in MongoDB.</p>' +
    '<div class="cf-kpi-grid">' +
    '<div class="cf-kpi cf-kpi-income">' +
    '<p class="cf-kpi-label">Monthly income (equiv.)</p>' +
    '<p id="cf-income" class="cf-kpi-val">' +
    escHtml(zeroFmt) +
    '</p></div>' +
    '<div class="cf-kpi cf-kpi-exp">' +
    '<p class="cf-kpi-label">Monthly expenses</p>' +
    '<p id="cf-expenses" class="cf-kpi-val">' +
    escHtml(zeroFmt) +
    '</p></div>' +
    '<div id="cf-net-card" class="cf-kpi cf-net cf-net-pos">' +
    '<p class="cf-kpi-label">Income − expenses</p>' +
    '<p id="cf-net" class="cf-kpi-val">' +
    escHtml(zeroFmt) +
    '</p></div></div>' +
    '<div class="cf-chart-block" role="img" aria-labelledby="cf-chart-heading">' +
    '<h3 id="cf-chart-heading" class="cf-chart-heading">Chart</h3>' +
    '<p class="cf-chart-sub">Horizontal bars use one scale: the largest value among income, expenses, and absolute net (minimum $1 so empty data still draws).</p>' +
    '<div class="cf-hbar"><span class="cf-hbar-lab">Income</span><div class="cf-hbar-track"><div id="cf-hbar-inc" class="cf-hbar-fill cf-hbar-inc" style="width:0%"></div></div></div>' +
    '<div class="cf-hbar"><span class="cf-hbar-lab">Expenses</span><div class="cf-hbar-track"><div id="cf-hbar-exp" class="cf-hbar-fill cf-hbar-exp" style="width:0%"></div></div></div>' +
    '<div class="cf-hbar"><span class="cf-hbar-lab">Net</span><div class="cf-hbar-track"><div id="cf-hbar-net" class="cf-hbar-fill cf-hbar-netpos" style="width:0%"></div></div></div>' +
    '</div>' +
    '<p class="cf-formula"><strong>Net</strong> = total monthly-equivalent income − sum of expense line items. The net bar is green when surplus, red when deficit (length shows |net| on the same scale).</p>' +
    '<div class="cf-comment-block">' +
    '<label for="cf-comment" class="cf-comment-label">Comment</label>' +
    '<textarea id="cf-comment" class="cf-comment-field" maxlength="8000" placeholder="Context, goals, or trade-offs—saved in this browser with your cashflow view."></textarea>' +
    '<p class="cf-comment-note">Saved automatically as you type (local storage).</p>' +
    '</div>' +
    cfScript +
    '</div></div>'
  );
}

function buildSavingDefaultRowsHtml() {
  const rows = [
    ['Emergency fund', 0],
    ['Short-term goal', 0]
  ];
  let html = '';
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    html +=
      '<tr>' +
      '<td><input class="sv-label" type="text" autocomplete="off" value="' +
      escAttr(r[0]) +
      '"/></td>' +
      '<td><input class="sv-balance" type="number" min="0" step="0.01" inputmode="decimal" value="' +
      escAttr(String(r[1])) +
      '"/></td>' +
      '<td><button type="button" class="sv-remove">Remove</button></td>' +
      '</tr>';
  }
  return html;
}

function buildSavingWorkspaceHtml() {
  const zeroFmt = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(0);
  const moExpEmptyStoreCad = monthlyExpensesDefaultTotalCad();
  const tbodyHtml = buildSavingDefaultRowsHtml();
  const svStyles =
    '<style>' +
    '.sv-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.sv-totals{display:grid;gap:12px;grid-template-columns:1fr;}@media(min-width:640px){.sv-totals{grid-template-columns:1fr 1fr;}}' +
    '.sv-total-card{border:1px solid #0ea5e955;border-radius:12px;padding:14px 18px;background:linear-gradient(135deg,#e0f2fe,#fff);}' +
    '.sv-total-card.sv-net-pos{border-color:#86efac;background:linear-gradient(135deg,#ecfdf5,#fff);}' +
    '.sv-total-card.sv-net-pos .sv-total-val{color:#166534;}' +
    '.sv-total-card.sv-net-neg{border-color:#fca5a5;background:linear-gradient(135deg,#fef2f2,#fff);}' +
    '.sv-total-card.sv-net-neg .sv-total-val{color:#b91c1c;}' +
    '.sv-total-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#0369a1;margin:0 0 6px;}' +
    '.sv-total-card.sv-net-pos .sv-total-label,.sv-total-card.sv-net-neg .sv-total-label{color:#64748b;}' +
    '.sv-total-val{font-size:1.5rem;font-weight:800;color:#0f172a;margin:0;font-variant-numeric:tabular-nums;}' +
    '.sv-cf-mirror{margin:10px 0 0;font-size:13px;color:#475569;line-height:1.45;}' +
    '.sv-hint{margin:0 0 16px;font-size:13px;color:#64748b;line-height:1.45;}' +
    '.sv-table-wrap{overflow:auto;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:14px;}' +
    '.sv-table{width:100%;border-collapse:collapse;min-width:560px;font-size:14px;}' +
    '.sv-table th{text-align:left;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#334155;font-weight:700;}' +
    '.sv-table th:nth-child(2){text-align:right;width:11rem;}' +
    '.sv-table td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle;}' +
    '.sv-table td:nth-child(2){text-align:right;}' +
    '.sv-table tr:last-child td{border-bottom:none;}' +
    '.sv-label,.sv-balance{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;}' +
    '.sv-balance{text-align:right;max-width:11rem;margin-left:auto;display:block;}' +
    '.sv-remove{border:1px solid #e5e7eb;background:#fff;color:#64748b;border-radius:6px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;font:inherit;}' +
    '.sv-remove:hover{background:#f8fafc;color:#0f172a;}' +
    '.sv-actions{display:flex;flex-wrap:wrap;gap:10px;}' +
    '.sv-actions button{border:1px solid #e5e7eb;background:#fff;color:#111827;border-radius:6px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;font:inherit;}' +
    '.sv-actions button:hover{background:#f9fafb;}' +
    '#sv-add{border-color:#0284c7;background:#0284c7;color:#fff;}' +
    '#sv-add:hover{background:#0369a1;border-color:#0369a1;color:#fff;}' +
    '.sv-chart-block{margin-top:18px;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px 10px;background:#fafafa;}' +
    '.sv-chart-title{font-size:14px;font-weight:800;margin:0 0 4px;color:#0f172a;}' +
    '.sv-chart-sub{font-size:12px;color:#64748b;margin:0 0 10px;line-height:1.45;max-width:48em;}' +
    '#sv-chart-svg{width:100%;height:auto;display:block;vertical-align:middle;}' +
    '.sv-month-wrap{margin-top:14px;padding-top:14px;border-top:1px solid #e5e7eb;}' +
    '.sv-month-caption{font-size:12px;color:#64748b;margin:0 0 10px;line-height:1.45;}' +
    '.sv-month-table{width:100%;border-collapse:collapse;font-size:14px;}' +
    '.sv-month-table thead th{text-align:left;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#334155;font-weight:700;vertical-align:top;}' +
    '.sv-month-table thead th .sv-th-sub{display:block;font-size:11px;font-weight:600;color:#64748b;text-transform:none;letter-spacing:0;margin-top:4px;line-height:1.35;}' +
    '.sv-month-table .sv-month-amt{text-align:right;font-variant-numeric:tabular-nums;}' +
    '.sv-month-table tbody th,.sv-month-table tbody td{padding:8px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle;}' +
    '.sv-month-table tbody th{font-weight:600;color:#0f172a;text-align:left;width:40%;}' +
    '.sv-month-table .sv-month-proj{color:#0369a1;}' +
    '.sv-month-actual{width:100%;max-width:11rem;margin-left:auto;display:block;box-sizing:border-box;padding:6px 8px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;}' +
    '.sv-month-table tbody tr:last-child th,.sv-month-table tbody tr:last-child td{border-bottom:none;}' +
    '.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}' +
    '</style>';
  const svScript =
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var _svIncome=null,_svExpenses=null,_svKpi=null;' +
    'var SK=' +
    JSON.stringify(SAVING_STORAGE_KEY) +
    ';' +
    'var SKI=' +
    JSON.stringify(INCOME_STORAGE_KEY) +
    ';' +
    'var SKE=' +
    JSON.stringify(MONTHLY_EXPENSES_STORAGE_KEY) +
    ';' +
    'var SKK=' +
    JSON.stringify(CASHFLOW_KPI_STORAGE_KEY) +
    ';' +
    'var tb=document.getElementById("sv-tbody");' +
    'var elS=document.getElementById("sv-total-saved");' +
    'var elNet=document.getElementById("sv-net-val");' +
    'var elNetCard=document.getElementById("sv-net-card");' +
    'var elMirror=document.getElementById("sv-cf-mirror");' +
    'var chartRoot=document.getElementById("sv-chart-root");' +
    'var chartSvg=document.getElementById("sv-chart-svg");' +
    'var monthTb=document.getElementById("sv-month-tbody");' +
    'var savedActuals=null;' +
    'if(!tb||!elS||!elNet||!elNetCard)return;' +
    'function fmt(n){return new Intl.NumberFormat("en-CA",{style:"currency",currency:"CAD"}).format(n);}' +
    'function parseNum(v){var x=parseFloat(String(v).replace(/,/g,""));return isFinite(x)?x:0;}' +
    'function toMo(a,f){var v=parseNum(a);if(f==="biweekly")return v*26/12;if(f==="weekly")return v*52/12;if(f==="annual")return v/12;return v;}' +
    'function readIncome(){var d=_svIncome;if(!d||!d.sources||!d.sources.length)return 0;var sum=0;var s,i,src,lines,L;for(s=0;s<d.sources.length;s++){src=d.sources[s];lines=src&&src.lines?src.lines:[];for(i=0;i<lines.length;i++){L=lines[i];sum+=toMo(L&&L.amount,L&&L.frequency||"monthly");}}return sum;}' +
    'function readExpenses(){var rows=_svExpenses;if(!rows||!Array.isArray(rows))return ' +
    String(moExpEmptyStoreCad) +
    ';var sum=0;var i;for(i=0;i<rows.length;i++){sum+=parseNum(rows[i]&&rows[i].amount);}return sum;}' +
    'function dataSig(){return JSON.stringify(_svIncome||null)+"\\n"+JSON.stringify(_svExpenses||null);}' +
    'function readKpiFromStore(){var o=_svKpi;if(!o||o.sig==null)return null;var inc=parseNum(o.income);var exp=parseNum(o.expenses);var net=parseNum(o.net);if(!isFinite(inc)||!isFinite(exp)||!isFinite(net))return null;return{income:inc,expenses:exp,net:net,sig:String(o.sig)};}' +
    'function computeCashflowKpi(){var inc=readIncome();var exp=readExpenses();return{income:inc,expenses:exp,net:inc-exp};}' +
    'function getCashflowKpi(){var live=computeCashflowKpi();var sig=dataSig();var s=readKpiFromStore();if(s&&s.sig===sig&&Math.abs(s.net-(s.income-s.expenses))<0.05&&Math.abs(s.income-live.income)<0.05&&Math.abs(s.expenses-live.expenses)<0.05)return{income:s.income,expenses:s.expenses,net:s.net};wsPut(SKK,{income:live.income,expenses:live.expenses,net:live.net,sig:sig});return live;}' +
    'function rowsFromDom(){var out=[];var trs=tb.querySelectorAll("tr");for(var j=0;j<trs.length;j++){var tr=trs[j];var a=tr.querySelector(".sv-label");var b=tr.querySelector(".sv-balance");if(a&&b)out.push({label:String(a.value||""),balance:String(b.value||"")});}return out;}' +
    'function readMonthActualsFromDom(){var out=[];if(!monthTb)return out;var i,inp;for(i=0;i<13;i++){inp=monthTb.querySelector("input.sv-month-actual[data-mi=\\""+i+"\\"]");out.push(inp?String(inp.value||""):"");}return out;}' +
    'function readActualSeries(){var out=[];var i,inp;for(i=0;i<13;i++){inp=monthTb?monthTb.querySelector("input.sv-month-actual[data-mi=\\""+i+"\\"]"):null;out.push(inp?Math.max(0,parseNum(inp.value)):0);}return out;}' +
    'function save(){wsPut(SK,{buckets:rowsFromDom(),monthActuals:readMonthActualsFromDom()});}' +
    'function loadFromData(d){if(!d)return;var rows,ma;if(Array.isArray(d)){rows=d;ma=null;}else if(d&&Array.isArray(d.buckets)){rows=d.buckets;ma=d.monthActuals;}else return;if(!rows.length)return;tb.innerHTML="";var k;for(k=0;k<rows.length;k++){var r=rows[k];tb.appendChild(makeRow(r&&r.label!=null?r.label:"",r&&r.balance!=null?r.balance:"0"));}if(ma&&ma.length===13)savedActuals=ma.slice();else savedActuals=null;}' +
    'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");}' +
    'function makeRow(lab,bal){var tr=document.createElement("tr");tr.innerHTML="<td><input class=\\"sv-label\\" type=\\"text\\" autocomplete=\\"off\\" value=\\""+esc(lab)+"\\"/></td><td><input class=\\"sv-balance\\" type=\\"number\\" min=\\"0\\" step=\\"0.01\\" inputmode=\\"decimal\\" value=\\""+esc(bal)+"\\"/></td><td><button type=\\"button\\" class=\\"sv-remove\\">Remove</button></td>";return tr;}' +
    'var now=new Date();' +
    'function monthDate(i){return new Date(now.getFullYear(),now.getMonth()+i,1);}' +
    'function monthLab(i){var d=monthDate(i);return d.toLocaleDateString("en-CA",{month:"short",year:"2-digit"});}' +
    'function monthRowLabel(i){var d=monthDate(i);return d.toLocaleDateString("en-CA",{month:"long",year:"numeric"});}' +
    'function projectedCumulative(sumB,netMo,i){return Math.max(0,sumB+i*netMo);}' +
    'function buildMonthRows(sumB,netMo){if(!monthTb||monthTb.querySelector("tr"))return;var n=13,ri,tr,th,tdP,tdA,inp,pc,iv;for(ri=0;ri<n;ri++){tr=document.createElement("tr");th=document.createElement("th");th.scope="row";th.textContent=monthRowLabel(ri);tdP=document.createElement("td");tdP.className="sv-month-amt sv-month-proj";tdP.setAttribute("data-mi",String(ri));pc=projectedCumulative(sumB,netMo,ri);tdP.textContent=fmt(pc);tdA=document.createElement("td");tdA.className="sv-month-amt";inp=document.createElement("input");inp.type="number";inp.min="0";inp.step="0.01";inp.setAttribute("inputmode","decimal");inp.className="sv-month-actual";inp.setAttribute("data-mi",String(ri));inp.setAttribute("aria-label","Actual cumulative total saved through "+monthRowLabel(ri));iv=(savedActuals&&savedActuals[ri]!=null&&String(savedActuals[ri]).length)?String(savedActuals[ri]):String(pc);inp.value=iv;tdA.appendChild(inp);tr.appendChild(th);tr.appendChild(tdP);tr.appendChild(tdA);monthTb.appendChild(tr);}savedActuals=null;}' +
    'function updateProjectedCells(sumB,netMo){if(!monthTb)return;var i,el,pc;for(i=0;i<13;i++){el=monthTb.querySelector(".sv-month-proj[data-mi=\\""+i+"\\"]");if(el){pc=projectedCumulative(sumB,netMo,i);el.textContent=fmt(pc);}}}' +
    'function drawChart(sumB,netMo,actA){if(!chartSvg)return;var n=13,W=720,H=220,pl=50,pr=14,pt=26,pb=38,pw=W-pl-pr,ph=H-pt-pb;var proj=[];var actV=[];var i;for(i=0;i<n;i++){proj.push(projectedCumulative(sumB,netMo,i));}for(i=0;i<n;i++){actV.push((actA&&actA.length===n)?Math.max(0,parseNum(actA[i])):proj[i]);}var maxV=Math.max.apply(null,proj.concat(actV).concat([1]));function xAt(ii){return pl+pw*ii/(n-1);}function yAt(v){return pt+ph-ph*(v/maxV);}var poly=[];for(i=0;i<n;i++){poly.push(xAt(i)+","+yAt(proj[i]));}var polyA=[];for(i=0;i<n;i++){polyA.push(xAt(i)+","+yAt(actV[i]));}var areaD="M"+xAt(0)+","+(H-pb)+"L"+poly.join(" L")+" L"+xAt(n-1)+","+(H-pb)+"Z";var linePts=poly.join(" ");var lineAct=polyA.join(" ");var parts=[];parts.push("<defs><linearGradient id=\\"sv-gr\\" x1=\\"0\\" y1=\\"0\\" x2=\\"0\\" y2=\\"1\\"><stop offset=\\"0%\\" stop-color=\\"#38bdf8\\" stop-opacity=\\"0.28\\"/><stop offset=\\"100%\\" stop-color=\\"#38bdf8\\" stop-opacity=\\"0.04\\"/></linearGradient></defs>");parts.push("<rect x=\\"0\\" y=\\"0\\" width=\\""+W+"\\" height=\\""+H+"\\" fill=\\"#fff\\" rx=\\"8\\"/>");parts.push("<line x1=\\""+(W-118)+"\\" y1=\\"10\\" x2=\\""+(W-96)+"\\" y2=\\"10\\" stroke=\\"#0284c7\\" stroke-width=\\"3\\"/><text x=\\""+(W-90)+"\\" y=\\"14\\" font-size=\\"11\\" fill=\\"#334155\\">Projected</text>");parts.push("<line x1=\\""+(W-118)+"\\" y1=\\"24\\" x2=\\""+(W-96)+"\\" y2=\\"24\\" stroke=\\"#059669\\" stroke-width=\\"3\\"/><text x=\\""+(W-90)+"\\" y=\\"28\\" font-size=\\"11\\" fill=\\"#334155\\">Actual</text>");parts.push("<path d=\\""+areaD+"\\" fill=\\"url(#sv-gr)\\" stroke=\\"none\\"/>");parts.push("<line x1=\\""+pl+"\\" y1=\\""+(H-pb)+"\\" x2=\\""+(W-pr)+"\\" y2=\\""+(H-pb)+"\\" stroke=\\"#cbd5e1\\" stroke-width=\\"1\\"/>");parts.push("<polyline fill=\\"none\\" stroke=\\"#0284c7\\" stroke-width=\\"2.5\\" stroke-linejoin=\\"round\\" stroke-linecap=\\"round\\" points=\\""+linePts+"\\"/>");parts.push("<polyline fill=\\"none\\" stroke=\\"#059669\\" stroke-width=\\"2.5\\" stroke-linejoin=\\"round\\" stroke-linecap=\\"round\\" points=\\""+lineAct+"\\"/>");for(i=0;i<n;i++){parts.push("<circle cx=\\""+xAt(i)+"\\" cy=\\""+yAt(proj[i])+"\\" r=\\"3\\" fill=\\"#fff\\" stroke=\\"#0284c7\\" stroke-width=\\"2\\"/>");}for(i=0;i<n;i++){parts.push("<circle cx=\\""+xAt(i)+"\\" cy=\\""+yAt(actV[i])+"\\" r=\\"3.5\\" fill=\\"#fff\\" stroke=\\"#059669\\" stroke-width=\\"2\\"/>");}for(var xi=0;xi<n;xi+=2){parts.push("<text x=\\""+xAt(xi)+"\\" y=\\""+(H-12)+"\\" text-anchor=\\"middle\\" font-size=\\"11\\" fill=\\"#64748b\\">"+monthLab(xi).replace(/&/g,"&amp;").replace(/</g,"&lt;")+"</text>");}parts.push("<text x=\\""+(pl-6)+"\\" y=\\""+pt+"\\" text-anchor=\\"end\\" font-size=\\"11\\" fill=\\"#64748b\\">"+fmt(maxV).replace(/&/g,"&amp;")+"</text>");parts.push("<text x=\\""+(pl-6)+"\\" y=\\""+(H-pb)+"\\" text-anchor=\\"end\\" font-size=\\"11\\" fill=\\"#64748b\\">"+fmt(0).replace(/&/g,"&amp;")+"</text>");chartSvg.innerHTML=parts.join("");if(chartRoot){chartRoot.setAttribute("aria-label","Projected and actual cumulative saved through "+monthRowLabel(n-1)+": projected "+fmt(proj[n-1])+", actual "+fmt(actV[n-1])+".");}}' +
    'function recalc(){var sumB=0;tb.querySelectorAll("tr").forEach(function(tr){var b=tr.querySelector(".sv-balance");if(b)sumB+=parseNum(b.value);});var k=getCashflowKpi();var netMo=k.net;elS.textContent=fmt(sumB);elNet.textContent=fmt(netMo);elNetCard.className="sv-total-card "+(netMo>=0?"sv-net-pos":"sv-net-neg");if(elMirror){elMirror.textContent="From Cashflow data: income (equiv.) "+fmt(k.income)+"; monthly expenses "+fmt(k.expenses)+". Net uses the same local snapshot as Cashflow when your Income and Monthly expenses match the last Cashflow save.";}if(!monthTb||!monthTb.querySelector("tr"))buildMonthRows(sumB,netMo);else updateProjectedCells(sumB,netMo);var actR=readActualSeries();drawChart(sumB,netMo,actR);save();}' +
    'function onCh(){recalc();save();}' +
    'tb.addEventListener("input",function(ev){var t=ev.target;if(t&&(t.classList.contains("sv-label")||t.classList.contains("sv-balance")))onCh();});' +
    'tb.addEventListener("change",function(ev){var t=ev.target;if(t&&t.classList.contains("sv-balance"))onCh();});' +
    'tb.addEventListener("click",function(ev){var t=ev.target;if(t&&t.classList.contains("sv-remove")){var tr=t.closest&&t.closest("tr");var p=tr&&tr.parentNode;if(p===tb&&tb.querySelectorAll("tr").length>1){tr.remove();onCh();}}});' +
    'if(monthTb){monthTb.addEventListener("input",function(ev){var t=ev.target;if(t&&t.classList.contains("sv-month-actual")){var sumB2=0;tb.querySelectorAll("tr").forEach(function(tr){var b2=tr.querySelector(".sv-balance");if(b2)sumB2+=parseNum(b2.value);});var nm2=getCashflowKpi().net;drawChart(sumB2,nm2,readActualSeries());save();}});}' +
    'document.getElementById("sv-add").addEventListener("click",function(){tb.appendChild(makeRow("","0"));onCh();});' +
    'document.getElementById("sv-reset").addEventListener("click",function(){if(!confirm("Clear saved buckets and month actuals in the database and reload defaults?"))return;wsPut(SK,null);location.reload();});' +
    'var _svBoot=4;function svReady(){if(--_svBoot>0)return;recalc();}' +
    'wsGet(SKI,function(e,d){_svIncome=d;svReady();});wsGet(SKE,function(e,d){_svExpenses=d;svReady();});wsGet(SKK,function(e,d){_svKpi=d;svReady();});wsGet(SK,function(e,d){loadFromData(d);svReady();});' +
    'document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"){wsGet(SKI,function(e,d){_svIncome=d;});wsGet(SKE,function(e,d){_svExpenses=d;});recalc();}});' +
    '})();<' +
    '/script>';
  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Saving</h1>' +
    '<p class="sub">Bucket balances, Cashflow net, projected vs <strong>actual</strong> totals by month (both on the chart).</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/cashflow">Cashflow</a>' +
    '<a class="link-pill" href="/tickets">Tickets</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel sv-panel">' +
    svStyles +
    '<p class="sv-hint">Enter <strong>Balance</strong> per bucket. Net comes from the same Cashflow snapshot rules as before. The month table shows <strong>Projected</strong> (auto) beside <strong>Actual</strong> (your numbers); both feed the chart.</p>' +
    '<div class="sv-totals">' +
    '<div class="sv-total-card">' +
    '<p class="sv-total-label">Total saved (CAD)</p>' +
    '<p id="sv-total-saved" class="sv-total-val">' +
    escHtml(zeroFmt) +
    '</p></div>' +
    '<div id="sv-net-card" class="sv-total-card sv-net-pos">' +
    '<p class="sv-total-label">Cashflow net (CAD / mo)</p>' +
    '<p id="sv-net-val" class="sv-total-val">' +
    escHtml(zeroFmt) +
    '</p></div></div>' +
    '<p id="sv-cf-mirror" class="sv-cf-mirror"></p>' +
    '<div id="sv-chart-root" class="sv-chart-block" role="region" aria-labelledby="sv-chart-h">' +
    '<h3 id="sv-chart-h" class="sv-chart-title">Saving by month</h3>' +
    '<p class="sv-chart-sub">Blue line: <strong>Projected</strong> cumulative total saved through each month. Green line: <strong>Actual</strong> cumulative totals you enter in the table. No interest; projected series is floored at zero.</p>' +
    '<svg id="sv-chart-svg" viewBox="0 0 720 220" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>' +
    '<div class="sv-month-wrap">' +
    '<p class="sv-month-caption">Each row is one calendar month. <strong>Projected</strong> and <strong>Actual</strong> are both the <strong>total amount saved through that month</strong> (cumulative), not the amount added only that month.</p>' +
    '<div class="sv-table-wrap" style="margin:0;border-radius:10px">' +
    '<table class="sv-month-table" aria-label="Projected and actual saving by month">' +
    '<thead><tr><th scope="col">Month</th><th scope="col">Projected total saved <span class="sv-th-sub">(cumulative total at that month)</span></th><th scope="col">Actual total saved <span class="sv-th-sub">(cumulative total at that month, editable)</span></th></tr></thead>' +
    '<tbody id="sv-month-tbody"></tbody></table></div></div></div>' +
    '<div class="sv-table-wrap">' +
    '<table class="sv-table" aria-label="Saving buckets">' +
    '<thead><tr><th scope="col">Bucket</th><th scope="col">Balance (CAD)</th><th scope="col"><span class="visually-hidden">Remove</span></th></tr></thead>' +
    '<tbody id="sv-tbody">' +
    tbodyHtml +
    '</tbody></table></div>' +
    '<div class="sv-actions">' +
    '<button type="button" id="sv-add">Add bucket</button>' +
    '<button type="button" id="sv-reset">Clear &amp; reload defaults</button>' +
    '</div>' +
    svScript +
    '</div></div>'
  );
}

function buildCareerWorkspaceHtml() {
  const crStyles =
    '<style>' +
    '.cr-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.cr-hint{margin:0 0 16px;font-size:13px;color:#475569;line-height:1.55;max-width:56em}' +
    '.cr-root{display:flex;flex-direction:column;gap:12px}' +
    '.cr-path{border:1px solid #dbeafe;border-radius:10px;background:linear-gradient(135deg,#f8fafc 0%,#fff 45%);border-left:4px solid #0a66c2;overflow:hidden}' +
    '.cr-path-sum{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 12px;cursor:pointer;padding:12px 14px;background:#fff;border-bottom:1px solid #e5e7eb;list-style:none}' +
    '.cr-path-sum::-webkit-details-marker{display:none}' +
    '.cr-path-sum-title{font-weight:800;font-size:1rem;color:#0f172a;letter-spacing:-0.02em}' +
    '.cr-path-sum-hint{font-size:12px;color:#64748b;font-weight:500}' +
    '.cr-path-body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:14px}' +
    '.cr-field label{display:block;font-size:12px;font-weight:700;color:#334155;margin:0 0 6px}' +
    '.cr-field input,.cr-field textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;font-size:14px}' +
    '.cr-field textarea{min-height:72px;resize:vertical;line-height:1.45}' +
    '.cr-dates{display:grid;gap:12px;grid-template-columns:1fr}@media(min-width:640px){.cr-dates{grid-template-columns:repeat(3,1fr)}}' +
    '.cr-path-actions{margin-top:4px}' +
    '.cr-remove{border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:8px;padding:8px 12px;font-weight:600;font-size:13px;cursor:pointer;font:inherit}' +
    '.cr-remove:hover{background:#fef2f2}' +
    '.cr-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}' +
    '.cr-actions button{border:1px solid #e5e7eb;background:#fff;color:#111827;border-radius:8px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;font:inherit}' +
    '.cr-actions button:hover{background:#f9fafb}' +
    '#cr-add{border-color:#0a66c2;background:#0a66c2;color:#fff}' +
    '#cr-add:hover{background:#004182;border-color:#004182;color:#fff}' +
    '.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}' +
    '</style>';
  const crScript =
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var SK=' +
    JSON.stringify(CAREER_PATHS_STORAGE_KEY) +
    ';' +
    'var root=document.getElementById("cr-root");' +
    'if(!root)return;' +
    'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");}' +
    'function nextId(){return "p"+String(Date.now())+String(Math.random()).slice(2,9);}' +
    'function readPathsFromDom(){var out=[];root.querySelectorAll("details.cr-path").forEach(function(det){var id=det.getAttribute("data-path-id");var t=det.querySelector(".cr-title");var sd=det.querySelector(".cr-start");var td=det.querySelector(".cr-target");var ci=det.querySelector(".cr-checkin");var jb=det.querySelector(".cr-job");var rq=det.querySelector(".cr-req");var nw=det.querySelector(".cr-net");if(!id||!t)return;out.push({id:id,title:String(t.value||""),startDate:sd?String(sd.value||""):"",targetDate:td?String(td.value||""):"",checkInTime:ci?String(ci.value||""):"",targetJob:jb?String(jb.value||""):"",requirements:rq?String(rq.value||""):"",networking:nw?String(nw.value||""):""});});return out;}' +
    'function save(){wsPut(SK,{paths:readPathsFromDom()});}' +
    'function makePath(d){var id=String(d&&d.id||nextId());var A=function(x){return String(x==null?"":x);};var tit=A(d&&d.title);var sd=A(d&&d.startDate);var td=A(d&&d.targetDate);var ci=A(d&&d.checkInTime);var jb=A(d&&d.targetJob);var rq=A(d&&d.requirements);var nw=A(d&&d.networking);var det=document.createElement("details");det.className="cr-path";det.open=true;det.setAttribute("data-path-id",id);det.innerHTML="<summary class=\\"cr-path-sum\\"><span class=\\"cr-path-sum-title\\">"+esc(tit||"New career path")+"</span><span class=\\"cr-path-sum-hint\\">Start and target dates, check-in time, job, requirements, networking</span></summary><div class=\\"cr-path-body\\"><div class=\\"cr-field\\"><label>Path name</label><input class=\\"cr-title\\" type=\\"text\\" autocomplete=\\"off\\" placeholder=\\"e.g. Imaging leadership in Canada\\" value=\\""+esc(tit)+"\\"/></div><div class=\\"cr-dates\\"><div class=\\"cr-field\\"><label>Start date</label><input class=\\"cr-start\\" type=\\"date\\" value=\\""+esc(sd)+"\\"/></div><div class=\\"cr-field\\"><label>Target date</label><input class=\\"cr-target\\" type=\\"date\\" value=\\""+esc(td)+"\\"/></div><div class=\\"cr-field\\"><label>Check-in time</label><input class=\\"cr-checkin\\" type=\\"time\\" value=\\""+esc(ci)+"\\"/></div></div><div class=\\"cr-field\\"><label>Target role / job</label><input class=\\"cr-job\\" type=\\"text\\" autocomplete=\\"off\\" placeholder=\\"Role, level, or organization\\" value=\\""+esc(jb)+"\\"/></div><div class=\\"cr-field\\"><label>Requirements</label><textarea class=\\"cr-req\\" rows=\\"3\\" maxlength=\\"8000\\" placeholder=\\"Licenses, exams, gaps to close…\\">"+esc(rq)+"</textarea></div><div class=\\"cr-field\\"><label>Networking</label><textarea class=\\"cr-net\\" rows=\\"3\\" maxlength=\\"8000\\" placeholder=\\"Contacts, communities, LinkedIn, events…\\">"+esc(nw)+"</textarea></div><div class=\\"cr-path-actions\\"><button type=\\"button\\" class=\\"cr-remove\\">Remove this path</button></div></div>";return det;}' +
    'function loadPaths(data){if(!data||!Array.isArray(data.paths))return;data.paths.forEach(function(p){root.appendChild(makePath(p));});}' +
    'function ensureDefaults(){if(root.querySelector("details.cr-path"))return;root.appendChild(makePath({title:"Primary path"}));root.appendChild(makePath({title:"Alternate path"}));}' +
    'root.addEventListener("input",function(ev){var t=ev.target;if(!t)return;if(t.classList.contains("cr-title")){var det=t.closest&&t.closest("details.cr-path");if(det){var sp=det.querySelector(".cr-path-sum-title");if(sp)sp.textContent=t.value.trim()||"Untitled path";}}if(t.classList.contains("cr-title")||t.classList.contains("cr-start")||t.classList.contains("cr-target")||t.classList.contains("cr-checkin")||t.classList.contains("cr-job")||t.classList.contains("cr-req")||t.classList.contains("cr-net"))save();});' +
    'root.addEventListener("change",function(ev){var t=ev.target;if(t&&(t.classList.contains("cr-start")||t.classList.contains("cr-target")||t.classList.contains("cr-checkin")))save();});' +
    'root.addEventListener("click",function(ev){var t=ev.target;if(t&&t.classList.contains("cr-remove")){var det=t.closest&&t.closest("details.cr-path");if(det&&root.querySelectorAll("details.cr-path").length>1){det.remove();save();}}});' +
    'document.getElementById("cr-add").addEventListener("click",function(){root.appendChild(makePath({}));save();});' +
    'document.getElementById("cr-reset").addEventListener("click",function(){if(!confirm("Remove all career paths saved in the database?"))return;wsPut(SK,null);location.reload();});' +
    'wsGet(SK,function(err,data){loadPaths(data);if(!root.querySelector("details.cr-path")){ensureDefaults();save();}});' +
    '})();<' +
    '/script>';
  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Career paths</h1>' +
    '<p class="sub">Compare multiple directions—each path has dates, a weekly check-in time, target role, requirements, and networking notes (saved in this browser).</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/career/log">Review log</a>' +
    '<a class="link-pill" href="/career/new">Add note</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel cr-panel">' +
    crStyles +
    '<p class="cr-hint">Inspired by a <strong>LinkedIn-style timeline</strong>: use <strong>Start</strong> and <strong>Target</strong> dates to anchor each option, set a <strong>check-in time</strong> for a recurring reminder habit, and keep <strong>requirements</strong>, <strong>job</strong> targets, and <strong>networking</strong> in one place per path. Add as many paths as you want to compare.</p>' +
    '<div id="cr-root" class="cr-root" aria-label="Career paths"></div>' +
    '<div class="cr-actions">' +
    '<button type="button" id="cr-add">Add career path</button>' +
    '<button type="button" id="cr-reset">Clear all paths</button>' +
    '</div>' +
    crScript +
    '</div></div>'
  );
}

function buildDailyTasksPanelStylesHtml() {
  return (
    '<style>' +
    '.dt4-panel{border:1px solid #e7e5e4;border-radius:14px;padding:0;background:#fff;box-shadow:0 4px 22px rgba(28,25,23,0.06),0 1px 3px rgba(28,25,23,0.04)}' +
    '.dt4-pagehead{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:20px 22px 16px;border-bottom:1px solid #e7e5e4;background:linear-gradient(180deg,#fafaf9 0%,#ffffff 55%)}' +
    '.dt4-pagehead-left{display:flex;align-items:center;gap:12px;min-width:0}' +
    '.dt4-board-title{font-size:1.28rem;font-weight:800;color:#1c1917;letter-spacing:-0.035em}' +
    '.dt4-badge{font-size:11px;font-weight:800;background:#ccfbf1;color:#115e59;padding:5px 12px;border-radius:999px;white-space:nowrap;border:1px solid #99f6e4;letter-spacing:0.02em;text-transform:uppercase}' +
    '.dt4-pagehead-right{display:flex;align-items:center;gap:10px}' +
    '.dt4-btn-add{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border:none;border-radius:10px;background:#0d9488;color:#fff;font-size:14px;font-weight:700;cursor:pointer;font:inherit;box-shadow:0 2px 10px rgba(13,148,136,0.35)}' +
    '.dt4-btn-add:hover{background:#0f766e}' +
    '.dt4-btn-icon{display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;border:1px solid #d6d3d1;border-radius:11px;background:#fafaf9;cursor:pointer;color:#57534e;transition:background .15s ease,border-color .15s ease,color .15s ease}' +
    '.dt4-btn-icon:hover{background:#f5f5f4;color:#292524;border-color:#c4bfbc}' +
    '.dt4-btn-icon svg{display:block;pointer-events:none}' +
    '.dt4-tabs{display:flex;gap:8px;flex-wrap:wrap;padding:12px 20px 0;border-bottom:1px solid #e7e5e4;background:#fafaf9}' +
    '.dt4-tab{padding:9px 16px;border:none;background:transparent;font:inherit;font-size:13px;font-weight:700;color:#78716c;cursor:pointer;border-radius:10px 10px 0 0;margin-bottom:-1px;transition:color .15s ease,background .15s ease}' +
    '.dt4-tab:hover{color:#44403c;background:rgba(255,255,255,0.7)}' +
    '.dt4-tab.is-active{color:#115e59;background:#fff;border:1px solid #e7e5e4;border-bottom-color:#fff;box-shadow:0 -2px 12px rgba(28,25,23,0.04)}' +
    '.dt4-cat-tabs{display:flex;align-items:stretch;gap:0;padding:0 8px;border-bottom:1px solid #e2e8f0;background:#fff;overflow-x:auto;-webkit-overflow-scrolling:touch}' +
    '.dt4-cat-tab{flex:1 1 0;min-width:4.25rem;max-width:8.5rem;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:14px 10px 11px;border:none;border-radius:0;border-bottom:3px solid transparent;background:transparent;font:inherit;font-size:12px;font-weight:600;color:#64748b;cursor:pointer;margin-bottom:-1px;white-space:nowrap;transition:color .15s ease,border-color .15s ease}' +
    '.dt4-cat-tab:hover{color:#475569}' +
    '.dt4-cat-tab.is-active{color:#2563eb;border-bottom-color:#2563eb;font-weight:700}' +
    '.dt4-cat-tab-link{text-decoration:none;color:inherit}' +
    '.dt4-cat-ico{display:flex;align-items:center;justify-content:center;width:28px;height:28px;color:inherit}' +
    '.dt4-cat-ico svg{display:block;width:26px;height:26px;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}' +
    '.dt4-cat-label{line-height:1.2;text-align:center}' +
    'details.dt4-stream.dt4-cat-hidden{display:none !important}' +
    '.dt4-personal-board .dt4-th-fn,.dt4-personal-board .dt4-td-fn{display:none !important}' +
    '.dt4-td-status{display:flex;align-items:center;gap:6px;white-space:nowrap}' +
    '.dt4-l-flag-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid #fcd34d;border-radius:8px;background:#fffbeb;color:#d97706;cursor:pointer;transition:background .15s ease,border-color .15s ease,box-shadow .15s ease}' +
    '.dt4-l-flag-btn:hover{background:#fef3c7;border-color:#f59e0b;box-shadow:0 0 0 2px rgba(245,158,11,0.2)}' +
    '.dt4-l-flag-btn.is-on{background:#fef3c7;border-color:#f59e0b;color:#b45309;box-shadow:0 0 0 2px rgba(245,158,11,0.25)}' +
    '.dt4-l-flag-btn svg{display:block;width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '.dt4-l-repeat-group{display:inline-flex;align-items:center;gap:3px;flex-shrink:0}' +
    '.dt4-l-repeat-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid #e2e8f0;border-radius:7px;background:#fff;color:#64748b;cursor:pointer;transition:background .15s ease,border-color .15s ease,box-shadow .15s ease}' +
    '.dt4-l-repeat-btn:hover{background:#f8fafc;border-color:#cbd5e1}' +
    '.dt4-l-repeat-btn svg{display:block;width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '.dt4-l-repeat-btn-daily.is-on{background:#ecfeff;border-color:#22d3ee;color:#0e7490;box-shadow:0 0 0 2px rgba(34,211,238,0.2)}' +
    '.dt4-l-repeat-btn-weekly.is-on{background:#f5f3ff;border-color:#a78bfa;color:#6d28d9;box-shadow:0 0 0 2px rgba(167,139,250,0.22)}' +
    '.dt4-l-repeat-btn-monthly.is-on{background:#fdf2f8;border-color:#f472b6;color:#be185d;box-shadow:0 0 0 2px rgba(244,114,182,0.22)}' +
    'tr.dt4-line.dt4-line-flagged td{background:#fffbeb}' +
    'tr.dt4-line.dt4-line-flagged:hover td{background:#fef9c3}' +
    '.dt4-all-buckets{display:grid;gap:20px;padding:0 20px 8px}' +
    '.dt4-all-buckets[hidden]{display:none !important}' +
    '.dt4-bucket{border:1px solid #e7e5e4;border-radius:12px;background:#fafaf9;overflow:hidden}' +
    '.dt4-bucket-h{margin:0;padding:12px 16px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:#475569;background:linear-gradient(180deg,#f8fafc,#f1f5f9);border-bottom:1px solid #e2e8f0}' +
    '.dt4-bucket-h.dt4-bucket-h-complete{color:#166534;background:linear-gradient(180deg,#ecfdf5,#f0fdf4);border-bottom-color:#bbf7d0}' +
    '.dt4-bucket-host{display:flex;flex-direction:column;gap:10px;padding:14px;min-height:48px}' +
    '.dt4-bucket-host:empty::after{content:"Nothing here yet";display:block;padding:12px;text-align:center;font-size:13px;color:#94a3b8;font-style:italic}' +
    '.dt4-bucket-host.dt4-bucket-host-hidden{display:none}' +
    '.dt4-host-flat{display:flex;flex-direction:column;gap:10px;padding:14px 20px 22px;background:#f5f5f4}' +
    '.dt4-l-mark-actions{display:inline-flex;align-items:center;gap:4px;flex-shrink:0}' +
    '.dt4-l-status-quick{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;padding:5px 8px;border:1px solid #d6d3d1;border-radius:8px;background:#fff;color:#1c1917;cursor:pointer;max-width:8.5rem;font-family:inherit}' +
    '.dt4-l-status-quick:hover{border-color:#0d9488}' +
    '.dt4-l-status-quick:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 2px rgba(13,148,136,0.2)}' +
    '.dt4-status-hint{margin:0;padding:8px 20px 0;font-size:12px;color:#78716c;line-height:1.45}' +
    '.dt4-cat-hint{margin:0;padding:4px 20px 0;font-size:11px;font-weight:700;color:#0f766e;text-transform:uppercase;letter-spacing:0.05em}' +
    '.dt4-status-antenna{padding:16px 20px 8px;background:#fafaf9;border-bottom:1px solid #e7e5e4}' +
    '.dt4-antenna-grid{display:flex;align-items:flex-end;justify-content:center;gap:10px;max-width:100%;margin:0 auto;padding:0 4px;overflow-x:auto;-webkit-overflow-scrolling:touch}' +
    '.dt4-antenna-col{flex:0 0 auto;width:3rem;display:flex;flex-direction:column;align-items:center;gap:6px;border:none;background:transparent;cursor:pointer;font:inherit;padding:6px 3px 4px;border-radius:12px;transition:background .15s ease,transform .15s ease}' +
    '.dt4-antenna-col:hover{background:rgba(255,255,255,0.9);transform:translateY(-1px)}' +
    '.dt4-antenna-col.is-active{background:#fff;box-shadow:0 2px 14px rgba(28,25,23,0.1);outline:2px solid #99f6e4;outline-offset:1px}' +
    '.dt4-antenna-bar-wrap{width:100%;height:7.5rem;display:flex;flex-direction:column;justify-content:flex-end;align-items:stretch;background:#e2e8f0;border-radius:999px;overflow:hidden;box-shadow:inset 0 2px 8px rgba(15,23,42,0.12);border:1px solid #cbd5e1}' +
    '.dt4-antenna-bar{width:100%;height:0;min-height:0;border-radius:0 0 999px 999px;transition:height .4s cubic-bezier(0.4,0,0.2,1);position:relative;overflow:hidden}' +
    '.dt4-antenna-bar::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(-45deg,transparent,transparent 5px,rgba(255,255,255,0.12) 5px,rgba(255,255,255,0.12) 10px);pointer-events:none}' +
    '.dt4-antenna-bar::after{content:"";position:absolute;top:0;left:0;right:0;height:40%;background:linear-gradient(180deg,rgba(255,255,255,0.35),transparent);pointer-events:none}' +
    '.dt4-antenna-bar.dt4-antenna-inc{background:linear-gradient(0deg,#64748b,#94a3b8)}' +
    '.dt4-antenna-bar.dt4-antenna-next{background:linear-gradient(0deg,#2563eb,#60a5fa)}' +
    '.dt4-antenna-bar.dt4-antenna-done{background:linear-gradient(0deg,#16a34a,#4ade80)}' +
    '.dt4-antenna-bar.dt4-antenna-flag{background:linear-gradient(0deg,#d97706,#fbbf24)}' +
    '.dt4-antenna-bar.dt4-antenna-daily{background:linear-gradient(0deg,#0e7490,#22d3ee)}' +
    '.dt4-antenna-bar.dt4-antenna-weekly{background:linear-gradient(0deg,#6d28d9,#a78bfa)}' +
    '.dt4-antenna-bar.dt4-antenna-monthly{background:linear-gradient(0deg,#be185d,#f472b6)}' +
    '.dt4-status-tabs{flex-wrap:wrap}' +
    '.dt4-antenna-pct{font-size:9px;font-weight:800;color:#64748b;font-variant-numeric:tabular-nums;line-height:1;min-height:0.75rem}' +
    '.dt4-antenna-num{font-size:1rem;font-weight:800;color:#1c1917;font-variant-numeric:tabular-nums;line-height:1}' +
    '.dt4-antenna-lab{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#78716c;text-align:center;line-height:1.2;max-width:4.5rem}' +
    '.dt4-status-tabs{margin-top:0}' +
    '.dt4-l-status-pill{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;padding:2px 6px;border-radius:4px;white-space:nowrap}' +
    '.dt4-l-status-pill-incomplete,.dt4-l-status-pill-flagged{background:#f1f5f9;color:#475569}' +
    '.dt4-l-status-pill-next{background:#eff6ff;color:#1d4ed8}' +
    '.dt4-l-status-pill-complete{background:#ecfdf5;color:#166534}' +
    'details.dt4-stream.dt4-stream-empty-tab .dt4-table-wrap::after{content:"No tasks for this filter — try another view or add a line";display:block;padding:14px 16px;font-size:13px;color:#94a3b8;font-style:italic;border-top:1px dashed #e7e5e4}' +
    '.dt4-l-mark-next{border-color:#bfdbfe;color:#1d4ed8;background:#eff6ff}' +
    '.dt4-l-mark-next:hover{background:#dbeafe}' +
    'tr.dt4-line.dt4-line-next td{background:#eff6ff}' +
    'tr.dt4-row-group-h.dt4-row-group-next td{color:#1d4ed8;background:#eff6ff;border-top-color:#bfdbfe}' +
    'tr.dt4-row-group-h.dt4-row-group-flagged td{color:#b45309;background:#fffbeb;border-top-color:#fcd34d}' +
    '.dt4-l-mark-btn{padding:4px 8px;border-radius:6px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;cursor:pointer;border:1px solid #e2e8f0;background:#fff;color:#475569;line-height:1.2;white-space:nowrap}' +
    '.dt4-l-mark-btn:hover{background:#f8fafc;border-color:#cbd5e1}' +
    '.dt4-l-mark-complete{border-color:#bbf7d0;color:#166534;background:#f0fdf4}' +
    '.dt4-l-mark-complete:hover{background:#dcfce7}' +
    '.dt4-l-mark-incomplete{border-color:#e2e8f0;color:#64748b}' +
    'tr.dt4-line.dt4-line-complete .dt4-l-text{text-decoration:line-through;color:#64748b}' +
    'tr.dt4-line.dt4-line-complete td.dt4-td-task,tr.dt4-line.dt4-line-complete td.dt4-td-date,tr.dt4-line.dt4-line-complete td.dt4-td-amt{opacity:0.85}' +
    'tr.dt4-row-group-h td{padding:8px 14px 6px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;background:#f8fafc;border-top:1px solid #e2e8f0}' +
    'tr.dt4-row-group-h.dt4-row-group-done td{color:#166534;background:#ecfdf5;border-top-color:#bbf7d0}' +
    'tr.dt4-row-group-h:first-child td{border-top:none}' +
    '.dt4-done-stack{padding:14px 20px 22px;background:#f5f5f4;flex-direction:column;gap:0}' +
    '.dt4-done-stack[hidden]{display:none !important}' +
    '.dt4-done-stack-inner{background:#fff;border:1px solid #e7e5e4;border-radius:12px;overflow:hidden}' +
    '.dt4-done-flat{width:100%;border-collapse:collapse}' +
    '.dt4-done-flat thead th{padding:10px 14px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;background:#f8fafc;border-bottom:1px solid #e2e8f0}' +
    '.dt4-done-origin td{padding:10px 14px 4px;font-size:11px;font-weight:800;color:#0f766e;text-transform:uppercase;letter-spacing:0.05em;background:#f0fdfa;border:none}' +
    '.dt4-done-origin+.dt4-line td{border-top:1px solid #f1f5f9}' +
    '.dt4-done-stack-empty{margin:0;padding:28px 16px;text-align:center;color:#94a3b8;font-size:14px}' +
    '.dt4-flagged-stack{display:flex;flex-direction:column;padding:14px 20px 22px;background:#f5f5f4;gap:0}' +
    '.dt4-flagged-stack[hidden]{display:none !important}' +
    '.dt4-personal-board.dt4-tab-flat .dt4-host-flat{display:none !important}' +
    '.dt4-personal-board.dt4-tab-flat #dt4-add-stream{display:none}' +
    '.dt4-personal-board.dt4-tab-flat .dt4-cat-hint{display:none}' +
    '.dt4-flagged-stack-inner{background:#fff;border:1px solid #e7e5e4;border-radius:12px;overflow:hidden}' +
    '.dt4-flagged-flat{width:100%;border-collapse:collapse}' +
    '.dt4-flagged-flat thead th{padding:10px 14px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;background:#f8fafc;border-bottom:1px solid #e2e8f0}' +
    '.dt4-flagged-flat .dt4-td-stream{display:none !important}' +
    'tr.dt4-flagged-date-h td{padding:12px 14px 8px;font-size:12px;font-weight:800;color:#b45309;text-transform:uppercase;letter-spacing:0.06em;background:linear-gradient(180deg,#fffbeb,#fef9c3);border-bottom:1px solid #fcd34d;border-top:1px solid #fde68a}' +
    'tr.dt4-flagged-date-h:first-child td{border-top:none}' +
    '.dt4-flagged-empty{margin:0;padding:28px 16px;text-align:center;color:#94a3b8;font-size:14px}' +
    '.dt4-flagged-empty[hidden]{display:none !important}' +
    '.dt4-flat-total{margin:0;padding:14px 16px;font-size:14px;font-weight:700;color:#134e4a;background:linear-gradient(180deg,#ecfeff,#f0fdfa);border-top:1px solid #99f6e4;text-align:right}' +
    '.dt4-flat-total[hidden]{display:none !important}' +
    '.dt4-flat-total strong{font-weight:800;font-variant-numeric:tabular-nums;color:#0d9488;font-size:1.12em}' +
    'tr.dt4-flat-date-h-next td{padding:12px 14px 8px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;background:linear-gradient(180deg,#ecfeff,#f0fdfa);border-bottom:1px solid #99f6e4;border-top:1px solid #5eead4;color:#0f766e}' +
    'tr.dt4-flat-date-h-next:first-child td{border-top:none}' +
    'tr.dt4-gym-in-stack{display:none !important}' +
    '.dt4-flagged-flat tr.dt4-gym-flat td{vertical-align:middle;border-bottom:1px solid #f1f5f9}' +
    '.dt4-flagged-flat tr.dt4-gym-flat:hover td{background:#fafafa}' +
    '.dt4-gym-flat-task{display:flex;flex-direction:column;gap:4px;min-width:0}' +
    '.dt4-gym-flat-task .dt4-l-machine{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;font-size:14px;font-weight:600;color:#0f172a}' +
    '.dt4-gym-flat-sub{font-size:12px;color:#64748b;line-height:1.35}' +
    '.dt4-flagged-flat tr.dt4-gym-flat .dt4-td-amt .dt4-l-weight{width:5.5rem;text-align:right}' +
    '.dt4-st-flagged .dt4-l-status-ico{border:1px solid #fcd34d;background:#fffbeb}' +
    '.dt4-gym-stream .dt4-s-amount-wrap{display:none !important}' +
    '.dt4-gym-stream .dt4-table thead th.dt4-th-gym{text-align:left;padding:12px 14px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;background:#f8fafc;border-bottom:1px solid #e2e8f0}' +
    '.dt4-gym-stream .dt4-gym-cell{padding:0;border-bottom:1px solid #f1f5f9;background:#fff}' +
    '.dt4-gym-stream tr.dt4-gym-line:hover .dt4-gym-cell{background:#fafafa}' +
    '.dt4-gym-entry{display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px 14px;padding:14px 16px}' +
    '.dt4-gym-field{display:flex;flex-direction:column;gap:5px;flex:1 1 9rem;min-width:7.5rem;max-width:14rem}' +
    '.dt4-gym-field label{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em}' +
    '.dt4-gym-field input,.dt4-gym-field select{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;font-size:14px;color:#0f172a;background:#fff}' +
    '.dt4-gym-field input:focus,.dt4-gym-field select:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,0.15)}' +
    '.dt4-gym-entry-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;margin-left:auto;padding-bottom:2px}' +
    '.dt4-gym-entry-actions .dt4-l-status-ico{flex-shrink:0}' +
    '.dt4-gym-targets{margin:0 0 12px;padding:12px 14px;border:1px solid #e2e8f0;border-radius:10px;background:linear-gradient(180deg,#f8fafc,#f1f5f9)}' +
    '.dt4-gym-targets-h{margin:0 0 10px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:#475569}' +
    '.dt4-gym-targets-list{display:flex;flex-direction:column;gap:8px}' +
    '.dt4-gym-targets-empty{margin:0;font-size:12px;color:#94a3b8;font-style:italic}' +
    '.dt4-gym-target-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
    '.dt4-gym-target-name{flex:1;min-width:6rem;font-size:13px;font-weight:700;color:#1e293b}' +
    '.dt4-gym-target-inp{width:5.5rem;padding:7px 9px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;font-size:13px;text-align:right;font-variant-numeric:tabular-nums}' +
    '.dt4-gym-target-inp:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,0.15)}' +
    '.dt4-gym-target-unit{font-size:11px;font-weight:700;color:#64748b}' +
    '.dt4-gym-delta-field{min-width:5.5rem;max-width:7rem}' +
    '.dt4-gym-delta{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:6px 10px;border-radius:8px;font-size:12px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0}' +
    '.dt4-gym-delta.dt4-gym-delta-up{background:#ecfdf5;color:#166534;border-color:#bbf7d0}' +
    '.dt4-gym-delta.dt4-gym-delta-down{background:#fef2f2;color:#b91c1c;border-color:#fecaca}' +
    '.dt4-gym-delta.dt4-gym-delta-first{background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe}' +
    '.dt4-gym-delta-sub{display:block;font-size:9px;font-weight:700;margin-top:2px;opacity:0.85}' +
    '.dt4-s-category{padding:9px 11px;border:1px solid #d6d3d1;border-radius:9px;font:inherit;font-size:13px;background:#fafaf9;color:#1c1917;min-width:9rem}' +
    '.dt4-s-category:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,0.15);background:#fff}' +
    '.dt4-sum-cat{color:#0f766e;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.04em}' +
    '.dt4-sum-cat:empty{display:none}' +
    '.dt4-filters{display:flex;align-items:center;gap:12px;padding:14px 20px 18px;background:#f5f5f4;border-bottom:1px solid #e7e5e4}' +
    '.dt4-search{flex:1;min-width:12rem;max-width:28rem;padding:10px 14px;border:1px solid #d6d3d1;border-radius:11px;font:inherit;font-size:14px;background:#fff;color:#1c1917;transition:border-color .15s ease,box-shadow .15s ease}' +
    '.dt4-search:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,0.18)}' +
    '#dt4-streams,#dt4-completed-streams,#daily-personal-streams,#daily-personal-completed-streams,#work-planning-streams,#work-planning-completed-streams,#medical-physics-streams,#medical-physics-completed-streams{display:flex;flex-direction:column;gap:10px;padding:14px 20px 22px;background:#f5f5f4}' +
    'details.dt4-stream{border:1px solid #d6d3d1;border-radius:12px;background:#fff;overflow:hidden;box-shadow:0 2px 12px rgba(28,25,23,0.05)}' +
    'details.dt4-stream[open]{box-shadow:0 4px 20px rgba(28,25,23,0.07)}' +
    '.dt4-stream-summary{display:flex;align-items:center;gap:10px;padding:14px 18px;list-style:none;cursor:pointer;font-weight:700;color:#292524;background:linear-gradient(180deg,#ffffff 0%,#fafaf9 100%);border-bottom:1px solid #e7e5e4}' +
    'details.dt4-stream:not([open]) .dt4-stream-summary{border-bottom:none}' +
    '.dt4-stream-summary::-webkit-details-marker{display:none}' +
    '.dt4-sum-chev{flex-shrink:0;width:1.25rem;text-align:center;font-size:10px;line-height:1;color:#78716c;transition:transform .18s ease,color .15s ease}' +
    'details.dt4-stream:not([open]) .dt4-sum-chev{transform:rotate(-90deg)}' +
    '.dt4-sum-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.dt4-sum-sep,.dt4-sum-date,.dt4-sum-meta{color:#78716c;font-weight:600;font-size:13px}' +
    '.dt4-sum-amount{color:#115e59;font-weight:700;font-size:13px;font-variant-numeric:tabular-nums}' +
    '.dt4-sum-amount:empty{display:none}' +
    '.dt4-stream-body{padding:14px 16px 16px;background:#fff}' +
    '.dt4-stream-head{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:10px}' +
    '.dt4-stream-head label{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:#78716c;display:flex;flex-direction:column;gap:6px}' +
    '.dt4-s-title{width:min(100%,18rem);padding:9px 11px;border:1px solid #d6d3d1;border-radius:9px;font:inherit;background:#fafaf9;color:#1c1917;transition:border-color .15s ease,box-shadow .15s ease}' +
    '.dt4-s-title:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,0.15);background:#fff}' +
    '.dt4-s-date{padding:9px 11px;border:1px solid #d6d3d1;border-radius:9px;font:inherit;background:#fafaf9;color:#44403c}' +
    '.dt4-s-date:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,0.15)}' +
    '.dt4-s-amount{width:min(100%,9.5rem);padding:9px 11px;border:1px solid #d6d3d1;border-radius:9px;font:inherit;font-size:14px;background:#fafaf9;color:#1c1917;font-variant-numeric:tabular-nums;text-align:right}' +
    '.dt4-s-amount:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,0.15);background:#fff}' +
    '.dt4-s-amount[readonly]{background:#f1f5f9;color:#334155;cursor:default}' +
    '.dt4-stream-head-actions{display:flex;align-items:stretch;margin-left:auto}' +
    '.dt4-iconbar{display:inline-flex;border:1px solid #d6d3d1;border-radius:10px;overflow:hidden;background:#fafaf9}' +
    '.dt4-iconbtn{display:flex;align-items:center;justify-content:center;min-width:40px;height:40px;padding:0;border:none;border-right:1px solid #d6d3d1;background:#fff;cursor:pointer;color:#44403c;flex-shrink:0;transition:background .15s ease}' +
    '.dt4-iconbtn:last-child{border-right:0}' +
    '.dt4-iconbtn:hover{background:#f5f5f4}' +
    '.dt4-iconbtn-primary{background:#0d9488;color:#fff;border-right-color:#0f766e}' +
    '.dt4-iconbtn-primary:hover{background:#0f766e}' +
    '.dt4-iconbtn-danger{color:#b45309}' +
    '.dt4-iconbtn-danger:hover{background:#fff7ed}' +
    '.dt4-stream-complete{color:#047857}' +
    '.dt4-stream-complete:hover{background:#ecfdf5 !important}' +
    '.dt4-iconbtn svg{display:block;pointer-events:none}' +
    '.dt4-table-wrap{overflow:auto;border:1px solid #e7e5e4;border-radius:10px;background:#fafaf9}' +
    '.dt4-table{width:100%;border-collapse:collapse;border-spacing:0;font-size:14px;min-width:680px}' +
    '.dt4-table thead th{text-align:left;padding:10px 12px;background:#f5f5f4;border-bottom:1px solid #e7e5e4;color:#57534e;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.07em;white-space:nowrap}' +
    '.dt4-th-status{width:52px}' +
    '.dt4-personal-board .dt4-th-status{width:20rem;min-width:20rem}' +
    '.dt4-personal-board .dt4-td-status{min-width:20rem;max-width:22rem;flex-wrap:wrap;row-gap:4px}' +
    '.dt4-personal-board .dt4-l-status-quick{flex-shrink:0}' +
    '.dt4-th-act{width:48px;text-align:right !important}' +
    '.dt4-th-fn{width:8rem}' +
    '.dt4-th-amt{text-align:right;width:7rem}' +
    '.dt4-table tbody tr.dt4-line td{border-bottom:1px solid #f0ebe8;padding:4px 10px;vertical-align:middle;background:#fff}' +
    '.dt4-table tbody tr.dt4-line:hover td{background:#fafaf9}' +
    'tr.dt4-filter-hidden{display:none !important}' +
    'tr.dt4-note-row{display:none !important}' +
    'tr.dt4-note-row.dt4-note-open:not(.dt4-filter-hidden){display:table-row !important}' +
    'tr.dt4-note-row td.dt4-note-cell{padding:10px 12px 14px 14px;border-bottom:1px solid #e7e5e4;background:linear-gradient(180deg,#fafaf9 0%,#f5f5f4 100%);vertical-align:top}' +
    'tr.dt4-note-row.dt4-note-open td.dt4-note-cell{padding-top:10px}' +
    'details.dt4-note-details{border:1px solid #cfe8e4;border-radius:12px;padding:0;margin:2px 0 4px;overflow:hidden;background:linear-gradient(165deg,#ffffff 0%,#f8faf9 55%);box-shadow:0 2px 14px rgba(13,148,136,0.07),0 1px 3px rgba(28,25,23,0.05);transition:box-shadow .2s ease,border-color .2s ease}' +
    'details.dt4-note-details[open]{border-color:#99f6e4;box-shadow:0 6px 28px rgba(13,148,136,0.11),0 2px 8px rgba(28,25,23,0.06)}' +
    'details.dt4-note-details summary.dt4-note-sum{cursor:pointer;list-style:none;font-size:11px;font-weight:800;color:#115e59;padding:11px 14px 10px;text-transform:uppercase;letter-spacing:0.07em;background:linear-gradient(90deg,#ecfdf5 0%,#f0fdfa 45%,transparent 100%);border-bottom:1px solid #ccfbf1;display:flex;align-items:center;gap:8px}' +
    'details.dt4-note-details summary.dt4-note-sum::before{content:"\u2630";font-size:12px;font-weight:700;opacity:0.65}' +
    'details.dt4-note-details summary.dt4-note-sum::-webkit-details-marker{display:none}' +
    'details.dt4-note-details:not([open]) summary.dt4-note-sum{color:#57534e;background:#f5f5f4;border-bottom-color:#e7e5e4}' +
    '.dt4-note-body{padding:14px 14px 4px;background:linear-gradient(180deg,#ffffff 0%,#fafaf9 100%)}' +
    '.dt4-note-edit{display:flex;flex-direction:column;align-items:stretch;gap:10px}' +
    '.dt4-note-body.dt4-note-log-only .dt4-note-edit{display:none !important}' +
    '.dt4-note-log-hint{font-size:12px;color:#78716c;margin:0 0 10px;display:none;font-style:italic;line-height:1.45}' +
    '.dt4-note-body.dt4-note-log-only .dt4-note-log-hint{display:block}' +
    '.dt4-note-log{display:none;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.68;color:#292524;padding:14px 16px 16px;border:1px solid #e7e5e4;border-left:4px solid #14b8a6;border-radius:4px 11px 11px 4px;background:#fffefb;box-shadow:inset 0 1px 0 rgba(255,255,255,0.85),inset 0 -1px 12px rgba(13,148,136,0.04);min-height:3.25rem;cursor:pointer;transition:border-color .18s ease,box-shadow .18s ease,background .18s ease}' +
    '.dt4-note-log:hover{background:#fffdfa;border-color:#d6d3d1;box-shadow:inset 0 1px 0 rgba(255,255,255,0.9),inset 0 -1px 14px rgba(13,148,136,0.07)}' +
    '.dt4-note-log:focus{outline:none;box-shadow:inset 0 0 0 2px rgba(13,148,136,0.35),inset 0 -1px 12px rgba(13,148,136,0.06)}' +
    '.dt4-note-body.dt4-note-log-only .dt4-note-log{display:block}' +
    '.dt4-l-note{width:100%;box-sizing:border-box;min-height:5.5rem;padding:14px 16px;border:1px solid #d6d3d1;border-left:4px solid #0d9488;border-radius:4px 11px 11px 4px;font:inherit;font-size:13px;line-height:1.65;resize:vertical;max-height:14rem;background:#fff;color:#1c1917;box-shadow:inset 0 2px 8px rgba(28,25,23,0.03);transition:border-color .18s ease,box-shadow .18s ease}' +
    '.dt4-l-note:focus{outline:none;border-color:#5eead4;box-shadow:inset 0 2px 10px rgba(13,148,136,0.05),0 0 0 3px rgba(13,148,136,0.2)}' +
    '.dt4-note-actions{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:8px;padding:12px 0 4px;border-top:1px dashed #d6d3d1}' +
    '.dt4-note-actions .dt4-l-note-del{margin-right:auto}' +
    '.dt4-l-note-del{flex-shrink:0;width:32px;height:32px;padding:0;border:1px solid #e7e5e4;border-radius:9px;background:#fff;cursor:pointer;color:#b45309;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 1px 2px rgba(28,25,23,0.05)}' +
    '.dt4-l-note-del:hover{background:#fff7ed;border-color:#fdba74;color:#9a3412}' +
    '.dt4-l-note-del:focus-visible{outline:2px solid #0d9488;outline-offset:2px}' +
    '.dt4-l-note-del svg{display:block;pointer-events:none}' +
    '.dt4-note-log-bar{display:none;justify-content:flex-end;margin:0 0 8px}' +
    '.dt4-note-body.dt4-note-log-only .dt4-note-log-bar{display:flex}' +
    '.dt4-l-note-save{flex-shrink:0;width:auto;align-self:flex-end;padding:8px 14px;border:none;border-radius:9px;background:#0d9488;color:#fff;font:inherit;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(13,148,136,0.28)}' +
    '.dt4-l-note-save:hover{background:#0f766e}' +
    '.dt4-l-note-save:disabled{opacity:0.85;cursor:default}' +
    'td.dt4-l-meta-cell{display:none}' +
    '.dt4-l-meta{display:block}' +
    '.dt4-l-status-ico{width:36px;height:36px;padding:0;border:none;background:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;transition:background .15s ease}' +
    '.dt4-l-status-ico:hover{background:#f5f5f4}' +
    '.dt4-l-status-ico:focus-visible{outline:2px solid #0d9488;outline-offset:2px}' +
    '.dt4-task-cell{display:flex;align-items:center;gap:8px;min-width:0;width:100%}' +
    '.dt4-task-cell .dt4-l-text{flex:1;min-width:0;width:auto;box-sizing:border-box;border:1px solid transparent;border-radius:6px;padding:6px 9px;font:inherit;font-size:14px;background:transparent;color:#1c1917}' +
    '.dt4-task-cell .dt4-l-text:hover{border-color:#d6d3d1;background:#fafaf9}' +
    '.dt4-task-cell .dt4-l-text:focus{outline:none;border-color:#0d9488;background:#fff;box-shadow:0 0 0 3px rgba(13,148,136,0.14)}' +
    '.dt4-l-note-toggle{flex-shrink:0;width:34px;height:34px;padding:0;border:1px solid #d6d3d1;border-radius:9px;background:#fafaf9;cursor:pointer;color:#a8a29e;display:inline-flex;align-items:center;justify-content:center;transition:border-color .15s ease,background .15s ease,color .15s ease}' +
    '.dt4-l-note-toggle:hover{border-color:#c4bfbc;color:#57534e;background:#fff}' +
    '.dt4-l-note-toggle.dt4-outcome-has{color:#0f766e;border-color:#5eead4;background:#ccfbf1}' +
    '.dt4-l-note-toggle.dt4-outcome-has:hover{background:#99f6e4;border-color:#2dd4bf}' +
    '.dt4-l-note-toggle:focus-visible{outline:2px solid #0d9488;outline-offset:2px}' +
    '.dt4-l-note-toggle svg{display:block;pointer-events:none}' +
    '.dt4-l-note-close{flex-shrink:0;display:none;width:28px;height:28px;padding:0;border:1px solid #d6d3d1;border-radius:8px;background:#fff;cursor:pointer;color:#57534e;align-items:center;justify-content:center}' +
    'tr.dt4-line.dt4-line-note-open .dt4-task-cell .dt4-l-note-close{display:inline-flex;align-items:center;justify-content:center}' +
    '.dt4-l-note-close:hover{background:#fafaf9;color:#292524;border-color:#c4bfbc}' +
    '.dt4-l-note-close:focus-visible{outline:2px solid #0d9488;outline-offset:2px}' +
    '.dt4-l-note-close svg{display:block;pointer-events:none}' +
    '.dt4-l-stream-label{color:#57534e;font-size:13px;display:block;max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.dt4-td-fn{padding:2px 6px;vertical-align:middle}' +
    '.dt4-l-function{width:100%;max-width:9rem;box-sizing:border-box;padding:6px 9px;border:1px solid #d6d3d1;border-radius:8px;font:inherit;font-size:13px;color:#1c1917;background:#fafaf9}' +
    '.dt4-l-function:hover{border-color:#c4bfbc}' +
    '.dt4-l-function:focus{outline:none;border-color:#0d9488;background:#fff;box-shadow:0 0 0 3px rgba(13,148,136,0.14)}' +
    '.dt4-td-date{padding:2px 6px;vertical-align:middle}' +
    '.dt4-td-amt{padding:2px 6px;vertical-align:middle;text-align:right}' +
    '.dt4-l-date{width:100%;max-width:11rem;box-sizing:border-box;padding:6px 9px;border:1px solid #d6d3d1;border-radius:8px;font:inherit;font-size:13px;color:#44403c;background:#fafaf9;font-variant-numeric:tabular-nums}' +
    '.dt4-l-date:hover{border-color:#c4bfbc}' +
    '.dt4-l-date:focus{outline:none;border-color:#0d9488;background:#fff;box-shadow:0 0 0 3px rgba(13,148,136,0.14)}' +
    '.dt4-l-amount{width:100%;max-width:7rem;box-sizing:border-box;margin-left:auto;display:block;padding:6px 8px;border:1px solid #d6d3d1;border-radius:8px;font:inherit;font-size:13px;color:#1c1917;background:#fafaf9;font-variant-numeric:tabular-nums;text-align:right}' +
    '.dt4-l-amount:focus{outline:none;border-color:#0d9488;background:#fff;box-shadow:0 0 0 3px rgba(13,148,136,0.14)}' +
    '.dt4-td-act{text-align:right}' +
    '.dt4-l-act{display:inline-block;position:relative;text-align:left}' +
    '.dt4-l-act>summary.dt4-l-more{list-style:none;width:36px;height:36px;border-radius:9px;border:1px solid #d6d3d1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;background:#fafaf9;font-size:16px;line-height:1;color:#57534e;font-weight:800;margin-left:auto;transition:background .15s ease,border-color .15s ease}' +
    '.dt4-l-act>summary.dt4-l-more::-webkit-details-marker{display:none}' +
    '.dt4-l-act[open]>summary.dt4-l-more{background:#f5f5f4;border-color:#c4bfbc}' +
    '.dt4-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:10.5rem;background:#fff;border:1px solid #e7e5e4;border-radius:12px;box-shadow:0 14px 36px rgba(28,25,23,0.14);z-index:12;padding:6px}' +
    '.dt4-menu .dt4-remove-line{display:block;width:100%;text-align:left;border:none;background:transparent;padding:10px 12px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;border-radius:8px;color:#b45309}' +
    '.dt4-menu .dt4-remove-line:hover{background:#fff7ed}' +
    '.dt4-readonly .dt4-add-line,.dt4-readonly .dt4-stream-complete,.dt4-readonly .dt4-remove-stream{display:none !important}' +
    '.dt4-readonly .dt4-l-act,.dt4-readonly .dt4-l-note-toggle,.dt4-readonly .dt4-l-note-close{display:none !important}' +
    '.dt4-readonly .dt4-l-status-ico{pointer-events:none;cursor:default}' +
    '.dt4-readonly .dt4-l-text,.dt4-readonly .dt4-l-date,.dt4-readonly .dt4-l-function,.dt4-readonly .dt4-l-amount,.dt4-readonly .dt4-s-title,.dt4-readonly .dt4-s-date,.dt4-readonly .dt4-s-amount,.dt4-readonly .dt4-l-status{cursor:default;background:#fafaf9;color:#44403c}' +
    '.dt4-readonly .dt4-note-log{cursor:default}' +
    '.dt4-readonly .dt4-note-log:focus{outline:none}' +
    '.dt4-stream-unlock{margin-left:8px;padding:9px 17px;border-radius:10px;border:none;background:#0d9488;color:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;box-shadow:0 2px 8px rgba(13,148,136,0.25)}' +
    '.dt4-stream-unlock:hover{background:#0f766e}' +
    '</style>'
  );
}

function buildPersonalCatTabsHtml() {
  const tab = (cat, label, paths, active) => {
    const cls = 'dt4-cat-tab' + (active ? ' is-active' : '');
    return (
      '<button type="button" class="' +
      cls +
      '" data-cat="' +
      escAttr(cat) +
      '" role="tab" aria-selected="' +
      (active ? 'true' : 'false') +
      '">' +
      '<span class="dt4-cat-ico" aria-hidden="true">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
      paths +
      '</svg></span>' +
      '<span class="dt4-cat-label">' +
      escHtml(label) +
      '</span></button>'
    );
  };
  return (
    '<div class="dt4-cat-tabs" id="dt4-cat-tabs" role="tablist" aria-label="Destination lines">' +
    tab(
      'all',
      'All',
      '<path d="M12 2l2.2 6.8H21l-5.5 4 2.1 6.7L12 17.3 6.4 19.5l2.1-6.7L3 8.8h6.8z"/>',
      true
    ) +
    tab(
      'gym',
      'Gym',
      '<path d="M6.5 6.5v11M17.5 6.5v11"/><path d="M6.5 12H4.5a1 1 0 01-1-1V7.5a1 1 0 011-1h2M17.5 12h2a1 1 0 001-1V7.5a1 1 0 00-1-1h-2"/><path d="M10 12h4"/>',
      false
    ) +
    tab(
      'hair',
      'Hair routine',
      '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.5 15.5"/><path d="M14.5 14.5L20 20"/><path d="M8.5 8.5L12 12"/>',
      false
    ) +
    tab(
      'clothes',
      'Clothes',
      '<path d="M6 3l2 2h8l2-2"/><path d="M4 7h16v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7z"/><path d="M9 11h6"/>',
      false
    ) +
    tab(
      'food',
      'Food',
      '<path d="M18 8h1a2 2 0 012 2v1a6 6 0 01-6 6h-1"/><path d="M6 2v7a6 6 0 0012 0V2"/><line x1="6" y1="9" x2="6" y2="21"/>',
      false
    ) +
    tab(
      'teeth',
      'Teeth',
      '<path d="M8 10v5M10.5 9.5v6M13 9.5v6M15.5 10v5"/><path d="M6 10a6 6 0 0112 0"/>',
      false
    ) +
    tab(
      'skin',
      'Skin',
      '<circle cx="12" cy="10" r="3"/><path d="M8 15c1.5 2.5 5.5 2.5 8 0"/><path d="M10 20h4"/>',
      false
    ) +
    tab(
      'accessories',
      'Accessories',
      '<circle cx="12" cy="12" r="3"/><path d="M12 9V5"/><path d="M9 5h6"/><path d="M7 16h10"/><path d="M8 16v3M16 16v3"/>',
      false
    ) +
    tab(
      'home',
      'Home',
      '<path d="M4 10.5L12 4l8 6.5V20a1 1 0 01-1 1h-5v-6H10v6H5a1 1 0 01-1-1v-9.5z"/>',
      false
    ) +
    tab(
      'dating',
      'Dating',
      '<path d="M12 21s-6.5-4.35-9-7.5C1.5 11 2 7 5.5 5.5 8 4.5 10 6 12 8c2-2 4-3.5 6.5-2.5C22 7 22.5 11 21 13.5c-2.5 3.15-9 7.5-9 7.5z"/>',
      false
    ) +
    '</div>'
  );
}

function buildWorkPlanningCatTabsHtml() {
  const tab = (cat, label, paths, active) => {
    const cls = 'dt4-cat-tab' + (active ? ' is-active' : '');
    return (
      '<button type="button" class="' +
      cls +
      '" data-cat="' +
      escAttr(cat) +
      '" role="tab" aria-selected="' +
      (active ? 'true' : 'false') +
      '">' +
      '<span class="dt4-cat-ico" aria-hidden="true">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
      paths +
      '</svg></span>' +
      '<span class="dt4-cat-label">' +
      escHtml(label) +
      '</span></button>'
    );
  };
  return (
    '<div class="dt4-cat-tabs" id="dt4-cat-tabs" role="tablist" aria-label="Work planning lines">' +
    tab(
      'all',
      'All',
      '<path d="M12 2l2.2 6.8H21l-5.5 4 2.1 6.7L12 17.3 6.4 19.5l2.1-6.7L3 8.8h6.8z"/>',
      true
    ) +
    tab(
      'current_job',
      'Current job',
      '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/>',
      false
    ) +
    tab('step2', 'Step 2', '<path d="M4 6h16M4 12h10M4 18h6"/>', false) +
    tab('step3', 'Step 3', '<path d="M4 6h16M4 12h12M4 18h8"/>', false) +
    tab('step4', 'Step 4', '<path d="M4 6h16M4 12h14M4 18h10"/>', false) +
    tab(
      'business',
      'Business',
      '<path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/>',
      false
    ) +
    tab(
      'millionaire',
      'Millionaire',
      '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9 11h6"/>',
      false
    ) +
    tab(
      'independence',
      'Independence',
      '<path d="M12 3l2 4h4l-3 3 1 4-4-2-4 2 1-4-3-3h4z"/>',
      false
    ) +
    '</div>'
  );
}

function buildMedicalPhysicsCatTabsHtml(activePath) {
  const ap = String(activePath || '');
  const overviewActive =
    ap === '/studying-medical-physics/career-overview' ||
    ap.startsWith('/studying-medical-physics/career-overview/');
  const tab = (cat, label, paths, active) => {
    const cls = 'dt4-cat-tab' + (active ? ' is-active' : '');
    return (
      '<button type="button" class="' +
      cls +
      '" data-cat="' +
      escAttr(cat) +
      '" role="tab" aria-selected="' +
      (active ? 'true' : 'false') +
      '">' +
      '<span class="dt4-cat-ico" aria-hidden="true">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
      paths +
      '</svg></span>' +
      '<span class="dt4-cat-label">' +
      escHtml(label) +
      '</span></button>'
    );
  };
  const linkTab = (href, label, paths, active) => {
    const cls = 'dt4-cat-tab dt4-cat-tab-link' + (active ? ' is-active' : '');
    return (
      '<a class="' +
      cls +
      '" href="' +
      escAttr(href) +
      '" role="tab" aria-selected="' +
      (active ? 'true' : 'false') +
      '">' +
      '<span class="dt4-cat-ico" aria-hidden="true">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
      paths +
      '</svg></span>' +
      '<span class="dt4-cat-label">' +
      escHtml(label) +
      '</span></a>'
    );
  };
  return (
    '<div class="dt4-cat-tabs" id="dt4-cat-tabs" role="tablist" aria-label="Medical physics tracks">' +
    tab(
      'all',
      'All',
      '<path d="M12 2l2.2 6.8H21l-5.5 4 2.1 6.7L12 17.3 6.4 19.5l2.1-6.7L3 8.8h6.8z"/>',
      !overviewActive
    ) +
    tab(
      'courses_before_master',
      'Courses before master',
      '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>',
      false
    ) +
    tab(
      'master_program_list',
      'Master program list',
      '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
      false
    ) +
    tab(
      'master_program_requirement',
      'Master program requirement',
      '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
      false
    ) +
    linkTab(
      '/studying-medical-physics/career-overview',
      'Career overview',
      '<path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 5-6"/>',
      overviewActive
    ) +
    '</div>'
  );
}

function buildPersonalStatusFiltersHtml(labels) {
  const L = labels || PERSONAL_STATUS_TAB_LABELS;
  const t = L.filterTitle || {};
  const lab = (k) => escHtml(L[k] || k);
  const title = (k) => escAttr(t[k] || L[k] || k);
  return (
    '<div id="dt4-status-antenna" class="dt4-status-antenna" aria-label="Logs by status">' +
    '<div class="dt4-antenna-grid" role="group" aria-label="Status counts">' +
    '<button type="button" class="dt4-antenna-col" data-tab="active">' +
    '<div class="dt4-antenna-bar-wrap"><div class="dt4-antenna-bar dt4-antenna-inc"></div></div>' +
    '<span class="dt4-antenna-pct"></span><span class="dt4-antenna-num">0</span><span class="dt4-antenna-lab">' +
    lab('active') +
    '</span></button>' +
    '<button type="button" class="dt4-antenna-col" data-tab="next">' +
    '<div class="dt4-antenna-bar-wrap"><div class="dt4-antenna-bar dt4-antenna-next"></div></div>' +
    '<span class="dt4-antenna-pct"></span><span class="dt4-antenna-num">0</span><span class="dt4-antenna-lab">' +
    lab('next') +
    '</span></button>' +
    '<button type="button" class="dt4-antenna-col" data-tab="done">' +
    '<div class="dt4-antenna-bar-wrap"><div class="dt4-antenna-bar dt4-antenna-done"></div></div>' +
    '<span class="dt4-antenna-pct"></span><span class="dt4-antenna-num">0</span><span class="dt4-antenna-lab">' +
    lab('done') +
    '</span></button>' +
    '<button type="button" class="dt4-antenna-col" data-tab="flagged">' +
    '<div class="dt4-antenna-bar-wrap"><div class="dt4-antenna-bar dt4-antenna-flag"></div></div>' +
    '<span class="dt4-antenna-pct"></span><span class="dt4-antenna-num">0</span><span class="dt4-antenna-lab">' +
    lab('flagged') +
    '</span></button>' +
    '<button type="button" class="dt4-antenna-col" data-tab="daily">' +
    '<div class="dt4-antenna-bar-wrap"><div class="dt4-antenna-bar dt4-antenna-daily"></div></div>' +
    '<span class="dt4-antenna-pct"></span><span class="dt4-antenna-num">0</span><span class="dt4-antenna-lab">' +
    lab('daily') +
    '</span></button>' +
    '<button type="button" class="dt4-antenna-col" data-tab="weekly">' +
    '<div class="dt4-antenna-bar-wrap"><div class="dt4-antenna-bar dt4-antenna-weekly"></div></div>' +
    '<span class="dt4-antenna-pct"></span><span class="dt4-antenna-num">0</span><span class="dt4-antenna-lab">' +
    lab('weekly') +
    '</span></button>' +
    '<button type="button" class="dt4-antenna-col" data-tab="monthly">' +
    '<div class="dt4-antenna-bar-wrap"><div class="dt4-antenna-bar dt4-antenna-monthly"></div></div>' +
    '<span class="dt4-antenna-pct"></span><span class="dt4-antenna-num">0</span><span class="dt4-antenna-lab">' +
    lab('monthly') +
    '</span></button>' +
    '</div></div>' +
    '<div class="dt4-tabs dt4-status-tabs" id="dt4-tabs" role="tablist" aria-label="' +
    escAttr(L.filterAria || 'Status filter') +
    '">' +
    '<button type="button" class="dt4-tab is-active" data-tab="all" role="tab">All</button>' +
    '<button type="button" class="dt4-tab" data-tab="active" role="tab" title="' +
    title('active') +
    '">' +
    lab('active') +
    '</button>' +
    '<button type="button" class="dt4-tab" data-tab="next" role="tab" title="' +
    title('next') +
    '">' +
    lab('next') +
    '</button>' +
    '<button type="button" class="dt4-tab" data-tab="done" role="tab" title="' +
    title('done') +
    '">' +
    lab('done') +
    '</button>' +
    '<button type="button" class="dt4-tab" data-tab="flagged" role="tab" title="' +
    title('flagged') +
    '">' +
    lab('flagged') +
    '</button>' +
    '<button type="button" class="dt4-tab" data-tab="daily" role="tab" title="' +
    title('daily') +
    '">' +
    lab('daily') +
    '</button>' +
    '<button type="button" class="dt4-tab" data-tab="weekly" role="tab" title="' +
    title('weekly') +
    '">' +
    lab('weekly') +
    '</button>' +
    '<button type="button" class="dt4-tab" data-tab="monthly" role="tab" title="' +
    title('monthly') +
    '">' +
    lab('monthly') +
    '</button>' +
    '</div>'
  );
}

function buildDailyTasksWorkspaceHtml(options) {
  options = options || {};
  const completedShell = !!options.completedView;
  const personalView = !!options.personalView;
  const workPlanningView = !!options.workPlanningView && !personalView;
  const medicalPhysicsView = !!options.medicalPhysicsView && !personalView && !workPlanningView;
  const isPersonalStyleBoard = personalView || workPlanningView || medicalPhysicsView;

  const keyActive = medicalPhysicsView
    ? MEDICAL_PHYSICS_STORAGE_KEY
    : workPlanningView
      ? WORK_PLANNING_TASKS_STORAGE_KEY
      : personalView
        ? DAILY_TASKS_PERSONAL_STORAGE_KEY
        : DAILY_TASKS_STORAGE_KEY;
  const keyDone = medicalPhysicsView
    ? MEDICAL_PHYSICS_COMPLETED_STORAGE_KEY
    : workPlanningView
      ? WORK_PLANNING_TASKS_COMPLETED_STORAGE_KEY
      : personalView
        ? DAILY_TASKS_PERSONAL_COMPLETED_STORAGE_KEY
        : DAILY_TASKS_COMPLETED_STORAGE_KEY;
  const routeHome = medicalPhysicsView
    ? '/studying-medical-physics'
    : workPlanningView
      ? '/work-planning'
      : personalView
        ? '/daily-task-personal'
        : '/daily-tasks';
  const routeCompleted = medicalPhysicsView
    ? '/studying-medical-physics/completed'
    : workPlanningView
      ? '/work-planning/completed'
      : personalView
        ? '/daily-task-personal/completed'
        : '/daily-tasks/completed';
  const markerId = medicalPhysicsView
    ? 'medical-physics-completed-marker'
    : workPlanningView
      ? 'work-planning-completed-marker'
      : personalView
        ? 'daily-personal-completed-marker'
        : 'dt4-completed-marker';
  const hostActiveId = medicalPhysicsView
    ? 'medical-physics-streams'
    : workPlanningView
      ? 'work-planning-streams'
      : personalView
        ? 'daily-personal-streams'
        : 'dt4-streams';
  const hostCompletedId = medicalPhysicsView
    ? 'medical-physics-completed-streams'
    : workPlanningView
      ? 'work-planning-completed-streams'
      : personalView
        ? 'daily-personal-completed-streams'
        : 'dt4-completed-streams';
  const workspaceLabel = medicalPhysicsView
    ? 'Studying medical physics'
    : workPlanningView
      ? 'Work planning'
      : personalView
        ? 'Daily task personal'
        : 'Daily tasks';

  const dtStyles = buildDailyTasksPanelStylesHtml();
  const boardCategories = medicalPhysicsView
    ? MEDICAL_PHYSICS_CATEGORIES
    : workPlanningView
      ? WORK_PLANNING_CATEGORIES
      : PERSONAL_BOARD_CATEGORIES;
  const defaultBoardCat = boardCategories[0][0];
  const boardCatLabels = Object.fromEntries(boardCategories.map(([slug, label]) => [slug, label]));
  const statusTabLabels = workPlanningView ? WORK_PLANNING_STATUS_TAB_LABELS : PERSONAL_STATUS_TAB_LABELS;

  const dtScript =
    '<script>' +
    `(function(){
  var KEY=${JSON.stringify(keyActive)};
  var DONE_KEY=${JSON.stringify(keyDone)};
  var ROUTE_HOME=${JSON.stringify(routeHome)};
  var ROUTE_COMPLETED=${JSON.stringify(routeCompleted)};
  var COMPLETED_MARKER_ID=${JSON.stringify(markerId)};
  var HOST_ACTIVE_ID=${JSON.stringify(hostActiveId)};
  var HOST_COMPLETED_ID=${JSON.stringify(hostCompletedId)};
  var WORKSPACE_LABEL=${JSON.stringify(workspaceLabel)};
  var IS_ALT_BOARD=${isPersonalStyleBoard ? 'true' : 'false'};
  var IS_PERSONAL_BOARD=${isPersonalStyleBoard ? 'true' : 'false'};
  var IS_WORK_PLANNING_BOARD=${workPlanningView ? 'true' : 'false'};
  var IS_MEDICAL_PHYSICS_BOARD=${medicalPhysicsView ? 'true' : 'false'};
  var DEFAULT_BOARD_CAT=${JSON.stringify(defaultBoardCat)};
  var BOARD_CAT_OPTIONS=${JSON.stringify(boardCategories)};
  var DT4_HOST_ID=HOST_ACTIVE_ID;
  var IS_COMPLETED_VIEW=false;
  var PERSONAL_CAT_LABELS=${JSON.stringify(boardCatLabels)};
  var STATUS_TAB_LABELS=${JSON.stringify(statusTabLabels)};
  function statusTabLabel(k){return STATUS_TAB_LABELS&&STATUS_TAB_LABELS[k]?STATUS_TAB_LABELS[k]:k;}
  function getDt4Host(){return document.getElementById(DT4_HOST_ID);}
  ${buildBoardStorePersistenceJs()}

  function nextId(){return 'x'+Date.now()+Math.random().toString(36).slice(2,9);}
  function today(){try{return new Date().toISOString().slice(0,10);}catch(e){return'';}}

  var ICON_PLUS='<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  var ICON_TRASH='<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14M10 11v6M14 11v6"/></svg>';
  var ICON_STREAM_DONE='<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L15 9"/></svg>';
  var ICON_NOTE_DEL='<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14M10 11v6M14 11v6"/></svg>';
  var ICON_NOTE_CLOSE='<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  var ICON_OUTCOME='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>';

  var STATUS_ORDER=['not_started','in_progress','done','not_completed'];
  var STATUS_ORDER_PERSONAL=['incomplete','next','complete'];
  var STATUS_LABEL={not_started:'Not started',in_progress:'In progress',done:'Done',not_completed:'Not completed',flagged:'Flagged',incomplete:'Incomplete',next:'Next',complete:'Complete'};
  var SVG_ST_TODO='<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="#94a3b8" stroke-width="2"/></svg>';
  var SVG_ST_PROG='<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="#d97706" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="#d97706"/></svg>';
  var SVG_ST_DONE='<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#16a34a"/><path d="M8 12l2.5 2.5L16 9" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
  var SVG_ST_SKIP='<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="#dc2626" stroke-width="2"/><path d="M8 12h8" stroke="#dc2626" stroke-width="2" stroke-linecap="round"/></svg>';
  var SVG_ST_FLAG='<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l2 7h8l2-7H5z" fill="#f59e0b" stroke="#d97706" stroke-width="1.2" stroke-linejoin="round"/><path d="M7 10v9a2 2 0 002 2h6a2 2 0 002-2v-9" fill="none" stroke="#d97706" stroke-width="1.8" stroke-linecap="round"/></svg>';
  function normPersonalStatus(st){
    var s=String(st||'').trim();
    if(s==='done')return 'complete';
    if(s==='flagged')return 'incomplete';
    if(s==='incomplete'||s==='next'||s==='complete')return s;
    return 'incomplete';
  }
  function personalItemFlagged(d){
    if(!d)return false;
    if(d.flagged===true||d.flagged===1||d.flagged==='1')return true;
    if(String(d.flagged||'').toLowerCase()==='true')return true;
    return String(d.status||'').trim()==='flagged';
  }
  function personalPrepareItem(d){
    if(!d)return d;
    d.flagged=personalItemFlagged(d);
    if(d.status!=null)d.status=normPersonalStatus(d.status);
    if(d.repeat!=null)d.repeat=normRepeat(d.repeat);
    return d;
  }
  var REPEAT_LABELS={daily:'Daily',weekly:'Weekly',monthly:'Once a month'};
  var ICON_REPEAT_DAILY='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var ICON_REPEAT_WEEKLY='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M8 2v4M16 2v4M7 15h2M11 15h2M15 15h2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var ICON_REPEAT_MONTHLY='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M8 2v4M16 2v4M12 15v4M12 15h-2M12 15h2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function normRepeat(r){
    var s=String(r||'').toLowerCase().trim();
    if(s==='month')return 'monthly';
    if(s==='daily'||s==='weekly'||s==='monthly')return s;
    return '';
  }
  function getRowRepeat(tr){
    if(!tr)return '';
    var inp=tr.querySelector('.dt4-l-repeat');
    return inp?normRepeat(inp.value):'';
  }
  function isRowRepeat(tr,kind){return getRowRepeat(tr)===kind;}
  function isFlatViewTab(t){return t==='flagged'||t==='next'||t==='daily'||t==='weekly'||t==='monthly';}
  function flatViewMatches(tr,tab){
    if(!tr||!tab)return false;
    if(tab==='flagged')return isRowFlagged(tr);
    if(tab==='next'){
      var sel=tr.querySelector('.dt4-l-status');
      var st=sel?normPersonalStatus(sel.value):'incomplete';
      return isPersonalNext(st);
    }
    return isRowRepeat(tr,tab);
  }
  function rowLineAmount(tr){
    if(!tr)return 0;
    if(tr.classList.contains('dt4-gym-line')||tr.classList.contains('dt4-gym-flat'))return 0;
    var inp=tr.querySelector('.dt4-l-amount');
    return inp?parseDt4Amount(inp.value):0;
  }
  function formatCadCurrency(n){
    var x=isFinite(n)?n:0;
    try{return new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'}).format(x);}
    catch(e){return '$'+x.toFixed(2);}
  }
  function setRowRepeat(tr,val){
    if(!tr)return;
    var v=normRepeat(val);
    var inp=tr.querySelector('.dt4-l-repeat');
    if(!inp){
      inp=document.createElement('input');
      inp.type='hidden';
      inp.className='dt4-l-repeat';
      var meta=tr.querySelector('.dt4-l-meta');
      if(meta)meta.appendChild(inp);
      else tr.appendChild(inp);
    }
    inp.value=v;
    syncRepeatBtns(tr);
  }
  function syncRepeatBtns(tr){
    if(!tr)return;
    var cur=getRowRepeat(tr);
    tr.querySelectorAll('.dt4-l-repeat-btn').forEach(function(btn){
      var k=btn.getAttribute('data-repeat');
      var on=k===cur;
      btn.classList.toggle('is-on',on);
      var lab=REPEAT_LABELS[k]||k;
      btn.title=on?('Remove '+lab+' — tap again'):('Mark as '+lab);
      btn.setAttribute('aria-label',btn.title);
      btn.setAttribute('aria-pressed',on?'true':'false');
    });
  }
  function makeRepeatBtn(kind){
    var icons={daily:ICON_REPEAT_DAILY,weekly:ICON_REPEAT_WEEKLY,monthly:ICON_REPEAT_MONTHLY};
    var btn=document.createElement('button');
    btn.type='button';
    btn.className='dt4-l-repeat-btn dt4-l-repeat-btn-'+kind;
    btn.setAttribute('data-repeat',kind);
    btn.innerHTML=icons[kind]||'';
    return btn;
  }
  function makeRepeatBtnGroup(){
    var wrap=document.createElement('span');
    wrap.className='dt4-l-repeat-group';
    wrap.setAttribute('aria-label','Repeat schedule');
    ['daily','weekly','monthly'].forEach(function(k){wrap.appendChild(makeRepeatBtn(k));});
    return wrap;
  }
  function isRowFlagged(tr){
    if(!tr)return false;
    var f=tr.querySelector('.dt4-l-flag');
    return !!(f&&(f.value==='1'||String(f.value).toLowerCase()==='true'));
  }
  function setRowFlagged(tr,on){
    if(!tr)return;
    var f=tr.querySelector('.dt4-l-flag');
    if(!f){
      f=document.createElement('input');
      f.type='hidden';
      f.className='dt4-l-flag';
      var meta=tr.querySelector('.dt4-l-meta');
      if(meta)meta.appendChild(f);
      else tr.appendChild(f);
    }
    f.value=on?'1':'0';
    tr.classList.toggle('dt4-line-flagged',!!on);
    var fb=tr.querySelector('.dt4-l-flag-btn');
    if(fb){
      fb.classList.toggle('is-on',!!on);
      fb.title=on?'Unflag — remove from flagged list':'Flag — mark for attention (keeps current status)';
      fb.setAttribute('aria-label',fb.title);
    }
  }
  function getStatusOrder(){return IS_PERSONAL_BOARD?STATUS_ORDER_PERSONAL:STATUS_ORDER;}
  function isPersonalComplete(st){return st==='complete';}
  function isPersonalNext(st){return st==='next';}
  function isPersonalIncomplete(st){return st==='incomplete';}
  function isPersonalActive(st){return isPersonalIncomplete(st)||isPersonalNext(st);}
  var ICON_FLAG_BTN='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4M5 4l7 2 7-2v13l-7 2-7-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  function makeFlagBtn(){
    var flagBtn=document.createElement('button');
    flagBtn.type='button';
    flagBtn.className='dt4-l-flag-btn';
    flagBtn.title='Flag — mark for attention (keeps current status)';
    flagBtn.setAttribute('aria-label','Flag task — independent of incomplete, next, or complete');
    flagBtn.innerHTML=ICON_FLAG_BTN;
    return flagBtn;
  }
  function makeStatusQuickSelect(val){
    var wrap=document.createElement('span');
    wrap.className='dt4-l-mark-actions';
    var q=document.createElement('select');
    q.className='dt4-l-status-quick';
    q.setAttribute('aria-label','Task status');
    var cur=normPersonalStatus(val);
    var pick='incomplete';
    if(cur==='next')pick='next';
    else if(cur==='complete')pick='complete';
    [['next','NEXT'],['complete','COMPLETE'],['undo','UNDO'],['incomplete','INCOMPLETE']].forEach(function(pr){
      var o=document.createElement('option');
      o.value=pr[0];
      o.textContent=pr[1];
      if(pr[0]===pick)o.selected=true;
      q.appendChild(o);
    });
    wrap.appendChild(q);
    return wrap;
  }
  function syncStatusQuick(row){
    var q=row.querySelector('.dt4-l-status-quick');
    var sel=row.querySelector('.dt4-l-status');
    if(!q||!sel)return;
    var cur=normPersonalStatus(sel.value);
    if(cur==='next')q.value='next';
    else if(cur==='complete')q.value='complete';
    else q.value='incomplete';
  }
  function applyQuickStatus(val){
    if(val==='undo')return 'incomplete';
    if(val==='next'||val==='complete'||val==='incomplete')return val;
    return 'incomplete';
  }
  function lineBlock(tr){
    var bl=[tr];
    var nid=tr.getAttribute('data-id');
    var nx=tr.nextElementSibling;
    if(nx&&nx.classList.contains('dt4-note-row')&&nx.getAttribute('data-for')===nid)bl.push(nx);
    return bl;
  }
  function clearStreamGroupHeaders(sec){
    var tb=sec&&sec.querySelector('tbody.dt4-lines-tbody');
    if(!tb)return;
    tb.querySelectorAll('tr.dt4-row-group-h').forEach(function(r){r.remove();});
  }
  function groupStreamRows(sec){
    var tb=sec.querySelector('tbody.dt4-lines-tbody');
    if(!tb)return;
    clearStreamGroupHeaders(sec);
    var blocks=[];
    tb.querySelectorAll('tr.dt4-line').forEach(function(tr){blocks.push(lineBlock(tr));});
    var inc=[],nxt=[],comp=[],rest=[];
    blocks.forEach(function(bl){
      var tr=bl[0];
      if(tr.classList.contains('dt4-filter-hidden')){rest.push(bl);return;}
      var sel=tr.querySelector('.dt4-l-status');
      var st=sel?normPersonalStatus(sel.value):'incomplete';
      if(st==='complete')comp.push(bl);
      else if(st==='next')nxt.push(bl);
      else inc.push(bl);
    });
    blocks.forEach(function(bl){bl.forEach(function(n){if(n.parentNode===tb)n.remove();});});
    function appendBlocks(arr){
      arr.forEach(function(bl){bl.forEach(function(n){tb.appendChild(n);});});
    }
    function appendHeader(label,cls){
      var hr=document.createElement('tr');
      hr.className='dt4-row-group-h '+cls;
      var td=document.createElement('td');
      td.colSpan=7;
      td.textContent=label;
      hr.appendChild(td);
      tb.appendChild(hr);
    }
    var groups=[];
    if(inc.length)groups.push({label:'Incomplete',cls:'dt4-row-group-inc',blocks:inc});
    if(nxt.length)groups.push({label:'Next',cls:'dt4-row-group-next',blocks:nxt});
    if(comp.length)groups.push({label:'Complete',cls:'dt4-row-group-done',blocks:comp});
    if(groups.length>1){
      groups.forEach(function(g){
        appendHeader(g.label,g.cls);
        appendBlocks(g.blocks);
      });
    }else if(groups.length===1){
      appendBlocks(groups[0].blocks);
    }
    appendBlocks(rest);
  }
  function queryAllStreams(){
    var seen=new Set();
    var out=[];
    function take(root){
      if(!root)return;
      root.querySelectorAll('details.dt4-stream').forEach(function(sec){
        if(seen.has(sec))return;
        seen.add(sec);
        out.push(sec);
      });
    }
    take(getDt4Host());
    take(document.getElementById('dt4-bucket-incomplete'));
    take(document.getElementById('dt4-bucket-complete'));
    return out;
  }
  function queryAllLines(){
    var out=[];
    queryAllStreams().forEach(function(sec){
      sec.querySelectorAll('tr.dt4-line').forEach(function(tr){
        if(tr.classList.contains('dt4-gym-in-stack'))return;
        out.push(tr);
      });
    });
    var stackBody=document.getElementById('dt4-done-stack-body');
    if(stackBody)stackBody.querySelectorAll('tr.dt4-line').forEach(function(tr){out.push(tr);});
    var flaggedBody=document.getElementById('dt4-flagged-stack-body');
    if(flaggedBody)flaggedBody.querySelectorAll('tr.dt4-line').forEach(function(tr){out.push(tr);});
    return out;
  }
  function doneOriginRow(sec){
    var hr=document.createElement('tr');
    hr.className='dt4-done-origin';
    var td=document.createElement('td');
    td.colSpan=7;
    var sc=sec.querySelector('.dt4-s-category');
    var ck=sc?String(sc.value||''):'';
    var catLab=ck&&PERSONAL_CAT_LABELS[ck]?PERSONAL_CAT_LABELS[ck]:'';
    var ti=sec.querySelector('.dt4-s-title');
    var title=(ti&&String(ti.value||'').trim())||'';
    td.textContent=(catLab?(catLab+' \u00b7 '):'')+(title||'Untitled stream');
    hr.appendChild(td);
    return hr;
  }
  function findStreamSection(sid){
    if(sid==null||sid==='')return null;
    var want=String(sid);
    var list=document.querySelectorAll('.dt4-personal-board details.dt4-stream,details.dt4-stream');
    for(var i=0;i<list.length;i++){
      if(String(list[i].getAttribute('data-id')||'')===want)return list[i];
    }
    return null;
  }
  function restoreRowsFromStack(){
    var body=document.getElementById('dt4-done-stack-body');
    if(!body||!body.querySelectorAll)return;
    var lines=[];
    body.querySelectorAll('tr.dt4-line').forEach(function(tr){lines.push(lineBlock(tr));});
    var stranded=[];
    lines.forEach(function(bl){
      var tr=bl[0];
      var sid=tr.getAttribute('data-dt4-stream');
      if(!sid){stranded.push(bl);return;}
      var sec=findStreamSection(sid);
      var tb=sec&&sec.querySelector('tbody.dt4-lines-tbody');
      if(!tb){stranded.push(bl);return;}
      bl.forEach(function(node){tb.appendChild(node);});
    });
    body.innerHTML='';
    if(stranded.length){
      var host=getDt4Host();
      var fallback=host&&host.querySelector('details.dt4-stream tbody.dt4-lines-tbody');
      if(fallback)stranded.forEach(function(bl){bl.forEach(function(node){fallback.appendChild(node);});});
    }
  }
  function findRichGymRow(id){
    if(!id)return null;
    return document.querySelector('.dt4-personal-board tr.dt4-gym-line[data-id="'+String(id)+'"]');
  }
  function gymFlatSubText(tr){
    if(!tr)return '';
    var reps=tr.querySelector('.dt4-l-reps');
    var sess=tr.querySelector('.dt4-l-session');
    var p=[];
    if(reps&&String(reps.value||'').trim())p.push(String(reps.value).trim()+' reps');
    if(sess&&String(sess.value||'').trim())p.push(String(sess.value).trim());
    return p.join(' \u00b7 ');
  }
  function syncGymFlatSub(tr){
    if(!tr)return;
    var sub=tr.querySelector('.dt4-gym-flat-sub');
    if(sub)sub.textContent=gymFlatSubText(tr);
  }
  function syncGymRichFromFlat(flat,rich){
    if(!flat||!rich)return;
    [['.dt4-l-machine'],['.dt4-l-weight'],['.dt4-l-reps'],['.dt4-l-session'],['.dt4-l-date']].forEach(function(pair){
      var f=flat.querySelector(pair[0]);
      var r=rich.querySelector(pair[0]);
      if(f&&r)r.value=f.value;
    });
    var stF=flat.querySelector('.dt4-l-status');
    var stR=rich.querySelector('.dt4-l-status');
    if(stF&&stR)stR.value=stF.value;
    setRowFlagged(rich,isRowFlagged(flat));
    setRowRepeat(rich,getRowRepeat(flat));
    var sec=rich.closest('.dt4-stream');
    if(sec)syncGymRowDelta(rich,sec);
    paintStatusBtn(rich);
  }
  function syncGymFlatPair(flat){
    if(!flat||!flat.classList.contains('dt4-gym-flat'))return;
    syncGymFlatSub(flat);
    var rich=findRichGymRow(flat.getAttribute('data-id'));
    if(rich)syncGymRichFromFlat(flat,rich);
  }
  function makeGymFlatStackRow(d,sid){
    d=d||{};
    if(IS_PERSONAL_BOARD)personalPrepareItem(d);
    var tr=document.createElement('tr');
    tr.className='dt4-line dt4-gym-flat';
    tr.setAttribute('data-id',d.id||nextId());
    tr.setAttribute('data-dt4-stream',sid||'');
    tr.setAttribute('data-gym-flat','1');
    var l2=document.createElement('label');
    l2.textContent='Status';
    var st=document.createElement('select');
    st.className='dt4-l-status';
    statusOptions(st,d.status);
    l2.appendChild(st);
    var meta=document.createElement('div');
    meta.className='dt4-l-meta';
    meta.appendChild(l2);
    var flg=document.createElement('input');
    flg.type='hidden';
    flg.className='dt4-l-flag';
    flg.value=d.flagged?'1':'0';
    meta.appendChild(flg);
    var rep=document.createElement('input');
    rep.type='hidden';
    rep.className='dt4-l-repeat';
    rep.value=d.repeat?normRepeat(d.repeat):'';
    meta.appendChild(rep);
    var repsH=document.createElement('input');
    repsH.type='hidden';
    repsH.className='dt4-l-reps';
    repsH.value=d.reps!=null?String(d.reps):'';
    meta.appendChild(repsH);
    var sessH=document.createElement('input');
    sessH.type='hidden';
    sessH.className='dt4-l-session';
    sessH.value=d.session!=null?String(d.session):'';
    meta.appendChild(sessH);
    var stBtn=document.createElement('button');
    stBtn.type='button';
    stBtn.className='dt4-l-status-ico';
    var act=document.createElement('details');
    act.className='dt4-l-act';
    var sm=document.createElement('summary');
    sm.className='dt4-l-more';
    sm.setAttribute('aria-label','Row actions');
    sm.textContent='\u22EE';
    var menu=document.createElement('div');
    menu.className='dt4-menu';
    var rm=document.createElement('button');
    rm.type='button';
    rm.className='dt4-remove-line';
    rm.textContent='Remove set';
    menu.appendChild(rm);
    act.appendChild(sm);
    act.appendChild(menu);
    var tdStatus=document.createElement('td');
    tdStatus.className='dt4-td-status';
    tdStatus.appendChild(stBtn);
    tdStatus.appendChild(makeFlagBtn());
    tdStatus.appendChild(makeRepeatBtnGroup());
    tdStatus.appendChild(makeStatusQuickSelect(d.status));
    var tdTask=document.createElement('td');
    tdTask.className='dt4-td-task';
    var taskCell=document.createElement('div');
    taskCell.className='dt4-task-cell dt4-gym-flat-task';
    var mac=document.createElement('input');
    mac.type='text';
    mac.className='dt4-l-machine';
    mac.placeholder='Machine';
    mac.maxLength=120;
    mac.value=d.machine!=null?String(d.machine):'';
    var sub=document.createElement('span');
    sub.className='dt4-gym-flat-sub';
    sub.textContent=gymFlatSubText(tr)||'';
    taskCell.appendChild(mac);
    taskCell.appendChild(sub);
    tdTask.appendChild(taskCell);
    var tdFn=document.createElement('td');
    tdFn.className='dt4-td-fn';
    var tdStream=document.createElement('td');
    tdStream.className='dt4-td-stream';
    var streamLab=document.createElement('span');
    streamLab.className='dt4-l-stream-label';
    tdStream.appendChild(streamLab);
    var tdDate=document.createElement('td');
    tdDate.className='dt4-td-date';
    var idt=document.createElement('input');
    idt.type='date';
    idt.className='dt4-l-date';
    idt.value=d.date||today();
    tdDate.appendChild(idt);
    var tdAmt=document.createElement('td');
    tdAmt.className='dt4-td-amt';
    var wt=document.createElement('input');
    wt.type='number';
    wt.min='0';
    wt.step='0.5';
    wt.inputMode='decimal';
    wt.className='dt4-l-weight';
    wt.setAttribute('aria-label','Weight in pounds');
    wt.placeholder='lb';
    wt.value=d.weight!=null&&String(d.weight).length?String(d.weight):'';
    tdAmt.appendChild(wt);
    var tdAct=document.createElement('td');
    tdAct.className='dt4-td-act';
    tdAct.appendChild(act);
    var tdMeta=document.createElement('td');
    tdMeta.className='dt4-l-meta-cell';
    tdMeta.appendChild(meta);
    tr.appendChild(tdStatus);
    tr.appendChild(tdTask);
    tr.appendChild(tdFn);
    tr.appendChild(tdStream);
    tr.appendChild(tdDate);
    tr.appendChild(tdAmt);
    tr.appendChild(tdAct);
    tr.appendChild(tdMeta);
    syncGymFlatSub(tr);
    paintStatusBtn(tr);
    return tr;
  }
  function restoreRowsFromFlaggedStack(){
    var body=document.getElementById('dt4-flagged-stack-body');
    if(!body||!body.querySelectorAll)return;
    body.querySelectorAll('tr.dt4-gym-flat').forEach(function(flat){
      var rich=findRichGymRow(flat.getAttribute('data-id'));
      if(rich)syncGymRichFromFlat(flat,rich);
      flat.remove();
    });
    document.querySelectorAll('tr.dt4-gym-in-stack').forEach(function(tr){
      tr.classList.remove('dt4-gym-in-stack');
    });
    var lines=[];
    body.querySelectorAll('tr.dt4-line').forEach(function(tr){lines.push(lineBlock(tr));});
    var stranded=[];
    lines.forEach(function(bl){
      var tr=bl[0];
      var sid=tr.getAttribute('data-dt4-stream');
      if(!sid){stranded.push(bl);return;}
      var sec=findStreamSection(sid);
      var tb=sec&&sec.querySelector('tbody.dt4-lines-tbody');
      if(!tb){stranded.push(bl);return;}
      bl.forEach(function(node){tb.appendChild(node);});
    });
    body.innerHTML='';
    if(stranded.length){
      var host=getDt4Host();
      var fallback=host&&host.querySelector('details.dt4-stream tbody.dt4-lines-tbody');
      if(fallback)stranded.forEach(function(bl){bl.forEach(function(node){fallback.appendChild(node);});});
    }
  }
  function formatFlaggedDateLabel(iso){
    if(!iso||!String(iso).trim())return 'No date';
    try{
      var d=new Date(String(iso)+'T12:00:00');
      if(isNaN(d.getTime()))return String(iso);
      return d.toLocaleDateString('en-CA',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
    }catch(e){return String(iso);}
  }

  function syncOutcomeIcon(row){
    var btn=row&&row.querySelector('.dt4-l-note-toggle');
    if(!btn)return;
    var nid=row.getAttribute('data-id');
    var nx=row.nextElementSibling;
    var has=false;
    if(nx&&nx.classList.contains('dt4-note-row')&&nx.getAttribute('data-for')===nid){
      var ta=nx.querySelector('.dt4-l-note');
      has=ta&&String(ta.value||'').trim().length>0;
    }
    btn.classList.toggle('dt4-outcome-has',has);
    btn.title=has?'Outcome — click to view or edit':'Outcome — click to add a note';
    btn.setAttribute('aria-label',btn.title);
  }

  function syncStatusPill(row){
    if(!IS_PERSONAL_BOARD)return;
    var pill=row.querySelector('.dt4-l-status-pill');
    if(pill)pill.remove();
  }
  function paintStatusBtn(row){
    var btn=row.querySelector('.dt4-l-status-ico');
    var sel=row.querySelector('.dt4-l-status');
    if(!btn||!sel)return;
    var v=sel.value||(IS_PERSONAL_BOARD?'incomplete':'not_started');
    if(IS_PERSONAL_BOARD)v=normPersonalStatus(v);
    var lab=STATUS_LABEL[v]||v;
    btn.setAttribute('aria-label','Status: '+lab+'. Click to change.');
    btn.title=lab+' — click to cycle';
    if(IS_PERSONAL_BOARD){
      var flagged=isRowFlagged(row);
      row.classList.toggle('dt4-line-flagged',flagged);
      row.classList.toggle('dt4-line-next',v==='next');
      row.classList.toggle('dt4-line-complete',v==='complete');
      var fb=row.querySelector('.dt4-l-flag-btn');
      if(fb)fb.classList.toggle('is-on',flagged);
      btn.className='dt4-l-status-ico'+(v==='complete'?' dt4-st-done':v==='next'?' dt4-st-progress':' dt4-st-todo');
      if(v==='complete')btn.innerHTML=SVG_ST_DONE;
      else if(v==='next')btn.innerHTML=SVG_ST_PROG;
      else btn.innerHTML=SVG_ST_TODO;
      syncRepeatBtns(row);
    }else{
      row.classList.remove('dt4-line-flagged');
      btn.className='dt4-l-status-ico'+(v==='done'?' dt4-st-done':v==='in_progress'?' dt4-st-progress':v==='not_completed'?' dt4-st-skip':' dt4-st-todo');
      if(v==='done')btn.innerHTML=SVG_ST_DONE;
      else if(v==='in_progress')btn.innerHTML=SVG_ST_PROG;
      else if(v==='not_completed')btn.innerHTML=SVG_ST_SKIP;
      else btn.innerHTML=SVG_ST_TODO;
    }
    syncStatusPill(row);
    syncStatusQuick(row);
  }

  function statusOptions(sel,val){
    var def=IS_PERSONAL_BOARD?'incomplete':'not_started';
    var pairs=IS_PERSONAL_BOARD?STATUS_ORDER_PERSONAL.map(function(k){return [k,STATUS_LABEL[k]];}):[['not_started','Not started'],['in_progress','In progress'],['done','Done'],['not_completed','Not completed']];
    var pick=IS_PERSONAL_BOARD?normPersonalStatus(val):val;
    pairs.forEach(function(pr){
      var o=document.createElement('option');
      o.value=pr[0];
      o.textContent=pr[1];
      if((pick||def)===pr[0])o.selected=true;
      sel.appendChild(o);
    });
  }

  function makeLineRow(d){
    d=d||{};
    if(IS_PERSONAL_BOARD)personalPrepareItem(d);
    var tr=document.createElement('tr');
    tr.className='dt4-line';
    tr.setAttribute('data-id',d.id||nextId());
    var tx=document.createElement('input');
    tx.type='text';
    tx.className='dt4-l-text';
    tx.placeholder='Task title';
    tx.maxLength=500;
    tx.value=d.text||'';
    var l2=document.createElement('label');
    l2.textContent='Status';
    var st=document.createElement('select');
    st.className='dt4-l-status';
    statusOptions(st,d.status);
    l2.appendChild(st);
    var meta=document.createElement('div');
    meta.className='dt4-l-meta';
    meta.appendChild(l2);
    if(IS_PERSONAL_BOARD){
      var flg=document.createElement('input');
      flg.type='hidden';
      flg.className='dt4-l-flag';
      flg.value=d.flagged?'1':'0';
      meta.appendChild(flg);
      var rep=document.createElement('input');
      rep.type='hidden';
      rep.className='dt4-l-repeat';
      rep.value=d.repeat?normRepeat(d.repeat):'';
      meta.appendChild(rep);
    }
    var stBtn=document.createElement('button');
    stBtn.type='button';
    stBtn.className='dt4-l-status-ico';
    var act=document.createElement('details');
    act.className='dt4-l-act';
    var sm=document.createElement('summary');
    sm.className='dt4-l-more';
    sm.setAttribute('aria-label','Row actions');
    sm.textContent='\u22EE';
    var menu=document.createElement('div');
    menu.className='dt4-menu';
    var rm=document.createElement('button');
    rm.type='button';
    rm.className='dt4-remove-line';
    rm.textContent='Remove line';
    menu.appendChild(rm);
    act.appendChild(sm);
    act.appendChild(menu);
    var tdStatus=document.createElement('td');
    tdStatus.className='dt4-td-status';
    tdStatus.appendChild(stBtn);
    if(IS_PERSONAL_BOARD){
      tdStatus.appendChild(makeFlagBtn());
      tdStatus.appendChild(makeRepeatBtnGroup());
      tdStatus.appendChild(makeStatusQuickSelect(d.status));
    }
    var tdTask=document.createElement('td');
    tdTask.className='dt4-td-task';
    var taskCell=document.createElement('div');
    taskCell.className='dt4-task-cell';
    var noteClose=document.createElement('button');
    noteClose.type='button';
    noteClose.className='dt4-l-note-close';
    noteClose.title='Close note';
    noteClose.setAttribute('aria-label','Close note panel');
    noteClose.innerHTML=ICON_NOTE_CLOSE;
    var noteToggle=document.createElement('button');
    noteToggle.type='button';
    noteToggle.className='dt4-l-note-toggle';
    noteToggle.title='Outcome — click to add a note (or click the task title)';
    noteToggle.setAttribute('aria-label','Outcome — click to add a note, or click the task title');
    noteToggle.innerHTML=ICON_OUTCOME;
    taskCell.appendChild(tx);
    taskCell.appendChild(noteClose);
    taskCell.appendChild(noteToggle);
    tdTask.appendChild(taskCell);
    var tdFn=document.createElement('td');
    tdFn.className='dt4-td-fn';
    var ifn=document.createElement('input');
    ifn.type='text';
    ifn.className='dt4-l-function';
    ifn.placeholder='Function';
    ifn.maxLength=120;
    ifn.setAttribute('aria-label','Function or role');
    ifn.value=d.function!=null?String(d.function):'';
    tdFn.appendChild(ifn);
    var tdStream=document.createElement('td');
    tdStream.className='dt4-td-stream';
    var streamLab=document.createElement('span');
    streamLab.className='dt4-l-stream-label';
    tdStream.appendChild(streamLab);
    var tdDate=document.createElement('td');
    tdDate.className='dt4-td-date';
    var idt=document.createElement('input');
    idt.type='date';
    idt.className='dt4-l-date';
    idt.setAttribute('aria-label','Task date');
    idt.value=d.date||today();
    tdDate.appendChild(idt);
    var tdAmt=document.createElement('td');
    tdAmt.className='dt4-td-amt';
    var iam=document.createElement('input');
    iam.type='number';
    iam.min='0';
    iam.step='0.01';
    iam.inputMode='decimal';
    iam.className='dt4-l-amount';
    iam.setAttribute('aria-label','Task amount in Canadian dollars');
    iam.placeholder='0.00';
    iam.value=d.amount!=null&&String(d.amount).length?String(d.amount):'';
    tdAmt.appendChild(iam);
    var tdAct=document.createElement('td');
    tdAct.className='dt4-td-act';
    tdAct.appendChild(act);
    var tdMeta=document.createElement('td');
    tdMeta.className='dt4-l-meta-cell';
    tdMeta.appendChild(meta);
    tr.appendChild(tdStatus);
    tr.appendChild(tdTask);
    tr.appendChild(tdFn);
    tr.appendChild(tdStream);
    tr.appendChild(tdDate);
    tr.appendChild(tdAmt);
    tr.appendChild(tdAct);
    tr.appendChild(tdMeta);
    if(IS_COMPLETED_VIEW){
      tx.readOnly=true;
      ifn.readOnly=true;
      idt.readOnly=true;
      iam.readOnly=true;
      st.disabled=true;
      noteClose.style.display='none';
      noteToggle.style.display='none';
      tdAct.style.display='none';
      stBtn.setAttribute('disabled','');
      stBtn.style.pointerEvents='none';
      stBtn.style.cursor='default';
      tr.querySelectorAll('.dt4-l-flag-btn,.dt4-l-repeat-btn,.dt4-l-status-quick').forEach(function(el){
        el.setAttribute('disabled','');
        el.style.pointerEvents='none';
      });
    }
    paintStatusBtn(tr);
    return tr;
  }

  function streamIsGym(sec){
    if(!IS_PERSONAL_BOARD||IS_WORK_PLANNING_BOARD||!sec)return false;
    var sc=sec.querySelector('.dt4-s-category');
    return sc&&String(sc.value||'')==='gym';
  }
  function parseGymWeight(v){
    var x=parseFloat(String(v||'').replace(/,/g,''));
    return isFinite(x)?x:null;
  }
  function gymMachineKey(name){
    return String(name||'').trim().toLowerCase();
  }
  function readGymBaselines(sec){
    var el=sec&&sec.querySelector('.dt4-s-gym-baselines');
    if(!el)return {};
    try{
      var o=JSON.parse(el.value||'{}');
      return o&&typeof o==='object'?o:{};
    }catch(e){return {};}
  }
  function writeGymBaselines(sec,obj){
    var el=sec&&sec.querySelector('.dt4-s-gym-baselines');
    if(el)el.value=JSON.stringify(obj||{});
  }
  function getGymBaseline(sec,key){
    if(!key)return null;
    var b=readGymBaselines(sec);
    return parseGymWeight(b[key]);
  }
  function gymLinesForStream(sec){
    var rows=[];
    if(!sec)return rows;
    var sid=sec.getAttribute('data-id');
    sec.querySelectorAll('tr.dt4-gym-line').forEach(function(tr){rows.push(tr);});
    if(sid){
      var flat=document.getElementById('dt4-flagged-stack-body');
      if(flat)flat.querySelectorAll('tr.dt4-gym-line').forEach(function(tr){
        if(String(tr.getAttribute('data-dt4-stream')||'')===String(sid))rows.push(tr);
      });
    }
    return rows;
  }
  function collectGymMachines(sec){
    var keys=[];
    var seen={};
    gymLinesForStream(sec).forEach(function(tr){
      var mac=tr.querySelector('.dt4-l-machine');
      var k=gymMachineKey(mac?mac.value:'');
      if(k&&!seen[k]){seen[k]=1;keys.push(k);}
    });
    return keys;
  }
  function syncGymTargetsList(sec){
    if(!sec||!streamIsGym(sec))return;
    var list=sec.querySelector('.dt4-gym-targets-list');
    if(!list)return;
    var baselines=readGymBaselines(sec);
    var machines=collectGymMachines(sec);
    list.innerHTML='';
    if(!machines.length){
      var empty=document.createElement('p');
      empty.className='dt4-gym-targets-empty';
      empty.textContent='Add a set with a machine name, then set your target weight here once.';
      list.appendChild(empty);
      return;
    }
    machines.forEach(function(k){
      var display=k;
      gymLinesForStream(sec).forEach(function(tr){
        var mac=tr.querySelector('.dt4-l-machine');
        if(gymMachineKey(mac?mac.value:'')===k&&mac&&String(mac.value||'').trim()){
          display=String(mac.value||'').trim();
        }
      });
      var row=document.createElement('div');
      row.className='dt4-gym-target-row';
      row.setAttribute('data-machine-key',k);
      var nm=document.createElement('span');
      nm.className='dt4-gym-target-name';
      nm.textContent=display;
      var inp=document.createElement('input');
      inp.type='number';
      inp.min='0';
      inp.step='0.5';
      inp.inputMode='decimal';
      inp.className='dt4-gym-target-inp';
      inp.setAttribute('aria-label','Target weight for '+display);
      var cur=baselines[k];
      inp.value=cur!=null&&isFinite(cur)?String(cur):'';
      if(IS_COMPLETED_VIEW)inp.readOnly=true;
      var unit=document.createElement('span');
      unit.className='dt4-gym-target-unit';
      unit.textContent='lb target';
      row.appendChild(nm);
      row.appendChild(inp);
      row.appendChild(unit);
      list.appendChild(row);
    });
  }
  function formatGymDelta(n){
    if(n==null||!isFinite(n))return '';
    var r=Math.round(n*10)/10;
    if(Math.abs(r)<0.05)return '0';
    return (r>0?'+':'')+String(r);
  }
  function gymRowsSorted(sec){
    var rows=gymLinesForStream(sec);
    rows.forEach(function(tr,i){
      tr.setAttribute('data-gym-ord',String(i));
    });
    rows.sort(function(a,b){
      var da=a.querySelector('.dt4-l-date');
      var db=b.querySelector('.dt4-l-date');
      var sa=da?String(da.value||''):'';
      var sb=db?String(db.value||''):'';
      if(sa!==sb)return sa.localeCompare(sb);
      return Number(a.getAttribute('data-gym-ord')||0)-Number(b.getAttribute('data-gym-ord')||0);
    });
    return rows;
  }
  function syncGymRowDelta(tr,sec){
    if(!tr||!sec)return;
    var deltaEl=tr.querySelector('.dt4-gym-delta');
    if(!deltaEl)return;
    var mac=tr.querySelector('.dt4-l-machine');
    var wt=tr.querySelector('.dt4-l-weight');
    var key=gymMachineKey(mac?mac.value:'');
    var cur=wt?parseGymWeight(wt.value):null;
    deltaEl.innerHTML='';
    deltaEl.className='dt4-gym-delta';
    if(!key||cur==null){
      deltaEl.textContent='—';
      return;
    }
    var prev=null;
    gymRowsSorted(sec).forEach(function(r){
      if(r===tr)return;
      var mk=gymMachineKey((r.querySelector('.dt4-l-machine')||{}).value);
      if(mk!==key)return;
      var w=r.querySelector('.dt4-l-weight');
      var pv=w?parseGymWeight(w.value):null;
      if(pv!=null)prev=pv;
    });
    var target=getGymBaseline(sec,key);
    if(prev==null){
      deltaEl.classList.add('dt4-gym-delta-first');
      if(target!=null){
        var d0=cur-target;
        deltaEl.textContent=formatGymDelta(d0)+' lb';
        deltaEl.title='Vs target '+target+' lb';
        if(Math.abs(d0)>=0.05){
          deltaEl.classList.add(d0>0?'dt4-gym-delta-up':'dt4-gym-delta-down');
        }
      }else{
        deltaEl.textContent='First';
        deltaEl.title='First log for this machine';
      }
      return;
    }
    var dLast=cur-prev;
    deltaEl.textContent=formatGymDelta(dLast)+' lb';
    deltaEl.title='Vs last set ('+prev+' lb)';
    if(dLast>0.05)deltaEl.classList.add('dt4-gym-delta-up');
    else if(dLast<-0.05)deltaEl.classList.add('dt4-gym-delta-down');
    if(target!=null){
      var dTgt=cur-target;
      if(Math.abs(dTgt)>=0.05){
        var sub=document.createElement('span');
        sub.className='dt4-gym-delta-sub';
        sub.textContent=formatGymDelta(dTgt)+' vs target';
        deltaEl.appendChild(sub);
      }
    }
  }
  function syncGymStream(sec){
    if(!sec||!streamIsGym(sec))return;
    syncGymTargetsList(sec);
    gymLinesForStream(sec).forEach(function(tr){syncGymRowDelta(tr,sec);});
  }
  function makeGymTargetsBar(d){
    var bar=document.createElement('div');
    bar.className='dt4-gym-targets';
    var hid=document.createElement('input');
    hid.type='hidden';
    hid.className='dt4-s-gym-baselines';
    var bas=d.gymBaselines&&typeof d.gymBaselines==='object'?d.gymBaselines:{};
    hid.value=JSON.stringify(bas);
    var h=document.createElement('p');
    h.className='dt4-gym-targets-h';
    h.textContent='Target weight (set once per machine)';
    var list=document.createElement('div');
    list.className='dt4-gym-targets-list';
    bar.appendChild(hid);
    bar.appendChild(h);
    bar.appendChild(list);
    return bar;
  }

  function makeGymLineRow(d){
    d=d||{};
    if(IS_PERSONAL_BOARD)personalPrepareItem(d);
    if(d.text&&!d.session)d.session=d.text;
    if(d.function&&!d.machine)d.machine=d.function;
    var tr=document.createElement('tr');
    tr.className='dt4-line dt4-gym-line';
    tr.setAttribute('data-id',d.id||nextId());
    var td=document.createElement('td');
    td.colSpan=7;
    td.className='dt4-gym-cell';
    var entry=document.createElement('div');
    entry.className='dt4-gym-entry';
    function gymField(lbl,inp){
      var f=document.createElement('div');
      f.className='dt4-gym-field';
      var lab=document.createElement('label');
      lab.textContent=lbl;
      f.appendChild(lab);
      f.appendChild(inp);
      return f;
    }
    var mac=document.createElement('input');
    mac.type='text';
    mac.className='dt4-l-machine';
    mac.placeholder='e.g. Leg press';
    mac.maxLength=120;
    mac.value=d.machine!=null?String(d.machine):'';
    var reps=document.createElement('input');
    reps.type='text';
    reps.className='dt4-l-reps';
    reps.placeholder='e.g. 3×12';
    reps.maxLength=80;
    reps.value=d.reps!=null?String(d.reps):'';
    var sess=document.createElement('input');
    sess.type='text';
    sess.className='dt4-l-session';
    sess.placeholder='e.g. Warm-up set';
    sess.maxLength=200;
    sess.value=d.session!=null?String(d.session):'';
    var idt=document.createElement('input');
    idt.type='date';
    idt.className='dt4-l-date';
    idt.setAttribute('aria-label','Workout date');
    idt.value=d.date||today();
    var wt=document.createElement('input');
    wt.type='number';
    wt.min='0';
    wt.step='0.5';
    wt.inputMode='decimal';
    wt.className='dt4-l-weight';
    wt.setAttribute('aria-label','Set weight in pounds');
    wt.placeholder='0';
    wt.value=d.weight!=null&&String(d.weight).length?String(d.weight):'';
    var deltaWrap=document.createElement('div');
    deltaWrap.className='dt4-gym-field dt4-gym-delta-field';
    var deltaLab=document.createElement('label');
    deltaLab.textContent='Change';
    var deltaSpan=document.createElement('span');
    deltaSpan.className='dt4-gym-delta';
    deltaSpan.textContent='—';
    deltaWrap.appendChild(deltaLab);
    deltaWrap.appendChild(deltaSpan);
    entry.appendChild(gymField('Machine',mac));
    entry.appendChild(gymField('Set weight (lb)',wt));
    entry.appendChild(gymField('Reps',reps));
    entry.appendChild(gymField('Session',sess));
    entry.appendChild(gymField('Date',idt));
    entry.appendChild(deltaWrap);
    var actions=document.createElement('div');
    actions.className='dt4-gym-entry-actions';
    var stBtn=document.createElement('button');
    stBtn.type='button';
    stBtn.className='dt4-l-status-ico';
    var st=document.createElement('select');
    st.className='dt4-l-status';
    st.setAttribute('aria-label','Status');
    statusOptions(st,d.status);
    st.style.display='none';
    var act=document.createElement('details');
    act.className='dt4-l-act';
    var sm=document.createElement('summary');
    sm.className='dt4-l-more';
    sm.setAttribute('aria-label','Row actions');
    sm.textContent='\u22EE';
    var menu=document.createElement('div');
    menu.className='dt4-menu';
    var rm=document.createElement('button');
    rm.type='button';
    rm.className='dt4-remove-line';
    rm.textContent='Remove set';
    menu.appendChild(rm);
    act.appendChild(sm);
    act.appendChild(menu);
    if(IS_PERSONAL_BOARD){
      actions.appendChild(makeFlagBtn());
      actions.appendChild(makeRepeatBtnGroup());
      actions.appendChild(makeStatusQuickSelect(d.status));
    }
    actions.appendChild(stBtn);
    actions.appendChild(st);
    actions.appendChild(act);
    entry.appendChild(actions);
    td.appendChild(entry);
    tr.appendChild(td);
    if(IS_PERSONAL_BOARD){
      var flgG=document.createElement('input');
      flgG.type='hidden';
      flgG.className='dt4-l-flag';
      flgG.value=d.flagged?'1':'0';
      tr.appendChild(flgG);
      var repG=document.createElement('input');
      repG.type='hidden';
      repG.className='dt4-l-repeat';
      repG.value=d.repeat?normRepeat(d.repeat):'';
      tr.appendChild(repG);
    }
    if(IS_COMPLETED_VIEW){
      mac.readOnly=true;
      wt.readOnly=true;
      reps.readOnly=true;
      sess.readOnly=true;
      idt.readOnly=true;
      st.disabled=true;
      stBtn.setAttribute('disabled','');
      stBtn.style.pointerEvents='none';
      actions.querySelectorAll('.dt4-l-flag-btn,.dt4-l-repeat-btn,.dt4-l-status-quick').forEach(function(el){
        el.setAttribute('disabled','');
        el.style.pointerEvents='none';
      });
    }
    paintStatusBtn(tr);
    return tr;
  }

  function appendGymPair(tbody,d){
    return tbody.appendChild(makeGymLineRow(d));
  }

  function appendLinePair(tbody,d,sec){
    var s=sec||tbody.closest('.dt4-stream');
    if(streamIsGym(s))return appendGymPair(tbody,d);
    return appendTaskPair(tbody,d);
  }

  function defaultLineData(sec){
    var sd=sec&&sec.querySelector('.dt4-s-date');
    var dv=sd&&sd.value?sd.value:today();
    var st=IS_PERSONAL_BOARD?'incomplete':'not_started';
    if(streamIsGym(sec))return {machine:'',weight:'',reps:'',session:'',date:dv,status:st};
    return {text:'',date:dv,status:st};
  }

  function syncNoteSummary(details,ta){
    var sum=details&&details.querySelector('.dt4-note-sum');
    if(!sum||!ta)return;
    var body=details.querySelector('.dt4-note-body');
    if(body&&body.classList.contains('dt4-note-log-only')){
      sum.textContent='Note';
      return;
    }
    if(details.open){
      sum.textContent='Note';
      return;
    }
    var v=String(ta.value||'').trim().replace(/\s+/g,' ');
    if(!v){sum.textContent='Note';return;}
    sum.textContent=(v.length>64?v.slice(0,61)+'\u2026':v);
  }

  function getNoteRowParts(row){
    if(!row)return null;
    var nid=row.getAttribute('data-id');
    var nx=row.nextElementSibling;
    if(!nx||!nx.classList.contains('dt4-note-row')||nx.getAttribute('data-for')!==nid)return null;
    var det=nx.querySelector('details.dt4-note-details');
    var ta=nx.querySelector('.dt4-l-note');
    if(!det)return null;
    return {nx:nx,det:det,ta:ta};
  }
  function focusNoteTa(ta){
    if(!ta)return;
    setTimeout(function(){
      try{ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length);}
      catch(err){ta.focus();}
    },0);
  }
  function openNoteForLine(row,focusTa){
    var p=getNoteRowParts(row);
    if(!p)return;
    var body=p.nx.querySelector('.dt4-note-body');
    if(body)body.classList.remove('dt4-note-log-only');
    p.nx.classList.add('dt4-note-open');
    p.det.open=true;
    row.classList.add('dt4-line-note-open');
    syncNoteSummary(p.det,p.ta);
    if(focusTa)focusNoteTa(p.ta);
  }
  function closeNoteForLine(row){
    var p=getNoteRowParts(row);
    if(!p)return;
    p.det.open=false;
    p.nx.classList.remove('dt4-note-open');
    row.classList.remove('dt4-line-note-open');
  }

  function makeNoteRowForLine(mainTr,d){
    d=d||{};
    var lineId=mainTr.getAttribute('data-id');
    var noteTr=document.createElement('tr');
    noteTr.className='dt4-note-row';
    noteTr.setAttribute('data-for',lineId||'');
    var td=document.createElement('td');
    td.className='dt4-note-cell';
    td.colSpan=8;
    var det=document.createElement('details');
    det.className='dt4-note-details';
    var sum=document.createElement('summary');
    sum.className='dt4-note-sum';
    sum.textContent='Note';
    var body=document.createElement('div');
    body.className='dt4-note-body';
    var logHint=document.createElement('p');
    logHint.className='dt4-note-log-hint';
    logHint.textContent='Click the note below to edit.';
    var logBar=document.createElement('div');
    logBar.className='dt4-note-log-bar';
    var delLogBtn=document.createElement('button');
    delLogBtn.type='button';
    delLogBtn.className='dt4-l-note-del';
    delLogBtn.title='Clear note';
    delLogBtn.setAttribute('aria-label','Clear note');
    delLogBtn.innerHTML=ICON_NOTE_DEL;
    logBar.appendChild(delLogBtn);
    var logDiv=document.createElement('div');
    logDiv.className='dt4-note-log';
    logDiv.setAttribute('tabindex','0');
    logDiv.setAttribute('role','button');
    logDiv.setAttribute('aria-label','Saved note — click or press Enter to edit');
    var editWrap=document.createElement('div');
    editWrap.className='dt4-note-edit';
    var ta=document.createElement('textarea');
    ta.className='dt4-l-note';
    ta.setAttribute('aria-label','Task note');
    ta.placeholder='Type your note, then tap Save.';
    ta.maxLength=2000;
    ta.value=d.note!=null?String(d.note):'';
    var actions=document.createElement('div');
    actions.className='dt4-note-actions';
    var delEdBtn=document.createElement('button');
    delEdBtn.type='button';
    delEdBtn.className='dt4-l-note-del';
    delEdBtn.title='Clear note';
    delEdBtn.setAttribute('aria-label','Clear note');
    delEdBtn.innerHTML=ICON_NOTE_DEL;
    var saveBtn=document.createElement('button');
    saveBtn.type='button';
    saveBtn.className='dt4-l-note-save';
    saveBtn.textContent='Save note';
    saveBtn.setAttribute('aria-label','Save note to this browser');
    actions.appendChild(delEdBtn);
    actions.appendChild(saveBtn);
    editWrap.appendChild(ta);
    editWrap.appendChild(actions);
    body.appendChild(logHint);
    body.appendChild(logBar);
    body.appendChild(logDiv);
    body.appendChild(editWrap);
    det.appendChild(sum);
    det.appendChild(body);
    td.appendChild(det);
    noteTr.appendChild(td);
    det.addEventListener('toggle',function(){
      if(!det.open){
        noteTr.classList.remove('dt4-note-open');
        var mainR=noteTr.previousElementSibling;
        if(mainR&&mainR.classList.contains('dt4-line'))mainR.classList.remove('dt4-line-note-open');
      }
    });
    if(IS_COMPLETED_VIEW){
      var v0=String(ta.value||'').trim();
      editWrap.style.display='none';
      logHint.style.display='none';
      logBar.style.display='none';
      if(v0){
        logDiv.textContent=ta.value;
        body.classList.add('dt4-note-log-only');
        noteTr.classList.add('dt4-note-open');
        det.open=true;
      }else{
        noteTr.style.display='none';
      }
      ta.readOnly=true;
      ta.style.display='none';
    }
    syncNoteSummary(det,ta);
    return noteTr;
  }

  function appendTaskPair(tbody,d){
    var main=makeLineRow(d);
    tbody.appendChild(main);
    tbody.appendChild(makeNoteRowForLine(main,d));
    syncOutcomeIcon(main);
    return main;
  }

  function removeNoteRowIfAny(mainTr){
    if(!mainTr)return;
    var nid=mainTr.getAttribute('data-id');
    var nx=mainTr.nextElementSibling;
    if(nx&&nx.classList.contains('dt4-note-row')&&nx.getAttribute('data-for')===nid)nx.remove();
  }

  function makeStreamSection(d){
    d=d||{};
    var det=document.createElement('details');
    det.className='dt4-stream';
    det.open=true;
    det.setAttribute('data-id',d.id||nextId());
    var streamCat=IS_PERSONAL_BOARD?String(d.category||DEFAULT_BOARD_CAT):'';
    var isGym=IS_PERSONAL_BOARD&&!IS_WORK_PLANNING_BOARD&&streamCat==='gym';
    if(isGym)det.classList.add('dt4-gym-stream');
    var sum=document.createElement('summary');
    sum.className='dt4-stream-summary';
    var chev=document.createElement('span');
    chev.className='dt4-sum-chev';
    chev.setAttribute('aria-hidden','true');
    chev.textContent='\u25BC';
    var txSpan=document.createElement('span');
    txSpan.className='dt4-sum-text';
    var sep=document.createElement('span');
    sep.className='dt4-sum-sep';
    sep.textContent='\u00a0\u00b7\u00a0';
    var ddSpan=document.createElement('span');
    ddSpan.className='dt4-sum-date';
    var amtSummary=document.createElement('span');
    amtSummary.className='dt4-sum-amount';
    var catSpan=document.createElement('span');
    catSpan.className='dt4-sum-cat';
    var metaSpan=document.createElement('span');
    metaSpan.className='dt4-sum-meta';
    sum.appendChild(chev);
    sum.appendChild(txSpan);
    sum.appendChild(sep);
    sum.appendChild(ddSpan);
    sum.appendChild(amtSummary);
    sum.appendChild(catSpan);
    sum.appendChild(metaSpan);
    var body=document.createElement('div');
    body.className='dt4-stream-body';
    var head=document.createElement('div');
    head.className='dt4-stream-head';
    var ltn=document.createElement('label');
    ltn.textContent=isGym?'Session name':'Stream name';
    var title=document.createElement('input');
    title.type='text';
    title.className='dt4-s-title';
    title.placeholder=isGym?'e.g. Push day':'e.g. Study block';
    title.maxLength=200;
    title.value=d.title||'';
    ltn.appendChild(title);
    var lsd=document.createElement('label');
    lsd.textContent='Stream date';
    var sdt=document.createElement('input');
    sdt.type='date';
    sdt.className='dt4-s-date';
    sdt.value=d.date||today();
    lsd.appendChild(sdt);
    var lam=document.createElement('label');
    lam.className='dt4-s-amount-wrap';
    lam.textContent='Stream total (CAD)';
    var sam=document.createElement('input');
    sam.type='number';
    sam.min='0';
    sam.step='0.01';
    sam.inputMode='decimal';
    sam.className='dt4-s-amount';
    sam.setAttribute('aria-label','Stream total in Canadian dollars — sum of task amounts');
    sam.setAttribute('title','Adds up every task amount in this stream');
    sam.placeholder='0.00';
    sam.readOnly=true;
    sam.value=d.amount!=null&&String(d.amount).length?String(d.amount):'';
    lam.appendChild(sam);
    var lcat=null;
    var scat=null;
    if(IS_PERSONAL_BOARD){
      lcat=document.createElement('label');
      lcat.textContent='Category';
      scat=document.createElement('select');
      scat.className='dt4-s-category';
      scat.setAttribute('aria-label','Personal category');
      BOARD_CAT_OPTIONS.forEach(function(pr){
        var o=document.createElement('option');
        o.value=pr[0];
        o.textContent=pr[1];
        if((d.category||DEFAULT_BOARD_CAT)===pr[0])o.selected=true;
        scat.appendChild(o);
      });
      lcat.appendChild(scat);
    }
    var act=document.createElement('div');
    act.className='dt4-stream-head-actions';
    if(IS_COMPLETED_VIEW){
      title.readOnly=true;
      sdt.readOnly=true;
      sam.readOnly=true;
      if(scat)scat.disabled=true;
      var bUn=document.createElement('button');
      bUn.type='button';
      bUn.className='dt4-stream-unlock';
      bUn.textContent='Unlock';
      bUn.setAttribute('aria-label','Move stream back to '+WORKSPACE_LABEL+' to edit');
      act.appendChild(bUn);
    }else{
    var bAdd=document.createElement('button');
    bAdd.type='button';
    bAdd.className='dt4-add-line dt4-iconbtn dt4-iconbtn-primary';
    bAdd.setAttribute('aria-label',isGym?'Add set':'Add line');
    bAdd.title=isGym?'Add set':'Add line';
    bAdd.innerHTML=ICON_PLUS;
    var bDone=document.createElement('button');
    bDone.type='button';
    bDone.className='dt4-stream-complete dt4-iconbtn';
    bDone.setAttribute('aria-label','Mark stream complete');
    bDone.title='Mark stream complete — moves here and opens Completed streams';
    bDone.innerHTML=ICON_STREAM_DONE;
    var bRm=document.createElement('button');
    bRm.type='button';
    bRm.className='dt4-remove-stream dt4-iconbtn dt4-iconbtn-danger';
    bRm.setAttribute('aria-label','Remove stream');
    bRm.title='Remove stream';
    bRm.innerHTML=ICON_TRASH;
    var bar=document.createElement('div');
    bar.className='dt4-iconbar';
    bar.setAttribute('role','group');
    bar.setAttribute('aria-label','Stream lines');
    bar.appendChild(bAdd);
    bar.appendChild(bDone);
    bar.appendChild(bRm);
    act.appendChild(bar);
    }
    head.appendChild(ltn);
    head.appendChild(lsd);
    if(!isGym)head.appendChild(lam);
    if(lcat)head.appendChild(lcat);
    head.appendChild(act);
    var wrap=document.createElement('div');
    wrap.className='dt4-table-wrap';
    var table=document.createElement('table');
    table.className='dt4-table';
    var thead=document.createElement('thead');
    var thr=document.createElement('tr');
    if(isGym){
      var thG=document.createElement('th');
      thG.className='dt4-th-gym';
      thG.colSpan=7;
      thG.textContent='Machine · Weight · Reps · Session · Date · Change';
      thr.appendChild(thG);
    }else{
      [['Status','dt4-th-status'],['Task',''],['Function','dt4-th-fn'],['Stream',''],['Date',''],['Amount','dt4-th-amt'],['','dt4-th-act']].forEach(function(col){
        var th=document.createElement('th');
        th.textContent=col[0];
        if(col[1])th.className=col[1];
        thr.appendChild(th);
      });
    }
    thead.appendChild(thr);
    var tbody=document.createElement('tbody');
    tbody.className='dt4-lines-tbody';
    var defSt=IS_PERSONAL_BOARD?'incomplete':'not_started';
    var lines=(d.items&&d.items.length)?d.items:[isGym?{machine:'',weight:'',reps:'',session:'',date:today(),status:defSt}:{text:'',date:today(),status:defSt}];
    if(isGym)lines.forEach(function(L){appendGymPair(tbody,L);});
    else lines.forEach(function(L){appendTaskPair(tbody,L);});
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    det.appendChild(sum);
    det.appendChild(body);
    body.appendChild(head);
    if(isGym)body.appendChild(makeGymTargetsBar(d));
    body.appendChild(wrap);
    if(isGym)syncGymStream(det);
    return det;
  }

  function readRowItem(row,streamDate,isGym){
    var lid=row.getAttribute('data-id');
    var st=row.querySelector('.dt4-l-status');
    var dt=row.querySelector('.dt4-l-date');
    if(!lid)return null;
    var defSt=IS_PERSONAL_BOARD?'incomplete':'not_started';
    var rawDate=dt?String(dt.value||''):'';
    if(isGym||row.classList.contains('dt4-gym-line')||row.classList.contains('dt4-gym-flat')){
      var mac=row.querySelector('.dt4-l-machine');
      var wt=row.querySelector('.dt4-l-weight');
      var reps=row.querySelector('.dt4-l-reps');
      var sess=row.querySelector('.dt4-l-session');
      var sessionVal=sess?String(sess.value||''):'';
      return{
        id:lid,
        machine:mac?String(mac.value||''):'',
        weight:wt?String(wt.value||''):'',
        reps:reps?String(reps.value||''):'',
        session:sessionVal,
        text:sessionVal,
        date:rawDate||streamDate,
        status:st?(IS_PERSONAL_BOARD?normPersonalStatus(st.value):String(st.value||defSt)):defSt,
        flagged:IS_PERSONAL_BOARD?isRowFlagged(row):false,
        repeat:IS_PERSONAL_BOARD?getRowRepeat(row):'',
        note:''
      };
    }
    var tx=row.querySelector('.dt4-l-text');
    var fnEl=row.querySelector('.dt4-l-function');
    var amtEl=row.querySelector('.dt4-l-amount');
    if(!tx)return null;
    var rawFn=fnEl?String(fnEl.value||''):'';
    var rawAmt=amtEl?String(amtEl.value||''):'';
    var note='';
    var nx=row.nextElementSibling;
    if(nx&&nx.classList.contains('dt4-note-row')&&nx.getAttribute('data-for')===lid){
      var nta=nx.querySelector('.dt4-l-note');
      if(nta)note=String(nta.value||'');
    }
    return{id:lid,text:String(tx.value||''),function:rawFn,date:rawDate||streamDate,amount:rawAmt,status:st?(IS_PERSONAL_BOARD?normPersonalStatus(st.value):String(st.value||defSt)):defSt,flagged:IS_PERSONAL_BOARD?isRowFlagged(row):false,repeat:IS_PERSONAL_BOARD?getRowRepeat(row):'',note:note};
  }
  function parseDt4Amount(v){
    var x=parseFloat(String(v||'').replace(/,/g,''));
    return isFinite(x)?x:0;
  }
  function formatDt4Amount(n){
    if(!isFinite(n)||n<=0)return '';
    var r=Math.round(n*100)/100;
    return Math.abs(r-Math.round(r))<1e-9?String(Math.round(r)):r.toFixed(2);
  }
  function sumStreamLineAmounts(sec){
    var sum=0;
    if(!sec)return sum;
    sec.querySelectorAll('tr.dt4-line').forEach(function(tr){
      var inp=tr.querySelector('.dt4-l-amount');
      if(inp)sum+=parseDt4Amount(inp.value);
    });
    return sum;
  }
  function upsertStreamItem(items,rec){
    if(!rec)return;
    var idx=-1;
    for(var i=0;i<items.length;i++){
      if(String(items[i].id)===String(rec.id)){idx=i;break;}
    }
    if(idx>=0)items[idx]=rec;else items.push(rec);
  }
  function readStreams(){
    var out=[];
    queryAllStreams().forEach(function(sec){
      var sid=sec.getAttribute('data-id');
      var ti=sec.querySelector('.dt4-s-title');
      var sd=sec.querySelector('.dt4-s-date');
      var sam=sec.querySelector('.dt4-s-amount');
      var scat=sec.querySelector('.dt4-s-category');
      var tbody=sec.querySelector('tbody.dt4-lines-tbody');
      if(!sid||!ti||!sd||!tbody)return;
      var items=[];
      var streamDate=String(sd.value||'');
      var isGym=IS_PERSONAL_BOARD&&!IS_WORK_PLANNING_BOARD&&scat&&String(scat.value||'')==='gym';
      tbody.querySelectorAll('tr.dt4-line').forEach(function(row){
        var rec=readRowItem(row,streamDate,isGym);
        if(rec)items.push(rec);
      });
      var gymBaselines={};
      if(isGym){
        var gbEl=sec.querySelector('.dt4-s-gym-baselines');
        if(gbEl){
          try{
            var gb=JSON.parse(gbEl.value||'{}');
            if(gb&&typeof gb==='object')gymBaselines=gb;
          }catch(gbErr){gymBaselines={};}
        }
      }
      var rec={id:sid,title:String(ti.value||''),date:String(sd.value||''),amount:sam?String(sam.value||''):'',category:scat?String(scat.value||DEFAULT_BOARD_CAT):'',items:items};
      if(isGym)rec.gymBaselines=gymBaselines;
      out.push(rec);
    });
    function mergeStackRows(stackBody){
      if(!stackBody)return;
      stackBody.querySelectorAll('tr.dt4-line').forEach(function(row){
        var sid=row.getAttribute('data-dt4-stream');
        if(!sid)return;
        var streamRec=null;
        for(var j=0;j<out.length;j++){
          if(String(out[j].id)===String(sid)){streamRec=out[j];break;}
        }
        if(!streamRec)return;
        var sec=findStreamSection(sid);
        var scat=sec&&sec.querySelector('.dt4-s-category');
        var isGym=IS_PERSONAL_BOARD&&!IS_WORK_PLANNING_BOARD&&scat&&String(scat.value||'')==='gym';
        var sd=sec&&sec.querySelector('.dt4-s-date');
        var streamDate=sd?String(sd.value||''):'';
        upsertStreamItem(streamRec.items,readRowItem(row,streamDate,isGym));
      });
    }
    mergeStackRows(document.getElementById('dt4-done-stack-body'));
    mergeStackRows(document.getElementById('dt4-flagged-stack-body'));
    return out;
  }

  function readCompleted(){
    if(_doneStoreCache!=null){
      return {streams:Array.isArray(_doneStoreCache.streams)?_doneStoreCache.streams:[]};
    }
    try{
      var r=localStorage.getItem(DONE_KEY);
      if(!r)return {streams:[]};
      var o=JSON.parse(r);
      return {streams:Array.isArray(o.streams)?o.streams:[]};
    }catch(e){return {streams:[]};}
  }
  function writeCompleted(obj){
    _doneStoreCache={version:1,streams:obj.streams||[]};
    boardStorePut(DONE_KEY,_doneStoreCache);
  }

  function tryMigrate(){
    try{
      if(localStorage.getItem(KEY))return;
      if(IS_ALT_BOARD)return;
      var v3=localStorage.getItem('thirdBrainDailyTasksV3');
      if(v3){
        var o=JSON.parse(v3);
        if(o&&Array.isArray(o.items)&&o.items.length){
          localStorage.setItem(KEY,JSON.stringify({version:4,streams:[{id:nextId(),title:'Imported',date:today(),items:o.items}]}));
          return;
        }
      }
      var raw=localStorage.getItem('thirdBrainDailyTasksV1');
      if(!raw)return;
      var data=JSON.parse(raw);
      if(data&&data.version===2&&Array.isArray(data.streams)){
        localStorage.setItem(KEY,JSON.stringify({version:4,streams:data.streams}));
        return;
      }
      if(data&&Array.isArray(data.tasks)){
        var td=today();
        localStorage.setItem(KEY,JSON.stringify({version:4,streams:[{id:nextId(),title:'Imported',date:td,items:data.tasks.map(function(t){
          return{id:String(t&&t.id||nextId()),text:String(t&&t.text!=null?t.text:''),date:td,status:(t&&t.done)?'done':'not_started'};
        })}]}));
      }
    }catch(e){}
  }

  function boot(){
    var host=getDt4Host();
    var addStream=document.getElementById('dt4-add-stream');
    var clearDone=document.getElementById('dt4-clear-done');
    if(!host){console.error('[Daily tasks] Missing stream host #'+DT4_HOST_ID);return;}
    if(!IS_COMPLETED_VIEW && !addStream){console.error('[Daily tasks] Missing #dt4-streams or #dt4-add-stream');return;}

    function save(){
      try{
        var streams=readStreams();
        if(IS_PERSONAL_BOARD){
          restoreRowsFromStack();
          restoreRowsFromFlaggedStack();
        }
        if(IS_COMPLETED_VIEW){
          var donePayload={version:1,streams:streams};
          _doneStoreCache=donePayload;
          boardStorePut(DONE_KEY,donePayload);
        }else{
          var activePayload={version:4,streams:streams};
          _activeStoreCache=activePayload;
          boardStorePut(KEY,activePayload);
        }
      }catch(e){}
    }
    function syncStreamSummaries(){
      queryAllStreams().forEach(function(det){
        var ti=det.querySelector('.dt4-s-title');
        var sd=det.querySelector('.dt4-s-date');
        var sam=det.querySelector('.dt4-s-amount');
        var sumAmt=det.querySelector('.dt4-sum-amount');
        var n=det.querySelectorAll('tr.dt4-line').length;
        var tx=det.querySelector('.dt4-sum-text');
        var dd=det.querySelector('.dt4-sum-date');
        var meta=det.querySelector('.dt4-sum-meta');
        var sumCat=det.querySelector('.dt4-sum-cat');
        var scat=det.querySelector('.dt4-s-category');
        var isGym=streamIsGym(det);
        var streamTitle=(ti&&String(ti.value||'').trim())||(isGym?'Untitled session':'Untitled stream');
        var rawD=(sd&&String(sd.value||''))||'';
        if(tx)tx.textContent=streamTitle;
        if(dd)dd.textContent=rawD||'\u2014';
        if(sam&&!isGym){
          var lineSum=sumStreamLineAmounts(det);
          sam.value=formatDt4Amount(lineSum);
        }
        if(sumAmt){
          if(isGym)sumAmt.textContent='';
          else if(sam){
            var pv=parseDt4Amount(sam.value);
            if(pv>0){
              try{sumAmt.textContent='\u00a0\u00b7\u00a0'+new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'}).format(pv);}catch(e2){sumAmt.textContent='\u00a0\u00b7\u00a0'+sam.value;}
            }else sumAmt.textContent='';
          }
        }
        if(meta)meta.textContent=isGym?('\u00a0\u00b7\u00a0'+String(n)+' set'+(n===1?'':'s')):('\u00a0\u00b7\u00a0'+String(n)+' task'+(n===1?'':'s'));
        if(sumCat&&IS_PERSONAL_BOARD){
          var ck=scat?String(scat.value||''):'';
          sumCat.textContent=ck&&PERSONAL_CAT_LABELS[ck]?('\u00a0\u00b7\u00a0'+PERSONAL_CAT_LABELS[ck]):'';
        }else if(sumCat)sumCat.textContent='';
        det.querySelectorAll('tr.dt4-line').forEach(function(tr){
          var sl=tr.querySelector('.dt4-l-stream-label');
          if(sl)sl.textContent=streamTitle;
        });
        if(isGym)syncGymStream(det);
      });
    }
    function syncMeta(){
      var streams=queryAllStreams();
      var ns=streams.length;
      var nl=queryAllLines().length;
      var b=document.getElementById('dt4-badge');
      if(b)b.textContent=ns?(String(nl)+' task'+(nl===1?'':'s')+' \u00b7 '+String(ns)+' stream'+(ns===1?'':'s')):'0 tasks';
    }
    function countPersonalAntenna(){
      var inc=0,nxt=0,comp=0,flg=0,daily=0,weekly=0,monthly=0,total=0;
      queryAllLines().forEach(function(tr){
        var sec=tr.closest('details.dt4-stream');
        if(!sec){
          var sid=tr.getAttribute('data-dt4-stream');
          if(sid)sec=document.querySelector('.dt4-personal-board details.dt4-stream[data-id="'+sid+'"]');
        }
        if(!sec||sec.classList.contains('dt4-cat-hidden'))return;
        total++;
        var sel=tr.querySelector('.dt4-l-status');
        var st=sel?normPersonalStatus(sel.value):'incomplete';
        if(st==='complete')comp++;
        else if(st==='next')nxt++;
        else inc++;
        if(isRowFlagged(tr))flg++;
        var rep=getRowRepeat(tr);
        if(rep==='daily')daily++;
        else if(rep==='weekly')weekly++;
        else if(rep==='monthly')monthly++;
      });
      return {inc:inc,next:nxt,complete:comp,flagged:flg,daily:daily,weekly:weekly,monthly:monthly,total:total};
    }
    function syncStatusAntennaBar(){
      if(!IS_PERSONAL_BOARD)return;
      var root=document.getElementById('dt4-status-antenna');
      if(!root)return;
      var c=countPersonalAntenna();
      var total=c.total>0?c.total:1;
      var map={active:c.inc,next:c.next,done:c.complete,flagged:c.flagged,daily:c.daily,weekly:c.weekly,monthly:c.monthly};
      root.querySelectorAll('.dt4-antenna-col').forEach(function(col){
        var key=col.getAttribute('data-tab');
        var n=map[key]!=null?map[key]:0;
        var wrap=col.querySelector('.dt4-antenna-bar-wrap');
        var bar=col.querySelector('.dt4-antenna-bar');
        var num=col.querySelector('.dt4-antenna-num');
        var pctEl=col.querySelector('.dt4-antenna-pct');
        var pct=total>0?Math.round((n/total)*100):0;
        if(bar)bar.style.height=(n>0?Math.max(4,pct):0)+'%';
        if(wrap){
          wrap.setAttribute('role','progressbar');
          wrap.setAttribute('aria-valuemin','0');
          wrap.setAttribute('aria-valuemax',String(total));
          wrap.setAttribute('aria-valuenow',String(n));
        }
        if(num)num.textContent=String(n);
        if(pctEl)pctEl.textContent=n>0?pct+'%':'';
        col.classList.toggle('is-active',tabState===key);
      });
    }
    function syncAllOutcomeIcons(){
      queryAllLines().forEach(syncOutcomeIcon);
    }
    function syncAllStatusPills(){
      if(!IS_PERSONAL_BOARD)return;
      queryAllLines().forEach(syncStatusPill);
    }
    function refresh(opts){
      save();
      syncMeta();
      syncStreamSummaries();
      syncAllOutcomeIcons();
      syncAllStatusPills();
      applyFilters(opts);
    }
    function isLightInput(el){
      if(!el||!el.classList)return false;
      return el.classList.contains('dt4-l-text')||
        el.classList.contains('dt4-l-function')||
        el.classList.contains('dt4-l-machine')||
        el.classList.contains('dt4-l-weight')||
        el.classList.contains('dt4-l-reps')||
        el.classList.contains('dt4-l-session')||
        el.classList.contains('dt4-l-amount')||
        el.classList.contains('dt4-s-title');
    }

    function applyLoadDisk(data){
      host.innerHTML='';
      host.classList.remove('dt4-readonly');
      host.style.display='';
      var streams=(data&&Array.isArray(data.streams))?data.streams:[];
      if(!streams.length)host.appendChild(makeStreamSection({title:'',date:today(),items:[],category:IS_PERSONAL_BOARD?DEFAULT_BOARD_CAT:''}));
      else streams.forEach(function(s){host.appendChild(makeStreamSection(s));});
      tabState='all';
      if(tabs){
        tabs.querySelectorAll('.dt4-tab').forEach(function(x){
          x.classList.remove('is-active');
          x.setAttribute('aria-selected','false');
        });
        var allTab=tabs.querySelector('.dt4-tab[data-tab="all"]');
        if(allTab){
          allTab.classList.add('is-active');
          allTab.setAttribute('aria-selected','true');
        }
      }
      refresh();
    }

    function loadDisk(){
      tryMigrate();
      host.innerHTML='<p style="padding:14px 20px;color:#64748b">Loading from database…</p>';
      boardStoreLoadKey(KEY,function(data){
        applyLoadDisk(data);
      });
      boardStoreLoadKey(DONE_KEY,function(){});
    }

    function loadCompletedDisk(){
      host.innerHTML='<p style="padding:14px 20px;color:#64748b">Loading from database…</p>';
      boardStoreLoadKey(DONE_KEY,function(data){
        host.innerHTML='';
        host.classList.add('dt4-readonly');
        var streams=(data&&Array.isArray(data.streams))?data.streams:[];
        if(!streams.length){
          host.innerHTML='<p id="dtc-empty" class="dtc-empty" style="margin:12px 0;color:#64748b">No completed streams yet. Mark a stream complete from '+WORKSPACE_LABEL+' (check icon on the stream).</p>';
          return;
        }
        streams.forEach(function(s){host.appendChild(makeStreamSection(s));});
        syncStreamSummaries();
        syncMeta();
        syncAllOutcomeIcons();
        applyFilters();
      });
    }

    function unlockCompletedStream(sec){
      var sid=sec.getAttribute('data-id');
      var list=readStreams();
      var ix=-1;
      for(var i=0;i<list.length;i++){
        if(String(list[i].id)===String(sid)){ix=i;break;}
      }
      if(ix<0)return;
      var picked=list.splice(ix,1)[0];
      writeCompleted({streams:list});
      var data=_activeStoreCache||boardStoreReadLocal(KEY);
      var as=(data&&Array.isArray(data.streams))?data.streams:[];
      as.push(picked);
      _activeStoreCache={version:4,streams:as};
      boardStorePut(KEY,_activeStoreCache);
      location.assign(ROUTE_HOME);
    }

    function archiveStream(sec){
      if(!confirm('Mark this stream as completed? It will move to Completed streams—you can unlock it there anytime.'))return;
      var streams=readStreams();
      var sid=sec.getAttribute('data-id');
      var idx=-1;
      for(var i=0;i<streams.length;i++){
        if(String(streams[i].id)===String(sid)){idx=i;break;}
      }
      if(idx<0)return;
      var moved=streams.splice(idx,1)[0];
      var comp=readCompleted();
      comp.streams.push(moved);
      writeCompleted(comp);
      if(!streams.length)streams.push({id:nextId(),title:'',date:today(),items:[{text:'',date:today(),status:'not_started'}]});
      _activeStoreCache={version:4,streams:streams};
      boardStorePut(KEY,_activeStoreCache);
      loadDisk();
      location.assign(ROUTE_COMPLETED);
    }

    if(!IS_COMPLETED_VIEW){
    addStream.addEventListener('click',function(){
      var cat=IS_PERSONAL_BOARD&&catTabState!=='all'?catTabState:DEFAULT_BOARD_CAT;
      host.appendChild(makeStreamSection({title:'',date:today(),items:[],category:IS_PERSONAL_BOARD?cat:''}));
      var ti=host.querySelector('.dt4-stream:last-child .dt4-s-title');
      if(ti)ti.focus();
      refresh();
    });
    }
    var tabs=document.getElementById('dt4-tabs');
    var searchEl=document.getElementById('dt4-search');
    var tabState='all';
    var catTabs=document.getElementById('dt4-cat-tabs');
    var catTabState='all';
    function reparentStreamsToMain(){
      var main=getDt4Host();
      if(!main)return;
      var inc=document.getElementById('dt4-bucket-incomplete');
      var comp=document.getElementById('dt4-bucket-complete');
      function pull(h){
        if(!h)return;
        while(h.firstChild)main.appendChild(h.firstChild);
      }
      pull(inc);
      pull(comp);
    }
    function syncTabMode(){
      var panel=document.querySelector('.dt4-personal-board');
      if(panel){
        panel.classList.toggle('dt4-tab-all',tabState==='all');
        panel.classList.toggle('dt4-tab-incomplete',tabState==='active');
        panel.classList.toggle('dt4-tab-next',tabState==='next');
        panel.classList.toggle('dt4-tab-done',tabState==='done');
        panel.classList.toggle('dt4-tab-flagged',tabState==='flagged');
        panel.classList.toggle('dt4-tab-flat',isFlatViewTab(tabState));
      }
    }
    function layoutCompleteStack(){
      restoreRowsFromStack();
      var stack=document.getElementById('dt4-done-stack');
      var main=getDt4Host();
      if(stack)stack.hidden=true;
      if(main&&!isFlatViewTab(tabState))main.style.display='';
    }
    function layoutFlaggedStack(){
      var stack=document.getElementById('dt4-flagged-stack');
      var body=document.getElementById('dt4-flagged-stack-body');
      var emptyEl=document.getElementById('dt4-flagged-empty');
      var totalEl=document.getElementById('dt4-flat-total');
      var main=getDt4Host();
      if(!IS_PERSONAL_BOARD||!isFlatViewTab(tabState)){
        restoreRowsFromFlaggedStack();
        if(stack)stack.hidden=true;
        if(emptyEl)emptyEl.hidden=true;
        if(totalEl)totalEl.hidden=true;
        if(main)main.style.display='';
        return;
      }
      restoreRowsFromFlaggedStack();
      if(main)main.style.display='none';
      if(stack){
        stack.hidden=false;
        if(tabState==='next')stack.setAttribute('aria-label',STATUS_TAB_LABELS.stackNextAria||'Boarding tasks by date');
        else if(tabState==='flagged')stack.setAttribute('aria-label','Flagged tasks by date');
        else stack.setAttribute('aria-label','Tasks by date');
      }
      var amtTh=stack&&stack.querySelector('.dt4-th-amt');
      if(amtTh)amtTh.textContent=tabState==='next'?'Amount (CAD)':'Amount';
      if(!body)return;
      var entries=[];
      queryAllStreams().forEach(function(sec){
        if(sec.classList.contains('dt4-cat-hidden'))return;
        var sid=sec.getAttribute('data-id');
        var streamDateEl=sec.querySelector('.dt4-s-date');
        var streamDate=streamDateEl?String(streamDateEl.value||''):'';
        sec.querySelectorAll('tr.dt4-line').forEach(function(tr){
          if(tr.classList.contains('dt4-filter-hidden'))return;
          if(tr.classList.contains('dt4-gym-in-stack'))return;
          if(!flatViewMatches(tr,tabState))return;
          var dateInp=tr.querySelector('.dt4-l-date');
          var dateKey=dateInp?String(dateInp.value||'').trim():'';
          if(tr.classList.contains('dt4-gym-line')){
            tr.classList.add('dt4-gym-in-stack');
            entries.push({isGym:true,data:readRowItem(tr,streamDate,true),sid:sid,dateKey:dateKey||''});
            return;
          }
          entries.push({bl:lineBlock(tr),sid:sid,dateKey:dateKey||''});
        });
      });
      entries.sort(function(a,b){
        if(!a.dateKey&&b.dateKey)return 1;
        if(a.dateKey&&!b.dateKey)return -1;
        var dc=b.dateKey.localeCompare(a.dateKey);
        if(dc!==0)return dc;
        if(a.isGym&&!b.isGym)return 1;
        if(!a.isGym&&b.isGym)return -1;
        return 0;
      });
      body.innerHTML='';
      var lastDate=null;
      var flatTotal=0;
      entries.forEach(function(ent){
        if(ent.dateKey!==lastDate){
          lastDate=ent.dateKey;
          var hr=document.createElement('tr');
          hr.className=tabState==='next'?'dt4-flat-date-h-next':'dt4-flagged-date-h';
          var td=document.createElement('td');
          td.colSpan=7;
          td.textContent=formatFlaggedDateLabel(ent.dateKey);
          hr.appendChild(td);
          body.appendChild(hr);
        }
        if(ent.isGym){
          body.appendChild(makeGymFlatStackRow(ent.data,ent.sid));
          return;
        }
        flatTotal+=rowLineAmount(ent.bl[0]);
        ent.bl.forEach(function(node){
          if(node.classList&&node.classList.contains('dt4-line')){
            node.setAttribute('data-dt4-stream',ent.sid);
            var sl=node.querySelector('.dt4-l-stream-label');
            if(sl)sl.textContent='';
          }
          body.appendChild(node);
        });
      });
      queryAllStreams().forEach(function(sec){
        if(!sec.classList.contains('dt4-cat-hidden')&&streamIsGym(sec))syncGymStream(sec);
      });
      if(emptyEl){
        emptyEl.hidden=entries.length>0;
        if(!entries.length){
          if(tabState==='flagged')emptyEl.textContent='No flagged tasks — use the flag button on a task to add one here.';
          else if(tabState==='next')emptyEl.textContent=STATUS_TAB_LABELS.emptyNext||'No boarding tasks — tap the status button until a task shows Boarding.';
          else if(tabState==='daily')emptyEl.textContent='No daily tasks — tap the sun icon on a task.';
          else if(tabState==='weekly')emptyEl.textContent='No weekly tasks — tap the week icon on a task.';
          else if(tabState==='monthly')emptyEl.textContent='No monthly tasks — tap the month icon on a task.';
          else emptyEl.textContent='No tasks for this filter.';
        }
      }
      if(totalEl){
        if(tabState==='next'){
          totalEl.hidden=entries.length===0;
          totalEl.innerHTML=(STATUS_TAB_LABELS.totalNext||'Boarding total (CAD):')+' <strong>'+formatCadCurrency(flatTotal)+'</strong>';
        }else{
          totalEl.hidden=true;
          totalEl.textContent='';
        }
      }
    }
    function layoutAllView(){
      var buckets=document.getElementById('dt4-all-buckets');
      if(buckets)buckets.hidden=true;
      reparentStreamsToMain();
      syncTabMode();
      if(!IS_PERSONAL_BOARD){
        queryAllStreams().forEach(clearStreamGroupHeaders);
        return;
      }
      queryAllStreams().forEach(function(sec){
        if(sec.classList.contains('dt4-cat-hidden')){
          clearStreamGroupHeaders(sec);
          return;
        }
        if(isFlatViewTab(tabState)){
          clearStreamGroupHeaders(sec);
        }else if(tabState==='all'||tabState==='active'||tabState==='done'){
          groupStreamRows(sec);
        }else{
          clearStreamGroupHeaders(sec);
        }
      });
    }
    function applyFilters(opts){
      opts=opts||{};
      var skipLayout=!!opts.skipLayout;
      var q=(searchEl&&String(searchEl.value||'').toLowerCase().trim())||'';
      if(IS_PERSONAL_BOARD){
        queryAllStreams().forEach(function(sec){
          var sc=sec.querySelector('.dt4-s-category');
          var cv=sc?String(sc.value||''):'';
          var okCat=catTabState==='all'||cv===catTabState;
          sec.classList.toggle('dt4-cat-hidden',!okCat);
        });
      }
      queryAllLines().forEach(function(tr){
        var sel=tr.querySelector('.dt4-l-status');
        var st=sel?sel.value:'';
        if(IS_PERSONAL_BOARD)st=normPersonalStatus(st);
        var tx=tr.querySelector('.dt4-l-text');
        var text=tx?String(tx.value||'').toLowerCase():'';
        var fnInp=tr.querySelector('.dt4-l-function');
        var fnS=fnInp?String(fnInp.value||'').toLowerCase():'';
        var amtInp=tr.querySelector('.dt4-l-amount');
        var amtS=amtInp?String(amtInp.value||'').toLowerCase():'';
        var macInp=tr.querySelector('.dt4-l-machine');
        var macS=macInp?String(macInp.value||'').toLowerCase():'';
        var repsInp=tr.querySelector('.dt4-l-reps');
        var repsS=repsInp?String(repsInp.value||'').toLowerCase():'';
        var sessInp=tr.querySelector('.dt4-l-session');
        var sessS=sessInp?String(sessInp.value||'').toLowerCase():'';
        var wtInp=tr.querySelector('.dt4-l-weight');
        var wtS=wtInp?String(wtInp.value||'').toLowerCase():'';
        var nid=tr.getAttribute('data-id');
        var nx=tr.nextElementSibling;
        var noteText='';
        if(nx&&nx.classList.contains('dt4-note-row')&&nx.getAttribute('data-for')===nid){
          var ta=nx.querySelector('.dt4-l-note');
          noteText=ta?String(ta.value||'').toLowerCase():'';
        }
        var okTab;
        if(IS_PERSONAL_BOARD){
          if(tabState==='all')okTab=true;
          else if(tabState==='active')okTab=isPersonalIncomplete(st);
          else if(tabState==='next')okTab=isPersonalNext(st);
          else if(tabState==='done')okTab=isPersonalComplete(st);
          else if(tabState==='flagged')okTab=isRowFlagged(tr);
          else if(tabState==='daily')okTab=isRowRepeat(tr,'daily');
          else if(tabState==='weekly')okTab=isRowRepeat(tr,'weekly');
          else if(tabState==='monthly')okTab=isRowRepeat(tr,'monthly');
          else okTab=true;
        }else{
          okTab=(tabState==='all')||(tabState==='active'&&st!=='done')||(tabState==='done'&&st==='done');
        }
        var okSearch=!q||text.indexOf(q)>=0||fnS.indexOf(q)>=0||noteText.indexOf(q)>=0||amtS.indexOf(q)>=0||macS.indexOf(q)>=0||repsS.indexOf(q)>=0||sessS.indexOf(q)>=0||wtS.indexOf(q)>=0;
        var show=okTab&&okSearch;
        tr.classList.toggle('dt4-filter-hidden',!show);
        if(nx&&nx.classList.contains('dt4-note-row')&&nx.getAttribute('data-for')===nid){
          nx.classList.toggle('dt4-filter-hidden',!show);
          if(!show){
            var d=nx.querySelector('details.dt4-note-details');
            if(d)d.open=false;
            nx.classList.remove('dt4-note-open');
            tr.classList.remove('dt4-line-note-open');
          }
        }
      });
      if(IS_PERSONAL_BOARD){
        queryAllStreams().forEach(function(sec){
          if(sec.classList.contains('dt4-cat-hidden'))return;
          var vis=0;
          sec.querySelectorAll('tr.dt4-line').forEach(function(tr){
            if(!tr.classList.contains('dt4-filter-hidden'))vis++;
          });
          sec.classList.toggle('dt4-stream-empty-tab',vis===0);
        });
      }
      if(IS_PERSONAL_BOARD)syncStatusAntennaBar();
      if(!skipLayout){
        layoutAllView();
        layoutCompleteStack();
        layoutFlaggedStack();
      }
    }
    var statusAntenna=document.getElementById('dt4-status-antenna');
    if(statusAntenna)statusAntenna.addEventListener('click',function(e){
      var col=e.target.closest('.dt4-antenna-col');
      if(!col||!tabs)return;
      var t=col.getAttribute('data-tab');
      if(!t)return;
      var btn=tabs.querySelector('.dt4-tab[data-tab="'+t+'"]');
      if(btn)btn.click();
    });
    if(tabs)tabs.addEventListener('click',function(e){
      var b=e.target.closest('.dt4-tab');
      if(!b)return;
      tabs.querySelectorAll('.dt4-tab').forEach(function(x){x.classList.remove('is-active');});
      b.classList.add('is-active');
      tabState=b.getAttribute('data-tab')||'all';
      applyFilters();
    });
    if(searchEl)searchEl.addEventListener('input',function(){applyFilters({skipLayout:true});});
    if(catTabs)catTabs.addEventListener('click',function(e){
      var b=e.target.closest('.dt4-cat-tab');
      if(!b||b.tagName==='A')return;
      catTabs.querySelectorAll('.dt4-cat-tab').forEach(function(x){
        x.classList.remove('is-active');
        x.setAttribute('aria-selected','false');
      });
      b.classList.add('is-active');
      b.setAttribute('aria-selected','true');
      catTabState=b.getAttribute('data-cat')||'all';
      applyFilters();
    });

    if(!IS_COMPLETED_VIEW && clearDone)clearDone.addEventListener('click',function(){
      var doneVal=IS_PERSONAL_BOARD?'complete':'done';
      queryAllLines().forEach(function(tr){
        var s=tr.querySelector('.dt4-l-status');
        if(s&&s.value===doneVal){
          removeNoteRowIfAny(tr);
          tr.remove();
        }
      });
      queryAllStreams().forEach(function(sec){
        var tb=sec.querySelector('tbody.dt4-lines-tbody');
        if(tb&&!tb.querySelectorAll('tr.dt4-line').length)appendLinePair(tb,defaultLineData(sec),sec);
      });
      refresh();
    });

    var clickRoot=IS_PERSONAL_BOARD?(document.querySelector('.dt4-personal-board')||host):host;
    clickRoot.addEventListener('click',function(e){
      var t=e.target;
      if(!t||!t.closest)return;
      if(IS_COMPLETED_VIEW){
        var unlk=t.closest('.dt4-stream-unlock');
        if(unlk){
          e.preventDefault();
          var secU=unlk.closest('.dt4-stream');
          if(secU)unlockCompletedStream(secU);
          return;
        }
        return;
      }
      var noteGo=t.closest('.dt4-l-note-toggle');
      if(noteGo){
        var row=noteGo.closest('tr.dt4-line');
        if(!row)return;
        e.preventDefault();
        var pGo=getNoteRowParts(row);
        if(!pGo)return;
        if(pGo.det.open&&pGo.nx.classList.contains('dt4-note-open')){
          closeNoteForLine(row);
          return;
        }
        openNoteForLine(row,true);
        return;
      }
      var noteCloseHit=t.closest('.dt4-l-note-close');
      if(noteCloseHit){
        e.preventDefault();
        var rowNc=noteCloseHit.closest('tr.dt4-line');
        if(rowNc)closeNoteForLine(rowNc);
        return;
      }
      var noteSave=t.closest('.dt4-l-note-save');
      if(noteSave){
        e.preventDefault();
        var nr=noteSave.closest('tr.dt4-note-row');
        if(!nr)return;
        var det=nr.querySelector('details.dt4-note-details');
        var ta=nr.querySelector('.dt4-l-note');
        if(det&&ta)syncNoteSummary(det,ta);
        var main=nr.previousElementSibling;
        if(main&&main.classList.contains('dt4-line'))syncOutcomeIcon(main);
        refresh();
        if(ta){
          try{ta.blur();}catch(err){}
        }
        var noteBody=nr.querySelector('.dt4-note-body');
        var logEl=nr.querySelector('.dt4-note-log');
        var trimmed=String(ta&&ta.value||'').trim();
        if(trimmed&&noteBody&&logEl){
          logEl.textContent=ta.value;
          noteBody.classList.add('dt4-note-log-only');
          if(det&&ta)syncNoteSummary(det,ta);
        }else if(main&&main.classList.contains('dt4-line')){
          closeNoteForLine(main);
        }
        return;
      }
      var noteDel=t.closest('.dt4-l-note-del');
      if(noteDel){
        e.preventDefault();
        if(!confirm('Clear this note?'))return;
        var nrD=noteDel.closest('tr.dt4-note-row');
        if(!nrD)return;
        var detD=nrD.querySelector('details.dt4-note-details');
        var taD=nrD.querySelector('.dt4-l-note');
        var noteBodyD=nrD.querySelector('.dt4-note-body');
        var logElD=nrD.querySelector('.dt4-note-log');
        if(taD)taD.value='';
        if(logElD)logElD.textContent='';
        if(noteBodyD)noteBodyD.classList.remove('dt4-note-log-only');
        if(detD&&taD)syncNoteSummary(detD,taD);
        var mainD=nrD.previousElementSibling;
        if(mainD&&mainD.classList.contains('dt4-line'))syncOutcomeIcon(mainD);
        refresh();
        if(taD){
          try{taD.blur();}catch(err){}
        }
        if(mainD&&mainD.classList.contains('dt4-line'))closeNoteForLine(mainD);
        return;
      }
      var noteLogGo=t.closest('.dt4-note-log');
      if(noteLogGo){
        e.preventDefault();
        var bodL=noteLogGo.closest('.dt4-note-body');
        if(bodL)bodL.classList.remove('dt4-note-log-only');
        var nLog=noteLogGo.closest('tr.dt4-note-row');
        var detL=nLog&&nLog.querySelector('details.dt4-note-details');
        var taEd=nLog&&nLog.querySelector('.dt4-l-note');
        if(detL&&taEd)syncNoteSummary(detL,taEd);
        if(taEd)focusNoteTa(taEd);
        return;
      }
      var taskCellHit=t.closest('.dt4-task-cell');
      if(taskCellHit){
        var rowTc=taskCellHit.closest('tr.dt4-line');
        if(rowTc){
          var onTitle=t.nodeType===1&&t.classList&&t.classList.contains('dt4-l-text');
          openNoteForLine(rowTc,!onTitle);
        }
        return;
      }
      var flagHit=t.closest('.dt4-l-flag-btn');
      if(flagHit){
        var rowF=flagHit.closest('tr.dt4-line');
        if(rowF){
          setRowFlagged(rowF,!isRowFlagged(rowF));
          paintStatusBtn(rowF);
          refresh();
        }
        return;
      }
      var repeatHit=t.closest('.dt4-l-repeat-btn');
      if(repeatHit){
        var rowR=repeatHit.closest('tr.dt4-line');
        var kind=repeatHit.getAttribute('data-repeat');
        if(rowR&&kind){
          setRowRepeat(rowR,getRowRepeat(rowR)===kind?'':kind);
          paintStatusBtn(rowR);
          refresh();
        }
        return;
      }
      var stHit=t.closest('.dt4-l-status-ico');
      if(stHit){
        var row=stHit.closest('tr.dt4-line');
        if(!row)return;
        var sel=row.querySelector('.dt4-l-status');
        if(!sel)return;
        var order=getStatusOrder();
        var cur=IS_PERSONAL_BOARD?normPersonalStatus(sel.value):sel.value;
        var ix=order.indexOf(cur);
        if(ix<0)ix=0;
        sel.value=order[(ix+1)%order.length];
        paintStatusBtn(row);
        refresh();
        return;
      }
      var addLine=t.closest('.dt4-add-line');
      if(addLine){
        var sec=addLine.closest('.dt4-stream');
        if(!sec)return;
        var tb=sec.querySelector('tbody.dt4-lines-tbody');
        if(!tb)return;
        var m=appendLinePair(tb,defaultLineData(sec),sec);
        var ed=m.querySelector('.dt4-l-machine')||m.querySelector('.dt4-l-weight')||m.querySelector('.dt4-l-session')||m.querySelector('.dt4-l-text');
        if(ed)ed.focus();
        if(sec&&streamIsGym(sec))syncGymStream(sec);
        refresh();
        return;
      }
      var rmLine=t.closest('.dt4-remove-line');
      if(rmLine){
        var actDet=rmLine.closest('details.dt4-l-act');
        if(actDet)actDet.open=false;
        var row=rmLine.closest('tr.dt4-line');
        if(row&&row.classList.contains('dt4-gym-flat')){
          var richRm=findRichGymRow(row.getAttribute('data-id'));
          var tbG=richRm&&richRm.parentElement;
          if(richRm&&tbG){
            if(tbG.querySelectorAll('tr.dt4-line').length>1){
              removeNoteRowIfAny(richRm);
              richRm.remove();
              row.remove();
            }else{
              var secG=richRm.closest('.dt4-stream');
              var sddG=secG&&secG.querySelector('.dt4-s-date');
              var macG=richRm.querySelector('.dt4-l-machine');
              var wtG=richRm.querySelector('.dt4-l-weight');
              var repsG=richRm.querySelector('.dt4-l-reps');
              var sessG=richRm.querySelector('.dt4-l-session');
              var dvG=richRm.querySelector('.dt4-l-date');
              var stG=richRm.querySelector('.dt4-l-status');
              if(macG)macG.value='';
              if(wtG)wtG.value='';
              if(repsG)repsG.value='';
              if(sessG)sessG.value='';
              if(dvG)dvG.value=sddG&&sddG.value?sddG.value:today();
              if(stG)stG.value='incomplete';
              syncGymFlatPair(row);
              paintStatusBtn(richRm);
            }
          }else row.remove();
          refresh();
          return;
        }
        var tb=row&&row.parentElement;
        if(!row||!tb)return;
        if(tb.querySelectorAll('tr.dt4-line').length>1){
          removeNoteRowIfAny(row);
          row.remove();
        }
        else{
          var sec=row.closest('.dt4-stream');
          var sdd=sec&&sec.querySelector('.dt4-s-date');
          var dv=row.querySelector('.dt4-l-date');
          var st=row.querySelector('.dt4-l-status');
          if(row.classList.contains('dt4-gym-line')){
            var mac=row.querySelector('.dt4-l-machine');
            var wt=row.querySelector('.dt4-l-weight');
            var reps=row.querySelector('.dt4-l-reps');
            var sess=row.querySelector('.dt4-l-session');
            if(mac)mac.value='';
            if(wt)wt.value='';
            if(reps)reps.value='';
            if(sess)sess.value='';
            if(dv)dv.value=sdd&&sdd.value?sdd.value:today();
            if(st)st.value=IS_PERSONAL_BOARD?'incomplete':'not_started';
          }else{
            var tx=row.querySelector('.dt4-l-text');
            var fv=row.querySelector('.dt4-l-function');
            var av=row.querySelector('.dt4-l-amount');
            if(tx)tx.value='';
            if(fv)fv.value='';
            if(st)st.value=IS_PERSONAL_BOARD?'incomplete':'not_started';
            if(dv)dv.value=sdd&&sdd.value?sdd.value:today();
            if(av)av.value='';
            paintStatusBtn(row);
            var nid=row.getAttribute('data-id');
            var nx=row.nextElementSibling;
            if(nx&&nx.classList.contains('dt4-note-row')&&nx.getAttribute('data-for')===nid){
              var ta=nx.querySelector('.dt4-l-note');
              var det=nx.querySelector('details.dt4-note-details');
              if(ta)ta.value='';
              if(det&&ta)syncNoteSummary(det,ta);
              if(det)det.open=false;
              nx.classList.remove('dt4-note-open');
              row.classList.remove('dt4-line-note-open');
              var nb=nx.querySelector('.dt4-note-body');
              if(nb)nb.classList.remove('dt4-note-log-only');
              var lg=nx.querySelector('.dt4-note-log');
              if(lg)lg.textContent='';
            }
            syncOutcomeIcon(row);
          }
          if(st)paintStatusBtn(row);
        }
        refresh();
        return;
      }
      var streamDone=t.closest('.dt4-stream-complete');
      if(streamDone){
        e.preventDefault();
        var secDone=streamDone.closest('.dt4-stream');
        if(!secDone)return;
        archiveStream(secDone);
        return;
      }
      var rmStream=t.closest('.dt4-remove-stream');
      if(rmStream){
        var sec=rmStream.closest('.dt4-stream');
        if(!sec)return;
        if(queryAllStreams().length<=1){alert('Keep at least one stream.');return;}
        if(!confirm('Remove this stream and all its lines?'))return;
        sec.remove();
        refresh();
      }
    });
    clickRoot.addEventListener('keydown',function(e){
      if(IS_COMPLETED_VIEW)return;
      if(e.key!=='Enter'&&e.key!==' ')return;
      var el=e.target;
      if(!el||!el.closest)return;
      var lg=el.closest('.dt4-note-log');
      if(!lg)return;
      e.preventDefault();
      var bodK=lg.closest('.dt4-note-body');
      if(bodK)bodK.classList.remove('dt4-note-log-only');
      var nKey=lg.closest('tr.dt4-note-row');
      var detK=nKey&&nKey.querySelector('details.dt4-note-details');
      var taK=nKey&&nKey.querySelector('.dt4-l-note');
      if(detK&&taK)syncNoteSummary(detK,taK);
      if(taK)focusNoteTa(taK);
    });
    clickRoot.addEventListener('input',function(e){
      if(IS_COMPLETED_VIEW)return;
      var t=e.target;
      if(!t||!t.classList)return;
      if(t.classList.contains('dt4-l-note')){
        var det=t.closest('details.dt4-note-details');
        if(det)syncNoteSummary(det,t);
        var nr=t.closest('tr.dt4-note-row');
        if(nr){
          var main=nr.previousElementSibling;
          if(main&&main.classList.contains('dt4-line'))syncOutcomeIcon(main);
        }
        save();
        return;
      }
      if(t.classList.contains('dt4-gym-target-inp')){
        var secT=t.closest('.dt4-stream');
        var rowT=t.closest('.dt4-gym-target-row');
        var keyT=rowT&&rowT.getAttribute('data-machine-key');
        if(secT&&keyT){
          var basT=readGymBaselines(secT);
          var vT=parseGymWeight(t.value);
          if(vT!=null)basT[keyT]=vT;
          else delete basT[keyT];
          writeGymBaselines(secT,basT);
          syncGymStream(secT);
        }
        save();
        return;
      }
      var flatGym=t.closest('tr.dt4-gym-flat');
      if(flatGym){
        syncGymFlatPair(flatGym);
        save();
        syncStreamSummaries();
        return;
      }
      if(isLightInput(t)){
        save();
        syncStreamSummaries();
        var secL=t.closest('.dt4-stream');
        if(secL&&streamIsGym(secL))syncGymStream(secL);
        return;
      }
      refresh();
    });
    clickRoot.addEventListener('blur',function(e){
      if(IS_COMPLETED_VIEW)return;
      var t=e.target;
      if(!t||!t.classList)return;
      var flatB=t.closest('tr.dt4-gym-flat');
      if(flatB){syncGymFlatPair(flatB);refresh();return;}
      if(t.classList.contains('dt4-gym-target-inp')){
        var secB=t.closest('.dt4-stream');
        if(secB&&streamIsGym(secB))syncGymStream(secB);
        refresh();
        return;
      }
      if(isLightInput(t))refresh();
    },true);
    clickRoot.addEventListener('change',function(e){
      if(IS_COMPLETED_VIEW)return;
      var t=e.target;
      if(!t||!t.classList)return;
      if(t.classList.contains('dt4-l-status-quick')){
        var rowQ=t.closest('tr.dt4-line');
        var selQ=rowQ&&rowQ.querySelector('.dt4-l-status');
        if(selQ){
          selQ.value=applyQuickStatus(t.value);
          paintStatusBtn(rowQ);
        }
        refresh();
        return;
      }
      if(t.classList.contains('dt4-l-status')){
        var row=t.closest('tr.dt4-line');
        if(row)paintStatusBtn(row);
      }
      refresh();
    });

    if(IS_COMPLETED_VIEW)loadCompletedDisk();
    else loadDisk();
  }

  (function initDt4Board(){
    if(document.getElementById(COMPLETED_MARKER_ID)){
      DT4_HOST_ID=HOST_COMPLETED_ID;
      IS_COMPLETED_VIEW=true;
    }else{
      DT4_HOST_ID=HOST_ACTIVE_ID;
      IS_COMPLETED_VIEW=false;
    }
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);
    else boot();
  })();
})();` +
    '<' +
    '/script>';

  if(completedShell){
    const completedTitle = medicalPhysicsView
      ? 'Completed studying medical physics streams'
      : workPlanningView
        ? 'Completed work planning streams'
        : personalView
          ? 'Completed daily task personal streams'
          : 'Completed streams';
    const completedSub = isPersonalStyleBoard
      ? 'Frozen snapshot when you completed each stream—same tasks, statuses, dates, amounts, and notes. Unlock returns a stream to ' +
        workspaceLabel +
        ' for editing.'
      : 'Frozen snapshot when you completed each stream—same tasks, statuses, dates, amounts, and notes. Unlock returns a stream to Daily tasks for editing.';
    const completedBackPill = isPersonalStyleBoard
      ? '<a class="link-pill" href="' + escAttr(routeHome) + '">' + escHtml(workspaceLabel) + '</a>'
      : '<a class="link-pill" href="/daily-tasks">Daily tasks</a>';
    return (
      '<div class="analytics-toolbar">' +
      '<div>' +
      '<h1>' +
      escHtml(completedTitle) +
      '</h1>' +
      '<p class="sub">' +
      escHtml(completedSub) +
      '</p>' +
      '</div>' +
      '<div class="analytics-toolbar-actions">' +
      '<a class="link-pill" href="/">Home</a>' +
      completedBackPill +
      '</div></div>' +
      '<div class="analytics-body">' +
      '<div class="analytics-panel dt4-panel">' +
      dtStyles +
      '<input type="hidden" id="' +
      escAttr(markerId) +
      '" value="1" />' +
      '<div id="' +
      escAttr(hostCompletedId) +
      '" aria-label="Completed streams" role="region"></div>' +
      dtScript +
      '</div></div>'
    );
  }

  if(isPersonalStyleBoard){
    const personalBoardTitle = escHtml(workspaceLabel);
    const personalCompletedHref = escAttr(routeCompleted);
    const personalOtherBoardPill = medicalPhysicsView
      ? '<a class="link-pill" href="/daily-task-personal">Daily task personal</a><a class="link-pill" href="/work-planning">Work planning</a>'
      : workPlanningView
        ? '<a class="link-pill" href="/daily-task-personal">Daily task personal</a><a class="link-pill" href="/studying-medical-physics">Studying medical physics</a>'
        : '<a class="link-pill" href="/work-planning">Work planning</a><a class="link-pill" href="/studying-medical-physics">Studying medical physics</a>';
    return (
      '<div class="analytics-toolbar">' +
      '<div>' +
      '<h1>' +
      personalBoardTitle +
      '</h1>' +
      '</div>' +
      '<div class="analytics-toolbar-actions">' +
      '<a class="link-pill" href="/">Home</a>' +
      '<a class="link-pill" href="/daily-tasks">Daily tasks</a>' +
      personalOtherBoardPill +
      '<a class="link-pill" href="' +
      personalCompletedHref +
      '">Completed streams</a>' +
      '<a class="link-pill" href="/todolist">Todo list</a>' +
      '<a class="link-pill" href="/priority">Priority</a>' +
      '<a class="link-pill" href="/current-situation">Current situation</a>' +
      '</div></div>' +
      '<div class="analytics-body">' +
      '<div class="analytics-panel dt4-panel dt4-personal-board">' +
      dtStyles +
      '<div class="dt4-pagehead">' +
      '<div class="dt4-pagehead-left">' +
      '<span class="dt4-board-title">Tasks</span>' +
      '<span id="dt4-badge" class="dt4-badge" aria-live="polite">0 tasks</span>' +
      '</div>' +
      '<div class="dt4-pagehead-right">' +
      '<button type="button" id="dt4-add-stream" class="dt4-btn-add">+ Add stream</button>' +
      '<button type="button" id="dt4-clear-done" class="dt4-btn-icon" title="Remove completed tasks" aria-label="Remove completed tasks">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 14a2 2 0 002 1.8h8a2 2 0 002-1.8L19 7M10 11v5M14 11v5"/></svg>' +
      '</button></div></div>' +
      (workPlanningView
        ? buildWorkPlanningCatTabsHtml()
        : medicalPhysicsView
          ? buildMedicalPhysicsCatTabsHtml(routeHome)
          : buildPersonalCatTabsHtml()) +
      '<p class="dt4-cat-hint">' +
      escHtml(
        medicalPhysicsView
          ? 'Study track — your stream lives here'
          : 'Destination line — your stream lives here'
      ) +
      '</p>' +
      buildPersonalStatusFiltersHtml(statusTabLabels) +
      '<div class="dt4-filters">' +
      '<input type="search" id="dt4-search" class="dt4-search" placeholder="Search task title" autocomplete="off" />' +
      '</div>' +
      '<div id="dt4-flagged-stack" class="dt4-flagged-stack" hidden aria-label="Flagged tasks by date">' +
      '<div class="dt4-flagged-stack-inner">' +
      '<table class="dt4-table dt4-flagged-flat"><thead><tr>' +
      '<th class="dt4-th-status">Status</th><th>Task</th><th>Date</th><th class="dt4-th-amt">Amount</th><th></th>' +
      '</tr></thead><tbody id="dt4-flagged-stack-body"></tbody></table>' +
      '<p id="dt4-flagged-empty" class="dt4-flagged-empty" hidden>No flagged tasks yet.</p>' +
      '<p id="dt4-flat-total" class="dt4-flat-total" hidden aria-live="polite"></p>' +
      '</div></div>' +
      '<div id="dt4-done-stack" class="dt4-done-stack" hidden aria-label="Completed tasks">' +
      '<div class="dt4-done-stack-inner">' +
      '<table class="dt4-table dt4-done-flat"><thead><tr>' +
      '<th class="dt4-th-status">Status</th><th>Task</th><th>Date</th><th></th>' +
      '</tr></thead><tbody id="dt4-done-stack-body"></tbody></table>' +
      '</div></div>' +
      '<div id="dt4-all-buckets" class="dt4-all-buckets" hidden>' +
      '<section class="dt4-bucket">' +
      '<h3 class="dt4-bucket-h">Incomplete</h3>' +
      '<div id="dt4-bucket-incomplete" class="dt4-bucket-host" aria-label="Incomplete tasks"></div>' +
      '</section>' +
      '<section class="dt4-bucket">' +
      '<h3 class="dt4-bucket-h dt4-bucket-h-complete">Complete</h3>' +
      '<div id="dt4-bucket-complete" class="dt4-bucket-host" aria-label="Complete tasks"></div>' +
      '</section>' +
      '</div>' +
      '<div id="' +
      escAttr(hostActiveId) +
      '" class="dt4-host-flat" aria-label="Streams"></div>' +
      dtScript +
      '</div></div>'
    );
  }

  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Daily tasks</h1>' +
    '<p class="sub">Task-style dashboard: tabs, search, and a table per stream—saved in MongoDB (migrates from this browser on first load).</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/daily-tasks/completed">Completed streams</a>' +
    '<a class="link-pill" href="/todolist">Todo list</a>' +
    '<a class="link-pill" href="/daily-task-personal">Daily task personal</a>' +
    '<a class="link-pill" href="/work-planning">Work planning</a>' +
    '<a class="link-pill" href="/priority">Priority</a>' +
    '<a class="link-pill" href="/current-situation">Current situation</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel dt4-panel">' +
    dtStyles +
    '<div class="dt4-pagehead">' +
    '<div class="dt4-pagehead-left">' +
    '<span class="dt4-board-title">Tasks</span>' +
    '<span id="dt4-badge" class="dt4-badge" aria-live="polite">0 tasks</span>' +
    '</div>' +
    '<div class="dt4-pagehead-right">' +
    '<button type="button" id="dt4-add-stream" class="dt4-btn-add">+ Add stream</button>' +
    '<button type="button" id="dt4-clear-done" class="dt4-btn-icon" title="Remove completed tasks" aria-label="Remove completed tasks">' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 14a2 2 0 002 1.8h8a2 2 0 002-1.8L19 7M10 11v5M14 11v5"/></svg>' +
    '</button></div></div>' +
    '<div class="dt4-tabs" id="dt4-tabs" role="tablist" aria-label="Task status">' +
    '<button type="button" class="dt4-tab is-active" data-tab="all" role="tab">All</button>' +
    '<button type="button" class="dt4-tab" data-tab="active" role="tab">Active</button>' +
    '<button type="button" class="dt4-tab" data-tab="done" role="tab">Done</button>' +
    '</div>' +
    '<div class="dt4-filters">' +
    '<input type="search" id="dt4-search" class="dt4-search" placeholder="Search task title" autocomplete="off" />' +
    '</div>' +
    '<div id="' +
    escAttr(hostActiveId) +
    '" aria-label="Streams"></div>' +
    dtScript +
    '</div></div>'
  );
}

function buildDailyTasksCompletedStreamsHtml() {
  return buildDailyTasksWorkspaceHtml({ completedView: true });
}

function buildDailyTasksPersonalWorkspaceHtml() {
  return buildDailyTasksWorkspaceHtml({ personalView: true });
}

function buildDailyTasksPersonalCompletedStreamsHtml() {
  return buildDailyTasksWorkspaceHtml({ completedView: true, personalView: true });
}

function buildWorkPlanningWorkspaceHtml() {
  return buildDailyTasksWorkspaceHtml({ workPlanningView: true });
}

function buildWorkPlanningCompletedStreamsHtml() {
  return buildDailyTasksWorkspaceHtml({ completedView: true, workPlanningView: true });
}

function buildStudyingMedicalPhysicsWorkspaceHtml() {
  return buildDailyTasksWorkspaceHtml({ medicalPhysicsView: true });
}

function buildStudyingMedicalPhysicsCompletedStreamsHtml() {
  return buildDailyTasksWorkspaceHtml({ completedView: true, medicalPhysicsView: true });
}

function getTlListStyles() {
  return (
    '<style>' +
    '.tl-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.tl-dayhead{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 18px;}' +
    '.tl-dayhead h2{margin:0;font-size:1.35rem;font-weight:800;color:#0f172a;}' +
    '.tl-dayhead p{margin:0;font-size:13px;color:#64748b;}' +
    '.tl-hint{margin:0 0 16px;font-size:14px;color:#475569;line-height:1.55;max-width:52em;}' +
    '.tl-top-split{display:grid;gap:20px;margin:0 0 20px;}@media(min-width:900px){.tl-top-split{grid-template-columns:1fr minmax(260px,340px);align-items:start;}}' +
    '.tl-overview-col{border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;background:linear-gradient(180deg,#fafafa,#fff);}' +
    '.tl-overview-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 4px;}' +
    '.tl-overview-head h3{margin:0;flex:1;font-size:15px;font-weight:800;color:#0f172a;}' +
    '.tl-overview-toggles{display:inline-flex;gap:6px;flex-shrink:0;}' +
    '.tl-overview-toggle{width:32px;height:32px;padding:0;border-radius:50%;border:1px solid #e2e8f0;background:#fff;color:#64748b;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background .15s,border-color .15s,color .15s;}' +
    '.tl-overview-toggle svg{width:16px;height:16px;display:block;pointer-events:none;}' +
    '.tl-overview-toggle:hover{background:#f0fdfa;border-color:#99f6e4;color:#0f766e;}' +
    '.tl-overview-toggle:disabled{opacity:0.35;cursor:default;pointer-events:none;}' +
    '.tl-overview-col.is-collapsed .tl-overview-body{display:none;}' +
    '.tl-overview-now{margin:0 0 14px;font-size:12px;color:#64748b;line-height:1.4;}' +
    '.tl-overview-now strong{color:#0d9488;font-weight:700;}' +
    '.tl-route{display:flex;flex-direction:column;gap:0;}' +
    '.tl-stop{display:grid;grid-template-columns:4.75rem 1.25rem 1fr;gap:0 10px 0;align-items:start;padding:0 0 18px;position:relative;cursor:pointer;}' +
    '.tl-stop:last-child{padding-bottom:0;}' +
    '.tl-stop-time{font-size:13px;font-weight:700;color:#0f172a;font-variant-numeric:tabular-nums;padding-top:2px;}' +
    '.tl-stop-track{display:flex;flex-direction:column;align-items:center;min-height:100%;position:relative;}' +
    '.tl-stop-dot{width:12px;height:12px;border-radius:50%;border:2px solid #94a3b8;background:#fff;flex-shrink:0;z-index:1;box-sizing:border-box;}' +
    '.tl-stop-line{position:absolute;top:14px;bottom:-18px;left:50%;width:2px;margin-left:-1px;background:#cbd5e1;}' +
    '.tl-stop:last-child .tl-stop-line{display:none;}' +
    '.tl-stop-body{min-width:0;padding-top:0;}' +
    '.tl-stop-title{font-size:14px;font-weight:700;color:#0f172a;line-height:1.35;margin:0 0 4px;word-break:break-word;}' +
    '.tl-stop-meta{font-size:12px;color:#64748b;line-height:1.35;margin:0;}' +
    '.tl-stop-gap{grid-column:2/4;font-size:11px;color:#94a3b8;padding:2px 0 10px 22px;}' +
    '.tl-stop.is-current .tl-stop-time{color:#0d9488;}' +
    '.tl-stop.is-current .tl-stop-dot{border-color:#0d9488;background:#0d9488;box-shadow:0 0 0 4px rgba(13,148,136,0.2);width:14px;height:14px;}' +
    '.tl-stop.is-current .tl-stop-title{color:#0f766e;}' +
    '.tl-stop.is-current .tl-stop-line{background:#0d9488;}' +
    '.tl-stop.is-done .tl-stop-time,.tl-stop.is-done .tl-stop-title{color:#94a3b8;}' +
    '.tl-stop.is-done .tl-stop-title{text-decoration:line-through;}' +
    '.tl-stop.is-done .tl-stop-dot{border-color:#cbd5e1;background:#f1f5f9;}' +
    '.tl-stop.is-skipped .tl-stop-title{text-decoration:line-through;color:#94a3b8;}' +
    '@keyframes tl-progress-pulse{0%,100%{transform:scale(1);box-shadow:0 0 0 4px rgba(37,99,235,0.2);}50%{transform:scale(1.1);box-shadow:0 0 0 10px rgba(37,99,235,0.08);}}' +
    '@keyframes tl-now-pulse{0%,100%{opacity:1;}50%{opacity:0.55;}}' +
    '.tl-stop.is-in-progress .tl-stop-time{color:#1d4ed8;}' +
    '.tl-stop.is-in-progress .tl-stop-dot{border-color:#2563eb;background:#2563eb;width:14px;height:14px;animation:tl-progress-pulse 1.6s ease-in-out infinite;}' +
    '.tl-stop.is-in-progress .tl-stop-title{color:#1e40af;}' +
    '.tl-stop.is-in-progress .tl-stop-meta{color:#3b82f6;font-weight:600;}' +
    '.tl-overview-now.is-in-progress-active strong{animation:tl-now-pulse 1.6s ease-in-out infinite;}' +
    '@media(prefers-reduced-motion:reduce){.tl-stop.is-in-progress .tl-stop-dot,.tl-overview-now.is-in-progress-active strong{animation:none;}}' +
    '.tl-overview-empty{margin:0;font-size:13px;color:#94a3b8;line-height:1.5;}' +
    '.tl-add{display:grid;gap:12px;grid-template-columns:1fr;}@media(min-width:720px){.tl-add{grid-template-columns:1fr 7rem 9.5rem auto;align-items:end;}}@media(min-width:900px){.tl-top-split .tl-add{grid-template-columns:1fr;}}' +
    '.tl-field label{display:block;font-size:12px;font-weight:700;color:#475569;margin:0 0 6px;}' +
    '.tl-field input,.tl-field select{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;font:inherit;font-size:14px;color:#0f172a;background:#fff;}' +
    '.tl-field input:focus,.tl-field select:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,0.15);}' +
    '.tl-btn-add{padding:10px 18px;border:none;border-radius:10px;background:#0d9488;color:#fff;font:inherit;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;box-shadow:0 2px 8px rgba(13,148,136,0.25);}' +
    '.tl-btn-add:hover{background:#0f766e;}' +
    '.tl-row-notes td{padding:0 12px 12px;border-bottom:1px solid #f1f5f9;background:#fafafa;vertical-align:top;}' +
    '.tl-row-notes:last-child td{border-bottom:none;}' +
    '.tl-task-notes-panel{border:1px solid #e2e8f0;border-radius:10px;background:#fff;overflow:hidden;}' +
    '.tl-notes{border:1px solid #e2e8f0;border-radius:10px;background:#fff;overflow:hidden;}' +
    '.tl-notes summary{display:flex;align-items:center;gap:8px;padding:12px 14px;font-size:13px;font-weight:700;color:#334155;cursor:pointer;list-style:none;user-select:none;}' +
    '.tl-notes summary::-webkit-details-marker{display:none;}' +
    '.tl-notes summary::before{content:"";display:inline-block;width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;border-left:6px solid #64748b;transition:transform .15s ease;}' +
    '.tl-notes[open] summary::before{transform:rotate(90deg);}' +
    '.tl-notes summary:hover{background:#f1f5f9;}' +
    '.tl-notes-body{padding:0 14px 14px;}' +
    '.tl-notes-field{width:100%;min-height:72px;box-sizing:border-box;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;font-size:13px;line-height:1.5;color:#0f172a;background:#fff;resize:vertical;}' +
    '.tl-notes-field:focus{outline:none;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,0.15);}' +
    '.tl-day-notes-section{margin-top:24px;}' +
    '.tl-day-notes{border:1px solid #e2e8f0;border-radius:10px;background:#fafafa;overflow:hidden;}' +
    '.tl-day-notes summary{display:flex;align-items:center;gap:8px;padding:12px 14px;font-size:13px;font-weight:700;color:#334155;cursor:pointer;list-style:none;user-select:none;}' +
    '.tl-day-notes summary::-webkit-details-marker{display:none;}' +
    '.tl-day-notes summary::before{content:"";display:inline-block;width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;border-left:6px solid #64748b;transition:transform .15s ease;}' +
    '.tl-day-notes[open] summary::before{transform:rotate(90deg);}' +
    '.tl-day-notes summary:hover{background:#f1f5f9;}' +
    '.tl-day-notes .tl-notes-body{padding:0 14px 14px;}' +
    '.tl-day-notes .tl-notes-field{min-height:100px;font-size:14px;}' +
    '.tl-notes-hint{margin:8px 0 0;font-size:11px;color:#94a3b8;}' +
    '.tl-filters{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 14px;}' +
    '.tl-filter{border:1px solid #e2e8f0;background:#f8fafc;color:#475569;border-radius:999px;padding:8px 14px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;}' +
    '.tl-filter.is-active{background:#0d9488;border-color:#0d9488;color:#fff;}' +
    '.tl-table-wrap{overflow:auto;border:1px solid #e5e7eb;border-radius:10px;}' +
    '.tl-table{width:100%;border-collapse:collapse;min-width:560px;font-size:14px;}' +
    '.tl-table th{text-align:left;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#334155;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;}' +
    '.tl-table th:nth-child(1){width:6.5rem;}' +
    '.tl-table th:nth-child(3){width:9.5rem;}' +
    '.tl-table th:nth-child(4){width:8.75rem;text-align:right;}' +
    '.tl-table td{padding:10px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle;}' +
    '.tl-table td.tl-td-actions{text-align:right;padding:10px 12px;white-space:nowrap;}' +
    '.tl-table tr:last-child td{border-bottom:none;}' +
    '.tl-table tr.tl-row-done td{opacity:0.72;}' +
    '.tl-table tr.tl-row-done .tl-task-text{text-decoration:line-through;color:#64748b;}' +
    '.tl-table tr.tl-row-focus td{background:#ecfdf5 !important;}' +
    '.tl-task-text,.tl-task-time,.tl-task-status{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;}' +
    '.tl-task-time{max-width:7rem;font-variant-numeric:tabular-nums;}' +
    '.tl-task-status{max-width:9.5rem;}' +
    '.tl-view-text{color:#0f172a;line-height:1.4;}' +
    '.tl-view-time{font-variant-numeric:tabular-nums;color:#64748b;font-size:13px;white-space:nowrap;}' +
    '.tl-view-empty{color:#cbd5e1;font-style:italic;}' +
    '.tl-actions{display:inline-flex;gap:6px;align-items:center;justify-content:flex-end;}' +
    '.tl-icon-btn{width:32px;height:32px;padding:0;border-radius:50%;border:1px solid #e2e8f0;background:#fff;color:#64748b;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:background .15s,border-color .15s,color .15s,box-shadow .15s;}' +
    '.tl-icon-btn svg{width:15px;height:15px;display:block;pointer-events:none;}' +
    '.tl-icon-btn:hover{background:#f8fafc;border-color:#cbd5e1;color:#334155;}' +
    '.tl-icon-btn.tl-edit:hover{background:#f0fdfa;border-color:#99f6e4;color:#0f766e;}' +
    '.tl-icon-btn.tl-done:hover{background:#ecfdf5;border-color:#86efac;color:#16a34a;}' +
    '.tl-icon-btn.tl-done.is-active,.tl-icon-btn.tl-done:disabled{background:#ecfdf5;border-color:#bbf7d0;color:#16a34a;opacity:1;cursor:default;}' +
    '.tl-icon-btn.tl-remove:hover{background:#fef2f2;border-color:#fecaca;color:#b91c1c;}' +
    '.tl-icon-btn.tl-notes-btn:hover{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8;}' +
    '.tl-icon-btn.tl-notes-btn.is-open{background:#ecfdf5;border-color:#5eead4;color:#0f766e;box-shadow:0 0 0 3px rgba(13,148,136,0.12);}' +
    '.tl-icon-btn.tl-notes-btn.has-content{position:relative;}' +
    '.tl-icon-btn.tl-notes-btn.has-content::after{content:"";position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:#0d9488;border:1.5px solid #fff;}' +
    '.tl-icon-btn.tl-save{background:#0d9488;border-color:#0d9488;color:#fff;}' +
    '.tl-icon-btn.tl-save:hover{background:#0f766e;border-color:#0f766e;color:#fff;}' +
    '.tl-icon-btn.tl-cancel:hover{background:#f1f5f9;color:#475569;}' +
    '.tl-empty{margin:0;padding:24px 16px;text-align:center;color:#94a3b8;font-size:14px;}' +
    '.tl-badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;}' +
    '.tl-badge-not_started{background:#f1f5f9;color:#475569;}' +
    '.tl-badge-in_progress{background:#eff6ff;color:#1d4ed8;}' +
    '.tl-badge-done{background:#ecfdf5;color:#166534;}' +
    '.tl-badge-skipped{background:#fff7ed;color:#c2410c;}' +
    '</style>'
  );
}

function buildTodolistWorkspaceHtml() {
  const statusOpts = TODOLIST_STATUSES.map(
    ([v, lab]) => '<option value="' + escAttr(v) + '">' + escHtml(lab) + '</option>'
  ).join('');
  const tlStyles = getTlListStyles();
  const tlScript =
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var _tlCache=null;' +
    'var SK=' +
    JSON.stringify(TODOLIST_STORAGE_KEY) +
    ';' +
    'var STATUSES=' +
    JSON.stringify(TODOLIST_STATUSES) +
    ';' +
    'var STATUS_MAP={};STATUSES.forEach(function(p){STATUS_MAP[p[0]]=p[1];});' +
    'var SVG_PENCIL=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>\';' +
    'var SVG_TRASH=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>\';' +
    'var SVG_NOTE=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>\';' +
    'var SVG_CHECK=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>\';' +
    'var SVG_MARK_DONE=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9" stroke-linecap="round" stroke-linejoin="round"/></svg>\';' +
    'var SVG_X=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>\';' +
    'function makeIconBtn(cls,label,svg){var b=document.createElement("button");b.type="button";b.className="tl-icon-btn "+cls;b.setAttribute("aria-label",label);b.innerHTML=svg;return b;}' +
    'var filterState="all";' +
    'var editingId=null;' +
    'var tbody=document.getElementById("tl-tbody");' +
    'var emptyEl=document.getElementById("tl-empty");' +
    'var dayEl=document.getElementById("tl-day-label");' +
    'var dayPicker=document.getElementById("tl-day-picker");' +
    'var addText=document.getElementById("tl-add-text");' +
    'var addTime=document.getElementById("tl-add-time");' +
    'var addStatus=document.getElementById("tl-add-status");' +
    'var addBtn=document.getElementById("tl-add-btn");' +
    'var overviewCol=document.getElementById("tl-overview-col");' +
    'var overviewHost=document.getElementById("tl-overview-host");' +
    'var overviewNow=document.getElementById("tl-overview-now");' +
    'var overviewCollapseBtn=document.getElementById("tl-overview-collapse");' +
    'var overviewExpandBtn=document.getElementById("tl-overview-expand");' +
    'var notesPanel=document.getElementById("tl-notes-panel");' +
    'var notesField=document.getElementById("tl-day-notes");' +
    'var notesSaveTimer=null;' +
    'var selectedDate=null;' +
    'var taskNotesSaveTimers={};' +
    'if(!tbody)return;' +
    'function today(){try{return new Date().toISOString().slice(0,10);}catch(e){return"";}}' +
    'function isIsoDate(d){return /^\\d{4}-\\d{2}-\\d{2}$/.test(String(d||""));}' +
    'function formatDayLabel(d){try{var dt=new Date(d+"T12:00:00");return dt.toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric",year:"numeric"});}catch(e){return d;}}' +
    'function nextId(){return"x"+Date.now()+Math.random().toString(36).slice(2,9);}' +
    'function normStatus(s){var v=String(s||"").trim();for(var i=0;i<STATUSES.length;i++){if(STATUSES[i][0]===v)return v;}return"not_started";}' +
    'function normTask(t){if(!t||typeof t!=="object")return t;if(typeof t.notes!=="string")t.notes="";if(typeof t.notesOpen!=="boolean")t.notesOpen=false;return t;}' +
    'function defaultStore(){return{version:2,days:{}};}' +
    'function normDay(d){if(!d||typeof d!=="object")return{tasks:[],notes:"",notesOpen:false,overviewCollapsed:false};if(!Array.isArray(d.tasks))d.tasks=[];if(typeof d.notes!=="string")d.notes="";if(typeof d.notesOpen!=="boolean")d.notesOpen=false;if(typeof d.overviewCollapsed!=="boolean")d.overviewCollapsed=false;d.tasks=d.tasks.map(normTask);return d;}' +
    'function normStore(o){if(!o||typeof o!=="object")return defaultStore();if(o.version===2&&o.days&&typeof o.days==="object"&&!Array.isArray(o.days)){var days={};Object.keys(o.days).forEach(function(k){if(/^\\d{4}-\\d{2}-\\d{2}$/.test(k))days[k]=normDay(o.days[k]);});return{version:2,days:days};}if(o.date){var d=String(o.date).slice(0,10);var st=defaultStore();if(/^\\d{4}-\\d{2}-\\d{2}$/.test(d))st.days[d]=normDay(o);return st;}return defaultStore();}' +
    'function readStore(){if(_tlCache)return _tlCache;return defaultStore();}' +
    'function writeStore(o){if(o&&o._root){var d=o.date||today();o._root.days[d]={tasks:Array.isArray(o.tasks)?o.tasks:[],notes:typeof o.notes==="string"?o.notes:"",notesOpen:!!o.notesOpen,overviewCollapsed:!!o.overviewCollapsed};_tlCache=normStore(o._root);}else{_tlCache=normStore(o);}wsPut(SK,_tlCache);}' +
    'function ensureDay(dateStr){var st=readStore();var d=isIsoDate(dateStr)?dateStr:today();if(!st.days[d])st.days[d]={tasks:[],notes:"",notesOpen:false,overviewCollapsed:false};var day=st.days[d];return{date:d,tasks:day.tasks,notes:day.notes,notesOpen:day.notesOpen,overviewCollapsed:day.overviewCollapsed,_root:st};}' +
    'function ensureCurrentDay(){if(!selectedDate)selectedDate=today();return ensureDay(selectedDate);}' +
    'function setSelectedDate(dateStr){selectedDate=isIsoDate(dateStr)?dateStr:today();if(dayPicker&&dayPicker.value!==selectedDate)dayPicker.value=selectedDate;render();}' +
    'function loadOverviewUi(){var o=ensureCurrentDay();var collapsed=!!o.overviewCollapsed;if(overviewCol)overviewCol.classList.toggle("is-collapsed",collapsed);if(overviewCollapseBtn){overviewCollapseBtn.disabled=collapsed;overviewCollapseBtn.setAttribute("aria-expanded",collapsed?"false":"true");}if(overviewExpandBtn){overviewExpandBtn.disabled=!collapsed;overviewExpandBtn.setAttribute("aria-expanded",collapsed?"true":"false");}}' +
    'function setOverviewCollapsed(collapsed){var o=ensureCurrentDay();o.overviewCollapsed=!!collapsed;writeStore(o);loadOverviewUi();}' +
    'function loadDayNotesUi(){var o=ensureCurrentDay();if(notesField&&notesField.value!==o.notes)notesField.value=o.notes;if(notesPanel)notesPanel.open=!!o.notesOpen;}' +
    'function saveDayNotes(val){var o=ensureCurrentDay();o.notes=String(val!=null?val:"");writeStore(o);}' +
    'function saveDayNotesOpen(open){var o=ensureCurrentDay();o.notesOpen=!!open;writeStore(o);}' +
    'function scheduleDayNotesSave(){if(notesSaveTimer)clearTimeout(notesSaveTimer);notesSaveTimer=setTimeout(function(){notesSaveTimer=null;if(notesField)saveDayNotes(notesField.value);},400);}' +
    'function scheduleTaskNotesSave(id,val){if(taskNotesSaveTimers[id])clearTimeout(taskNotesSaveTimers[id]);taskNotesSaveTimers[id]=setTimeout(function(){delete taskNotesSaveTimers[id];updateTask(id,{notes:String(val!=null?val:"")},false);},400);}' +
    'function timeSortKey(t){var s=String(t||"").trim();if(!s)return"99:99";return s;}' +
    'function sortedTasks(tasks){return tasks.slice().sort(function(a,b){var c=timeSortKey(a.time).localeCompare(timeSortKey(b.time));if(c!==0)return c;return String(a.text||"").localeCompare(String(b.text||""));});}' +
    'function statusBadge(st){var s=normStatus(st);var lab=STATUS_MAP[s]||s;var cls="tl-badge tl-badge-"+s;return"<span class=\\""+cls+"\\">"+lab+"</span>";}' +
    'function statusOptions(sel){var h="";STATUSES.forEach(function(p){h+="<option value=\\""+p[0]+"\\""+(sel===p[0]?" selected":"")+">"+p[1]+"</option>";});return h;}' +
    'function matchesFilter(task){if(filterState==="all")return true;return normStatus(task.status)===filterState;}' +
    'function nowMinutes(){var d=new Date();return d.getHours()*60+d.getMinutes();}' +
    'function taskMinutes(t){var s=String(t.time||"").trim();if(!s)return null;var p=s.split(":");var h=parseInt(p[0],10);var m=parseInt(p[1]||"0",10);if(!isFinite(h)||!isFinite(m))return null;return h*60+m;}' +
    'function formatTime12(t){var s=String(t||"").trim();if(!s)return"—";var p=s.split(":");var h=parseInt(p[0],10);var m=String(p[1]||"00").padStart(2,"0");var ap=h>=12?"p.m.":"a.m.";var h12=h%12;if(h12===0)h12=12;return h12+":"+m+" "+ap;}' +
    'function formatNowClock(){try{var d=new Date();return d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});}catch(e){return"";}}' +
    'function gapLabel(a,b){var ma=taskMinutes(a);var mb=taskMinutes(b);if(ma==null||mb==null||mb<=ma)return"";var diff=mb-ma;if(diff<60)return diff+" min";var hr=Math.floor(diff/60);var rm=diff%60;return rm?hr+" hr "+rm+" min":hr+" hr";}' +
    'function pickCurrentTaskId(tasks){var list=sortedTasks(tasks);var i;for(i=0;i<list.length;i++){if(normStatus(list[i].status)==="in_progress")return list[i].id;}var now=nowMinutes();for(i=0;i<list.length;i++){var st=normStatus(list[i].status);if(st==="done"||st==="skipped")continue;var tm=taskMinutes(list[i]);if(tm!=null&&tm<=now)return list[i].id;}var best=null;var bestM=99999;for(i=0;i<list.length;i++){st=normStatus(list[i].status);if(st==="done"||st==="skipped")continue;tm=taskMinutes(list[i]);if(tm!=null&&tm>=now&&tm<bestM){bestM=tm;best=list[i].id;}}if(best)return best;for(i=0;i<list.length;i++){st=normStatus(list[i].status);if(st!=="done"&&st!=="skipped")return list[i].id;}return null;}' +
    'function renderOverview(){if(!overviewHost)return;var o=ensureCurrentDay();var route=sortedTasks(o.tasks);var currentId=pickCurrentTaskId(o.tasks);if(overviewNow){var cur=currentId?route.filter(function(t){return t.id===currentId;})[0]:null;overviewNow.classList.toggle("is-in-progress-active",!!(cur&&normStatus(cur.status)==="in_progress"));overviewNow.innerHTML=cur?"Now: <strong>"+String(cur.text||"Task").replace(/</g,"&lt;")+"</strong> at "+formatTime12(cur.time):"No active task — add times and set status to track your day.";}overviewHost.innerHTML="";if(!route.length){overviewHost.innerHTML=\'<p class="tl-overview-empty">Add tasks with times to see your day at a glance.</p>\';return;}var wrap=document.createElement("div");wrap.className="tl-route";wrap.setAttribute("role","list");route.forEach(function(task,idx){var st=normStatus(task.status);var stop=document.createElement("div");stop.className="tl-stop";if(task.id===currentId)stop.classList.add("is-current");if(st==="in_progress")stop.classList.add("is-in-progress");if(st==="done")stop.classList.add("is-done");if(st==="skipped")stop.classList.add("is-skipped");stop.setAttribute("role","listitem");stop.setAttribute("data-id",task.id);var timeEl=document.createElement("div");timeEl.className="tl-stop-time";timeEl.textContent=formatTime12(task.time);var track=document.createElement("div");track.className="tl-stop-track";var dot=document.createElement("span");dot.className="tl-stop-dot";dot.setAttribute("aria-hidden","true");var line=document.createElement("span");line.className="tl-stop-line";line.setAttribute("aria-hidden","true");track.appendChild(dot);track.appendChild(line);var body=document.createElement("div");body.className="tl-stop-body";var title=document.createElement("p");title.className="tl-stop-title";title.textContent=String(task.text||"Task");var meta=document.createElement("p");meta.className="tl-stop-meta";var metaBits=[STATUS_MAP[st]||st];if(task.id===currentId)metaBits.push("You are here");else if(st==="not_started"&&taskMinutes(task)!=null&&taskMinutes(task)<nowMinutes())metaBits.push("Overdue");meta.textContent=metaBits.join(" · ");body.appendChild(title);body.appendChild(meta);stop.appendChild(timeEl);stop.appendChild(track);stop.appendChild(body);wrap.appendChild(stop);if(idx<route.length-1){var gap=gapLabel(task,route[idx+1]);if(gap){var gapEl=document.createElement("div");gapEl.className="tl-stop-gap";gapEl.textContent=gap;wrap.appendChild(gapEl);}}});overviewHost.appendChild(wrap);}' +
    'function renderTable(){var o=ensureCurrentDay();var list=sortedTasks(o.tasks).filter(matchesFilter);if(editingId&&!list.some(function(t){return t.id===editingId;}))editingId=null;tbody.innerHTML="";if(emptyEl)emptyEl.hidden=list.length>0;list.forEach(function(task){var tr=document.createElement("tr");tr.setAttribute("data-id",task.id);if(normStatus(task.status)==="done")tr.className="tl-row-done";var isEdit=editingId===task.id;var tdTime=document.createElement("td");var tdText=document.createElement("td");var tdStatus=document.createElement("td");if(isEdit){var inpTime=document.createElement("input");inpTime.type="time";inpTime.className="tl-task-time";inpTime.value=String(task.time||"");inpTime.setAttribute("aria-label","Time");tdTime.appendChild(inpTime);var inpText=document.createElement("input");inpText.type="text";inpText.className="tl-task-text";inpText.value=String(task.text||"");inpText.placeholder="Task";tdText.appendChild(inpText);var selStatus=document.createElement("select");selStatus.className="tl-task-status";selStatus.innerHTML=statusOptions(normStatus(task.status));selStatus.setAttribute("aria-label","Status");tdStatus.appendChild(selStatus);}else{var viewTime=document.createElement("span");viewTime.className="tl-view-time";viewTime.textContent=String(task.time||"").trim()?formatTime12(task.time):"—";tdTime.appendChild(viewTime);var viewText=document.createElement("span");viewText.className="tl-view-text";var txt=String(task.text||"").trim();viewText.textContent=txt||"Untitled task";if(!txt)viewText.classList.add("tl-view-empty");tdText.appendChild(viewText);tdStatus.innerHTML=statusBadge(task.status);}var tdAct=document.createElement("td");tdAct.className="tl-td-actions";var actWrap=document.createElement("div");actWrap.className="tl-actions";if(isEdit){actWrap.appendChild(makeIconBtn("tl-save","Save task",SVG_CHECK));actWrap.appendChild(makeIconBtn("tl-cancel","Cancel editing",SVG_X));}else{var btnNotes=makeIconBtn("tl-notes-btn","Notes",SVG_NOTE);btnNotes.setAttribute("data-id",task.id);if(task.notesOpen)btnNotes.classList.add("is-open");if(String(task.notes||"").trim())btnNotes.classList.add("has-content");actWrap.appendChild(btnNotes);actWrap.appendChild(makeIconBtn("tl-edit","Edit task",SVG_PENCIL));var btnDone=makeIconBtn("tl-done","Mark as done",SVG_MARK_DONE);if(normStatus(task.status)==="done"){btnDone.disabled=true;btnDone.classList.add("is-active");}actWrap.appendChild(btnDone);actWrap.appendChild(makeIconBtn("tl-remove","Remove task",SVG_TRASH));}tdAct.appendChild(actWrap);tr.appendChild(tdTime);tr.appendChild(tdText);tr.appendChild(tdStatus);tr.appendChild(tdAct);tbody.appendChild(tr);var trN=document.createElement("tr");trN.className="tl-row-notes";trN.setAttribute("data-for",task.id);if(!task.notesOpen)trN.hidden=true;var tdN=document.createElement("td");tdN.colSpan=4;var panel=document.createElement("div");panel.className="tl-task-notes-panel";var ta=document.createElement("textarea");ta.className="tl-notes-field tl-task-notes";ta.setAttribute("data-id",task.id);ta.value=String(task.notes||"");ta.placeholder="Context, links, or reminders for this task…";ta.spellcheck=true;panel.appendChild(ta);tdN.appendChild(panel);trN.appendChild(tdN);tbody.appendChild(trN);if(isEdit){var focusText=tr.querySelector(".tl-task-text");if(focusText)focusText.focus();}});}' +
    'function render(){var o=ensureCurrentDay();if(dayEl)dayEl.textContent=formatDayLabel(o.date);if(dayPicker&&dayPicker.value!==o.date)dayPicker.value=o.date;loadDayNotesUi();loadOverviewUi();renderTable();renderOverview();}' +
    'function updateTask(id,patch,rerender){var o=ensureCurrentDay();for(var i=0;i<o.tasks.length;i++){if(String(o.tasks[i].id)===String(id)){Object.assign(o.tasks[i],patch);break;}}writeStore(o);if(rerender!==false)render();else renderOverview();}' +
    'function removeTask(id){var o=ensureCurrentDay();o.tasks=o.tasks.filter(function(t){return String(t.id)!==String(id);});writeStore(o);render();}' +
    'function addTask(){var text=addText?String(addText.value||"").trim():"";if(!text)return;var o=ensureCurrentDay();o.tasks.push({id:nextId(),text:text,time:addTime?String(addTime.value||""):"",status:addStatus?normStatus(addStatus.value):"not_started",notes:"",notesOpen:false});writeStore(o);if(addText)addText.value="";if(addTime)addTime.value="";if(addStatus)addStatus.value="not_started";render();if(addText)addText.focus();}' +
    'document.querySelectorAll(".tl-filter").forEach(function(btn){btn.addEventListener("click",function(){filterState=btn.getAttribute("data-filter")||"all";document.querySelectorAll(".tl-filter").forEach(function(b){b.classList.toggle("is-active",b===btn);});render();});});' +
    'if(addBtn)addBtn.addEventListener("click",addTask);' +
    'if(addText)addText.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();addTask();}});' +
    'tbody.addEventListener("input",function(e){if(!e.target.classList.contains("tl-task-notes"))return;var id=e.target.getAttribute("data-id");if(id)scheduleTaskNotesSave(id,e.target.value);});' +
    'tbody.addEventListener("blur",function(e){if(!e.target.classList.contains("tl-task-notes"))return;var id=e.target.getAttribute("data-id");if(!id)return;if(taskNotesSaveTimers[id]){clearTimeout(taskNotesSaveTimers[id]);delete taskNotesSaveTimers[id];}updateTask(id,{notes:String(e.target.value||"")},false);},true);' +
    'if(notesField){notesField.addEventListener("input",scheduleDayNotesSave);notesField.addEventListener("blur",function(){if(notesSaveTimer){clearTimeout(notesSaveTimer);notesSaveTimer=null;}saveDayNotes(notesField.value);});}' +
    'if(notesPanel){notesPanel.addEventListener("toggle",function(){saveDayNotesOpen(notesPanel.open);});}' +
    'function saveEditingRow(tr){if(!tr)return;var id=tr.getAttribute("data-id");var inpText=tr.querySelector(".tl-task-text");var inpTime=tr.querySelector(".tl-task-time");var selStatus=tr.querySelector(".tl-task-status");var notesTa=tr.parentNode?tr.parentNode.querySelector(\'textarea.tl-task-notes[data-id="\'+id+\'"]\'):null;var text=inpText?String(inpText.value||"").trim():"";if(!text){if(inpText)inpText.focus();return;}var patch={text:text,time:inpTime?String(inpTime.value||""):"",status:selStatus?normStatus(selStatus.value):"not_started"};if(notesTa)patch.notes=String(notesTa.value||"");editingId=null;updateTask(id,patch,true);}' +
    'tbody.addEventListener("keydown",function(e){var tr=e.target.closest("tr[data-id]");if(!tr||editingId!==tr.getAttribute("data-id"))return;if(e.key==="Enter"&&e.target.classList.contains("tl-task-text")){e.preventDefault();saveEditingRow(tr);}else if(e.key==="Escape"){e.preventDefault();editingId=null;render();}});' +
    'tbody.addEventListener("click",function(e){var notesBtn=e.target.closest(".tl-notes-btn");if(notesBtn){var nid=notesBtn.getAttribute("data-id");if(nid){var o=ensureCurrentDay();var open=false;for(var i=0;i<o.tasks.length;i++){if(String(o.tasks[i].id)===String(nid)){open=!o.tasks[i].notesOpen;break;}}updateTask(nid,{notesOpen:open},true);}return;}var tr=e.target.closest("tr[data-id]");if(!tr)return;var id=tr.getAttribute("data-id");if(e.target.closest(".tl-edit")){editingId=id;render();return;}if(e.target.closest(".tl-done")){updateTask(id,{status:"done"},true);return;}if(e.target.closest(".tl-save")){saveEditingRow(tr);return;}if(e.target.closest(".tl-cancel")){editingId=null;render();return;}if(e.target.closest(".tl-remove")){if(editingId===id)editingId=null;removeTask(id);}});' +
    'document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"){wsGet(SK,function(e,d){_tlCache=normStore(d||defaultStore());render();});}});' +
    'setInterval(function(){renderOverview();},60000);' +
    'if(overviewCollapseBtn)overviewCollapseBtn.addEventListener("click",function(){setOverviewCollapsed(true);});' +
    'if(overviewExpandBtn)overviewExpandBtn.addEventListener("click",function(){setOverviewCollapsed(false);});' +
    'if(overviewHost)overviewHost.addEventListener("click",function(e){var stop=e.target.closest(".tl-stop");if(!stop)return;var id=stop.getAttribute("data-id");var tr=tbody.querySelector(\'tr[data-id="\'+id+\'"]\');if(tr){tr.scrollIntoView({behavior:"smooth",block:"nearest"});tr.classList.add("tl-row-focus");setTimeout(function(){tr.classList.remove("tl-row-focus");},1200);}});' +
    'if(dayPicker)dayPicker.addEventListener("change",function(){setSelectedDate(dayPicker.value);});' +
    'wsGet(SK,function(e,d){_tlCache=normStore(d||defaultStore());selectedDate=today();if(dayPicker)dayPicker.value=selectedDate;render();});' +
    '})();<' +
    '/script>';
  const filterBtns =
    '<button type="button" class="tl-filter is-active" data-filter="all">All</button>' +
    TODOLIST_STATUSES.map(
      ([v, lab]) =>
        '<button type="button" class="tl-filter" data-filter="' + escAttr(v) + '">' + escHtml(lab) + '</button>'
    ).join('');
  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Todo list</h1>' +
    '<p class="sub">Today’s tasks with a time and status—saved in MongoDB. Past days are on the calendar.</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/todolist/calendar">Calendar</a>' +
    '<a class="link-pill" href="/daily-tasks">Daily tasks</a>' +
    '<a class="link-pill" href="/work-planning">Work planning</a>' +
    '<a class="link-pill" href="/priority">Priority</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel tl-panel">' +
    tlStyles +
    '<div class="tl-dayhead">' +
    '<div><h2 id="tl-day-label">Today</h2><p>Select any date to view or update that day’s todo list.</p></div>' +
    '<div class="tl-field" style="min-width:14rem"><label for="tl-day-picker">Date</label><input type="date" id="tl-day-picker" /></div>' +
    '</div>' +
    '<p class="tl-hint">Add tasks for the selected date. Pick a time to order the day, and update status as you go.</p>' +
    '<div class="tl-top-split">' +
    '<div class="tl-add">' +
    '<div class="tl-field"><label for="tl-add-text">Task</label><input type="text" id="tl-add-text" autocomplete="off" placeholder="What to do today" /></div>' +
    '<div class="tl-field"><label for="tl-add-time">Time</label><input type="time" id="tl-add-time" /></div>' +
    '<div class="tl-field"><label for="tl-add-status">Status</label><select id="tl-add-status">' +
    statusOpts +
    '</select></div>' +
    '<div class="tl-field"><label>&nbsp;</label><button type="button" id="tl-add-btn" class="tl-btn-add">+ Add</button></div>' +
    '</div>' +
    '<aside class="tl-overview-col" id="tl-overview-col" aria-label="Today overview">' +
    '<div class="tl-overview-head">' +
    '<h3>Today overview</h3>' +
    '<div class="tl-overview-toggles">' +
    '<button type="button" id="tl-overview-collapse" class="tl-overview-toggle" aria-label="Collapse overview" aria-controls="tl-overview-body" aria-expanded="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg></button>' +
    '<button type="button" id="tl-overview-expand" class="tl-overview-toggle" aria-label="Expand overview" aria-controls="tl-overview-body" aria-expanded="false" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>' +
    '</div></div>' +
    '<div id="tl-overview-body" class="tl-overview-body">' +
    '<p id="tl-overview-now" class="tl-overview-now">Your current task will show here.</p>' +
    '<div id="tl-overview-host"></div>' +
    '</div></aside>' +
    '</div>' +
    '<div class="tl-filters" role="group" aria-label="Filter by status">' +
    filterBtns +
    '</div>' +
    '<div class="tl-table-wrap">' +
    '<table class="tl-table" aria-label="Today tasks">' +
    '<thead><tr><th>Time</th><th>Task</th><th>Status</th><th></th></tr></thead>' +
    '<tbody id="tl-tbody"></tbody>' +
    '</table>' +
    '<p id="tl-empty" class="tl-empty" hidden>No tasks for this filter yet.</p>' +
    '</div>' +
    tlScript +
    '</div></div>'
  );
}

function buildTodolistCalendarHtml() {
  const statusJson = JSON.stringify(TODOLIST_STATUSES);
  const calStyles =
    '<style>' +
    '.tl-cal-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.tl-cal-nav{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin:0 0 18px;}' +
    '.tl-cal-nav h2{margin:0;font-size:1.35rem;font-weight:800;color:#0f172a;}' +
    '.tl-cal-nav-btns{display:flex;gap:8px;}' +
    '.tl-cal-nav-btns button{padding:8px 14px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;font:inherit;font-size:13px;font-weight:600;color:#334155;cursor:pointer;}' +
    '.tl-cal-nav-btns button:hover{background:#f1f5f9;border-color:#cbd5e1;}' +
    '.tl-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:20px;}' +
    '.tl-cal-dow{font-size:11px;font-weight:700;color:#64748b;text-align:center;padding:6px 0;text-transform:uppercase;letter-spacing:0.04em;}' +
    '.tl-cal-cell{min-height:4.5rem;border:1px solid #e5e7eb;border-radius:10px;padding:6px 8px;background:#fafafa;cursor:pointer;text-align:left;font:inherit;color:inherit;transition:background .15s,border-color .15s,box-shadow .15s;}' +
    '.tl-cal-cell:hover:not(:disabled){background:#f0fdfa;border-color:#99f6e4;}' +
    '.tl-cal-cell.is-outside{opacity:0.35;cursor:default;background:#f8fafc;}' +
    '.tl-cal-cell.is-today{border-color:#0d9488;box-shadow:0 0 0 2px rgba(13,148,136,0.2);}' +
    '.tl-cal-cell.is-selected{background:#ecfdf5;border-color:#0d9488;}' +
    '.tl-cal-cell.has-data{background:#fff;}' +
    '.tl-cal-num{font-size:13px;font-weight:700;color:#0f172a;display:block;margin-bottom:4px;}' +
    '.tl-cal-dots{font-size:10px;color:#64748b;line-height:1.3;}' +
    '.tl-cal-detail{border:1px solid #e2e8f0;border-radius:10px;padding:16px;background:#fafafa;}' +
    '.tl-cal-detail h3{margin:0 0 12px;font-size:1.1rem;color:#0f172a;}' +
    '.tl-cal-detail-empty{margin:0;color:#94a3b8;font-size:14px;}' +
    '.tl-cal-task-list{margin:0;padding:0;list-style:none;}' +
    '.tl-cal-task-list li{padding:10px 0;border-bottom:1px solid #e5e7eb;font-size:14px;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:baseline;}' +
    '.tl-cal-task-list li:last-child{border-bottom:none;}' +
    '.tl-cal-task-time{font-variant-numeric:tabular-nums;color:#64748b;font-size:13px;min-width:5rem;}' +
    '.tl-cal-notes{margin-top:14px;padding-top:14px;border-top:1px solid #e5e7eb;}' +
    '.tl-cal-notes h4{margin:0 0 8px;font-size:13px;color:#475569;}' +
    '.tl-cal-notes p{margin:0;font-size:14px;color:#334155;white-space:pre-wrap;line-height:1.5;}' +
    getTlListStyles().replace('<style>', '').replace('</style>', '') +
    '</style>';
  const calScript =
    '<script>' +
    '(function(){' +
    'var STATUSES=' +
    statusJson +
    ';' +
    'var STATUS_MAP={};STATUSES.forEach(function(p){STATUS_MAP[p[0]]=p[1];});' +
    'var monthLabel=document.getElementById("tl-cal-month-label");' +
    'var gridHost=document.getElementById("tl-cal-grid");' +
    'var detailHost=document.getElementById("tl-cal-detail");' +
    'var prevBtn=document.getElementById("tl-cal-prev");' +
    'var nextBtn=document.getElementById("tl-cal-next");' +
    'var todayBtn=document.getElementById("tl-cal-today");' +
    'if(!gridHost||!detailHost)return;' +
    'var viewYear=new Date().getFullYear();' +
    'var viewMonth=new Date().getMonth()+1;' +
    'var selectedDate=null;' +
    'var monthCache={};' +
    'function pad2(n){return String(n).padStart(2,"0");}' +
    'function isoDate(y,m,d){return y+"-"+pad2(m)+"-"+pad2(d);}' +
    'function todayIso(){try{return new Date().toISOString().slice(0,10);}catch(e){return"";}}' +
    'function formatDayTitle(d){try{var dt=new Date(d+"T12:00:00");return dt.toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric",year:"numeric"});}catch(e){return d;}}' +
    'function formatTime12(t){var s=String(t||"").trim();if(!s)return"—";var p=s.split(":");var h=parseInt(p[0],10);var m=String(p[1]||"00").padStart(2,"0");var ap=h>=12?"p.m.":"a.m.";var h12=h%12;if(h12===0)h12=12;return h12+":"+m+" "+ap;}' +
    'function statusBadge(st){var s=String(st||"not_started");var lab=STATUS_MAP[s]||s;return"<span class=\\"tl-badge tl-badge-"+s+"\\">"+lab+"</span>";}' +
    'function cacheKey(y,m){return y+"-"+pad2(m);}' +
    'function fetchMonth(y,m,cb){var k=cacheKey(y,m);if(monthCache[k]){cb(null,monthCache[k]);return;}' +
    'fetch("/api/todolist/calendar?year="+encodeURIComponent(y)+"&month="+encodeURIComponent(m),{headers:{Accept:"application/json"}})' +
    '.then(function(r){if(!r.ok)throw new Error("calendar failed");return r.json();})' +
    '.then(function(res){monthCache[k]=res&&res.days?res.days:{};cb(null,monthCache[k]);})' +
    '.catch(function(e){cb(e,{});});}' +
    'function fetchDay(date,cb){' +
    'fetch("/api/todolist/day/"+encodeURIComponent(date),{headers:{Accept:"application/json"}})' +
    '.then(function(r){if(!r.ok)throw new Error("day failed");return r.json();})' +
    '.then(function(res){cb(null,res);})' +
    '.catch(function(e){cb(e,null);});}' +
    'function renderDetail(date){if(!date){detailHost.innerHTML=\'<p class="tl-cal-detail-empty">Pick a day on the calendar to see what happened on your todo list.</p>\';return;}' +
    'detailHost.innerHTML=\'<p class="tl-cal-detail-empty">Loading…</p>\';' +
    'fetchDay(date,function(err,data){' +
    'if(err||!data||!data.day){detailHost.innerHTML=\'<h3>\'+formatDayTitle(date)+\'</h3><p class="tl-cal-detail-empty">No todo list saved for this day.</p>\';return;}' +
    'var day=data.day;var tasks=Array.isArray(day.tasks)?day.tasks.slice():[];' +
    'tasks.sort(function(a,b){return String(a.time||"").localeCompare(String(b.time||""));});' +
    'var h=\'<h3>\'+formatDayTitle(date)+\'</h3>\';' +
    'if(!tasks.length&&!String(day.notes||"").trim()){h+=\'<p class="tl-cal-detail-empty">No tasks or notes recorded.</p>\';}' +
    'else{if(tasks.length){h+=\'<ul class="tl-cal-task-list">\';tasks.forEach(function(t){h+=\'<li><span class="tl-cal-task-time">\'+formatTime12(t.time)+\'</span><span>\'+String(t.text||"Task").replace(/</g,"&lt;")+\'</span>\'+statusBadge(t.status)+\'</li>\';});h+=\'</ul>\';}' +
    'if(String(day.notes||"").trim()){h+=\'<div class="tl-cal-notes"><h4>Day notes</h4><p>\'+String(day.notes).replace(/</g,"&lt;").replace(/\\n/g,"<br>")+\'</p></div>\';}' +
    'detailHost.innerHTML=h;});}' +
    'function renderGrid(days){var first=new Date(viewYear,viewMonth-1,1);var startDow=first.getDay();var daysInMonth=new Date(viewYear,viewMonth,0).getDate();' +
    'if(monthLabel)monthLabel.textContent=first.toLocaleDateString(undefined,{month:"long",year:"numeric"});' +
    'var html="";var dow=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];dow.forEach(function(d){html+=\'<div class="tl-cal-dow">\'+d+\'</div>\';});' +
    'var totalCells=Math.ceil((startDow+daysInMonth)/7)*7;var cell=0;for(cell=0;cell<totalCells;cell++){var dayNum=cell-startDow+1;var inMonth=dayNum>=1&&dayNum<=daysInMonth;var y=viewYear,m=viewMonth,d=dayNum;var dateStr=inMonth?isoDate(y,m,d):"";var cls="tl-cal-cell";if(!inMonth)cls+=" is-outside";else{if(dateStr===todayIso())cls+=" is-today";if(days&&days[dateStr])cls+=" has-data";if(dateStr===selectedDate)cls+=" is-selected";}' +
    'var summary="";if(inMonth&&days&&days[dateStr]){var s=days[dateStr];var bits=[];if(s.taskCount)bits.push(s.taskCount+" task"+(s.taskCount===1?"":"s"));if(s.doneCount)bits.push(s.doneCount+" done");summary=bits.join(" · ");}' +
    'html+=\'<button type="button" class="\'+cls+\'"\'+(inMonth?\' data-date="\'+dateStr+\'"\':" disabled")+\'>\';' +
    'if(inMonth){html+=\'<span class="tl-cal-num">\'+dayNum+\'</span><span class="tl-cal-dots">\'+(summary||"")+\'</span>\';}' +
    'html+=\'</button>\';}' +
    'gridHost.innerHTML=html;}' +
    'function loadMonth(){fetchMonth(viewYear,viewMonth,function(err,days){renderGrid(days||{});if(selectedDate&&selectedDate.slice(0,7)===viewYear+"-"+pad2(viewMonth))renderDetail(selectedDate);});}' +
    'gridHost.addEventListener("click",function(e){var btn=e.target.closest(".tl-cal-cell[data-date]");if(!btn)return;selectedDate=btn.getAttribute("data-date");loadMonth();renderDetail(selectedDate);});' +
    'if(prevBtn)prevBtn.addEventListener("click",function(){viewMonth-=1;if(viewMonth<1){viewMonth=12;viewYear-=1;}loadMonth();});' +
    'if(nextBtn)nextBtn.addEventListener("click",function(){viewMonth+=1;if(viewMonth>12){viewMonth=1;viewYear+=1;}loadMonth();});' +
    'if(todayBtn)todayBtn.addEventListener("click",function(){var n=new Date();viewYear=n.getFullYear();viewMonth=n.getMonth()+1;selectedDate=todayIso();loadMonth();renderDetail(selectedDate);});' +
    'selectedDate=todayIso();loadMonth();renderDetail(selectedDate);' +
    '})();<' +
    '/script>';
  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Todo list calendar</h1>' +
    '<p class="sub">Browse past days and see tasks and notes saved in MongoDB.</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/todolist">Today’s list</a>' +
    '<a class="link-pill" href="/daily-tasks">Daily tasks</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel tl-cal-panel">' +
    calStyles +
    '<div class="tl-cal-nav">' +
    '<h2 id="tl-cal-month-label">Month</h2>' +
    '<div class="tl-cal-nav-btns">' +
    '<button type="button" id="tl-cal-prev" aria-label="Previous month">←</button>' +
    '<button type="button" id="tl-cal-today">Today</button>' +
    '<button type="button" id="tl-cal-next" aria-label="Next month">→</button>' +
    '</div></div>' +
    '<div id="tl-cal-grid" class="tl-cal-grid" aria-label="Calendar month"></div>' +
    '<div id="tl-cal-detail" class="tl-cal-detail" aria-live="polite">' +
    '<p class="tl-cal-detail-empty">Pick a day on the calendar to see what happened on your todo list.</p>' +
    '</div>' +
    calScript +
    '</div></div>'
  );
}

function buildPriorityWorkspaceHtml() {
  const prStyles =
    '<style>' +
    '.pr-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.pr-hint{margin:0 0 16px;font-size:14px;color:#475569;line-height:1.55;max-width:52em;}' +
    '.pr-label{display:block;font-size:13px;font-weight:700;color:#334155;margin:0 0 8px;}' +
    '.pr-field{width:100%;max-width:100%;min-height:220px;box-sizing:border-box;padding:14px 16px;border:1px solid #e2e8f0;border-radius:10px;font:inherit;font-size:15px;line-height:1.5;color:#0f172a;background:#fff;resize:vertical;}' +
    '.pr-field:focus{outline:none;border-color:#1d4ed8;box-shadow:0 0 0 3px rgba(29,78,216,0.15);}' +
    '.pr-note{margin:10px 0 0;font-size:12px;color:#64748b;}' +
    '</style>';
  const prScript =
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var SK=' +
    JSON.stringify(PRIORITY_STORAGE_KEY) +
    ';' +
    'var ta=document.getElementById("priority-field");' +
    'var t=null;' +
    'if(!ta)return;' +
    'function applyText(d){var v="";if(d&&d.text!=null)v=String(d.text);else if(typeof d==="string")v=d;ta.value=v;}' +
    'function flush(){if(t){clearTimeout(t);t=null;}wsPut(SK,{text:ta.value});}' +
    'function sched(){if(t)clearTimeout(t);t=setTimeout(function(){t=null;flush();},400);}' +
    'wsGet(SK,function(err,d){applyText(d);});' +
    'ta.addEventListener("input",sched);' +
    'ta.addEventListener("blur",flush);' +
    'document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible")wsGet(SK,function(err,d){applyText(d);});});' +
    '})();<' +
    '/script>';
  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Priority</h1>' +
    '<p class="sub">The few things in your life that deserve the most energy, time, and resources—written in your own words.</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/daily-tasks">Daily tasks</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel pr-panel">' +
    prStyles +
    '<p class="pr-hint">Name what matters most right now—people, health, work, learning, relationships, or anything else. Revisit this when trade-offs get noisy. Saved in MongoDB.</p>' +
    '<label class="pr-label" for="priority-field">What gets my best energy, time, and resources</label>' +
    '<textarea id="priority-field" class="pr-field" spellcheck="true" autocomplete="off" placeholder="e.g. Family and health first; deep work on the product; one intentional friendship; sleep and movement non-negotiable…"></textarea>' +
    '<p class="pr-note">Tip: keep the list short so it stays actionable when you plan your week or say no to distractions.</p>' +
    prScript +
    '</div></div>'
  );
}

function buildTicketsWorkspaceHtml() {
  const zeroFmt = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(0);
  const tkStyles =
    '<style>' +
    '.tk-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.tk-totals{display:grid;gap:12px;grid-template-columns:1fr;}@media(min-width:720px){.tk-totals{grid-template-columns:repeat(3,1fr);}}' +
    '.tk-total-card{border:1px solid #6366f155;border-radius:12px;padding:14px 16px;background:linear-gradient(135deg,#eef2ff,#fff);}' +
    '.tk-total-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#4338ca;margin:0 0 6px;}' +
    '.tk-total-val{font-size:1.35rem;font-weight:800;color:#0f172a;margin:0;font-variant-numeric:tabular-nums;}' +
    '.tk-hint{margin:0 0 14px;font-size:13px;color:#64748b;line-height:1.5;max-width:52em;}' +
    '.tk-table-wrap{overflow:auto;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:14px;}' +
    '.tk-table{width:100%;border-collapse:collapse;min-width:720px;font-size:14px;}' +
    '.tk-table th{text-align:left;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#334155;font-weight:700;}' +
    '.tk-table th:nth-child(3){text-align:right;width:9rem;}' +
    '.tk-table td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle;}' +
    '.tk-table td:nth-child(3){text-align:right;}' +
    '.tk-table tr.tkt-detail td{background:#fafafa;border-bottom:1px solid #e5e7eb;padding:12px 14px 14px;}' +
    '.tk-table tr.tkt-detail:last-child td{border-bottom:none;}' +
    '.tkt-cat,.tkt-title,.tkt-amount,.tkt-status{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;}' +
    '.tkt-amount{text-align:right;max-width:10rem;margin-left:auto;display:block;}' +
    '.tkt-status{max-width:10rem;}' +
    '.tkt-remove{border:1px solid #e5e7eb;background:#fff;color:#64748b;border-radius:6px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;font:inherit;}' +
    '.tkt-remove:hover{background:#fef2f2;color:#b91c1c;border-color:#fecaca;}' +
    '.tkt-close-wrap[hidden]{display:none !important;}' +
    '.tkt-close-wrap:not([hidden]){display:block;}' +
    '.tkt-field{margin-top:10px;}' +
    '.tkt-field:first-child{margin-top:0;}' +
    '.tkt-field label{display:block;font-size:12px;font-weight:700;color:#475569;margin:0 0 6px;}' +
    '.tkt-conclusion,.tkt-unlocks{width:100%;min-height:64px;box-sizing:border-box;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;font-size:13px;line-height:1.45;resize:vertical;}' +
    '.tk-actions{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;}' +
    '.tk-actions button{border:1px solid #e5e7eb;background:#fff;color:#111827;border-radius:6px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;font:inherit;}' +
    '.tk-actions button:hover{background:#f9fafb;}' +
    '#tk-add{border-color:#4f46e5;background:#4f46e5;color:#fff;}' +
    '#tk-add:hover{background:#4338ca;border-color:#4338ca;color:#fff;}' +
    '.tk-yield{margin-top:20px;padding-top:16px;border-top:1px solid #e5e7eb;}' +
    '.tk-yield > summary{cursor:pointer;font-weight:800;font-size:14px;color:#0f172a;list-style:none;padding:8px 0;}' +
    '.tk-yield > summary::-webkit-details-marker{display:none;}' +
    '.tk-yield-body{padding:12px 0 4px;display:grid;gap:12px;max-width:420px;}' +
    '.tk-yield-row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;}' +
    '.tk-yield-row label{font-size:13px;font-weight:600;color:#334155;display:flex;flex-direction:column;gap:6px;}' +
    '.tk-yield-out{margin:0;font-size:14px;color:#0f172a;font-weight:600;}' +
    '.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}' +
    '</style>';
  const tkScript =
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var SK=' +
    JSON.stringify(TICKETS_STORAGE_KEY) +
    ';' +
    'var OLDW="thirdBrainWealthV1";' +
    'var tb=document.getElementById("tk-tbody");' +
    'var elO=document.getElementById("tk-open-n");' +
    'var elC=document.getElementById("tk-closed-n");' +
    'var elA=document.getElementById("tk-amt-sum");' +
    'if(!tb||!elO||!elC||!elA)return;' +
    'function fmt(n){return new Intl.NumberFormat("en-CA",{style:"currency",currency:"CAD"}).format(n);}' +
    'function parseNum(v){var x=parseFloat(String(v).replace(/,/g,""));return isFinite(x)?x:0;}' +
    'function toMonthly(a,f){var v=parseNum(a);if(f==="biweekly")return v*26/12;if(f==="weekly")return v*52/12;if(f==="annual")return v/12;return v;}' +
    'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");}' +
    'function nextId(){return "t"+String(Date.now())+String(Math.random()).slice(2,9);}' +
    'function detailRow(id){return tb.querySelector("tr.tkt-detail[data-tkt=\\""+id+"\\"]");}' +
    'function wrapFor(id){var d=detailRow(id);return d?d.querySelector(".tkt-close-wrap"):null;}' +
    'function makePair(d){var id=nextId();var cat=String(d&&d.category==="purchase"?"purchase":"invest");' +
    'var title=String(d&&d.title!=null?d.title:"");var amt=String(d&&d.amount!=null?d.amount:"0");var st=(d&&d.status==="closed")?"closed":"open";' +
    'var con=String(d&&d.conclusion!=null?d.conclusion:"");var un=String(d&&d.unlocks!=null?d.unlocks:"");var hid=st==="open"?" hidden":"";' +
    'var tr1=document.createElement("tr");tr1.className="tkt-head";tr1.setAttribute("data-tkt",id);' +
    'tr1.innerHTML="<td><select class=\\"tkt-cat\\" aria-label=\\"Ticket type\\"><option value=\\"invest\\""+(cat==="invest"?" selected":"")+">Investing</option><option value=\\"purchase\\""+(cat==="purchase"?" selected":"")+">Purchase with intent</option></select></td><td><input class=\\"tkt-title\\" type=\\"text\\" autocomplete=\\"off\\" placeholder=\\"Ticket name\\" value=\\""+esc(title)+"\\"/></td><td><input class=\\"tkt-amount\\" type=\\"number\\" min=\\"0\\" step=\\"0.01\\" inputmode=\\"decimal\\" value=\\""+esc(amt)+"\\"/></td><td><select class=\\"tkt-status\\" aria-label=\\"Status\\"><option value=\\"open\\""+(st==="open"?" selected":"")+">Open</option><option value=\\"closed\\""+(st==="closed"?" selected":"")+">Closed</option></select></td><td><button type=\\"button\\" class=\\"tkt-remove\\">Remove</button></td>";' +
    'var tr2=document.createElement("tr");tr2.className="tkt-detail";tr2.setAttribute("data-tkt",id);' +
    'tr2.innerHTML="<td colspan=\\"5\\"><div class=\\"tkt-close-wrap\\""+hid+"><div class=\\"tkt-field\\"><label for=\\"\\">Conclusion</label><textarea class=\\"tkt-conclusion\\" rows=\\"3\\" maxlength=\\"4000\\" placeholder=\\"What happened, what you learned, or how you will measure success.\\">"+esc(con)+"</textarea></div><div class=\\"tkt-field\\"><label for=\\"\\">Unlocks next</label><textarea class=\\"tkt-unlocks\\" rows=\\"2\\" maxlength=\\"4000\\" placeholder=\\"e.g. room for another asset, raise income target, start follow-up ticket…\\">"+esc(un)+"</textarea></div></div></td>";' +
    'tb.appendChild(tr1);tb.appendChild(tr2);return id;}' +
    'function migrateFromLocal(){var cur=wsReadLocalOnce(SK);if(cur&&cur.tickets)return cur;var raw=wsReadLocalOnce(OLDW);if(!raw)return null;var d=raw;var tix=[];' +
    'if(d&&Array.isArray(d.investments)){d.investments.forEach(function(x){tix.push({category:"invest",title:String(x&&x.label||""),amount:String(x&&x.amount!=null?x.amount:"0"),status:"open",conclusion:"",unlocks:""});});}' +
    'if(d&&Array.isArray(d.purchases)){d.purchases.forEach(function(x){tix.push({category:"purchase",title:String(x&&x.label||""),amount:String(x&&x.amount!=null?x.amount:"0"),status:"open",conclusion:"",unlocks:""});});}' +
    'if(tix.length)return{tickets:tix};return null;}' +
    'function readTickets(){var out=[];tb.querySelectorAll("tr.tkt-head").forEach(function(tr){var id=tr.getAttribute("data-tkt");var cat=tr.querySelector(".tkt-cat");var ti=tr.querySelector(".tkt-title");var am=tr.querySelector(".tkt-amount");var st=tr.querySelector(".tkt-status");var d2=detailRow(id);var cw=d2?d2.querySelector(".tkt-close-wrap"):null;var co=cw?cw.querySelector(".tkt-conclusion"):null;var un=cw?cw.querySelector(".tkt-unlocks"):null;if(cat&&ti&&am&&st)out.push({category:String(cat.value||"invest"),title:String(ti.value||""),amount:String(am.value||""),status:String(st.value||"open"),conclusion:co?String(co.value||""):"",unlocks:un?String(un.value||""):""});});return out;}' +
    'function save(){wsPut(SK,{tickets:readTickets()});}' +
    'function recalc(){var openN=0,closedN=0,sum=0;tb.querySelectorAll("tr.tkt-head").forEach(function(tr){var st=tr.querySelector(".tkt-status");var am=tr.querySelector(".tkt-amount");var v=am?parseNum(am.value):0;sum+=v;if(st&&st.value==="closed")closedN+=1;else openN+=1;});elO.textContent=String(openN);elC.textContent=String(closedN);elA.textContent=fmt(sum);}' +
    'function onCh(){recalc();save();}' +
    'function loadTickets(list){tb.innerHTML="";if(!list||!list.length){makePair({category:"invest",title:"",amount:"0",status:"open",conclusion:"",unlocks:""});return;}for(var i=0;i<list.length;i++){makePair(list[i]);}}' +
    'tb.addEventListener("input",function(ev){var t=ev.target;if(t&&(t.classList.contains("tkt-title")||t.classList.contains("tkt-amount")||t.classList.contains("tkt-conclusion")||t.classList.contains("tkt-unlocks")))onCh();});' +
    'tb.addEventListener("change",function(ev){var t=ev.target;if(t&&t.classList.contains("tkt-status")){var tr=t.closest("tr.tkt-head");var id=tr&&tr.getAttribute("data-tkt");var w=id?wrapFor(id):null;if(t.value==="closed"&&w){var co=w.querySelector(".tkt-conclusion");if(!co||!String(co.value||"").trim()){alert("Add a conclusion before closing this ticket.");t.value="open";if(w)w.setAttribute("hidden","hidden");return;}if(w)w.removeAttribute("hidden");}else if(w){w.setAttribute("hidden","hidden");}onCh();return;}if(t&&(t.classList.contains("tkt-cat")||t.classList.contains("tkt-amount")))onCh();});' +
    'tb.addEventListener("click",function(ev){var t=ev.target;if(!t||!t.classList.contains("tkt-remove"))return;var tr=t.closest("tr.tkt-head");if(!tr)return;var id=tr.getAttribute("data-tkt");if(tb.querySelectorAll("tr.tkt-head").length<=1){alert("Keep at least one ticket row.");return;}tb.querySelectorAll("tr[data-tkt=\\""+id+"\\"]").forEach(function(r){r.remove();});onCh();});' +
    'document.getElementById("tk-add").addEventListener("click",function(){makePair({category:"invest",title:"",amount:"0",status:"open",conclusion:"",unlocks:""});onCh();});' +
    'document.getElementById("tk-reset").addEventListener("click",function(){if(!confirm("Remove all tickets in the database and reload one empty starter?"))return;wsPut(SK,null);location.reload();});' +
    'wsGet(SK,function(err,d){if(!d){d=migrateFromLocal();if(d)wsPut(SK,d);}loadTickets(d&&Array.isArray(d.tickets)?d.tickets:null);recalc();});' +
    'var yAmt=document.getElementById("yield-amt");var yFr=document.getElementById("yield-freq");var yMo=document.getElementById("yield-out-mo");var yWk=document.getElementById("yield-out-wk");' +
    'function yRecalc(){if(!yAmt||!yFr||!yMo||!yWk)return;var mo=toMonthly(yAmt.value,yFr.value);var wk=mo*12/52;yMo.textContent=fmt(mo);yWk.textContent=fmt(wk);}' +
    'if(yAmt&&yFr){yAmt.addEventListener("input",yRecalc);yFr.addEventListener("change",yRecalc);yRecalc();}' +
    '})();<' +
    '/script>';
  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>Tickets</h1>' +
    '<p class="sub">Investing moves and intentional purchases as tickets. Close a ticket with a conclusion and note what it unlocks next—more assets, income, or follow-on work.</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/saving">Saving</a>' +
    '<a class="link-pill" href="/cashflow">Cashflow</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel tk-panel">' +
    tkStyles +
    '<p class="tk-hint">Each row is a <strong>ticket</strong>. While <strong>Open</strong>, use it to track the name and amount (CAD). When you mark it <strong>Closed</strong>, you must add a <strong>conclusion</strong>—then describe what that closure <strong>unlocks</strong> (e.g. capacity for another asset, a higher income target, a follow-up ticket). Data stays in this browser only.</p>' +
    '<div class="tk-totals">' +
    '<div class="tk-total-card">' +
    '<p class="tk-total-label">Open tickets</p>' +
    '<p id="tk-open-n" class="tk-total-val">0</p></div>' +
    '<div class="tk-total-card">' +
    '<p class="tk-total-label">Closed tickets</p>' +
    '<p id="tk-closed-n" class="tk-total-val">0</p></div>' +
    '<div class="tk-total-card">' +
    '<p class="tk-total-label">Sum of amounts (all)</p>' +
    '<p id="tk-amt-sum" class="tk-total-val">' +
    escHtml(zeroFmt) +
    '</p></div></div>' +
    '<div class="tk-table-wrap">' +
    '<table class="tk-table" aria-label="Tickets">' +
    '<thead><tr><th scope="col">Type</th><th scope="col">Ticket</th><th scope="col">Amount (CAD)</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Remove</span></th></tr></thead>' +
    '<tbody id="tk-tbody"></tbody></table></div>' +
    '<div class="tk-actions">' +
    '<button type="button" id="tk-add">Add ticket</button>' +
    '<button type="button" id="tk-reset">Clear all &amp; reload starter</button>' +
    '</div>' +
    '<details class="tk-yield">' +
    '<summary>Income yield helper (weekly ↔ monthly)</summary>' +
    '<div class="tk-yield-body">' +
    '<div class="tk-yield-row">' +
    '<label>Amount (CAD)<input id="yield-amt" type="number" min="0" step="0.01" inputmode="decimal" value="0"/></label>' +
    '<label>Frequency<select id="yield-freq">' +
    '<option value="monthly">Monthly</option>' +
    '<option value="biweekly">Biweekly (26/yr)</option>' +
    '<option value="weekly">Weekly</option>' +
    '<option value="annual">Annual</option>' +
    '</select></label></div>' +
    '<p class="tk-yield-out">≈ <span id="yield-out-mo">$0.00</span> / month · <span id="yield-out-wk">$0.00</span> / week</p>' +
    '<p class="tk-hint" style="margin:0;font-size:12px">Uses the same monthly-equivalent rules as the Income page; week = month × 12 ÷ 52.</p>' +
    '</div></details>' +
    tkScript +
    '</div></div>'
  );
}

function buildCostPlannerWorkspaceHtml(cfg) {
  const p = cfg.idPrefix;
  const zeroFmt = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(0);
  const addBtnStyle =
    cfg.addBtnColor === 'rose'
      ? '#' + p + '-add-debt{border-color:#be185d;background:#be185d;color:#fff;}' +
        '#' + p + '-add-debt:hover{background:#9d174d;border-color:#9d174d;color:#fff;}'
      : '#' + p + '-add-debt{border-color:#dc2626;background:#dc2626;color:#fff;}' +
        '#' + p + '-add-debt:hover{background:#b91c1c;border-color:#b91c1c;color:#fff;}';
  const totalCardStyle =
    cfg.addBtnColor === 'rose'
      ? '.' + p + '-total-card{border:1px solid #be185d55;border-radius:12px;padding:16px 20px;margin-bottom:16px;background:linear-gradient(135deg,#fdf2f8,#fff);}' +
        '.' + p + '-total-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#9d174d;margin:0 0 6px;}'
      : '.' + p + '-total-card{border:1px solid #dc262655;border-radius:12px;padding:16px 20px;margin-bottom:16px;background:linear-gradient(135deg,#fef2f2,#fff);}' +
        '.' + p + '-total-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#b91c1c;margin:0 0 6px;}';
  const styles =
    '<style>' +
    '.' + p + '-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.' + p + '-hint{margin:0 0 16px;font-size:13px;color:#64748b;line-height:1.5;max-width:56em;}' +
    '.' + p + '-grid{display:grid;gap:18px;grid-template-columns:1fr;align-items:start;}' +
    '@media(min-width:900px){.' + p + '-grid{grid-template-columns:minmax(0,3fr) minmax(220px,1fr);}}' +
    '.' + p + '-block{border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;background:#fafafa;min-width:0;}' +
    '.' + p + '-block-owe{padding:16px 18px 18px;}' +
    '.' + p + '-block-income{min-width:0;}' +
    '.' + p + '-block h2{margin:0 0 12px;font-size:15px;font-weight:800;color:#0f172a;letter-spacing:-0.02em;}' +
    totalCardStyle +
    '.' + p + '-total-val{font-size:1.85rem;font-weight:800;color:#0f172a;margin:0;font-variant-numeric:tabular-nums;}' +
    '.' + p + '-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:12px;}' +
    '.' + p + '-table{width:100%;border-collapse:collapse;font-size:14px;}' +
    '.' + p + '-table th{text-align:left;padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#334155;font-weight:700;white-space:nowrap;}' +
    '.' + p + '-table td{padding:10px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle;}' +
    '.' + p + '-table tr:last-child td{border-bottom:none;}' +
    '.' + p + '-table-planner{min-width:920px;table-layout:fixed;}' +
    '.' + p + '-table-planner-noprio{min-width:720px;}' +
    '.' + p + '-col-prio{width:4.25rem;}' +
    '.' + p + '-col-cat{width:auto;min-width:9.5rem;}' +
    '.' + p + '-col-amt{width:6.75rem;}' +
    '.' + p + '-col-status{width:10rem;}' +
    '.' + p + '-col-act{width:9.5rem;}' +
    '.' + p + '-table-planner td:last-child,.' + p + '-table-planner th:last-child{position:sticky;right:0;z-index:1;background:#fff;box-shadow:-4px 0 8px -4px rgba(15,23,42,0.08);}' +
    '.' + p + '-table-planner th:last-child{background:#f8fafc;z-index:2;}' +
    '.' + p + '-table-planner tr.' + p + '-row-editing td:last-child{background:#fffbeb;}' +
    '.' + p + '-table-planner tr.' + p + '-row-paid-off td:last-child{background:#f0fdf4;}' +
    '.' + p + '-table-simple th:nth-child(2){text-align:right;width:11rem;}' +
    '.' + p + '-table-simple th:nth-child(3){width:5.5rem;text-align:center;}' +
    '.' + p + '-table-simple td:nth-child(2){text-align:right;}' +
    '.' + p + '-table-simple td:nth-child(3){text-align:center;}' +
    '.' + p + '-debt-label-inp{width:100%;min-width:0;box-sizing:border-box;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;font-weight:600;color:#334155;}' +
    '.' + p + '-balance{width:100%;min-width:0;box-sizing:border-box;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;text-align:right;font-variant-numeric:tabular-nums;}' +
    '.' + p + '-num-inp::-webkit-outer-spin-button,.' + p + '-num-inp::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}' +
    '.' + p + '-num-inp{-moz-appearance:textfield;appearance:textfield;}' +
    '.' + p + '-debt-delete{white-space:nowrap;border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:6px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;font:inherit;}' +
    '.' + p + '-debt-delete:hover{background:#fef2f2;border-color:#f87171;color:#991b1b;}' +
    '.' + p + '-debt-edit{white-space:nowrap;border:1px solid #e5e7eb;background:#fff;color:#475569;border-radius:6px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;font:inherit;}' +
    '.' + p + '-debt-edit:hover{background:#f8fafc;border-color:#cbd5e1;color:#0f172a;}' +
    '.' + p + '-row-actions{white-space:nowrap;text-align:right;display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;}' +
    '.' + p + '-row-actions .' + p + '-debt-edit{margin-right:6px;}' +
    '.' + p + '-row-editing{background:#fffbeb;}' +
    '.' + p + '-debt-label-txt{display:block;font-weight:600;color:#334155;word-break:break-word;}' +
    '.' + p + '-orig-txt,.' + p + '-balance-txt{display:block;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;color:#0f172a;}' +
    '.' + p + '-orig-txt{color:#64748b;}' +
    '.' + p + '-debt-actions{margin-top:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;}' +
    '.' + p + '-debt-actions button{border:1px solid #e5e7eb;background:#fff;color:#111827;border-radius:6px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;font:inherit;}' +
    '.' + p + '-debt-actions-hint{font-size:12px;color:#64748b;line-height:1.45;}' +
    '.' + p + '-debt-actions button:hover{background:#f9fafb;}' +
    addBtnStyle +
    '.' + p + '-income-row{display:grid;grid-template-columns:1fr;gap:14px;margin-bottom:12px;}' +
    '@media(min-width:540px){.' + p + '-income-row{grid-template-columns:minmax(10rem,14rem) 1fr;align-items:end;}}' +
    '@media(min-width:900px){.' + p + '-block-income .' + p + '-income-row{grid-template-columns:1fr;}}' +
    '.' + p + '-income-row label{font-size:13px;font-weight:600;color:#334155;display:flex;flex-direction:column;gap:6px;}' +
    '.' + p + '-income-row input[type=number],.' + p + '-income-row select{padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;width:100%;box-sizing:border-box;}' +
    '.' + p + '-income-extras{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;}' +
    '@media(min-width:900px){.' + p + '-block-income .' + p + '-income-extras{flex-direction:column;align-items:flex-start;}}' +
    '.' + p + '-income-extras label{flex-direction:row;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#334155;white-space:nowrap;}' +
    '.' + p + '-income-extras label input{width:auto;margin:0;}' +
    '#'+p+'-pull-income{border:1px solid #e5e7eb;background:#fff;color:#111827;border-radius:8px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;font:inherit;white-space:nowrap;}' +
    '#'+p+'-pull-income:hover{background:#f9fafb;}' +
    '.' + p + '-pct-wrap{margin:12px 0;}' +
    '.' + p + '-pct-wrap label{display:block;font-size:13px;font-weight:600;color:#334155;margin:0 0 8px;}' +
    '.' + p + '-pct-row{display:grid;grid-template-columns:1fr auto auto;gap:10px 14px;align-items:center;}' +
    '@media(max-width:520px){.' + p + '-pct-row{grid-template-columns:1fr;}}' +
    '@media(min-width:900px){.' + p + '-block-income .' + p + '-pct-row{grid-template-columns:1fr;}}' +
    '.' + p + '-pct-row input[type=range]{width:100%;min-width:0;max-width:none;margin:0;}' +
    '.' + p + '-pct-num-wrap{display:flex;align-items:center;gap:2px;font-weight:700;color:#334155;}' +
    '.' + p + '-pct-num{width:3rem;text-align:center;font-weight:700;border:1px solid #e2e8f0;border-radius:8px;padding:6px 4px;background:#fff;}' +
    '.' + p + '-pct-summary{font-size:13px;color:#475569;white-space:nowrap;}' +
    '.' + p + '-proj{margin-top:14px;padding:14px 16px;border-radius:10px;border:1px solid #bbf7d0;background:linear-gradient(135deg,#ecfdf5,#fff);}' +
    '.' + p + '-proj-warn{border-color:#fde68a;background:linear-gradient(135deg,#fffbeb,#fff);}' +
    '.' + p + '-proj-none{border-color:#e5e7eb;background:#f8fafc;}' +
    '.' + p + '-proj p{margin:0 0 6px;font-size:14px;color:#0f172a;line-height:1.45;}' +
    '.' + p + '-proj p:last-child{margin-bottom:0;}' +
    '.' + p + '-proj strong{font-variant-numeric:tabular-nums;}' +
    '.' + p + '-progress-block{margin-top:18px;padding-top:18px;border-top:1px solid #e5e7eb;}' +
    '.' + p + '-progress-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;margin-bottom:10px;}' +
    '.' + p + '-progress-head span{font-size:13px;font-weight:600;color:#475569;}' +
    '.' + p + '-progress-track{height:28px;background:#f1f5f9;border-radius:999px;overflow:hidden;border:1px solid #e2e8f0;}' +
    '.' + p + '-progress-fill{height:100%;width:0%;background:linear-gradient(90deg,#15803d,#22c55e);border-radius:999px;transition:width .35s ease;min-width:0;}' +
    '.' + p + '-progress-stats{display:flex;flex-wrap:wrap;gap:16px;margin-top:12px;}' +
    '.' + p + '-stat{flex:1;min-width:120px;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;background:#fff;}' +
    '.' + p + '-stat-lab{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;margin:0 0 4px;}' +
    '.' + p + '-stat-val{font-size:1.2rem;font-weight:800;color:#0f172a;margin:0;font-variant-numeric:tabular-nums;}' +
    '.' + p + '-log-form{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:14px 0;}' +
    '.' + p + '-log-form label{font-size:12px;font-weight:600;color:#475569;display:flex;flex-direction:column;gap:4px;}' +
    '.' + p + '-log-form input,.' + p + '-log-form select{padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px;font:inherit;}' +
    '.' + p + '-log-form select{min-width:10rem;max-width:16rem;background:#fff;}' +
    '.' + p + '-log-form button{border:1px solid #15803d;background:#15803d;color:#fff;border-radius:8px;padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer;font:inherit;}' +
    '.' + p + '-log-form button:hover{background:#166534;}' +
    '.' + p + '-log-table-wrap{overflow:auto;border:1px solid #e5e7eb;border-radius:10px;max-height:240px;}' +
    '.' + p + '-log-table{width:100%;border-collapse:collapse;font-size:13px;}' +
    '.' + p + '-log-table th{text-align:left;padding:8px 10px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-weight:700;color:#334155;position:sticky;top:0;}' +
    '.' + p + '-log-table th:nth-child(2){text-align:right;}' +
    '.' + p + '-log-table td{padding:8px 10px;border-bottom:1px solid #f1f5f9;}' +
    '.' + p + '-log-table td:nth-child(2){text-align:right;font-variant-numeric:tabular-nums;font-weight:600;}' +
    '.' + p + '-log-del{border:none;background:transparent;color:#94a3b8;cursor:pointer;font-size:16px;padding:2px 6px;line-height:1;}' +
    '.' + p + '-log-del:hover{color:#b91c1c;}' +
    '.' + p + '-log-delete{white-space:nowrap;border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;font:inherit;}' +
    '.' + p + '-log-delete:hover{background:#fef2f2;border-color:#f87171;color:#991b1b;}' +
    '.' + p + '-log-edit{border:1px solid #e5e7eb;background:#fff;color:#475569;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;font:inherit;}' +
    '.' + p + '-log-edit:hover{background:#f8fafc;border-color:#cbd5e1;color:#0f172a;}' +
    '.' + p + '-log-actions{white-space:nowrap;text-align:right;}' +
    '.' + p + '-log-actions .'+p+'-log-edit{margin-right:6px;}' +
    '.' + p + '-log-editing{background:#fffbeb;}' +
    '#'+p+'-log-btn.'+p+'-log-btn-edit{background:#b45309;border-color:#b45309;}' +
    '#'+p+'-log-btn.'+p+'-log-btn-edit:hover{background:#92400e;border-color:#92400e;}' +
    '.' + p + '-log-alloc{font-size:12px;color:#475569;line-height:1.4;max-width:18rem;}' +
    '.' + p + '-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;}' +
    '.' + p + '-actions button{border:1px solid #e5e7eb;background:#fff;color:#111827;border-radius:6px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;font:inherit;}' +
    '.' + p + '-actions button:hover{background:#f9fafb;}' +
    '.' + p + '-summary-block{margin-top:22px;padding-top:20px;border-top:1px solid #e5e7eb;}' +
    '.' + p + '-summary-block h2{margin:0 0 8px;font-size:15px;font-weight:800;color:#0f172a;}' +
    '.' + p + '-summary-hint{margin:0 0 12px;font-size:13px;color:#64748b;line-height:1.45;}' +
    '.' + p + '-summary-text{width:100%;min-height:220px;box-sizing:border-box;padding:12px 14px;border:1px solid #e2e8f0;border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:1.5;color:#0f172a;background:#f8fafc;resize:vertical;}' +
    '.' + p + '-summary-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;}' +
    '.' + p + '-summary-actions button{border:1px solid #e5e7eb;background:#fff;color:#111827;border-radius:6px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;font:inherit;}' +
    '.' + p + '-summary-actions button:hover{background:#f9fafb;}' +
    '#'+p+'-summary-gen{border-color:#1d4ed8;background:#1d4ed8;color:#fff;}' +
    '#'+p+'-summary-gen:hover{background:#1e40af;border-color:#1e40af;color:#fff;}' +
    '#'+p+'-summary-copy{border-color:#15803d;color:#15803d;}' +
    '#'+p+'-summary-dl{border-color:#475569;color:#475569;}' +
    '.' + p + '-summary-toast{margin:10px 0 0;font-size:12px;font-weight:600;color:#15803d;min-height:1.2em;}' +
    (cfg.paymentPriority
      ? '.' +
        p +
        '-prio-cell{white-space:nowrap;text-align:center;vertical-align:middle;}' +
        '.' +
        p +
        '-prio-num{display:inline-flex;align-items:center;justify-content:center;min-width:1.75rem;height:1.75rem;border-radius:999px;background:#fdf2f8;color:#9d174d;font-size:12px;font-weight:800;margin-bottom:4px;}' +
        '.' +
        p +
        '-prio-btns{display:flex;gap:3px;justify-content:center;}' +
        '.' +
        p +
        '-prio-up,.' +
        p +
        '-prio-down{border:1px solid #e5e7eb;background:#fff;color:#475569;border-radius:4px;padding:2px 6px;font-size:11px;line-height:1;cursor:pointer;font:inherit;}' +
        '.' +
        p +
        '-prio-up:hover,.' +
        p +
        '-prio-down:hover{background:#fdf2f8;border-color:#f9a8d4;color:#9d174d;}' +
        '.' +
        p +
        '-prio-note{margin:0 0 10px;font-size:12px;color:#64748b;line-height:1.45;}' +
        '.' +
        p +
        '-target-row{margin-bottom:12px;}' +
        '.' +
        p +
        '-target-row label{font-size:13px;font-weight:600;color:#334155;display:flex;flex-direction:column;gap:6px;max-width:220px;}' +
        '.' +
        p +
        '-income-summary{margin:0 0 12px;padding:10px 12px;border-radius:8px;background:#fdf2f8;border:1px solid #fbcfe8;font-size:13px;color:#831843;line-height:1.45;}' +
        ''
      : '') +
    (cfg.paidOffStatus || cfg.paymentCalendar
      ? '.' +
        p +
        '-row-paid-off{background:#f0fdf4;}' +
        '.' +
        p +
        '-row-paid-off .' +
        p +
        '-debt-label-inp{color:#15803d;}' +
        '.' +
        p +
        '-paid-badge{display:inline-block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.04em;color:#fff;background:#15803d;border-radius:999px;padding:3px 8px;}' +
        '.' +
        p +
        '-paid-date{display:block;font-size:11px;color:#64748b;margin-top:4px;line-height:1.35;word-break:break-word;}' +
        '.' +
        p +
        '-balance-paid{background:#ecfdf5;border-color:#bbf7d0;color:#15803d;}' +
        '.' +
        p +
        '-amt-cell{text-align:right;vertical-align:middle;font-variant-numeric:tabular-nums;}' +
        '.' +
        p +
        '-table th.' +
        p +
        '-th-amt{text-align:right;}' +
        '.' +
        p +
        '-status-cell{min-width:0;line-height:1.4;vertical-align:middle;}' +
        '.' +
        p +
        '-orig-inp{width:100%;min-width:0;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;text-align:right;font-weight:600;color:#0f172a;background:#fff;font-variant-numeric:tabular-nums;}' +
        '.' +
        p +
        '-orig-inp:focus{border-color:#be185d;outline:2px solid rgba(190,24,93,0.2);outline-offset:0;}' +
        '.' +
        p +
        '-orig-inp::placeholder{color:#94a3b8;font-weight:500;}' +
        '.' +
        p +
        '-row-editing .' +
        p +
        '-orig-txt,.' +
        p +
        '-row-editing .' +
        p +
        '-debt-label-txt{display:none!important;}' +
        '.' +
        p +
        '-row-editing .' +
        p +
        '-balance{display:none!important;}' +
        '.' +
        p +
        '-row-editing .' +
        p +
        '-balance-txt{display:block!important;}' +
        '.' +
        p +
        '-paid-amt{display:block;font-weight:700;color:#15803d;padding:4px 0;}' +
        '.' +
        p +
        '-pay-hint{margin:0 0 10px;font-size:12px;color:#64748b;line-height:1.45;}' +
        '.' +
        p +
        '-timeline-block{margin-top:20px;padding-top:18px;border-top:1px solid #e5e7eb;}' +
        '.' +
        p +
        '-timeline-block h2{margin:0 0 8px;font-size:15px;font-weight:800;color:#0f172a;}' +
        '.' +
        p +
        '-pay-timeline{margin-top:4px;}' +
        '.' +
        p +
        '-pay-timeline-item{display:grid;grid-template-columns:5.75rem 1.35rem 1fr;gap:10px 14px;padding:0 0 24px;align-items:start;cursor:default;}' +
        '.' +
        p +
        '-pay-timeline-item[data-date]{cursor:pointer;}' +
        '.' +
        p +
        '-pay-timeline-left{text-align:right;padding-top:2px;}' +
        '.' +
        p +
        '-pay-timeline-date-lbl{display:block;font-weight:800;font-size:13px;color:#0f172a;font-variant-numeric:tabular-nums;}' +
        '.' +
        p +
        '-pay-timeline-day-lbl{display:block;font-size:11px;color:#64748b;margin-top:2px;}' +
        '.' +
        p +
        '-pay-timeline-rail{position:relative;display:flex;flex-direction:column;align-items:center;min-height:100%;}' +
        '.' +
        p +
        '-pay-timeline-dot{width:12px;height:12px;border-radius:999px;background:#fff;border:2px solid #94a3b8;flex-shrink:0;z-index:1;box-sizing:border-box;}' +
        '.' +
        p +
        '-pay-timeline-dot-done{background:#0d9488;border-color:#0d9488;}' +
        '.' +
        p +
        '-pay-timeline-dot-future{background:#fff;border-color:#cbd5e1;}' +
        '.' +
        p +
        '-pay-timeline-dot-projected{background:#fff;border:2px dashed #f472b6;}' +
        '.' +
        p +
        '-pay-timeline-line{flex:1;width:2px;background:#e2e8f0;margin-top:4px;min-height:28px;}' +
        '.' +
        p +
        '-pay-timeline-body{min-width:0;}' +
        '.' +
        p +
        '-pay-timeline-you{margin:0 0 6px;font-size:12px;font-weight:700;color:#0d9488;}' +
        '.' +
        p +
        '-pay-timeline-event{margin:0 0 8px;font-size:14px;color:#0f172a;line-height:1.45;}' +
        '.' +
        p +
        '-pay-timeline-event strong{font-variant-numeric:tabular-nums;}' +
        '.' +
        p +
        '-pay-timeline-meta{display:block;font-size:11px;color:#64748b;margin-top:3px;}' +
        '.' +
        p +
        '-pay-timeline-note{color:#64748b;}' +
        '.' +
        p +
        '-pay-timeline-item-today .' +
        p +
        '-pay-timeline-body{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:10px 12px;}' +
        '.' +
        p +
        '-pay-timeline-item-projected .' +
        p +
        '-pay-timeline-event{color:#831843;}' +
        '.' +
        p +
        '-pay-timeline-empty{margin:0;font-size:13px;color:#64748b;line-height:1.45;}' +
        ''
      : '') +
    (cfg.paymentCalendar
      ? '.' +
        p +
        '-cal-block{margin-top:20px;padding-top:18px;border-top:1px solid #e5e7eb;}' +
        '.' +
        p +
        '-cal-block h2{margin:0 0 12px;font-size:15px;font-weight:800;color:#0f172a;}' +
        '.' +
        p +
        '-cal-nav{display:flex;align-items:center;gap:12px;margin-bottom:12px;}' +
        '.' +
        p +
        '-cal-nav button{border:1px solid #e5e7eb;background:#fff;border-radius:6px;padding:6px 12px;font:inherit;font-weight:700;cursor:pointer;}' +
        '.' +
        p +
        '-cal-nav button:hover{background:#fdf2f8;border-color:#f9a8d4;}' +
        '.' +
        p +
        '-cal-nav span{flex:1;text-align:center;font-weight:800;font-size:15px;color:#831843;}' +
        '.' +
        p +
        '-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;max-width:420px;}' +
        '.' +
        p +
        '-cal-dow{font-size:11px;font-weight:700;color:#64748b;text-align:center;padding:4px 0;}' +
        '.' +
        p +
        '-cal-day{border:1px solid #e5e7eb;background:#fff;border-radius:8px;padding:8px 4px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;text-align:center;min-height:2.25rem;}' +
        '.' +
        p +
        '-cal-day:hover{background:#fdf2f8;}' +
        '.' +
        p +
        '-cal-empty{border:none;background:transparent;cursor:default;min-height:0;padding:0;}' +
        '.' +
        p +
        '-cal-has-pay{background:#fdf2f8;border-color:#f9a8d4;color:#9d174d;font-weight:800;}' +
        '.' +
        p +
        '-cal-selected{outline:2px solid #be185d;outline-offset:1px;}' +
        '.' +
        p +
        '-cal-detail{margin-top:14px;padding:12px 14px;border:1px solid #fbcfe8;border-radius:10px;background:#fdf2f8;font-size:13px;color:#831843;line-height:1.5;}' +
        '.' +
        p +
        '-cal-detail ul{margin:8px 0 0;padding-left:0;}' +
        '.' +
        p +
        '-cal-pay-item{display:flex;flex-wrap:wrap;align-items:center;gap:8px;list-style:none;margin:8px 0;padding:0;}' +
        '.' +
        p +
        '-cal-pay-amt{font-weight:700;}' +
        '.' +
        p +
        '-cal-pay-actions{margin-left:auto;display:flex;gap:6px;}' +
        '.' +
        p +
        '-cal-log-edit,.' +
        p +
        '-cal-log-delete{border:1px solid #e5e7eb;background:#fff;color:#475569;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;font:inherit;}' +
        '.' +
        p +
        '-cal-log-delete{border-color:#fecaca;color:#b91c1c;}' +
        '.' +
        p +
        '-cal-log-delete:hover{background:#fef2f2;border-color:#f87171;color:#991b1b;}' +
        '.' +
        p +
        '-cal-log-edit:hover{background:#f8fafc;border-color:#cbd5e1;color:#0f172a;}' +
        ''
      : '') +
    '.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}' +
    '</style>';
  const scriptCfg = {
    idPrefix: p,
    storageKey: cfg.storageKey,
    defaults: cfg.defaults,
    legacyKeys: cfg.legacyKeys || null,
    legacyLabels: cfg.legacyLabels || null,
    keepOneRowAlert: cfg.keepOneRowAlert,
    deleteConfirm: cfg.deleteConfirm || 'Delete this row?',
    logAlert: cfg.logAlert,
    resetConfirm: cfg.resetConfirm,
    projEmptyTitle: cfg.projEmptyTitle,
    projEmptySub: cfg.projEmptySub,
    projNoPay: cfg.projNoPay,
    goalLabel: cfg.goalLabel,
    moPaySuffix: cfg.moPaySuffix,
    pctPaidSuffix: cfg.pctPaidSuffix,
    paymentPriority: !!cfg.paymentPriority,
    targetDate: !!cfg.targetDate,
    paidOffStatus: !!cfg.paidOffStatus,
    paymentCalendar: !!cfg.paymentCalendar,
    summaryTitle: cfg.summaryTitle || cfg.pageTitle + ' summary',
    summaryFileName: cfg.summaryFileName || 'summary.txt',
    paidLabel: cfg.paidLabel,
    moPaySuffix: cfg.moPaySuffix,
    logBtn: cfg.logBtn,
    logUpdateBtn: cfg.logUpdateBtn || 'Update payment',
    logDeleteConfirm: cfg.logDeleteConfirm || 'Delete this payment?',
  };
  const script =
    '<script>' +
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var CFG=' +
    JSON.stringify(scriptCfg) +
    ';' +
    'var P=CFG.idPrefix;' +
    'var SK=CFG.storageKey;' +
    'var SKI=' +
    JSON.stringify(INCOME_STORAGE_KEY) +
    ';' +
    'var DEFAULTS=CFG.defaults;' +
    'var LEGACY_KEYS=CFG.legacyKeys;' +
    'var LEGACY_LABELS=CFG.legacyLabels;' +
    'function gid(id){return P+"-"+id;}' +
    'function bindClick(id,fn){var el=document.getElementById(gid(id));if(el)el.addEventListener("click",fn);}' +
    'var elDebtTb=document.getElementById(gid("debt-tbody"));' +
    'var elTotal=document.getElementById(gid("total"));' +
    'var elMoPay=document.getElementById(gid("mo-pay"));' +
    'var elProj=document.getElementById(gid("projection"));' +
    'var elFill=document.getElementById(gid("progress-fill"));' +
    'var elPaid=document.getElementById(gid("paid"));' +
    'var elLeft=document.getElementById(gid("left"));' +
    'var elPctDisp=document.getElementById(gid("pct-disp"));' +
    'var elIncome=document.getElementById(gid("income"));' +
    'var elPct=document.getElementById(gid("pct"));' +
    'var elLogTb=document.getElementById(gid("log-tbody"));' +
    'var _incomePage=null;var _canSave=false;' +
    'if(!elTotal||!elDebtTb)return;' +
    'function fmt(n){return new Intl.NumberFormat("en-CA",{style:"currency",currency:"CAD"}).format(n);}' +
    'function parseNum(v){var x=parseFloat(String(v).replace(/,/g,""));return isFinite(x)?x:0;}' +
    'function toMo(a,f){var v=parseNum(a);if(f==="biweekly")return v*26/12;if(f==="weekly")return v*52/12;if(f==="annual")return v/12;return v;}' +
    'function readIncomePage(){var d=_incomePage;if(!d||!d.sources||!d.sources.length)return 0;var sum=0,s,i,src,lines,L;for(s=0;s<d.sources.length;s++){src=d.sources[s];lines=src&&src.lines?src.lines:[];for(i=0;i<lines.length;i++){L=lines[i];sum+=toMo(L&&L.amount,L&&L.frequency||"monthly");}}return sum;}' +
    'function newRowId(){return "r"+String(Date.now())+Math.random().toString(36).slice(2,8);}' +
    'function readDebtsFromDom(){var out=[];elDebtTb.querySelectorAll("tr").forEach(function(tr,i){var lab=tr.querySelector("."+P+"-debt-label-inp");var amt=tr.querySelector("."+P+"-balance");if(!lab||!amt)return;var row={id:tr.getAttribute("data-row-id")||newRowId(),label:String(lab.value||""),balance:String(amt.value||"")};if(CFG.paymentPriority)row.priority=parseNum(tr.getAttribute("data-priority"))||(i+1);if(CFG.paidOffStatus){var origInp=tr.querySelector("."+P+"-orig-inp");var tgt=origInp?String(origInp.value||""):tr.getAttribute("data-target-amt");if(tgt)row.target=String(tgt);if(tr.getAttribute("data-paid-off")==="1"){row.paidOff=true;var pod=tr.getAttribute("data-paid-off-date");if(pod)row.paidOffDate=pod;}}if(!tr.getAttribute("data-row-id"))tr.setAttribute("data-row-id",row.id);out.push(row);});return out;}' +
    'function sumDebtItems(items){var s=0,i;for(i=0;i<items.length;i++)s+=parseNum(items[i]&&items[i].balance);return s;}' +
    'function readState(){var useInc=document.getElementById(gid("use-income-page"));var inc=useInc&&useInc.checked?readIncomePage():parseNum(elIncome&&elIncome.value);var st={debtItems:readDebtsFromDom(),incomeMonthly:inc,useIncomePage:!!(useInc&&useInc.checked),debtPct:Math.min(100,Math.max(0,parseNum(elPct&&elPct.value))),baseline:parseNum(document.getElementById(gid("baseline"))&&document.getElementById(gid("baseline")).value),payments:readPayments()};if(CFG.targetDate){var td=document.getElementById(gid("target-date"));st.targetDate=td?String(td.value||""):"";}return st;}' +
    'function readPayments(){var out=[];if(!elLogTb)return out;elLogTb.querySelectorAll("tr").forEach(function(tr){var d=tr.getAttribute("data-date");var a=tr.getAttribute("data-amt");var n=tr.querySelector("."+P+"-log-note");var pt=tr.getAttribute("data-target");var allocRaw=tr.getAttribute("data-alloc");var allocs=[];if(allocRaw){try{allocs=JSON.parse(allocRaw)||[];}catch(e){allocs=[];}}var row={date:d,amount:String(a),note:n?String(n.textContent||""):""};if(pt)row.payTarget=pt;if(allocs.length)row.allocations=allocs;if(d&&a)out.push(row);});return out;}' +
    'function save(st){if(!_canSave)return;if(!st)st=readState();if(!st.debtItems||!st.debtItems.length){if(!elDebtTb||!elDebtTb.querySelectorAll("tr").length)return;}wsPut(SK,st);}' +
    'function addMonths(d,n){var x=new Date(d.getTime());x.setMonth(x.getMonth()+n);return x;}' +
    'function fmtDate(d){return d.toLocaleDateString("en-CA",{month:"long",day:"numeric",year:"numeric"});}' +
    'function monthsBetween(from,to){return Math.max(0,(to.getFullYear()-from.getFullYear())*12+(to.getMonth()-from.getMonth()));}' +
    'function renderProjection(total,moPay,pct,inc){if(!elProj||!elMoPay)return;elMoPay.textContent=fmt(moPay);elProj.className=P+"-proj";var sumEl=document.getElementById(gid("income-summary"));if(sumEl){if(inc>0&&pct>0)sumEl.innerHTML="You put <strong>"+pct+"%</strong> of <strong>"+fmt(inc)+"</strong>/mo income toward the wedding = <strong>"+fmt(moPay)+"</strong>/mo.";else sumEl.textContent="Set income and a savings % to see your monthly wedding contribution.";}if(total<=0){elProj.className+=" "+P+"-proj-none";elProj.innerHTML="<p><strong>"+CFG.projEmptyTitle+"</strong> "+CFG.projEmptySub+"</p>";return;}if(moPay<=0){elProj.className+=" "+P+"-proj-warn";elProj.innerHTML="<p>"+CFG.projNoPay+"</p><p>Total remaining: <strong>"+fmt(total)+"</strong></p>";return;}var months=Math.ceil(total/moPay);var free=addMonths(new Date(),months);var html="<p>At <strong>"+fmt(moPay)+"</strong>/mo ("+pct+"% of income), you could be "+CFG.goalLabel+" in about <strong>"+months+"</strong> month"+(months===1?"":"s")+" — around <strong>"+fmtDate(free)+"</strong>.</p><p>Total remaining: <strong>"+fmt(total)+"</strong></p>";if(CFG.targetDate){var td=document.getElementById(gid("target-date"));var ts=td?String(td.value||""):"";if(ts){var target=new Date(ts+"T12:00:00");var today=new Date();today.setHours(12,0,0,0);var moLeft=monthsBetween(today,target);if(moLeft>0){var needMo=total/moLeft;html+="<p>Target date <strong>"+fmtDate(target)+"</strong> ("+moLeft+" mo away): need <strong>"+fmt(needMo)+"</strong>/mo.";if(moPay>=needMo-0.01)html+=" <strong>On track</strong> at your current "+pct+"%.";else if(inc>0)html+=" Short <strong>"+fmt(needMo-moPay)+"</strong>/mo — about <strong>"+Math.min(100,Math.ceil((needMo/inc)*100))+"%</strong> of income would cover it.";html+="</p>";}else if(moLeft===0&&total>0){html+="<p class=\\""+P+"-proj-warn\\">Target date is this month — still <strong>"+fmt(total)+"</strong> to fund.</p>";}}}elProj.innerHTML=html;}' +
    'function renderProgress(total,baseline){var base=baseline>0?baseline:total;var paid=Math.max(0,base-total);var pct=base>0?Math.min(100,Math.round((paid/base)*1000)/10):0;if(elFill)elFill.style.width=pct+"%";if(elPaid)elPaid.textContent=fmt(paid);if(elLeft)elLeft.textContent=fmt(total);var pctEl=document.getElementById(gid("progress-pct"));if(pctEl)pctEl.textContent=pct+CFG.pctPaidSuffix;}' +
    'function recalc(){var items=readDebtsFromDom();var total=sumDebtItems(items);elTotal.textContent=fmt(total);var st=readState();var inc=st.incomeMonthly;var pct=st.debtPct;var moPay=inc*(pct/100);if(elPctDisp)elPctDisp.textContent=String(Math.round(pct));if(elIncome&&st.useIncomePage)elIncome.value=inc?String(Math.round(inc*100)/100):"0";renderProjection(total,moPay,pct,inc);var base=st.baseline;var blEl=document.getElementById(gid("baseline"));if(base<=0&&total>0){base=total;if(blEl)blEl.value=String(base);st.baseline=base;}renderProgress(total,base);if(CFG.paidOffStatus)orderedRows().forEach(function(tr){syncRowPaySummary(tr);syncRowPaidOff(tr);if(!tr.classList.contains(P+"-row-editing"))syncRowView(tr);});refreshPayTargetSelect();if(CFG.paidOffStatus)renderPaymentTimeline();if(CFG.paymentCalendar)renderPaymentCalendar();save(st);}' +
    'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");}' +
    'function renumberPriorities(){if(!CFG.paymentPriority)return;elDebtTb.querySelectorAll("tr").forEach(function(tr,i){var sp=tr.querySelector("."+P+"-prio-num");if(sp)sp.textContent=String(i+1);tr.setAttribute("data-priority",String(i+1));});}' +
    'function sumAllocationsForId(id){if(!id)return 0;var pays=readPayments(),sum=0;pays.forEach(function(py){(py.allocations||[]).forEach(function(a){if(a&&a.id===id)sum+=parseNum(a.amount);});});return Math.round(sum*100)/100;}' +
    'function lastPaymentDateForId(id){if(!id)return "";var pays=readPayments(),last="";pays.forEach(function(py){(py.allocations||[]).forEach(function(a){if(a&&a.id===id&&parseNum(a.amount)>0&&py.date)last=py.date;});});return last;}' +
    'function restoreInputFocus(inp){if(!inp||!inp.isConnected)return;var s=inp.selectionStart,e=inp.selectionEnd;requestAnimationFrame(function(){try{inp.focus();if(inp.setSelectionRange!=null&&s!=null)inp.setSelectionRange(s,e);}catch(err){}});}' +
    'function anyRowEditing(){return !!(elDebtTb&&elDebtTb.querySelector("."+P+"-row-editing"));}' +
    'function rowFieldFocused(tr){if(!tr)return false;var ae=document.activeElement;if(!ae||!tr.contains(ae))return false;return ae.classList.contains(P+"-orig-inp")||ae.classList.contains(P+"-debt-label-inp")||ae.classList.contains(P+"-balance");}' +
    'function syncRemainingDisplay(tr){if(!tr)return;var id=tr.getAttribute("data-row-id");var applied=sumAllocationsForId(id);var origInp=tr.querySelector("."+P+"-orig-inp");var orig=origInp?parseNum(origInp.value):parseNum(tr.getAttribute("data-target-amt"));var rem=Math.max(0,Math.round((orig-applied)*100)/100);var balInp=tr.querySelector("."+P+"-balance");var balTxt=tr.querySelector("."+P+"-balance-txt");if(balInp)balInp.value=String(rem);if(balTxt)balTxt.textContent=fmt(rem);if(origInp&&document.activeElement===origInp)restoreInputFocus(origInp);}' +
    'function ensureRowTarget(tr){if(!tr)return 0;if(rowFieldFocused(tr)){var origInp0=tr.querySelector("."+P+"-orig-inp");return origInp0?parseNum(origInp0.value):parseNum(tr.getAttribute("data-target-amt"));}var id=tr.getAttribute("data-row-id");var applied=sumAllocationsForId(id);var origInp=tr.querySelector("."+P+"-orig-inp");var inp=tr.querySelector("."+P+"-balance");var bal=inp?parseNum(inp.value):0;var tgt=origInp?parseNum(origInp.value):parseNum(tr.getAttribute("data-target-amt"));if(tgt<=0.009&&origInp){if(applied>0.009&&bal>0.009&&applied>bal+0.009)tgt=bal;else if(applied>0.009||bal>0.009)tgt=Math.round((bal+applied)*100)/100;if(tgt>0.009){origInp.value=String(tgt);tr.setAttribute("data-target-amt",String(tgt));}}else if(tgt>0.009){tr.setAttribute("data-target-amt",String(tgt));if(origInp&&!parseNum(origInp.value))origInp.value=String(tgt);}return tgt;}' +
    'function syncRowView(tr){if(!CFG.paidOffStatus||!tr||tr.classList.contains(P+"-row-editing"))return;var labInp=tr.querySelector("."+P+"-debt-label-inp");var labTxt=tr.querySelector("."+P+"-debt-label-txt");var origInp=tr.querySelector("."+P+"-orig-inp");var origTxt=tr.querySelector("."+P+"-orig-txt");var balInp=tr.querySelector("."+P+"-balance");var balTxt=tr.querySelector("."+P+"-balance-txt");if(labTxt&&labInp)labTxt.textContent=String(labInp.value||"").trim()||"—";if(origTxt&&origInp){var o=parseNum(origInp.value);origTxt.textContent=o>0.009?fmt(o):"—";}if(balTxt&&balInp)balTxt.textContent=fmt(parseNum(balInp.value));}' +
    'function refreshRowEditUi(tr){if(!CFG.paidOffStatus||!tr||!tr.classList.contains(P+"-row-editing"))return;var delBtn=tr.querySelector("."+P+"-debt-delete");if(delBtn)delBtn.hidden=false;if(rowFieldFocused(tr))return;var balInp=tr.querySelector("."+P+"-balance");var balTxt=tr.querySelector("."+P+"-balance-txt");if(balInp&&balTxt){balInp.hidden=true;balTxt.hidden=false;syncRemainingDisplay(tr);}}' +
    'function setRowEditing(tr,on){if(!CFG.paidOffStatus||!tr)return;var wasEditing=tr.classList.contains(P+"-row-editing");var editing=!!on;if(editing){orderedRows().forEach(function(other){if(other!==tr&&other.classList.contains(P+"-row-editing"))setRowEditing(other,false);});}var editBtn=tr.querySelector("."+P+"-debt-edit");var delBtn=tr.querySelector("."+P+"-debt-delete");if(editing)tr.classList.add(P+"-row-editing");else{tr.classList.remove(P+"-row-editing");if(!isRowEmpty(tr))tr.removeAttribute("data-row-new");}if(editBtn)editBtn.textContent=editing?"Done":"Edit";if(delBtn)delBtn.hidden=!editing;var labInp=tr.querySelector("."+P+"-debt-label-inp");var labTxt=tr.querySelector("."+P+"-debt-label-txt");var origInp=tr.querySelector("."+P+"-orig-inp");var origTxt=tr.querySelector("."+P+"-orig-txt");var balInp=tr.querySelector("."+P+"-balance");var balTxt=tr.querySelector("."+P+"-balance-txt");if(labInp)labInp.hidden=!editing;if(labTxt)labTxt.hidden=editing;if(origInp)origInp.hidden=!editing;if(origTxt)origTxt.hidden=editing;if(balInp&&balTxt){if(editing){syncRemainingDisplay(tr);balInp.hidden=true;balTxt.hidden=false;}else{balInp.hidden=true;balTxt.hidden=false;}}if(editing&&!wasEditing&&tr.getAttribute("data-row-new")==="1"){try{labInp&&labInp.focus();}catch(e){}}else if(!editing)syncRowView(tr);}' +
    'function isRowEmpty(tr){if(!tr)return true;var lab=tr.querySelector("."+P+"-debt-label-inp");var labTxt=tr.querySelector("."+P+"-debt-label-txt");var name=lab?String(lab.value||"").trim():"";if(!name&&labTxt)name=String(labTxt.textContent||"").trim();if(name&&name!=="—")return false;var orig=tr.querySelector("."+P+"-orig-inp");var bal=tr.querySelector("."+P+"-balance");if(orig&&parseNum(orig.value)>0.009)return false;if(bal&&parseNum(bal.value)>0.009)return false;var id=tr.getAttribute("data-row-id");if(id&&sumAllocationsForId(id)>0.009)return false;return true;}' +
    'function deleteDebtRow(tr){if(!tr||tr.parentNode!==elDebtTb)return;var rows=elDebtTb.querySelectorAll("tr");if(rows.length<=1){if(!isRowEmpty(tr)){alert(CFG.keepOneRowAlert);return;}tr.remove();elDebtTb.appendChild(makeDebtRow({}));renumberPriorities();recalc();return;}var lab=tr.querySelector("."+P+"-debt-label-inp");var labTxt=tr.querySelector("."+P+"-debt-label-txt");var name=lab&&!lab.hidden?String(lab.value||"").trim():(labTxt?String(labTxt.textContent||"").trim():"");if(name==="—")name="";if(!isRowEmpty(tr)){var msg=CFG.deleteConfirm;if(name)msg="Delete \\""+name+"\\"?";if(!confirm(msg))return;}tr.remove();renumberPriorities();recalc();}' +
    'function debtCategoryCell(label,isNew){if(!CFG.paidOffStatus)return "<td><input class=\\""+P+"-debt-label-inp\\" type=\\"text\\" autocomplete=\\"off\\" placeholder=\\"Category name\\" value=\\""+esc(label)+"\\"/></td>";return "<td class=\\""+P+"-cat-cell\\"><span class=\\""+P+"-debt-label-txt\\">"+esc(String(label||"").trim()||"—")+"</span><input class=\\""+P+"-debt-label-inp\\" type=\\"text\\" autocomplete=\\"off\\" placeholder=\\"Category name\\" value=\\""+esc(label)+"\\""+(isNew?"":" hidden")+"/></td>";}' +
    'function debtActionsCell(isNew){if(!CFG.paidOffStatus)return "<td><button type=\\"button\\" class=\\""+P+"-debt-delete\\" title=\\"Delete row\\" aria-label=\\"Delete row\\">Delete</button></td>";var delHidden=isNew?"":" hidden";return "<td class=\\""+P+"-row-actions\\"><button type=\\"button\\" class=\\""+P+"-debt-edit\\" title=\\"Edit category\\" aria-label=\\"Edit category\\">"+(isNew?"Done":"Edit")+"</button><button type=\\"button\\" class=\\""+P+"-debt-delete\\" title=\\"Delete row\\" aria-label=\\"Delete row\\""+delHidden+">Delete</button></td>";}' +
    'function syncRowPaySummary(tr){if(!CFG.paidOffStatus||!tr)return;var id=tr.getAttribute("data-row-id");var applied=sumAllocationsForId(id);var target=ensureRowTarget(tr);var paidEl=tr.querySelector("."+P+"-paid-amt");if(paidEl)paidEl.textContent=fmt(applied);}' +
    'function syncRowPaidOff(tr,payDate){if(!CFG.paidOffStatus||!tr)return;if(!rowFieldFocused(tr))syncRowPaySummary(tr);else{var id0=tr.getAttribute("data-row-id");var paidEl0=tr.querySelector("."+P+"-paid-amt");if(paidEl0)paidEl0.textContent=fmt(sumAllocationsForId(id0));syncRemainingDisplay(tr);}var inp=tr.querySelector("."+P+"-balance");var bal=inp?parseNum(inp.value):0;var id=tr.getAttribute("data-row-id");var applied=sumAllocationsForId(id);var target=rowFieldFocused(tr)?(function(){var o=tr.querySelector("."+P+"-orig-inp");return o?parseNum(o.value):parseNum(tr.getAttribute("data-target-amt"));})():ensureRowTarget(tr);var badge=tr.querySelector("."+P+"-paid-badge");var dateEl=tr.querySelector("."+P+"-paid-date");var fullyPaid=(target>0.009&&applied>=target-0.009)||(bal<=0.009&&applied>0.009);if(dateEl){if(applied>0.009&&target>0.009)dateEl.textContent=fmt(applied)+" paid of "+fmt(target)+" (from log)";else dateEl.textContent="";}if(fullyPaid&&!rowFieldFocused(tr)){tr.classList.add(P+"-row-paid-off");tr.setAttribute("data-paid-off","1");var pd=tr.getAttribute("data-paid-off-date");if(!pd){if(payDate)pd=payDate;else pd=lastPaymentDateForId(id);if(pd)tr.setAttribute("data-paid-off-date",pd);}if(badge)badge.hidden=false;if(dateEl&&pd)dateEl.textContent="Paid "+pd+" · "+fmt(applied)+" of "+fmt(target);if(inp){inp.readOnly=true;inp.classList.add(P+"-balance-paid");}}else if(!fullyPaid){tr.classList.remove(P+"-row-paid-off");tr.removeAttribute("data-paid-off");tr.removeAttribute("data-paid-off-date");if(badge)badge.hidden=true;if(inp){inp.readOnly=false;inp.classList.remove(P+"-balance-paid");}}var origInp=tr.querySelector("."+P+"-orig-inp");if(origInp){origInp.readOnly=false;origInp.classList.remove(P+"-balance-paid");}refreshRowEditUi(tr);}' +
    'function debtRowAmountCells(it,isNew){var balance=String(it.balance!=null?it.balance:"0");var orig=it.target!=null&&parseNum(it.target)>0?String(it.target):(parseNum(balance)>0?balance:"");var rem="<td><input class=\\""+P+"-balance "+P+"-num-inp\\" type=\\"number\\" min=\\"0\\" step=\\"0.01\\" inputmode=\\"decimal\\" value=\\""+esc(balance)+"\\"/></td>";if(!CFG.paidOffStatus)return rem;var origDisp=parseNum(orig)>0.009?fmt(parseNum(orig)):"—";var balDisp=fmt(parseNum(balance));var hideOrig=isNew?"":" hidden";var hideBal=isNew?"":" hidden";return "<td class=\\""+P+"-amt-cell\\"><span class=\\""+P+"-orig-txt\\">"+esc(origDisp)+"</span><input class=\\""+P+"-orig-inp "+P+"-num-inp\\" type=\\"text\\" inputmode=\\"decimal\\" placeholder=\\"0\\" value=\\""+esc(orig)+"\\" aria-label=\\"Original amount\\""+hideOrig+"/></td><td class=\\""+P+"-amt-cell\\"><span class=\\""+P+"-paid-amt\\">"+fmt(0)+"</span></td><td class=\\""+P+"-amt-cell\\"><span class=\\""+P+"-balance-txt\\">"+esc(balDisp)+"</span><input class=\\""+P+"-balance "+P+"-num-inp\\" type=\\"text\\" inputmode=\\"decimal\\" value=\\""+esc(balance)+"\\" aria-label=\\"Remaining amount\\" hidden/></td>";}' +
    'function makeDebtRow(it){it=it||{};var id=it.id||newRowId();var label=it.label!=null?it.label:"";var balance=String(it.balance!=null?it.balance:"0");var isNew=!String(label||"").trim()&&parseNum(balance)<=0.009&&!(it.target!=null&&parseNum(it.target)>0.009);var tr=document.createElement("tr");tr.setAttribute("data-row-id",id);if(isNew)tr.setAttribute("data-row-new","1");if(it.target!=null&&parseNum(it.target)>0)tr.setAttribute("data-target-amt",String(it.target));if(it.paidOff){tr.setAttribute("data-paid-off","1");if(it.paidOffDate)tr.setAttribute("data-paid-off-date",String(it.paidOffDate));}var statusCell=CFG.paidOffStatus?"<td class=\\""+P+"-status-cell\\"><span class=\\""+P+"-paid-badge\\" hidden>Paid off</span><span class=\\""+P+"-paid-date\\"></span></td>":"";var amtCells=debtRowAmountCells(it,isNew);var catCell=debtCategoryCell(label,isNew);var actCell=debtActionsCell(isNew);if(CFG.paymentPriority){tr.innerHTML="<td class=\\""+P+"-prio-cell\\"><span class=\\""+P+"-prio-num\\">1</span><div class=\\""+P+"-prio-btns\\"><button type=\\"button\\" class=\\""+P+"-prio-up\\" title=\\"Pay sooner\\">↑</button><button type=\\"button\\" class=\\""+P+"-prio-down\\" title=\\"Pay later\\">↓</button></div></td>"+catCell+amtCells+statusCell+actCell;}else{tr.innerHTML=catCell+amtCells+statusCell+actCell;}if(CFG.paidOffStatus){ensureRowTarget(tr);syncRowPaySummary(tr);syncRowPaidOff(tr);if(isNew)tr.classList.add(P+"-row-editing");else syncRowView(tr);}return tr;}' +
    'function loadDebtRows(items){elDebtTb.innerHTML="";var list=items&&items.length?items.slice():(DEFAULTS&&DEFAULTS.length?DEFAULTS.slice():[]);if(!list.length&&DEFAULTS&&DEFAULTS.length)list=DEFAULTS.slice();if(CFG.paymentPriority&&list.length){list.sort(function(a,b){return(parseNum(a.priority)||999)-(parseNum(b.priority)||999);});}for(var i=0;i<list.length;i++){elDebtTb.appendChild(makeDebtRow(list[i]));}renumberPriorities();}' +
    'function migrateDebtItems(d){if(!d)return null;if(Array.isArray(d.debtItems)&&d.debtItems.length){return d.debtItems.map(function(it,idx){var row=Object.assign({},it);if(!row.id)row.id=newRowId();if(CFG.paymentPriority&&row.priority==null)row.priority=idx+1;return row;});}if(d.debts&&!Array.isArray(d.debts)&&LEGACY_KEYS){var out=[],k;for(k=0;k<LEGACY_KEYS.length;k++){var key=LEGACY_KEYS[k];out.push({id:newRowId(),label:LEGACY_LABELS[key],balance:String(d.debts[key]!=null?d.debts[key]:"0"),priority:k+1});}return out;}return null;}' +
    'function orderedRows(){return [].slice.call(elDebtTb.querySelectorAll("tr"));}' +
    'function refreshPayTargetSelect(){var sel=document.getElementById(gid("log-target"));if(!sel)return;var cur=sel.value;sel.innerHTML="<option value=\\"\\">Auto (by pay order)</option>";orderedRows().forEach(function(tr,i){var id=tr.getAttribute("data-row-id")||"";var lab=tr.querySelector("."+P+"-debt-label-inp");var lbl=lab?String(lab.value||"").trim():"";if(!lbl)lbl="Item "+(i+1);var bal=tr.querySelector("."+P+"-balance");var balTxt=bal?fmt(parseNum(bal.value)):"";var opt=document.createElement("option");opt.value=id;opt.textContent=lbl+(balTxt?" ("+balTxt+")":"");sel.appendChild(opt);});if(cur){try{sel.value=cur;}catch(e){}}}' +
    'function replayPaymentAllocations(){var pays=readPayments();if(!pays.length)return;orderedRows().forEach(function(tr){var applied=sumAllocationsForId(tr.getAttribute("data-row-id"));var inp=tr.querySelector("."+P+"-balance");if(!inp)return;ensureRowTarget(tr);var origInp=tr.querySelector("."+P+"-orig-inp");var tgt=origInp?parseNum(origInp.value):parseNum(tr.getAttribute("data-target-amt"));if(applied>0.009&&tgt>0.009)inp.value=String(Math.max(0,Math.round((tgt-applied)*100)/100));syncRowPaySummary(tr);});}' +
    'function applyPayment(amt,targetId){var left=amt;var allocs=[];var rows=orderedRows();if(targetId){for(var j=0;j<rows.length;j++){var trT=rows[j];if(trT.getAttribute("data-row-id")!==targetId)continue;var inpT=trT.querySelector("."+P+"-balance");var labT=trT.querySelector("."+P+"-debt-label-inp");if(!inpT)break;var balT=parseNum(inpT.value);var takeT=Math.min(balT,left);if(takeT>0){inpT.value=String(Math.round((balT-takeT)*100)/100);left-=takeT;var lblT=labT?String(labT.value||"").trim():"";allocs.push({id:targetId,label:lblT||"Selected item",amount:Math.round(takeT*100)/100});}break;}if(left>0.009){var extra=Math.round(left*100)/100;allocs.push({id:"",label:"Unapplied (over balance)",amount:extra});}return allocs;}for(var i=0;i<rows.length;i++){if(left<=0)break;var tr=rows[i];var inp=tr.querySelector("."+P+"-balance");var lab=tr.querySelector("."+P+"-debt-label-inp");if(!inp)continue;var bal=parseNum(inp.value);var take=Math.min(bal,left);if(take>0){inp.value=String(Math.round((bal-take)*100)/100);left-=take;var lbl=lab?String(lab.value||"").trim():"";allocs.push({id:tr.getAttribute("data-row-id")||"",label:lbl||("Item "+(i+1)),amount:Math.round(take*100)/100});}}return allocs;}' +
    'function formatAlloc(allocs){if(!allocs||!allocs.length)return "—";return allocs.map(function(a){return (a.label||"Item")+" "+fmt(a.amount);}).join(", ");}' +
    'function parseAllocsFromTr(tr){var allocRaw=tr.getAttribute("data-alloc");if(!allocRaw)return [];try{return JSON.parse(allocRaw)||[];}catch(e){return [];}}' +
    'function reverseAllocations(allocs){if(!allocs||!allocs.length)return;allocs.forEach(function(a){if(!a||!a.id)return;var rows=orderedRows();for(var i=0;i<rows.length;i++){if(rows[i].getAttribute("data-row-id")===a.id){var inp=rows[i].querySelector("."+P+"-balance");if(inp)inp.value=String(Math.round((parseNum(inp.value)+parseNum(a.amount))*100)/100);if(CFG.paidOffStatus){syncRowPaySummary(rows[i]);syncRowPaidOff(rows[i]);}break;}}});}' +
    'var _editLogTr=null;' +
    'function resetLogBtn(){var btn=document.getElementById(gid("log-btn"));if(!btn)return;btn.textContent=CFG.logBtn;btn.classList.remove(P+"-log-btn-edit");}' +
    'function findLogRowForPayment(py){if(!elLogTb||!py||!py.date)return null;var best=null;elLogTb.querySelectorAll("tr").forEach(function(tr){if(tr.getAttribute("data-date")!==py.date)return;if(String(tr.getAttribute("data-amt"))!==String(py.amount))return;var noteCell=tr.querySelector("."+P+"-log-note");var note=noteCell?String(noteCell.textContent||""):"";if(String(py.note||"")===note){best=tr;return;}if(!best)best=tr;});return best;}' +
    'function deleteLogRow(tr){if(!tr||tr.parentNode!==elLogTb)return;var amt=tr.getAttribute("data-amt");var dt=tr.getAttribute("data-date");var msg=CFG.logDeleteConfirm;if(dt&&amt)msg="Delete payment of "+fmt(parseNum(amt))+" on "+dt+"?";if(!confirm(msg))return;if(_editLogTr===tr){_editLogTr=null;resetLogBtn();}reverseAllocations(parseAllocsFromTr(tr));tr.remove();recalc();}' +
    'function startEditLogRow(tr){if(!tr)return;if(_editLogTr&&_editLogTr!==tr)_editLogTr.classList.remove(P+"-log-editing");_editLogTr=tr;tr.classList.add(P+"-log-editing");var dateInp=document.getElementById(gid("log-date"));var amtInp=document.getElementById(gid("log-amt"));var noteInp=document.getElementById(gid("log-note"));var targetSel=document.getElementById(gid("log-target"));if(dateInp)dateInp.value=tr.getAttribute("data-date")||"";if(amtInp)amtInp.value=tr.getAttribute("data-amt")||"";if(noteInp){var noteCell=tr.querySelector("."+P+"-log-note");noteInp.value=noteCell?String(noteCell.textContent||""):"";}if(targetSel)targetSel.value=tr.getAttribute("data-target")||"";var btn=document.getElementById(gid("log-btn"));if(btn){btn.textContent=CFG.logUpdateBtn;btn.classList.add(P+"-log-btn-edit");}try{amtInp&&amtInp.focus();}catch(e){}}' +
    'function addLogRow(row,prepend){var tr=document.createElement("tr");tr.setAttribute("data-date",row.date);tr.setAttribute("data-amt",row.amount);if(row.payTarget)tr.setAttribute("data-target",row.payTarget);if(row.allocations&&row.allocations.length)tr.setAttribute("data-alloc",JSON.stringify(row.allocations));tr.innerHTML="<td>"+esc(row.date)+"</td><td>"+fmt(parseNum(row.amount))+"</td><td class=\\""+P+"-log-alloc\\">"+esc(formatAlloc(row.allocations))+"</td><td class=\\""+P+"-log-note\\">"+esc(row.note||"")+"</td><td class=\\""+P+"-log-actions\\"><button type=\\"button\\" class=\\""+P+"-log-edit\\" title=\\"Edit payment\\" aria-label=\\"Edit payment\\">Edit</button><button type=\\"button\\" class=\\""+P+"-log-delete\\" title=\\"Delete payment\\" aria-label=\\"Delete payment\\">Delete</button></td>";if(prepend&&elLogTb.firstChild)elLogTb.insertBefore(tr,elLogTb.firstChild);else elLogTb.appendChild(tr);}' +
    'function loadState(d){if(anyRowEditing())return;if(!d){loadDebtRows(null);recalc();return;}var items=migrateDebtItems(d);if((!items||!items.length)&&Array.isArray(d.debtItems)&&d.debtItems.length===0)items=null;loadDebtRows(items);if(elIncome&&d.incomeMonthly!=null&&!d.useIncomePage)elIncome.value=String(d.incomeMonthly);var useEl=document.getElementById(gid("use-income-page"));if(useEl)useEl.checked=!!d.useIncomePage;if(elPct&&d.debtPct!=null)elPct.value=String(d.debtPct);var bl=document.getElementById(gid("baseline"));if(bl&&d.baseline!=null)bl.value=String(d.baseline);if(CFG.targetDate){var td=document.getElementById(gid("target-date"));if(td&&d.targetDate!=null)td.value=String(d.targetDate);}if(elLogTb){elLogTb.innerHTML="";var pays=d.payments||[];for(var i=pays.length-1;i>=0;i--)addLogRow(pays[i],false);}replayPaymentAllocations();if(CFG.paidOffStatus)orderedRows().forEach(function(tr){ensureRowTarget(tr);syncRowPaidOff(tr);});recalc();}' +
    'var _origDebTimer=null;' +
    'elDebtTb.addEventListener("input",function(ev){var t=ev.target;if(!t)return;var tr=t.closest("tr");if(t.classList.contains(P+"-orig-inp")&&tr){tr.setAttribute("data-target-amt",String(parseNum(t.value)));syncRemainingDisplay(tr);restoreInputFocus(t);if(_origDebTimer)clearTimeout(_origDebTimer);_origDebTimer=setTimeout(function(){var total=sumDebtItems(readDebtsFromDom());elTotal.textContent=fmt(total);save(readState());},500);return;}if(t.classList.contains(P+"-debt-label-inp"))recalc();});' +
    'elDebtTb.addEventListener("change",function(ev){var t=ev.target;if(t&&t.classList.contains(P+"-orig-inp"))recalc();});' +
    'elDebtTb.addEventListener("focusout",function(ev){var t=ev.target;if(t&&t.classList.contains(P+"-orig-inp"))recalc();});' +
    'elDebtTb.addEventListener("click",function(ev){var t=ev.target;if(!t)return;var tr=t.closest("tr");if(!tr||tr.parentNode!==elDebtTb)return;var editBtn=t.closest&&t.closest("."+P+"-debt-edit");if(editBtn&&editBtn.closest("tr")===tr){var editing=tr.classList.contains(P+"-row-editing");setRowEditing(tr,!editing);if(editing)recalc();return;}var delBtn=t.closest&&t.closest("."+P+"-debt-delete");if(delBtn&&delBtn.closest("tr")===tr){deleteDebtRow(tr);return;}if(CFG.paymentPriority&&t.classList.contains(P+"-prio-up")){var prev=tr.previousElementSibling;if(prev){elDebtTb.insertBefore(tr,prev);renumberPriorities();save();}return;}if(CFG.paymentPriority&&t.classList.contains(P+"-prio-down")){var next=tr.nextElementSibling;if(next){elDebtTb.insertBefore(next,tr);renumberPriorities();save();}return;}});' +
    'bindClick("add-debt",function(){elDebtTb.appendChild(makeDebtRow({}));renumberPriorities();var rows=elDebtTb.querySelectorAll("tr");if(rows.length){var last=rows[rows.length-1];var lab=last.querySelector("."+P+"-debt-label-inp");if(lab&&!lab.hidden){try{lab.focus();}catch(e){}}recalc();}});' +
    'if(elIncome){elIncome.addEventListener("input",function(){var u=document.getElementById(gid("use-income-page"));if(u)u.checked=false;recalc();});}' +
    'if(elPct){elPct.addEventListener("input",recalc);elPct.addEventListener("change",recalc);}' +
    'var useIncEl=document.getElementById(gid("use-income-page"));' +
    'if(useIncEl)useIncEl.addEventListener("change",recalc);' +
    'var targetEl=document.getElementById(gid("target-date"));if(targetEl){targetEl.addEventListener("change",recalc);targetEl.addEventListener("input",recalc);}' +
    'bindClick("pull-income",function(){wsGet(SKI,function(e,d){_incomePage=d;var u=document.getElementById(gid("use-income-page"));if(u)u.checked=true;recalc();});});' +
    'bindClick("log-btn",function(){var amtInp=document.getElementById(gid("log-amt"));var dateInp=document.getElementById(gid("log-date"));var noteInp=document.getElementById(gid("log-note"));var targetSel=document.getElementById(gid("log-target"));var amt=parseNum(amtInp&&amtInp.value);if(amt<=0){alert(CFG.logAlert);return;}var dt=dateInp&&dateInp.value?dateInp.value:new Date().toISOString().slice(0,10);var note=noteInp?String(noteInp.value||""):"";var targetId=targetSel?String(targetSel.value||""):"";if(_editLogTr){reverseAllocations(parseAllocsFromTr(_editLogTr));_editLogTr.remove();_editLogTr=null;resetLogBtn();}var allocs=applyPayment(amt,targetId);if(CFG.paidOffStatus)orderedRows().forEach(function(tr){syncRowPaidOff(tr,dt);});addLogRow({date:dt,amount:String(amt),note:note,payTarget:targetId,allocations:allocs},true);if(amtInp)amtInp.value="";if(noteInp)noteInp.value="";if(targetSel)targetSel.value="";recalc();});' +
    'if(elLogTb)elLogTb.addEventListener("click",function(ev){var editBtn=ev.target.closest&&ev.target.closest("."+P+"-log-edit");if(editBtn){var trE=editBtn.closest("tr");if(trE&&trE.parentNode===elLogTb)startEditLogRow(trE);return;}var delBtn=ev.target.closest&&ev.target.closest("."+P+"-log-delete");if(delBtn){var trD=delBtn.closest("tr");if(trD&&trD.parentNode===elLogTb)deleteLogRow(trD);return;}});' +
    'bindClick("lock-baseline",function(){var t=sumDebtItems(readDebtsFromDom());var bl=document.getElementById(gid("baseline"));if(bl)bl.value=String(t);recalc();});' +
    'bindClick("reset",function(){if(!confirm(CFG.resetConfirm))return;wsPut(SK,null);location.reload();});' +
    'function summaryToast(msg){var el=document.getElementById(gid("summary-toast"));if(el)el.textContent=msg||"";if(msg){setTimeout(function(){if(el&&el.textContent===msg)el.textContent="";},2800);}}' +
    'function buildSummaryText(){var st=readState();var items=st.debtItems||[];var total=sumDebtItems(items);var inc=st.incomeMonthly;var pct=st.debtPct;var moPay=inc*(pct/100);var base=st.baseline>0?st.baseline:total;var paid=Math.max(0,base-total);var pctDone=base>0?Math.round((paid/base)*1000)/10:0;var lines=[];lines.push(CFG.summaryTitle);lines.push("Generated: "+new Date().toLocaleString("en-CA"));lines.push("");lines.push("OVERVIEW");lines.push("Total remaining: "+fmt(total));lines.push(CFG.paidLabel+" (vs baseline): "+fmt(paid));lines.push("Remaining: "+fmt(total));lines.push("Progress: "+pctDone+CFG.pctPaidSuffix);lines.push("Baseline: "+fmt(base));lines.push("");lines.push("INCOME PLAN");lines.push("Monthly income: "+fmt(inc));lines.push("Allocation: "+pct+"% of income");lines.push("Monthly "+CFG.moPaySuffix+": "+fmt(moPay));if(CFG.targetDate&&st.targetDate){lines.push("Target date: "+st.targetDate);var target=new Date(st.targetDate+"T12:00:00");var today=new Date();today.setHours(12,0,0,0);var moLeft=monthsBetween(today,target);if(moLeft>0&&total>0){var needMo=total/moLeft;lines.push("Months until target: "+moLeft);lines.push("Needed per month: "+fmt(needMo));lines.push(moPay>=needMo-0.01?"Status: On track at current allocation.":"Status: Short "+fmt(Math.max(0,needMo-moPay))+"/mo at current allocation.");}}if(total>0&&moPay>0){var months=Math.ceil(total/moPay);lines.push("Projected "+CFG.goalLabel+" in ~"+months+" month"+(months===1?"":"s")+" (~"+fmtDate(addMonths(new Date(),months))+")");}lines.push("");lines.push(CFG.paymentPriority?"CATEGORIES (pay order)":"CATEGORIES");if(!items.length){lines.push("(none)");}else{items.forEach(function(it,i){var lab=String(it.label||"").trim()||("Item "+(i+1));var bal=parseNum(it.balance);var id=it.id||"";var logPaid=id?sumAllocationsForId(id):0;var orig=parseNum(it.target)||Math.round((bal+logPaid)*100)/100;var prefix=CFG.paymentPriority?(String(it.priority||i+1)+". "):"- ";if(CFG.paidOffStatus&&logPaid>0)lines.push(prefix+lab+": original "+fmt(orig)+", paid "+fmt(logPaid)+" (from log), remaining "+fmt(bal));else lines.push(prefix+lab+": "+fmt(bal));});}var pays=st.payments||[];lines.push("");lines.push("CONTRIBUTION LOG ("+pays.length+" entries)");if(!pays.length){lines.push("(none logged yet)");}else{for(var pi=pays.length-1;pi>=0;pi--){var py=pays[pi];var row=py.date+"  "+fmt(parseNum(py.amount));if(py.note)row+="  — "+py.note;if(py.allocations&&py.allocations.length)row+="  ["+py.allocations.map(function(a){return (a.label||"Item")+" "+fmt(a.amount);}).join(", ")+"]";lines.push(row);}}lines.push("");lines.push("— Third brain · "+window.location.href);return lines.join("\\n");}' +
    'function renderSummary(){var ta=document.getElementById(gid("summary-text"));if(!ta)return;ta.value=buildSummaryText();}' +
    'function copySummary(){renderSummary();var ta=document.getElementById(gid("summary-text"));if(!ta||!ta.value){summaryToast("Generate a summary first.");return;}var text=ta.value;if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){summaryToast("Copied to clipboard.");}).catch(function(){ta.select();try{document.execCommand("copy");summaryToast("Copied to clipboard.");}catch(e){summaryToast("Could not copy — select the text manually.");}});}else{ta.select();try{document.execCommand("copy");summaryToast("Copied to clipboard.");}catch(e){summaryToast("Could not copy — select the text manually.");}}}' +
    'function downloadSummary(){renderSummary();var ta=document.getElementById(gid("summary-text"));if(!ta||!ta.value){summaryToast("Generate a summary first.");return;}var blob=new Blob([ta.value],{type:"text/plain;charset=utf-8"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=CFG.summaryFileName;a.rel="noopener";document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},0);summaryToast("Download started.");}' +
    'var sumGen=document.getElementById(gid("summary-gen"));if(sumGen)sumGen.addEventListener("click",function(){renderSummary();summaryToast("Summary updated.");});' +
    'var sumCopy=document.getElementById(gid("summary-copy"));if(sumCopy)sumCopy.addEventListener("click",copySummary);' +
    'var sumDl=document.getElementById(gid("summary-dl"));if(sumDl)sumDl.addEventListener("click",downloadSummary);' +
    'var _calY=new Date().getFullYear();var _calM=new Date().getMonth();var _calSel=null;' +
    'function renderPaymentTimeline(){var host=document.getElementById(gid("pay-timeline"));if(!host)return;var pays=readPayments().slice().sort(function(a,b){return String(a.date).localeCompare(String(b.date));});var today=new Date();today.setHours(12,0,0,0);var todayStr=today.toISOString().slice(0,10);var byDate={};pays.forEach(function(py){if(!py.date)return;if(!byDate[py.date])byDate[py.date]=[];byDate[py.date].push(py);});var items=[];Object.keys(byDate).sort().forEach(function(ds){items.push({date:ds,type:"logged",pays:byDate[ds]});});var st=readState();var total=sumDebtItems(st.debtItems||[]);var moPay=st.incomeMonthly*(st.debtPct/100);if(total>0.009&&moPay>0.009){var cursor=new Date(today);cursor.setDate(1);cursor.setMonth(cursor.getMonth()+1);var projLeft=total;var guard=0;while(projLeft>0.009&&guard<96){guard++;var ds=cursor.toISOString().slice(0,10);var clash=false;var ci;for(ci=0;ci<items.length;ci++){if(items[ci].date===ds){clash=true;break;}}if(!clash){var amt=Math.round(Math.min(projLeft,moPay)*100)/100;items.push({date:ds,type:"projected",pays:[{amount:String(amt),note:"",allocations:[]}]});projLeft=Math.round((projLeft-amt)*100)/100;}cursor.setMonth(cursor.getMonth()+1);}}items.sort(function(a,b){return a.date.localeCompare(b.date);});var hasToday=false;var ti;for(ti=0;ti<items.length;ti++){if(items[ti].date===todayStr){hasToday=true;break;}}if(!hasToday){var ins=items.length;for(var i=0;i<items.length;i++){if(items[i].date>todayStr){ins=i;break;}}items.splice(ins,0,{date:todayStr,type:"today",pays:[]});}if(!pays.length&&!items.some(function(it){return it.type==="projected";})){host.innerHTML="<p class=\\""+P+"-pay-timeline-empty\\">No payments logged yet — log one above to start your timeline.</p>";return;}var html="";items.forEach(function(it,idx){var ds=it.date;var d=new Date(ds+"T12:00:00");var dateLbl=d.toLocaleDateString("en-CA",{month:"short",day:"numeric",year:"numeric"});var dayLbl=d.toLocaleDateString("en-CA",{weekday:"long"});var isToday=ds===todayStr;var isPast=ds<todayStr;var isProj=it.type==="projected";var dotCls=P+"-pay-timeline-dot";if(isProj)dotCls+=" "+P+"-pay-timeline-dot-projected";else if(isPast||isToday)dotCls+=" "+P+"-pay-timeline-dot-done";else dotCls+=" "+P+"-pay-timeline-dot-future";var itemCls=P+"-pay-timeline-item";if(isToday)itemCls+=" "+P+"-pay-timeline-item-today";if(isProj)itemCls+=" "+P+"-pay-timeline-item-projected";html+="<div class=\\""+itemCls+"\\" data-date=\\""+esc(ds)+"\\">";html+="<div class=\\""+P+"-pay-timeline-left\\"><span class=\\""+P+"-pay-timeline-date-lbl\\">"+esc(dateLbl)+"</span><span class=\\""+P+"-pay-timeline-day-lbl\\">"+esc(dayLbl)+"</span></div>";html+="<div class=\\""+P+"-pay-timeline-rail\\"><span class=\\""+dotCls+"\\"></span>";if(idx<items.length-1)html+="<span class=\\""+P+"-pay-timeline-line\\"></span>";html+="</div><div class=\\""+P+"-pay-timeline-body\\">";if(isToday)html+="<p class=\\""+P+"-pay-timeline-you\\">You are here</p>";if(it.type==="today"&&!it.pays.length&&!isProj)html+="<p class=\\""+P+"-pay-timeline-meta\\">Today — log a payment above when ready.</p>";it.pays.forEach(function(py){html+="<div class=\\""+P+"-pay-timeline-event\\"><strong>"+fmt(parseNum(py.amount))+"</strong>";if(py.allocations&&py.allocations.length)html+=" <span>"+esc(formatAlloc(py.allocations))+"</span>";if(py.note)html+=" <span class=\\""+P+"-pay-timeline-note\\">— "+esc(py.note)+"</span>";html+="<span class=\\""+P+"-pay-timeline-meta\\">"+(isProj?"Projected at "+Math.round(st.debtPct)+"% of income ("+fmt(moPay)+"/mo)":"Logged payment")+"</span></div>";});html+="</div></div>";});host.innerHTML=html;}' +
    'function paymentsForCalendar(){var pays=readPayments();var map={};pays.forEach(function(py){var d=py.date;if(!d)return;if(!map[d])map[d]=[];map[d].push(py);});return map;}' +
    'function renderPaymentCalendar(){if(!CFG.paymentCalendar)return;var grid=document.getElementById(gid("cal-grid"));var title=document.getElementById(gid("cal-title"));var detail=document.getElementById(gid("cal-detail"));if(!grid||!title)return;var byDate=paymentsForCalendar();var monthNames=["January","February","March","April","May","June","July","August","September","October","November","December"];title.textContent=monthNames[_calM]+" "+_calY;grid.innerHTML="";var dow=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];dow.forEach(function(d){var h=document.createElement("div");h.className=P+"-cal-dow";h.textContent=d;grid.appendChild(h);});var first=new Date(_calY,_calM,1);var start=first.getDay();var days=new Date(_calY,_calM+1,0).getDate();for(var i=0;i<start;i++){var blank=document.createElement("div");blank.className=P+"-cal-day "+P+"-cal-empty";grid.appendChild(blank);}for(var day=1;day<=days;day++){var ds=_calY+"-"+String(_calM+1).padStart(2,"0")+"-"+String(day).padStart(2,"0");var cell=document.createElement("button");cell.type="button";cell.className=P+"-cal-day";cell.textContent=String(day);if(byDate[ds]){cell.classList.add(P+"-cal-has-pay");cell.title=byDate[ds].length+" payment(s)";}if(_calSel===ds)cell.classList.add(P+"-cal-selected");cell.setAttribute("data-date",ds);grid.appendChild(cell);}if(detail){if(_calSel&&byDate[_calSel]){var html="<strong>"+_calSel+"</strong><ul>";byDate[_calSel].forEach(function(py){html+="<li class=\\""+P+"-cal-pay-item\\"><span class=\\""+P+"-cal-pay-amt\\">"+fmt(parseNum(py.amount))+"</span>";if(py.allocations&&py.allocations.length)html+="<span>"+esc(formatAlloc(py.allocations))+"</span>";if(py.note)html+="<span>— "+esc(py.note)+"</span>";html+="<span class=\\""+P+"-cal-pay-actions\\"><button type=\\"button\\" class=\\""+P+"-cal-log-edit\\" data-date=\\""+esc(py.date)+"\\" data-amt=\\""+esc(String(py.amount))+"\\" data-note=\\""+esc(py.note||"")+"\\">Edit</button><button type=\\"button\\" class=\\""+P+"-cal-log-delete\\" data-date=\\""+esc(py.date)+"\\" data-amt=\\""+esc(String(py.amount))+"\\" data-note=\\""+esc(py.note||"")+"\\">Delete</button></span></li>";});html+="</ul>";detail.innerHTML=html;}else if(_calSel){detail.innerHTML="<p>No payments on "+esc(_calSel)+".</p>";}else{detail.innerHTML="<p>Click a highlighted day to see what was paid toward the wedding.</p>";}}}' +
    'var calGrid=document.getElementById(gid("cal-grid"));if(calGrid){calGrid.addEventListener("click",function(ev){var btn=ev.target.closest("."+P+"-cal-day");if(!btn||btn.classList.contains(P+"-cal-empty"))return;var ds=btn.getAttribute("data-date");if(ds){_calSel=ds;renderPaymentCalendar();}});}' +
    'var calDetailEl=document.getElementById(gid("cal-detail"));if(calDetailEl){calDetailEl.addEventListener("click",function(ev){var editBtn=ev.target.closest&&ev.target.closest("."+P+"-cal-log-edit");if(editBtn){var tr=findLogRowForPayment({date:editBtn.getAttribute("data-date"),amount:editBtn.getAttribute("data-amt"),note:editBtn.getAttribute("data-note")||""});if(tr)startEditLogRow(tr);return;}var delBtn=ev.target.closest&&ev.target.closest("."+P+"-cal-log-delete");if(delBtn){var tr2=findLogRowForPayment({date:delBtn.getAttribute("data-date"),amount:delBtn.getAttribute("data-amt"),note:delBtn.getAttribute("data-note")||""});if(tr2)deleteLogRow(tr2);}});}' +
    'var timelineHost=document.getElementById(gid("pay-timeline"));if(timelineHost){timelineHost.addEventListener("click",function(ev){var item=ev.target.closest&&ev.target.closest("."+P+"-pay-timeline-item");if(!item||!CFG.paymentCalendar)return;var ds=item.getAttribute("data-date");if(!ds)return;_calSel=ds;var parts=ds.split("-");if(parts.length>=2){_calY=parseNum(parts[0]);_calM=parseNum(parts[1])-1;}renderPaymentCalendar();var calBlock=document.querySelector("."+P+"-cal-block");if(calBlock){try{calBlock.scrollIntoView({behavior:"smooth",block:"nearest"});}catch(e){}}});}' +
    'var calPrev=document.getElementById(gid("cal-prev"));if(calPrev)calPrev.addEventListener("click",function(){_calM--;if(_calM<0){_calM=11;_calY--;}_calSel=null;renderPaymentCalendar();});' +
    'var calNext=document.getElementById(gid("cal-next"));if(calNext)calNext.addEventListener("click",function(){_calM++;if(_calM>11){_calM=0;_calY++;}_calSel=null;renderPaymentCalendar();});' +
    'var dateInp=document.getElementById(gid("log-date"));if(dateInp&&!dateInp.value)dateInp.value=new Date().toISOString().slice(0,10);' +
    'var _storeLoaded=false;var _storeFetchDone=false;function hydrateStore(d){if(_storeLoaded)return;if(anyRowEditing()){setTimeout(function(){hydrateStore(d);},400);return;}_storeLoaded=true;_canSave=true;loadState(d);}' +
    'loadDebtRows(null);recalc();' +
    'wsGet(SKI,function(e,d){_incomePage=d;});' +
    'wsGet(SK,function(e,d){_storeFetchDone=true;hydrateStore(d);});' +
    'setTimeout(function(){if(!_storeFetchDone&&!_storeLoaded)hydrateStore(null);},12000);' +
    '})();<' +
    '/script>';
  const tablePlanner = cfg.paidOffStatus;
  const tableClass =
    p +
    '-table' +
    (tablePlanner ? ' ' + p + '-table-planner' + (cfg.paymentPriority ? '' : ' ' + p + '-table-planner-noprio') : ' ' + p + '-table-simple');
  const tableColGroup = tablePlanner
    ? cfg.paymentPriority
      ? '<colgroup><col class="' +
        p +
        '-col-prio"><col class="' +
        p +
        '-col-cat"><col class="' +
        p +
        '-col-amt"><col class="' +
        p +
        '-col-amt"><col class="' +
        p +
        '-col-amt"><col class="' +
        p +
        '-col-status"><col class="' +
        p +
        '-col-act"></colgroup>'
      : '<colgroup><col class="' +
        p +
        '-col-cat"><col class="' +
        p +
        '-col-amt"><col class="' +
        p +
        '-col-amt"><col class="' +
        p +
        '-col-amt"><col class="' +
        p +
        '-col-status"><col class="' +
        p +
        '-col-act"></colgroup>'
    : '';
  const payColsHead = cfg.paidOffStatus
    ? '<th scope="col" class="' +
      p +
      '-th-amt">Original (CAD)</th><th scope="col" class="' +
      p +
      '-th-amt">Paid (CAD)</th><th scope="col" class="' +
      p +
      '-th-amt">Remaining (CAD)</th>'
    : '<th scope="col">Balance (CAD)</th>';
  const payHintHtml = cfg.paidOffStatus
    ? '<p class="' +
      p +
      '-pay-hint"><strong>Paid</strong> totals come from the contribution log <strong>Applied to</strong> column below. Set <strong>Original</strong> to the full cost; <strong>Remaining</strong> updates when you log payments.</p>'
    : '';
  const tableHeadRow = cfg.paymentPriority
    ? '<thead><tr><th scope="col">Pay order</th><th scope="col">Category</th>' +
      payColsHead +
      (cfg.paidOffStatus ? '<th scope="col">Status</th>' : '') +
      '<th scope="col">Actions</th></tr></thead>'
    : '<thead><tr><th scope="col">Category</th>' +
      payColsHead +
      (cfg.paidOffStatus ? '<th scope="col">Status</th>' : '') +
      '<th scope="col">Actions</th></tr></thead>';
  const prioNoteHtml = cfg.paymentPriority
    ? '<p class="' + p + '-prio-note">Use ↑ ↓ to set payment order — contributions pay top items first until each balance hits zero.</p>'
    : '';
  const targetDateHtml = cfg.targetDate
    ? '<div class="' +
      p +
      '-target-row"><label>Target wedding date<input id="' +
      p +
      '-target-date" type="date" aria-label="Target wedding date"/></label></div>'
    : '';
  const incomeSummaryHtml = cfg.targetDate
    ? '<p id="' + p + '-income-summary" class="' + p + '-income-summary">Set income and a savings % to see your monthly wedding contribution.</p>'
    : '';
  const logTableHead =
    '<thead><tr><th>Date</th><th>Amount</th><th>Applied to</th><th>Note</th><th><span class="visually-hidden">Actions</span></th></tr></thead>';
  return (
    '<div class="analytics-toolbar">' +
    '<div>' +
    '<h1>' +
    escHtml(cfg.pageTitle) +
    '</h1>' +
    '<p class="sub">' +
    escHtml(cfg.pageSub) +
    '</p>' +
    '</div>' +
    '<div class="analytics-toolbar-actions">' +
    cfg.toolbarPills +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<div class="analytics-panel ' +
    p +
    '-panel">' +
    styles +
    '<p class="' +
    p +
    '-hint">' +
    cfg.hint +
    '</p>' +
    '<div class="' +
    p +
    '-total-card">' +
    '<p class="' +
    p +
    '-total-label">' +
    escHtml(cfg.totalLabel) +
    '</p>' +
    '<p id="' +
    p +
    '-total" class="' +
    p +
    '-total-val">' +
    escHtml(zeroFmt) +
    '</p></div>' +
    '<div class="' +
    p +
    '-grid">' +
    '<div class="' +
    p +
    '-block ' +
    p +
    '-block-owe">' +
    '<h2>' +
    escHtml(cfg.oweSectionTitle) +
    '</h2>' +
    prioNoteHtml +
    payHintHtml +
    '<div class="' +
    p +
    '-table-wrap"><table class="' +
    tableClass +
    '" aria-label="' +
    escAttr(cfg.tableAria) +
    '">' +
    tableColGroup +
    tableHeadRow +
    '<tbody id="' +
    p +
    '-debt-tbody"></tbody></table></div>' +
    '<div class="' +
    p +
    '-debt-actions">' +
    '<button type="button" id="' +
    p +
    '-add-debt">' +
    escHtml(cfg.addRowBtn) +
    '</button>' +
    (tablePlanner
      ? '<span class="' + p + '-debt-actions-hint">Click <strong>Edit</strong> on a row to change it or <strong>Delete</strong> it.</span>'
      : '') +
    '</div>' +
    '<input type="hidden" id="' +
    p +
    '-baseline" value="0"/>' +
    '</div>' +
    '<div class="' +
    p +
    '-block ' +
    p +
    '-block-income">' +
    '<h2>' +
    escHtml(cfg.incomeSectionTitle) +
    '</h2>' +
    targetDateHtml +
    incomeSummaryHtml +
    '<div class="' +
    p +
    '-income-row">' +
    '<label>Monthly income (CAD)<input class="' +
    p +
    '-num-inp" id="' +
    p +
    '-income" type="number" min="0" step="0.01" inputmode="decimal" value="0"/></label>' +
    '<div class="' +
    p +
    '-income-extras">' +
    '<label><input type="checkbox" id="' +
    p +
    '-use-income-page"/> Use Income page total</label>' +
    '<button type="button" id="' +
    p +
    '-pull-income">Refresh from Income</button>' +
    '</div>' +
    '</div>' +
    '<div class="' +
    p +
    '-pct-wrap">' +
    '<label for="' +
    p +
    '-pct">' +
    escHtml(cfg.pctLabel) +
    '</label>' +
    '<div class="' +
    p +
    '-pct-row">' +
    '<input id="' +
    p +
    '-pct" type="range" min="0" max="100" step="1" value="20"/>' +
    '<span class="' +
    p +
    '-pct-num-wrap"><input class="' +
    p +
    '-pct-num" id="' +
    p +
    '-pct-disp" type="text" readonly value="20" aria-label="' +
    escAttr(cfg.pctAria) +
    '"/>%</span>' +
    '<span class="' +
    p +
    '-pct-summary">→ <strong id="' +
    p +
    '-mo-pay">' +
    escHtml(zeroFmt) +
    '</strong>/mo ' +
    escHtml(cfg.moPaySuffix) +
    '</span>' +
    '</div></div>' +
    '<div id="' +
    p +
    '-projection" class="' +
    p +
    '-proj ' +
    p +
    '-proj-none"><p>' +
    escHtml(cfg.projDefault) +
    '</p></div>' +
    '</div></div>' +
    '<div class="' +
    p +
    '-progress-block">' +
    '<h2 style="margin:0 0 12px;font-size:15px;font-weight:800;color:#0f172a">Progress</h2>' +
    '<div class="' +
    p +
    '-progress-head"><span id="' +
    p +
    '-progress-pct">0' +
    escHtml(cfg.pctPaidSuffix) +
    '</span><span>' +
    escHtml(cfg.progressSub) +
    '</span></div>' +
    '<div class="' +
    p +
    '-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
    '<div id="' +
    p +
    '-progress-fill" class="' +
    p +
    '-progress-fill"></div></div>' +
    '<div class="' +
    p +
    '-progress-stats">' +
    '<div class="' +
    p +
    '-stat"><p class="' +
    p +
    '-stat-lab">' +
    escHtml(cfg.paidLabel) +
    '</p><p id="' +
    p +
    '-paid" class="' +
    p +
    '-stat-val">' +
    escHtml(zeroFmt) +
    '</p></div>' +
    '<div class="' +
    p +
    '-stat"><p class="' +
    p +
    '-stat-lab">' +
    escHtml(cfg.remainingLabel) +
    '</p><p id="' +
    p +
    '-left" class="' +
    p +
    '-stat-val">' +
    escHtml(zeroFmt) +
    '</p></div></div>' +
    '<div class="' +
    p +
    '-log-form">' +
    '<label>Date<input id="' +
    p +
    '-log-date" type="date"/></label>' +
    '<label>' +
    escHtml(cfg.paymentLabel) +
    '<input id="' +
    p +
    '-log-amt" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0"/></label>' +
    '<label>Pay toward<select id="' +
    p +
    '-log-target" aria-label="Choose category to pay"><option value="">Auto (by pay order)</option></select></label>' +
    '<label>Note<input id="' +
    p +
    '-log-note" type="text" autocomplete="off" placeholder="Optional"/></label>' +
    '<button type="button" id="' +
    p +
    '-log-btn">' +
    escHtml(cfg.logBtn) +
    '</button>' +
    '</div>' +
    '<div class="' +
    p +
    '-log-table-wrap"><table class="' +
    p +
    '-log-table" aria-label="Payment log">' +
    logTableHead +
    '<tbody id="' +
    p +
    '-log-tbody"></tbody></table></div>' +
    (cfg.paidOffStatus
      ? '<div class="' +
        p +
        '-timeline-block" aria-label="Payment timeline">' +
        '<h2>Payment timeline</h2>' +
        '<p class="' +
        p +
        '-summary-hint" style="margin-top:0">' +
        escHtml(cfg.timelineHint || 'Chronological view of logged payments and projected dates from your income plan.') +
        '</p>' +
        '<div id="' +
        p +
        '-pay-timeline" class="' +
        p +
        '-pay-timeline" aria-live="polite"></div>' +
        '</div>'
      : '') +
    (cfg.paymentCalendar
      ? '<div class="' +
        p +
        '-cal-block" aria-label="Payment calendar">' +
        '<h2>Payment calendar</h2>' +
        '<p class="' +
        p +
        '-summary-hint" style="margin-top:0">Days with contributions are highlighted — click a day to see what was paid and which category it went to.</p>' +
        '<div class="' +
        p +
        '-cal-nav">' +
        '<button type="button" id="' +
        p +
        '-cal-prev" aria-label="Previous month">←</button>' +
        '<span id="' +
        p +
        '-cal-title"></span>' +
        '<button type="button" id="' +
        p +
        '-cal-next" aria-label="Next month">→</button>' +
        '</div>' +
        '<div id="' +
        p +
        '-cal-grid" class="' +
        p +
        '-cal-grid"></div>' +
        '<div id="' +
        p +
        '-cal-detail" class="' +
        p +
        '-cal-detail"><p>Click a highlighted day to see what was paid toward the wedding.</p></div>' +
        '</div>'
      : '') +
    '<div class="' +
    p +
    '-actions">' +
    '<button type="button" id="' +
    p +
    '-lock-baseline">' +
    escHtml(cfg.lockBaseline) +
    '</button>' +
    '<button type="button" id="' +
    p +
    '-reset">' +
    escHtml(cfg.resetBtn) +
    '</button>' +
    '</div>' +
    '<div class="' +
    p +
    '-summary-block">' +
    '<h2>Share summary</h2>' +
    '<p class="' +
    p +
    '-summary-hint">Generate a plain-text snapshot of balances, plan, and contribution log — copy to share or download as a file.</p>' +
    '<textarea id="' +
    p +
    '-summary-text" class="' +
    p +
    '-summary-text" readonly aria-label="Generated summary"></textarea>' +
    '<div class="' +
    p +
    '-summary-actions">' +
    '<button type="button" id="' +
    p +
    '-summary-gen">Generate summary</button>' +
    '<button type="button" id="' +
    p +
    '-summary-copy">Copy to clipboard</button>' +
    '<button type="button" id="' +
    p +
    '-summary-dl">Download .txt</button>' +
    '</div>' +
    '<p id="' +
    p +
    '-summary-toast" class="' +
    p +
    '-summary-toast" aria-live="polite"></p>' +
    '</div></div>' +
    script +
    '</div></div>'
  );
}

function buildMoneyDashboardHtml() {
  const keysJson = JSON.stringify({
    income: INCOME_STORAGE_KEY,
    expenses: MONTHLY_EXPENSES_STORAGE_KEY,
    debt: DEBT_TRACKER_STORAGE_KEY,
    marriage: MARRIAGE_COST_STORAGE_KEY,
    saving: SAVING_STORAGE_KEY,
    tickets: TICKETS_STORAGE_KEY
  });
  const dashClientJs =
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var KEYS=' +
    keysJson +
    ';' +
    'var charts=[];' +
    'function fmt(n){return new Intl.NumberFormat("en-CA",{style:"currency",currency:"CAD"}).format(n||0);}' +
    'function pn(v){var x=parseFloat(String(v).replace(/,/g,""));return isFinite(x)?x:0;}' +
    'function escCell(s){return String(s==null?"":s).split("<").join("&lt;");}' +
    'function toMo(a,f){var v=pn(a);if(f==="biweekly")return v*26/12;if(f==="weekly")return v*52/12;if(f==="annual")return v/12;return v;}' +
    'function sumIncome(d){if(!d||!d.sources)return 0;var s=0;d.sources.forEach(function(src){(src.lines||[]).forEach(function(L){s+=toMo(L.amount,L.frequency||"monthly");});});return s;}' +
    'function sumExpenses(rows){if(!Array.isArray(rows))return 0;var s=0;rows.forEach(function(r){s+=pn(r&&r.amount);});return s;}' +
    'function allocPaidForId(payload,id){var s=0;(payload&&payload.payments||[]).forEach(function(py){(py.allocations||[]).forEach(function(a){if(a&&a.id===id)s+=pn(a.amount);});});return Math.round(s*100)/100;}' +
    'function plannerSum(payload){var items=(payload&&payload.debtItems)||[];var remaining=0,original=0,paidAlloc=0;items.forEach(function(it){var bal=pn(it.balance);var tgt=pn(it.target);var ap=allocPaidForId(payload,it.id);var orig=tgt>0?tgt:(ap>0&&bal>0&&ap>bal?bal:bal+ap);remaining+=bal;original+=orig;paidAlloc+=ap;});var base=pn(payload&&payload.baseline);if(base<=0)base=original;var paid=paidAlloc>0?paidAlloc:Math.max(0,base-remaining);return{total:remaining,original:original,baseline:base,paid:paid,items:items,payments:(payload&&payload.payments)||[],pct:pn(payload&&payload.debtPct),targetDate:payload&&payload.targetDate};}' +
    'function allocTotals(payload){var m={};(payload&&payload.payments||[]).forEach(function(py){(py.allocations||[]).forEach(function(a){if(!a)return;var k=a.label||a.id||"?";m[k]=(m[k]||0)+pn(a.amount);});});return m;}' +
    'function setKpi(id,val,sub){var el=document.getElementById(id);if(el)el.textContent=val;var s=document.getElementById(id+"-sub");if(s&&sub!=null)s.textContent=sub;}' +
    'function destroyCharts(){charts.forEach(function(c){try{c.destroy();}catch(e){}});charts=[];}' +
    'function mkChart(id,cfg){var el=document.getElementById(id);if(!el||typeof Chart==="undefined")return null;var c=new Chart(el,cfg);charts.push(c);return c;}' +
    'function yAxisCad(){return{ticks:{callback:function(v){return "$"+v;}}};}' +
    'function renderBarH(id,labels,data,color){if(!labels.length)return;mkChart(id,{type:"bar",data:{labels:labels,datasets:[{label:"Applied (log)",data:data,backgroundColor:color}]},options:{indexAxis:"y",plugins:{legend:{display:false}}}});}' +
    'function monthTotals(pays){var m={};(pays||[]).forEach(function(py){var d=py.date;if(!d)return;var mk=d.slice(0,7);m[mk]=(m[mk]||0)+pn(py.amount);});return m;}' +
    'function monthKeys(){var keys={},i;for(i=0;i<arguments.length;i++)Object.keys(arguments[i]||{}).forEach(function(k){keys[k]=1;});return Object.keys(keys).sort();}' +
    'function renderLinePayRgb(id,labels,data,rgb){if(!labels.length)return;var fill="rgba("+rgb[0]+","+rgb[1]+","+rgb[2]+",0.15)";var stroke="rgb("+rgb[0]+","+rgb[1]+","+rgb[2]+")";mkChart(id,{type:"line",data:{labels:labels,datasets:[{label:"Payments",data:data,borderColor:stroke,backgroundColor:fill,fill:true,tension:0.3}]},options:{plugins:{legend:{display:false}},scales:{y:yAxisCad()}}});}' +
    'function renderAll(D){destroyCharts();var inc=sumIncome(D.income);var exp=sumExpenses(D.expenses);var cf=inc-exp;var debt=plannerSum(D.debt);var wed=plannerSum(D.marriage);setKpi("dash-kpi-income",fmt(inc),"Monthly from Income page");setKpi("dash-kpi-expenses",fmt(exp),"Monthly from Expenses page");setKpi("dash-kpi-cashflow",fmt(cf),cf>=0?"Surplus":"Shortfall");setKpi("dash-kpi-debt",fmt(debt.total),debt.paid>0?fmt(debt.paid)+" paid (from log)":(debt.items.length?debt.items.length+" categories":""));setKpi("dash-kpi-wedding",fmt(wed.total),wed.paid>0?fmt(wed.paid)+" funded (from log)":(wed.targetDate?"Target "+wed.targetDate:""));var debtPaid=Math.max(0,debt.paid);var wedPaid=Math.max(0,wed.paid);mkChart("dash-chart-cashflow",{type:"bar",data:{labels:["Income","Expenses","Net"],datasets:[{label:"CAD/mo",data:[inc,exp,cf],backgroundColor:["#15803d","#dc2626",cf>=0?"#2563eb":"#f59e0b"]}]},options:{plugins:{legend:{display:false}},scales:{y:yAxisCad()}}});if(debtPaid+debt.total>0){mkChart("dash-chart-debt",{type:"doughnut",data:{labels:["Paid","Remaining"],datasets:[{data:[debtPaid,debt.total],backgroundColor:["#15803d","#fecaca"]}]},options:{plugins:{legend:{position:"bottom"}}}});}if(wedPaid+wed.total>0){mkChart("dash-chart-wedding",{type:"doughnut",data:{labels:["Funded","Remaining"],datasets:[{data:[wedPaid,wed.total],backgroundColor:["#be185d","#fbcfe8"]}]},options:{plugins:{legend:{position:"bottom"}}}});}var debtMo=monthTotals(debt.payments);var wedMo=monthTotals(wed.payments);var debtMl=Object.keys(debtMo).sort();var wedMl=Object.keys(wedMo).sort();var mergedMl=monthKeys(debtMo,wedMo);renderLinePayRgb("dash-chart-payments-debt",debtMl,debtMl.map(function(k){return debtMo[k];}),[220,38,38]);renderLinePayRgb("dash-chart-payments-wed",wedMl,wedMl.map(function(k){return wedMo[k];}),[190,24,93]);renderLinePayRgb("dash-chart-payments-merged",mergedMl,mergedMl.map(function(k){return(debtMo[k]||0)+(wedMo[k]||0);}),[124,58,237]);var debtAlloc=allocTotals(D.debt);var debtLabels=Object.keys(debtAlloc);if(!debtLabels.length&&debt.items.length){debt.items.forEach(function(it){var lab=it.label||"Item";debtLabels.push(lab);debtAlloc[lab]=0;});}renderBarH("dash-chart-debt-cat",debtLabels.slice(0,8),debtLabels.slice(0,8).map(function(k){return debtAlloc[k]||0;}),"#fca5a5");var wedAlloc=allocTotals(D.marriage);var wedLabels=Object.keys(wedAlloc);if(!wedLabels.length&&wed.items.length){wed.items.forEach(function(it){var lab=it.label||"Item";wedLabels.push(lab);wedAlloc[lab]=0;});}renderBarH("dash-chart-wed-cat",wedLabels.slice(0,8),wedLabels.slice(0,8).map(function(k){return wedAlloc[k]||0;}),"#f9a8d4");var recent=[];(debt.payments||[]).forEach(function(p){recent.push({date:p.date,amt:pn(p.amount),type:"Debt",alloc:p.allocations,note:p.note});});(wed.payments||[]).forEach(function(p){recent.push({date:p.date,amt:pn(p.amount),type:"Wedding",alloc:p.allocations,note:p.note});});recent.sort(function(a,b){return String(b.date).localeCompare(String(a.date));});var tb=document.getElementById("dash-recent-tbody");if(tb){tb.innerHTML="";recent.slice(0,20).forEach(function(r){var tr=document.createElement("tr");var allocTxt="—";if(r.alloc&&r.alloc.length)allocTxt=r.alloc.map(function(a){return (a.label||"?")+" "+fmt(a.amount);}).join(", ");tr.innerHTML="<td>"+escCell(r.date)+"</td><td>"+escCell(r.type)+"</td><td>"+fmt(r.amt)+"</td><td>"+escCell(allocTxt)+"</td><td>"+escCell(r.note)+"</td>";tb.appendChild(tr);});if(!recent.length)tb.innerHTML="<tr><td colspan=\\"5\\">No payments logged yet.</td></tr>";}}' +
    'function loadAll(){var out={};var left=6;function done(){left--;if(left<=0)renderAll(out);}["income","expenses","debt","marriage","saving","tickets"].forEach(function(k){wsGet(KEYS[k],function(e,d){out[k]=d;done();});});}' +
    'function boot(){if(typeof Chart==="undefined"){setTimeout(boot,80);return;}loadAll();}' +
    'boot();' +
    '})();';
  const script =
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"><' +
    '/script><script>' +
    dashClientJs +
    '<' +
    '/script>';
  return (
    '<div class="analytics-toolbar">' +
    '<div><h1>Money dashboard</h1>' +
    '<p class="sub">Charts and totals across income, expenses, debt, and wedding savings.</p></div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/debt-tracker">Debt tracker</a>' +
    '<a class="link-pill" href="/marriage-cost">Marriage cost</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<style>' +
    '.dash-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.dash-kpis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:20px}' +
    '.dash-kpi{border:1px solid #e5e7eb;border-radius:10px;padding:14px;background:#fafafa}' +
    '.dash-kpi-lab{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin:0 0 6px}' +
    '.dash-kpi-val{font-size:1.35rem;font-weight:800;color:#0f172a;margin:0;font-variant-numeric:tabular-nums}' +
    '.dash-kpi-sub{font-size:12px;color:#64748b;margin:6px 0 0}' +
    '.dash-grid{display:grid;gap:18px}@media(min-width:960px){.dash-grid{grid-template-columns:1fr 1fr}}' +
    '.dash-card{border:1px solid #e5e7eb;border-radius:12px;padding:16px;background:#fff}' +
    '.dash-card h2{margin:0 0 12px;font-size:14px;font-weight:800;color:#0f172a}' +
    '.dash-card canvas{max-height:240px}' +
    '.dash-wide{grid-column:1/-1}' +
    '.dash-pay-grid{display:grid;gap:16px;grid-template-columns:1fr;}' +
    '@media(min-width:900px){.dash-pay-grid{grid-template-columns:repeat(3,1fr);}}' +
    '.dash-pay-card{border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;background:#fafafa;}' +
    '.dash-pay-card h3{margin:0 0 10px;font-size:13px;font-weight:800;color:#334155;}' +
    '.dash-pay-card canvas{max-height:200px;}' +
    '.dash-table{width:100%;border-collapse:collapse;font-size:13px}' +
    '.dash-table th{text-align:left;padding:8px 10px;background:#f8fafc;border-bottom:1px solid #e5e7eb}' +
    '.dash-table td{padding:8px 10px;border-bottom:1px solid #f1f5f9}' +
    '</style>' +
    '<div class="dash-panel">' +
    '<div class="dash-kpis">' +
    '<div class="dash-kpi"><p class="dash-kpi-lab">Income</p><p id="dash-kpi-income" class="dash-kpi-val">—</p><p id="dash-kpi-income-sub" class="dash-kpi-sub"></p></div>' +
    '<div class="dash-kpi"><p class="dash-kpi-lab">Expenses</p><p id="dash-kpi-expenses" class="dash-kpi-val">—</p><p id="dash-kpi-expenses-sub" class="dash-kpi-sub"></p></div>' +
    '<div class="dash-kpi"><p class="dash-kpi-lab">Cashflow</p><p id="dash-kpi-cashflow" class="dash-kpi-val">—</p><p id="dash-kpi-cashflow-sub" class="dash-kpi-sub"></p></div>' +
    '<div class="dash-kpi"><p class="dash-kpi-lab">Debt left</p><p id="dash-kpi-debt" class="dash-kpi-val">—</p><p id="dash-kpi-debt-sub" class="dash-kpi-sub"></p></div>' +
    '<div class="dash-kpi"><p class="dash-kpi-lab">Wedding left</p><p id="dash-kpi-wedding" class="dash-kpi-val">—</p><p id="dash-kpi-wedding-sub" class="dash-kpi-sub"></p></div>' +
    '</div>' +
    '<div class="dash-grid">' +
    '<div class="dash-card dash-wide"><h2>Income vs expenses (monthly)</h2><canvas id="dash-chart-cashflow"></canvas></div>' +
    '<div class="dash-card"><h2>Debt progress</h2><canvas id="dash-chart-debt"></canvas></div>' +
    '<div class="dash-card"><h2>Wedding fund progress</h2><canvas id="dash-chart-wedding"></canvas></div>' +
    '<div class="dash-card dash-wide"><h2>Payments over time</h2>' +
    '<div class="dash-pay-grid">' +
    '<div class="dash-pay-card"><h3>Debt</h3><canvas id="dash-chart-payments-debt" aria-label="Debt payments over time"></canvas></div>' +
    '<div class="dash-pay-card"><h3>Wedding</h3><canvas id="dash-chart-payments-wed" aria-label="Wedding payments over time"></canvas></div>' +
    '<div class="dash-pay-card"><h3>Combined</h3><canvas id="dash-chart-payments-merged" aria-label="Combined debt and wedding payments over time"></canvas></div>' +
    '</div></div>' +
    '<div class="dash-card"><h2>Debt — applied by category</h2><canvas id="dash-chart-debt-cat"></canvas></div>' +
    '<div class="dash-card"><h2>Wedding — applied by category</h2><canvas id="dash-chart-wed-cat"></canvas></div>' +
    '<div class="dash-card dash-wide"><h2>Recent payments</h2>' +
    '<table class="dash-table"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Applied to</th><th>Note</th></tr></thead>' +
    '<tbody id="dash-recent-tbody"><tr><td colspan="5">Loading…</td></tr></tbody></table></div>' +
    '</div></div>' +
    script +
    '</div>'
  );
}

function buildDebtTrackerWorkspaceHtml() {
  return buildCostPlannerWorkspaceHtml({
    idPrefix: 'dt',
    storageKey: DEBT_TRACKER_STORAGE_KEY,
    addBtnColor: 'red',
    paidOffStatus: true,
    pageTitle: 'Debt tracker',
    pageSub:
      'School debt, credit cards, tickets, and insurance—set income, assign a % to debt, and see when you could be debt-free.',
    hint:
      'Enter what you still owe in each category (CAD). Use <strong>Add debt row</strong> for anything else—car loan, line of credit, etc. Your plan uses monthly income and the % you put toward debt. Log payments to update balances and fill the progress bar. Everything saves in MongoDB.',
    totalLabel: 'Total debt remaining (CAD)',
    oweSectionTitle: 'What you owe',
    addRowBtn: 'Add debt row',
    tableAria: 'Debt balances',
    incomeSectionTitle: 'Income & payoff plan',
    pctLabel: '% of income to debt',
    pctAria: 'Percent to debt',
    moPaySuffix: 'to debt',
    projDefault: 'Add balances and income to see your debt-free date.',
    projEmptyTitle: 'No debt entered.',
    projEmptySub: 'Add balances above to see your payoff timeline.',
    projNoPay: 'Set income and a debt payment % above zero to estimate when you will be debt-free.',
    goalLabel: 'debt-free',
    pctPaidSuffix: '% paid',
    paidLabel: 'Paid off',
    remainingLabel: 'Remaining',
    progressSub: 'Baseline tracks how much you started with',
    logBtn: 'Log payment',
    logUpdateBtn: 'Update payment',
    logDeleteConfirm: 'Delete this payment?',
    paymentLabel: 'Payment (CAD)',
    lockBaseline: 'Set baseline from current total',
    resetBtn: 'Reset all data',
    resetConfirm: 'Clear all debt tracker data in the database?',
    summaryTitle: 'Debt tracker summary',
    summaryFileName: 'debt-tracker-summary.txt',
    keepOneRowAlert: 'Keep at least one debt row.',
    deleteConfirm: 'Delete this debt category?',
    timelineHint: 'Logged payments and projected payoff dates based on your income plan — green dots are past/today, dashed dots are projected.',
    logAlert: 'Enter a payment amount greater than zero.',
    legacyKeys: ['school', 'creditCard1', 'creditCard2', 'tickets', 'insurance'],
    legacyLabels: {
      school: 'School debt',
      creditCard1: 'Credit card 1',
      creditCard2: 'Credit card 2',
      tickets: 'Tickets',
      insurance: 'Insurance'
    },
    defaults: [
      { label: 'School debt', balance: '0' },
      { label: 'Credit card 1', balance: '0' },
      { label: 'Credit card 2', balance: '0' },
      { label: 'Tickets', balance: '0' },
      { label: 'Insurance', balance: '0' }
    ],
    toolbarPills:
      '<a class="link-pill" href="/">Home</a>' +
      '<a class="link-pill" href="/income">Income</a>' +
      '<a class="link-pill" href="/cashflow">Cashflow</a>' +
      '<a class="link-pill" href="/tickets">Tickets</a>' +
      '<a class="link-pill" href="/marriage-cost">Marriage cost</a>'
  });
}

function buildMarriageCostWorkspaceHtml() {
  return buildCostPlannerWorkspaceHtml({
    idPrefix: 'mc',
    storageKey: MARRIAGE_COST_STORAGE_KEY,
    addBtnColor: 'rose',
    paymentPriority: true,
    targetDate: true,
    paidOffStatus: true,
    paymentCalendar: true,
    pageTitle: 'Marriage cost',
    pageSub:
      'Venue, catering, attire, and more—set income %, target date, and payment order for each cost.',
    hint:
      'Enter what you still need to fund (CAD). Use <strong>↑ ↓</strong> to rank categories—logged contributions pay higher-priority items first. When a category hits zero it is marked <strong>Paid off</strong>. Use the <strong>payment calendar</strong> to see what was paid on each day. Everything saves in MongoDB.',
    totalLabel: 'Total wedding cost remaining (CAD)',
    oweSectionTitle: 'What you owe',
    addRowBtn: 'Add cost row',
    tableAria: 'Marriage cost balances',
    incomeSectionTitle: 'Income & savings plan',
    pctLabel: '% of income to wedding savings',
    pctAria: 'Percent to wedding savings',
    moPaySuffix: 'to wedding fund',
    projDefault: 'Add balances and income to see your fully funded date.',
    projEmptyTitle: 'No costs entered.',
    projEmptySub: 'Add balances above to see your savings timeline.',
    projNoPay:
      'Set income and a wedding savings % above zero to estimate when you will be fully funded.',
    goalLabel: 'fully funded',
    pctPaidSuffix: '% funded',
    paidLabel: 'Funded',
    remainingLabel: 'Remaining',
    progressSub: 'Baseline tracks your starting wedding budget',
    logBtn: 'Log contribution',
    logUpdateBtn: 'Update contribution',
    logDeleteConfirm: 'Delete this contribution?',
    paymentLabel: 'Contribution (CAD)',
    lockBaseline: 'Set baseline from current total',
    resetBtn: 'Reset all data',
    resetConfirm: 'Clear all marriage cost data in the database?',
    summaryTitle: 'Marriage cost summary',
    summaryFileName: 'marriage-cost-summary.txt',
    keepOneRowAlert: 'Keep at least one cost row.',
    deleteConfirm: 'Delete this wedding cost category?',
    timelineHint: 'Contributions logged and projected savings dates toward your wedding — green dots are past/today, dashed dots are projected.',
    logAlert: 'Enter a contribution amount greater than zero.',
    defaults: [
      { label: 'Venue', balance: '0', priority: 1 },
      { label: 'Catering', balance: '0', priority: 2 },
      { label: 'Photography & video', balance: '0', priority: 3 },
      { label: 'Attire & beauty', balance: '0', priority: 4 },
      { label: 'Rings & jewellery', balance: '0', priority: 5 },
      { label: 'Flowers & decor', balance: '0', priority: 6 }
    ],
    toolbarPills:
      '<a class="link-pill" href="/">Home</a>' +
      '<a class="link-pill" href="/income">Income</a>' +
      '<a class="link-pill" href="/cashflow">Cashflow</a>' +
      '<a class="link-pill" href="/debt-tracker">Debt tracker</a>'
  });
}

function buildProjectedDateWorkspaceHtml() {
  const keysJson = JSON.stringify({
    debt: DEBT_TRACKER_STORAGE_KEY,
    marriage: MARRIAGE_COST_STORAGE_KEY,
    income: INCOME_STORAGE_KEY,
    projected: PROJECTED_DATE_STORAGE_KEY
  });
  const clientJs =
    '(function(){' +
    WORKSPACE_STORE_API_JS +
    'var KEYS=' +
    keysJson +
    ';' +
    'var D={debt:null,marriage:null,income:null,projected:null};' +
    'function fmt(n){return new Intl.NumberFormat("en-CA",{style:"currency",currency:"CAD"}).format(n||0);}' +
    'function pn(v){var x=parseFloat(String(v).replace(/,/g,""));return isFinite(x)?x:0;}' +
    'function esc(s){return String(s==null?"":s).split("<").join("&lt;").split(">").join("&gt;").split("\\"").join("&quot;");}' +
    'function toMo(a,f){var v=pn(a);if(f==="biweekly")return v*26/12;if(f==="weekly")return v*52/12;if(f==="annual")return v/12;return v;}' +
    'function sumIncome(d){if(!d||!d.sources)return 0;var s=0;d.sources.forEach(function(src){(src.lines||[]).forEach(function(L){s+=toMo(L.amount,L.frequency||"monthly");});});return s;}' +
    'function plannerIncome(pl,incomePage){if(!pl)return 0;if(pl.useIncomePage&&incomePage)return sumIncome(incomePage);return pn(pl.incomeMonthly);}' +
    'function sumRemaining(items){if(!Array.isArray(items))return 0;var s=0;items.forEach(function(it){s+=pn(it&&it.balance);});return Math.round(s*100)/100;}' +
    'function addMonths(d,n){var x=new Date(d);x.setMonth(x.getMonth()+n);return x;}' +
    'function fmtDate(d){return d.toLocaleDateString("en-CA",{month:"short",day:"numeric",year:"numeric"});}' +
    'function monthsBetween(from,to){return Math.max(0,(to.getFullYear()-from.getFullYear())*12+(to.getMonth()-from.getMonth()));}' +
    'function projMonths(total,moPay){if(total<=0.009||moPay<=0.009)return 0;return Math.ceil(total/moPay);}' +
    'function projDate(total,moPay){var m=projMonths(total,moPay);return m>0?addMonths(new Date(),m):null;}' +
    'function formatAlloc(allocs){if(!allocs||!allocs.length)return "";return allocs.map(function(a){return (a.label||"Item")+" "+fmt(a.amount);}).join(", ");}' +
    'function pushEvent(map,ds,ev){if(!ds)return;if(!map[ds])map[ds]=[];map[ds].push(ev);}' +
    'function projectedList(){var p=D.projected;return Array.isArray(p&&p.projectedDates)?p.projectedDates.slice():[];}' +
    'function saveProjectedList(list,cb){var payload={projectedDates:list};wsPut(KEYS.projected,payload,function(err){if(!err)D.projected=payload;if(cb)cb(err);});}' +
    'function newProjId(){return "pd-"+Date.now()+"-"+Math.random().toString(36).slice(2,8);}' +
    'function buildTimeline(){var debt=D.debt||{};var wed=D.marriage||{};var today=new Date();today.setHours(12,0,0,0);var todayStr=today.toISOString().slice(0,10);var map={};(debt.payments||[]).forEach(function(py){if(!py.date)return;pushEvent(map,py.date,{kind:"logged",track:"debt",amount:pn(py.amount),alloc:formatAlloc(py.allocations),note:py.note||""});});(wed.payments||[]).forEach(function(py){if(!py.date)return;pushEvent(map,py.date,{kind:"logged",track:"wedding",amount:pn(py.amount),alloc:formatAlloc(py.allocations),note:py.note||""});});var debtTarget=String(debt.targetDate||"").trim();var wedTarget=String(wed.targetDate||"").trim();if(debtTarget)pushEvent(map,debtTarget,{kind:"target",track:"debt",amount:0,note:"Debt-free target"});if(wedTarget)pushEvent(map,wedTarget,{kind:"target",track:"wedding",amount:0,note:"Wedding funded target"});projectedList().forEach(function(row){if(!row||!row.date)return;var track=row.track||"milestone";if(track!=="debt"&&track!=="wedding")track="milestone";var lbl=String(row.label||row.note||"").trim()||"Important date";pushEvent(map,row.date,{kind:"planned",track:track,amount:pn(row.amount),note:lbl,id:row.id||""});});var dates=Object.keys(map).sort();if(dates.indexOf(todayStr)<0){var ins=dates.length;for(var i=0;i<dates.length;i++){if(dates[i]>todayStr){ins=i;break;}}dates.splice(ins,0,todayStr);map[todayStr]=map[todayStr]||[];}return{dates:dates,map:map,todayStr:todayStr};}' +
    'function setText(id,val){var el=document.getElementById(id);if(el)el.textContent=val;}' +
    'function renderOverview(){var debt=D.debt||{};var wed=D.marriage||{};var incPage=D.income;var debtInc=plannerIncome(debt,incPage);var wedInc=plannerIncome(wed,incPage);var debtRem=sumRemaining(debt.debtItems);var wedRem=sumRemaining(wed.debtItems);var debtPct=pn(debt.debtPct);var wedPct=pn(wed.debtPct);var debtMo=debtInc*(debtPct/100);var wedMo=wedInc*(wedPct/100);var debtProj=projDate(debtRem,debtMo);var wedProj=projDate(wedRem,wedMo);setText("pd-kpi-debt-rem",fmt(debtRem));setText("pd-kpi-debt-mo",debtMo>0?fmt(debtMo)+"/mo ("+Math.round(debtPct)+"% income)":"Set income & % on Debt tracker");setText("pd-kpi-debt-proj",debtProj?("Est. debt-free: "+fmtDate(debtProj)):debtRem<=0.009?"Debt-free":"—");setText("pd-kpi-wed-rem",fmt(wedRem));setText("pd-kpi-wed-mo",wedMo>0?fmt(wedMo)+"/mo ("+Math.round(wedPct)+"% income)":"Set income & % on Marriage cost");setText("pd-kpi-wed-proj",wedProj?("Est. funded: "+fmtDate(wedProj)):wedRem<=0.009?"Fully funded":"—");var debtTarget=String(debt.targetDate||"").trim();var wedTarget=String(wed.targetDate||"").trim();var debtTargetInp=document.getElementById("pd-debt-target");var wedTargetInp=document.getElementById("pd-wed-target");if(debtTargetInp&&document.activeElement!==debtTargetInp)debtTargetInp.value=debtTarget;if(wedTargetInp&&document.activeElement!==wedTargetInp)wedTargetInp.value=wedTarget;var debtStatus=document.getElementById("pd-debt-target-status");var wedStatus=document.getElementById("pd-wed-target-status");if(debtStatus){if(!debtTarget)debtStatus.textContent="No target set.";else if(debtProj&&debtTarget){var dt=new Date(debtTarget+"T12:00:00");var diff=Math.round((dt-debtProj)/86400000);debtStatus.textContent=diff>=0?"On track — target is "+Math.abs(diff)+" day"+(Math.abs(diff)===1?"":"s")+" after estimated payoff.":"Behind — need ~"+fmt(Math.max(0,(debtRem/monthsBetween(new Date(),dt)||1)-debtMo))+" more per month.";}else debtStatus.textContent="Target: "+debtTarget;}if(wedStatus){if(!wedTarget)wedStatus.textContent="No target set.";else if(wedProj&&wedTarget){var dt2=new Date(wedTarget+"T12:00:00");var diff2=Math.round((dt2-wedProj)/86400000);wedStatus.textContent=diff2>=0?"On track — target is "+Math.abs(diff2)+" day"+(Math.abs(diff2)===1?"":"s")+" after estimated funding.":"Behind — need ~"+fmt(Math.max(0,(wedRem/monthsBetween(new Date(),dt2)||1)-wedMo))+" more per month.";}else wedStatus.textContent="Target: "+wedTarget;}}' +
    'function trackLabel(t){if(t==="debt")return "Debt";if(t==="wedding")return "Wedding";return "Milestone";}' +
    'function renderProjectedTable(){var tb=document.getElementById("pd-proj-tbody");if(!tb)return;var list=projectedList().slice().sort(function(a,b){return String(a.date).localeCompare(String(b.date));});tb.innerHTML="";if(!list.length){tb.innerHTML="<tr><td colspan=\\"5\\">No dates yet — use the form above.</td></tr>";return;}list.forEach(function(row){var tr=document.createElement("tr");tr.setAttribute("data-proj-id",row.id||"");var amt=pn(row.amount)>0?fmt(row.amount):"—";var lbl=String(row.label||row.note||"");tr.innerHTML="<td>"+esc(row.date)+"</td><td>"+esc(trackLabel(row.track))+"</td><td>"+esc(lbl)+"</td><td>"+esc(amt)+"</td><td><button type=\\"button\\" class=\\"pd-proj-del\\" data-proj-id=\\""+esc(row.id||"")+"\\">Delete</button></td>";tb.appendChild(tr);});}' +
    'function renderTimeline(){var host=document.getElementById("pd-timeline");if(!host)return;var tl=buildTimeline();var dates=tl.dates;var map=tl.map;var todayStr=tl.todayStr;var hasPlanned=projectedList().length>0;var hasLogged=(D.debt&&D.debt.payments&&D.debt.payments.length)||(D.marriage&&D.marriage.payments&&D.marriage.payments.length);if(!dates.length||(!hasPlanned&&!hasLogged&&dates.length<=1)){host.innerHTML="<p class=\\"pd-timeline-empty\\">Add important dates on the left — the timeline updates here. Logged payments from Debt tracker and Marriage cost also appear.</p>";return;}var html="";dates.forEach(function(ds,idx){var events=map[ds]||[];var d=new Date(ds+"T12:00:00");var dateLbl=d.toLocaleDateString("en-CA",{month:"short",day:"numeric",year:"numeric"});var dayLbl=d.toLocaleDateString("en-CA",{weekday:"long"});var isToday=ds===todayStr;var hasLoggedEv=events.some(function(e){return e.kind==="logged";});var hasPlannedEv=events.some(function(e){return e.kind==="planned";});var hasTarget=events.some(function(e){return e.kind==="target";});var dotCls="pd-timeline-dot";if(hasTarget)dotCls+=" pd-timeline-dot-target";else if(hasPlannedEv&&!hasLoggedEv)dotCls+=" pd-timeline-dot-planned";else if(isToday)dotCls+=" pd-timeline-dot-today";else if(ds<todayStr)dotCls+=" pd-timeline-dot-done";else dotCls+=" pd-timeline-dot-future";var itemCls="pd-timeline-item";if(isToday)itemCls+=" pd-timeline-item-today";if(hasPlannedEv)itemCls+=" pd-timeline-item-planned";html+="<div class=\\""+itemCls+"\\" data-date=\\""+esc(ds)+"\\">";html+="<div class=\\"pd-timeline-left\\"><span class=\\"pd-timeline-date-lbl\\">"+esc(dateLbl)+"</span><span class=\\"pd-timeline-day-lbl\\">"+esc(dayLbl)+"</span></div>";html+="<div class=\\"pd-timeline-rail\\"><span class=\\""+dotCls+"\\"></span>";if(idx<dates.length-1)html+="<span class=\\"pd-timeline-line\\"></span>";html+="</div><div class=\\"pd-timeline-body\\">";if(isToday)html+="<p class=\\"pd-timeline-you\\">You are here</p>";if(isToday&&!events.length)html+="<p class=\\"pd-timeline-meta\\">Today</p>";events.forEach(function(ev){var trackCls=ev.track==="debt"?"pd-event-debt":ev.track==="wedding"?"pd-event-wed":"pd-event-milestone";var tLbl=trackLabel(ev.track);html+="<div class=\\"pd-timeline-event "+trackCls+"\\">";if(ev.kind==="target")html+="<strong>Target — "+esc(tLbl)+"</strong> <span>"+esc(ev.note)+"</span>";else if(ev.kind==="planned"){html+="<strong>"+esc(ev.note)+"</strong>";if(pn(ev.amount)>0)html+=" <span>"+fmt(ev.amount)+"</span>";html+="<span class=\\"pd-timeline-meta\\">"+esc(tLbl)+" · date you added</span>";}else html+="<strong>"+fmt(ev.amount)+"</strong> <span class=\\"pd-track-tag\\">"+tLbl+" logged</span>"+(ev.alloc?" <span>"+esc(ev.alloc)+"</span>":"")+(ev.note?" <span class=\\"pd-timeline-note\\">— "+esc(ev.note)+"</span>":"")+"<span class=\\"pd-timeline-meta\\">Logged payment</span>";html+="</div>";});html+="</div></div>";});host.innerHTML=html;}' +
    'function renderAll(){renderOverview();renderProjectedTable();renderTimeline();}' +
    'function toast(msg){var el=document.getElementById("pd-save-toast");if(!el)return;el.textContent=msg||"";if(msg){setTimeout(function(){if(el.textContent===msg)el.textContent="";},2400);}}' +
    'var _saveTimer=null;function saveTarget(track,dateVal){clearTimeout(_saveTimer);_saveTimer=setTimeout(function(){var key=track==="debt"?KEYS.debt:KEYS.marriage;var payload=track==="debt"?Object.assign({},D.debt||{}):Object.assign({},D.marriage||{});payload.targetDate=dateVal||"";wsPut(key,payload,function(err){if(!err){if(track==="debt")D.debt=payload;else D.marriage=payload;toast("Saved "+(track==="debt"?"debt-free":"wedding")+" target date.");renderOverview();renderTimeline();}});},400);}' +
    'function addProjectedDate(){var trackSel=document.getElementById("pd-proj-track");var dateInp=document.getElementById("pd-proj-date");var amtInp=document.getElementById("pd-proj-amt");var labelInp=document.getElementById("pd-proj-label");if(!trackSel||!dateInp||!labelInp)return;var ds=String(dateInp.value||"").trim();if(!ds){alert("Choose a date.");return;}var label=String(labelInp.value||"").trim();if(!label){alert("Describe why this date is important.");labelInp.focus();return;}var track=trackSel.value==="wedding"?"wedding":trackSel.value==="milestone"?"milestone":"debt";var list=projectedList();if(list.some(function(r){return r.date===ds&&r.track===track&&String(r.label||r.note||"")===label;})){alert("That date is already listed.");return;}list.push({id:newProjId(),date:ds,track:track,amount:amtInp?String(amtInp.value||""):"",label:label,note:label});list.sort(function(a,b){return String(a.date).localeCompare(String(b.date));});saveProjectedList(list,function(err){if(err){alert("Could not save.");return;}if(amtInp)amtInp.value="";labelInp.value="";toast("Date added — timeline updated.");renderAll();});}' +
    'function deleteProjectedDate(id){if(!id)return;if(!confirm("Delete this projected date?"))return;var list=projectedList().filter(function(r){return r.id!==id;});saveProjectedList(list,function(err){if(err){alert("Could not delete.");return;}toast("Projected date removed.");renderAll();});}' +
    'function loadAll(){var left=4;function done(){left--;if(left<=0)renderAll();}wsGet(KEYS.debt,function(e,d){D.debt=d;done();});wsGet(KEYS.marriage,function(e,d){D.marriage=d;done();});wsGet(KEYS.income,function(e,d){D.income=d;done();});wsGet(KEYS.projected,function(e,d){D.projected=d&&Array.isArray(d.projectedDates)?d:{projectedDates:[]};done();});}' +
    'var debtInp=document.getElementById("pd-debt-target");if(debtInp)debtInp.addEventListener("change",function(){saveTarget("debt",debtInp.value);});' +
    'var wedInp=document.getElementById("pd-wed-target");if(wedInp)wedInp.addEventListener("change",function(){saveTarget("wedding",wedInp.value);});' +
    'var addBtn=document.getElementById("pd-proj-add");if(addBtn)addBtn.addEventListener("click",addProjectedDate);' +
    'var projTb=document.getElementById("pd-proj-tbody");if(projTb)projTb.addEventListener("click",function(ev){var btn=ev.target.closest&&ev.target.closest(".pd-proj-del");if(!btn)return;deleteProjectedDate(btn.getAttribute("data-proj-id"));});' +
    'var dateInpInit=document.getElementById("pd-proj-date");if(dateInpInit&&!dateInpInit.value)dateInpInit.value=new Date().toISOString().slice(0,10);' +
    'loadAll();' +
    '})();';
  const script = '<script>' + clientJs + '<' + '/script>';
  return (
    '<div class="analytics-toolbar">' +
    '<div><h1>Projected date</h1>' +
    '<p class="sub">Add important dates on the left — overview and timeline update on the right. No auto-filled monthly dates.</p></div>' +
    '<div class="analytics-toolbar-actions">' +
    '<a class="link-pill" href="/">Home</a>' +
    '<a class="link-pill" href="/dashboard">Dashboard</a>' +
    '<a class="link-pill" href="/debt-tracker">Debt tracker</a>' +
    '<a class="link-pill" href="/marriage-cost">Marriage cost</a>' +
    '</div></div>' +
    '<div class="analytics-body">' +
    '<style>' +
    '.pd-split{display:grid;gap:20px;align-items:start}' +
    '@media(min-width:1024px){.pd-split{grid-template-columns:minmax(300px,380px) 1fr}}' +
    '.pd-left{display:flex;flex-direction:column;gap:16px}' +
    '.pd-right{display:flex;flex-direction:column;gap:16px;min-width:0}' +
    '@media(min-width:1024px){.pd-right{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow-y:auto}}' +
    '.pd-panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,0.06)}' +
    '.pd-panel h2{margin:0 0 10px;font-size:15px;font-weight:800;color:#0f172a}' +
    '.pd-panel-lead{margin:0 0 14px;font-size:12px;color:#64748b;line-height:1.45}' +
    '.pd-field{margin:0 0 12px;display:flex;flex-direction:column;gap:6px}' +
    '.pd-field span{font-size:12px;font-weight:700;color:#475569}' +
    '.pd-field input[type=date],.pd-field input[type=number],.pd-field input[type=text],.pd-field select{font:inherit;padding:9px 10px;border:1px solid #cbd5e1;border-radius:8px;width:100%;box-sizing:border-box}' +
    '.pd-status{margin:6px 0 0;font-size:12px;color:#64748b;line-height:1.45}' +
    '.pd-target-grid{display:grid;gap:12px}' +
    '.pd-add-btn{font:inherit;padding:10px 16px;border:none;border-radius:8px;background:#0f172a;color:#fff;font-weight:700;cursor:pointer;width:100%}' +
    '.pd-add-btn:hover{background:#1e293b}' +
    '.pd-proj-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}' +
    '.pd-proj-table th{text-align:left;padding:7px 8px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-size:11px}' +
    '.pd-proj-table td{padding:7px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top;word-break:break-word}' +
    '.pd-proj-del{border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:600;cursor:pointer;font:inherit}' +
    '.pd-proj-del:hover{background:#fef2f2}' +
    '.pd-kpis{display:grid;gap:10px;grid-template-columns:1fr 1fr}' +
    '.pd-kpi{border:1px solid #e5e7eb;border-radius:10px;padding:12px;background:#fafafa}' +
    '.pd-kpi-lab{margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748b}' +
    '.pd-kpi-val{margin:0;font-size:1.1rem;font-weight:800;color:#0f172a;font-variant-numeric:tabular-nums}' +
    '.pd-kpi-sub{margin:5px 0 0;font-size:11px;color:#64748b;line-height:1.35}' +
    '.pd-timeline{margin-top:4px}' +
    '.pd-timeline-item{display:grid;grid-template-columns:5.5rem 1.35rem 1fr;gap:8px 12px;padding:0 0 22px;align-items:start}' +
    '.pd-timeline-left{text-align:right;padding-top:2px}' +
    '.pd-timeline-date-lbl{display:block;font-weight:800;font-size:12px;color:#0f172a;font-variant-numeric:tabular-nums}' +
    '.pd-timeline-day-lbl{display:block;font-size:10px;color:#64748b;margin-top:2px}' +
    '.pd-timeline-rail{display:flex;flex-direction:column;align-items:center;min-height:100%}' +
    '.pd-timeline-dot{width:12px;height:12px;border-radius:999px;background:#fff;border:2px solid #94a3b8;flex-shrink:0;z-index:1;box-sizing:border-box}' +
    '.pd-timeline-dot-done{background:#0d9488;border-color:#0d9488}' +
    '.pd-timeline-dot-today{background:#0d9488;border-color:#0d9488;box-shadow:0 0 0 3px rgba(13,148,136,0.25)}' +
    '.pd-timeline-dot-future{background:#fff;border-color:#cbd5e1}' +
    '.pd-timeline-dot-planned{background:#fff;border:2px dashed #6366f1}' +
    '.pd-timeline-dot-target{background:#f59e0b;border-color:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,0.25)}' +
    '.pd-timeline-line{flex:1;width:2px;background:#e2e8f0;margin-top:4px;min-height:24px}' +
    '.pd-timeline-body{min-width:0}' +
    '.pd-timeline-you{margin:0 0 6px;font-size:12px;font-weight:700;color:#0d9488}' +
    '.pd-timeline-event{margin:0 0 8px;font-size:13px;color:#0f172a;line-height:1.45}' +
    '.pd-timeline-event strong{font-variant-numeric:tabular-nums}' +
    '.pd-timeline-meta{display:block;font-size:10px;color:#64748b;margin-top:3px}' +
    '.pd-timeline-note{color:#64748b}' +
    '.pd-timeline-item-today .pd-timeline-body{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:10px 12px}' +
    '.pd-timeline-item-planned .pd-timeline-event{color:#3730a3}' +
    '.pd-event-debt .pd-track-tag{color:#b91c1c;font-weight:700;font-size:11px}' +
    '.pd-event-wed .pd-track-tag{color:#be185d;font-weight:700;font-size:11px}' +
    '.pd-event-milestone{color:#4338ca}' +
    '.pd-timeline-empty{margin:0;font-size:13px;color:#64748b;line-height:1.45}' +
    '#pd-save-toast{margin:0;font-size:12px;color:#15803d;font-weight:600;min-height:18px}' +
    '</style>' +
    '<div class="pd-split">' +
    '<div class="pd-left">' +
    '<div class="pd-panel">' +
    '<h2>Add important date</h2>' +
    '<p class="pd-panel-lead">Pick a date, say why it matters, and click Add. Build your full schedule here — nothing is auto-generated.</p>' +
    '<label class="pd-field"><span>Date</span><input type="date" id="pd-proj-date" aria-label="Date"/></label>' +
    '<label class="pd-field"><span>Type</span><select id="pd-proj-track" aria-label="Date type"><option value="debt">Debt</option><option value="wedding">Wedding</option><option value="milestone">Other milestone</option></select></label>' +
    '<label class="pd-field"><span>Why is this date important?</span><input type="text" id="pd-proj-label" autocomplete="off" placeholder="e.g. Pay off credit card, venue deposit due"/></label>' +
    '<label class="pd-field"><span>Amount (optional, CAD)</span><input type="number" id="pd-proj-amt" min="0" step="0.01" inputmode="decimal" placeholder="0"/></label>' +
    '<button type="button" id="pd-proj-add" class="pd-add-btn">Add date</button>' +
    '<p id="pd-save-toast" aria-live="polite"></p>' +
    '</div>' +
    '<div class="pd-panel">' +
    '<h2>Your dates</h2>' +
    '<table class="pd-proj-table" aria-label="Important dates"><thead><tr><th>Date</th><th>Type</th><th>Label</th><th>Amt</th><th></th></tr></thead>' +
    '<tbody id="pd-proj-tbody"><tr><td colspan="5">Loading…</td></tr></tbody></table>' +
    '</div>' +
    '<div class="pd-panel">' +
    '<h2>Target dates</h2>' +
    '<div class="pd-target-grid">' +
    '<label class="pd-field"><span>Debt-free target</span><input type="date" id="pd-debt-target" aria-label="Debt-free target date"/></label>' +
    '<p id="pd-debt-target-status" class="pd-status">Loading…</p>' +
    '<label class="pd-field"><span>Wedding funded target</span><input type="date" id="pd-wed-target" aria-label="Wedding funded target date"/></label>' +
    '<p id="pd-wed-target-status" class="pd-status">Loading…</p>' +
    '</div></div>' +
    '</div>' +
    '<div class="pd-right">' +
    '<div class="pd-panel">' +
    '<h2>Overview</h2>' +
    '<p class="pd-panel-lead">From your Debt tracker and Marriage cost balances (reference only — not added to timeline unless you add the date).</p>' +
    '<div class="pd-kpis">' +
    '<div class="pd-kpi"><p class="pd-kpi-lab">Debt left</p><p id="pd-kpi-debt-rem" class="pd-kpi-val">—</p><p id="pd-kpi-debt-mo" class="pd-kpi-sub">—</p><p id="pd-kpi-debt-proj" class="pd-kpi-sub">—</p></div>' +
    '<div class="pd-kpi"><p class="pd-kpi-lab">Wedding left</p><p id="pd-kpi-wed-rem" class="pd-kpi-val">—</p><p id="pd-kpi-wed-mo" class="pd-kpi-sub">—</p><p id="pd-kpi-wed-proj" class="pd-kpi-sub">—</p></div>' +
    '</div></div>' +
    '<div class="pd-panel">' +
    '<h2>Timeline</h2>' +
    '<p class="pd-panel-lead">Green = logged · Purple dashed = dates you added · Gold = targets · Today highlighted.</p>' +
    '<div id="pd-timeline" class="pd-timeline" aria-live="polite"></div>' +
    '</div></div></div>' +
    script +
    '</div>'
  );
}

// --- HTTP routes: Third brain ---

app.get('/api/board-store/:boardKey', async (req, res) => {
  const boardKey = decodeURIComponent(String(req.params.boardKey || '').trim());
  if (!BOARD_WORKSPACE_STORE_KEYS.has(boardKey)) {
    return res.status(400).json({ error: 'invalid board key' });
  }
  if (!isMongoConnected()) {
    return res.status(503).json({ error: 'database unavailable' });
  }
  try {
    const payload = await getBoardWorkspacePayload(boardKey);    return res.json({ boardKey, payload });
  } catch (err) {
    console.error('board-store GET failed:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'could not load board data' });
  }
});

app.put('/api/board-store/:boardKey', async (req, res) => {
  const boardKey = decodeURIComponent(String(req.params.boardKey || '').trim());
  if (!BOARD_WORKSPACE_STORE_KEYS.has(boardKey)) {
    return res.status(400).json({ error: 'invalid board key' });
  }
  if (!isMongoConnected()) {
    return res.status(503).json({ error: 'database unavailable' });
  }
  if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'payload')) {
    return res.status(400).json({ error: 'payload required' });
  }
  const payload = req.body.payload;  try {
    await setBoardWorkspacePayload(boardKey, payload);
    return res.json({ ok: true, boardKey });
  } catch (err) {
    console.error('board-store PUT failed:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'could not save board data' });
  }
});

app.get('/', (req, res) => {
  res.type('html').send(
    renderSecondBrainPage(
      'Third brain',
      `<header class="sb-banner" role="banner">
    <div class="tag">Money workspace</div>
    <h1>Third brain</h1>
    <p>Track expenses, income, cashflow, savings, debt payoff, and wedding costs—saved in MongoDB with separate collections from Second brain.</p>
  </header>
  <section class="sb-time-section" aria-labelledby="sb-money-heading">
    <h2 id="sb-money-heading" class="sb-time-heading">Money</h2>
    <p class="sb-time-lead">Plan and log what you earn, spend, owe, and save toward.</p>
    <nav class="sb-grid" aria-label="Money tools">
    <a class="sb-card" href="/dashboard">
      <h2>Dashboard</h2>
      <span>Charts for income, expenses, debt progress, wedding savings, and recent payments.</span>
    </a>
    <a class="sb-card" href="/monthly-expenses">
      <h2>Monthly expenses</h2>
      <span>Edit line items in CAD and see your monthly total update at the top.</span>
    </a>
    <a class="sb-card" href="/income">
      <h2>Income</h2>
      <span>Sources and pay frequency—feeds cashflow, debt, and marriage planners.</span>
    </a>
    <a class="sb-card" href="/cashflow">
      <h2>Cashflow</h2>
      <span>Income minus expenses with room for notes.</span>
    </a>
    <a class="sb-card" href="/saving">
      <h2>Saving</h2>
      <span>Goals and amounts you set aside.</span>
    </a>
    <a class="sb-card" href="/tickets">
      <h2>Tickets</h2>
      <span>Track ticket spend and conclusions.</span>
    </a>
    <a class="sb-card" href="/debt-tracker">
      <h2>Debt tracker</h2>
      <span>School debt, cards, tickets, insurance—income % payoff plan and progress log.</span>
    </a>
    <a class="sb-card" href="/marriage-cost">
      <h2>Marriage cost</h2>
      <span>Wedding budget by category—income % savings plan, funded date, and contribution log.</span>
    </a>
    <a class="sb-card" href="/projected-date">
      <h2>Projected date</h2>
      <span>Set debt-free and wedding target dates and see a combined payment timeline.</span>
    </a>
    </nav>
  </section>`
    )
  );
});
app.get('/dashboard', (req, res) => {
  const canvas = buildMoneyDashboardHtml();
  res.type('html').send(renderSecondBrainWorkspace('Dashboard — Third brain', '/dashboard', canvas));
});

app.get('/monthly-expenses', (req, res) => {
  const canvas = buildMonthlyExpensesWorkspaceHtml();
  res.type('html').send(renderSecondBrainWorkspace('Monthly expenses — Third brain', '/monthly-expenses', canvas));
});

app.get('/income', (req, res) => {
  const canvas = buildIncomeWorkspaceHtml();
  res.type('html').send(renderSecondBrainWorkspace('Income — Third brain', '/income', canvas));
});

app.get('/cashflow', (req, res) => {
  const canvas = buildCashflowWorkspaceHtml();
  res.type('html').send(renderSecondBrainWorkspace('Cashflow — Third brain', '/cashflow', canvas));
});

app.get('/saving', (req, res) => {
  const canvas = buildSavingWorkspaceHtml();
  res.type('html').send(renderSecondBrainWorkspace('Saving — Third brain', '/saving', canvas));
});

app.get('/wealth', (req, res) => {
  res.redirect(302, '/tickets');
});

app.get('/tickets', (req, res) => {
  const canvas = buildTicketsWorkspaceHtml();
  res.type('html').send(renderSecondBrainWorkspace('Tickets — Third brain', '/tickets', canvas));
});

app.get('/debt-tracker', (req, res) => {
  const canvas = buildDebtTrackerWorkspaceHtml();
  res.type('html').send(renderSecondBrainWorkspace('Debt tracker — Third brain', '/debt-tracker', canvas));
});

app.get('/marriage-cost', (req, res) => {
  const canvas = buildMarriageCostWorkspaceHtml();
  res.type('html').send(renderSecondBrainWorkspace('Marriage cost — Third brain', '/marriage-cost', canvas));
});

app.get('/projected-date', (req, res) => {
  const canvas = buildProjectedDateWorkspaceHtml();
  res.type('html').send(renderSecondBrainWorkspace('Projected date — Third brain', '/projected-date', canvas));
});

app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

startMongo();

const host = process.env.HOST || '0.0.0.0';
const server = app.listen(port, host, () => {
  console.log(`http://localhost:${port}`);
  console.log(`Listening on ${host}:${port}`);
  if (typeof scheduleDailyUserSummaryPush === 'function') {
    scheduleDailyUserSummaryPush();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Set a different PORT in .env or stop the other process.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
