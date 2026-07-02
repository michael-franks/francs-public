#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Francs — Akahu open-banking server
// Fetches transactions from Akahu (read-only) and serves them to the budget UI.
//
// Paths (override via env):
//   Data:  ./data            (DATA_DIR) — JSON state, transactions, balances
//   Env:   .env / process env — AKAHU_APP_TOKEN, AKAHU_USER_TOKEN, etc.
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const fs = require('fs');
const path = require('path');
let nodemailer = null; try { nodemailer = require('nodemailer'); } catch (e) { console.warn('nodemailer not installed — credit-card reminder emails disabled'); }

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';   // localhost-only by default; set HOST=0.0.0.0 to expose (behind auth — see the startup warning)

// ─── Akahu config ──────────────────────────────────────────────
const AKAHU_BASE = 'https://api.akahu.io/v1';
const APP_TOKEN = process.env.AKAHU_APP_TOKEN;
const USER_TOKEN = process.env.AKAHU_USER_TOKEN;

if (!APP_TOKEN || !USER_TOKEN) {
  console.error('ERROR: AKAHU_APP_TOKEN and AKAHU_USER_TOKEN must be set (see .env.example)');
  process.exit(1);
}

const HEADERS = {
  'Authorization': `Bearer ${USER_TOKEN}`,
  'X-Akahu-Id': APP_TOKEN,
  'Accept': 'application/json'
};

// ─── Data storage ──────────────────────────────────────────────
// All JSON data files live here. Create it up front so the very first write
// (state save / fetch) can't ENOENT on a fresh clone or an empty Docker volume.
const DATA_DIR = process.env.DATA_DIR || './data';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('Could not create DATA_DIR:', e.message); }
const TX_FILE = path.join(DATA_DIR, 'transactions.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const META_FILE = path.join(DATA_DIR, 'fetch-meta.json');
const BALANCE_HISTORY_FILE = path.join(DATA_DIR, 'balance-history.json');
const BALANCE_LOG_FILE = path.join(DATA_DIR, 'balance-log.json');

// Optional: manually-tracked self-custody crypto (no API), valued live via CoinGecko.
// Ships empty. To track holdings WITHOUT editing source (keeps your balances out of
// git), create data/crypto-holdings.json as an array of { id, sym, amount } where id
// is the CoinGecko id, e.g. [ { "id": "bitcoin", "sym": "BTC", "amount": 0.05 } ].
// The inline array is only a fallback when that file is absent.
const CRYPTO_HOLDINGS = loadJSON(path.join(DATA_DIR, 'crypto-holdings.json'), [
  // { id: 'bitcoin', sym: 'BTC', amount: 0.05 },
  // { id: 'ethereum', sym: 'ETH', amount: 1.2 },
]);
async function fetchCryptoData() {
  // Opt-in: with no holdings configured, do nothing (and skip the pointless CoinGecko call).
  if (!Array.isArray(CRYPTO_HOLDINGS) || !CRYPTO_HOLDINGS.length) return { holdings: [], total: 0 };
  const ids = CRYPTO_HOLDINGS.map(c => c.id).join(',');
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=nzd', { signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('coingecko ' + r.status);
  const prices = await r.json();
  const holdings = CRYPTO_HOLDINGS.map(c => {
    const p = (prices[c.id] && prices[c.id].nzd) || 0;
    return { sym: c.sym, amount: c.amount, priceNzd: p, valueNzd: c.amount * p };
  });
  return { holdings, total: holdings.reduce((s, h) => s + h.valueNzd, 0) };
}

// Append a daily snapshot of every account balance (keyed by date, latest of the
// day wins) so value-over-time can be charted. `extra` adds non-Akahu values
// (e.g. crypto total). Non-fatal.
function logBalances(accounts, extra) {
  try {
    const log = loadJSON(BALANCE_LOG_FILE, {});
    const today = new Date().toISOString().slice(0, 10);
    const snap = {};
    (accounts || []).forEach(a => { if (a.id != null && typeof a.balance === 'number') snap[a.id] = a.balance; });
    if (extra) Object.assign(snap, extra);
    log[today] = snap;
    const dates = Object.keys(log).sort();
    while (dates.length > 1500) delete log[dates.shift()];
    saveJSON(BALANCE_LOG_FILE, log);
  } catch (e) { console.error('balance log failed (non-fatal):', e.message); }
}

function loadJSON(filepath, fallback) {
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) { console.error(`Failed to read ${filepath}:`, e.message); }
  return fallback;
}

// Strict read: if the file exists but is corrupt, THROW rather than silently
// returning empty (which a caller could then overwrite, destroying recoverable data).
function loadJSONStrict(filepath) {
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

// Atomic write that FAILS LOUD (throws) so an API handler returns 500 rather than
// reporting success after losing data. Writes to a temp file, fsyncs, then renames.
function saveJSON(filepath, data) {
  const tmp = filepath + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); }
  catch (e) { try { fs.closeSync(fd); } catch (_) {} try { fs.unlinkSync(tmp); } catch (_) {} throw e; }   // don't leave a partial .tmp behind
  fs.closeSync(fd);
  fs.renameSync(tmp, filepath);
}

// Load → mutate → save fetch-meta.json in ONE synchronous tick, so overlapping async writers
// (fetch / balance-refresh / card-reminder) that each hold META across multi-second awaits can't
// clobber one another's fields. Each caller mutates only the keys it owns.
function withMeta(mutate) {
  const m = loadJSON(META_FILE, {});
  mutate(m);
  saveJSON(META_FILE, m);
  return m;
}

// ─── Akahu API helpers ─────────────────────────────────────────

async function akahu(endpoint, params = {}) {
  const url = new URL(`${AKAHU_BASE}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });

  // api.akahu.io (CloudFront) resolves to IPs across several subnets, and one of
  // them (13.226.59.0/24) is currently unroutable from this network — a connect to
  // it hangs (~10s) then fails. Each fetch re-resolves DNS, so retrying lands on a
  // reachable IP. AbortSignal caps each attempt so we don't wait the full undici 10s.
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(url.toString(), { headers: HEADERS, signal: AbortSignal.timeout(7000) });
    } catch (e) {
      lastErr = e;
      const code = (e && (e.code || (e.cause && e.cause.code) || e.name)) || e.message;
      console.warn(`[akahu] ${endpoint} connect attempt ${attempt}/5 failed (${code}) — retrying`);
      if (attempt < 5) { await new Promise(r => setTimeout(r, 400)); continue; }
      throw e;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Akahu ${endpoint} ${res.status}: ${body}`);
    }
    return res.json();
  }
  throw lastErr;
}

async function fetchAccounts() {
  console.log('[akahu] Fetching accounts...');
  const data = await akahu('/accounts');
  if (!data.success) throw new Error('Accounts fetch failed');

  const accounts = data.items.map(a => ({
    id: a._id,
    name: a.name,
    bank: a.connection?.name || 'Unknown',
    type: a.type,
    number: a.formatted_account || '',
    balance: a.balance?.current ?? null,
    currency: a.balance?.currency || 'NZD',
    status: a.status
  }));

  saveJSON(ACCOUNTS_FILE, accounts);
  console.log(`[akahu] Found ${accounts.length} accounts`);
  return accounts;
}

async function fetchTransactions(startDate, endDate) {
  console.log(`[akahu] Fetching transactions from ${startDate || 'beginning'} to ${endDate || 'now'}...`);
  const allTx = [];
  let cursor = null;
  let page = 0;

  do {
    page++;
    const params = {};
    if (startDate) params.start = startDate;
    if (endDate) params.end = endDate;
    if (cursor) params.cursor = cursor;

    const data = await akahu('/transactions', params);
    if (!data.success) throw new Error(`Transaction fetch failed on page ${page}`);

    allTx.push(...data.items);
    cursor = data.cursor?.next || null;
    console.log(`[akahu]   Page ${page}: ${data.items.length} transactions (total: ${allTx.length})`);
  } while (cursor);

  return allTx;
}

async function fetchPending() {
  // Pending (authorised but not-yet-posted) transactions live on a SEPARATE
  // endpoint from posted ones. They're ephemeral — a pending item's _id changes
  // when it finally posts — so callers must REPLACE their stored pending set on
  // each sync rather than append. This is the data the old fetch never pulled,
  // which is why recent card spend never appeared.
  const data = await akahu('/transactions/pending');
  if (data.success === false) throw new Error('Pending fetch failed');
  return data.items || [];
}

// ─── Transaction format conversion ────────────────────────────
// Converts Akahu transaction → budget tracker format

function convertTransaction(tx, accountMap) {
  const account = accountMap[tx._account] || {};

  // Build detail string matching ANZ CSV style
  // Akahu gives us: description, merchant, meta.particulars, meta.code, meta.reference
  let detail = tx.description || '';
  const particulars = tx.meta?.particulars || '';
  if (particulars && !detail.toLowerCase().includes(particulars.toLowerCase())) {
    detail = detail + ' ' + particulars;
  }

  // Map Akahu type to ANZ-style txType
  const typeMap = {
    'EFTPOS': 'Eft-Pos',
    'DIRECT DEBIT': 'D/D',
    'DIRECT CREDIT': 'D/C',
    'TRANSFER': 'Transfer',
    'PAYMENT': 'Payment',
    'CREDIT': 'D/C',
    'DEBIT': 'D/D',
    'ATM': 'ATM',
    'STANDING ORDER': 'A/P',
    'CREDIT CARD': 'Visa Purchase',
    'FEE': 'Bank Fee',
    'INTEREST': 'Interest',
    'TAX': 'Tax'
  };

  return {
    date: tx.date,
    detail: detail.trim(),
    amount: tx.amount,
    txType: typeMap[tx.type] || tx.type || '',
    toFrom: tx.meta?.other_account || '',
    reference: tx.meta?.reference || '',
    code: tx.meta?.code || '',
    balance: tx.balance ?? null,
    account: account.name || '',
    accountNum: account.number || '',
    owner: '',
    category: '',
    flagged: false,
    // Extra Akahu data for enrichment (fields confirmed available via akahu-probe)
    _akahu: {
      id: tx._id,
      hash: tx.hash || null,                                            // stable dedup key
      cardSuffix: tx.meta?.card_suffix || null,                         // → owner (auto split-by-card)
      merchant: tx.merchant?.name || null,
      merchantId: tx.merchant?._id || null,                             // location-independent merchant key
      akahuType: tx.type || null,                                       // raw type (TRANSFER/STANDING ORDER/…)
      akahuCategory: tx.category?.name || null,                         // NZFCC category, e.g. "Supermarkets…"
      akahuGroup: tx.category?.groups?.personal_finance?.name || null,  // e.g. "Food"
      conversion: tx.meta?.conversion || null                           // FX info on overseas spend
    }
  };
}

// ─── Fetch & store logic ──────────────────────────────────────

async function runFetch() {
  const meta = loadJSON(META_FILE, { lastFetch: null, lastTxDate: null });
  const accounts = await fetchAccounts();
  const accountMap = {};
  accounts.forEach(a => { accountMap[a.id] = a; });
  let cryptoTotal = 0;
  try { cryptoTotal = (await fetchCryptoData()).total; } catch (e) { console.error('crypto fetch failed (non-fatal):', e.message); }
  logBalances(accounts, cryptoTotal ? { crypto: cryptoTotal } : null);

  // Incremental start from the last POSTED tx date, backed off a few days so a
  // transaction that posts late (with an earlier value date) is still recaptured.
  // Dedup by stable Akahu id makes the overlap harmless.
  const OVERLAP_DAYS = 5;
  let startDate = meta.lastTxDate || process.env.INITIAL_FETCH_FROM || null;
  if (startDate && !startDate.includes('T')) startDate = startDate + 'T00:00:00.000Z';
  if (startDate) {
    const backed = new Date(new Date(startDate).getTime() - OVERLAP_DAYS * 86400000);
    if (!isNaN(backed.getTime())) startDate = backed.toISOString();
  }

  // 1) POSTED transactions (incremental).
  const rawPosted = await fetchTransactions(startDate, null);
  const postedConv = rawPosted.map(tx => convertTransaction(tx, accountMap));

  // 2) PENDING transactions (full snapshot; replaced each sync — see fetchPending).
  let pendingConv = [];
  try {
    const rawPending = await fetchPending();
    pendingConv = rawPending.map(tx => {
      const c = convertTransaction(tx, accountMap);
      c._akahu.pending = true;
      return c;
    });
    console.log(`[akahu] Pending: ${pendingConv.length} from Akahu`);
  } catch (e) {
    console.error('[akahu] Pending fetch failed (non-fatal):', e.message);
  }

  // Merge: keep stored POSTED (dedup by id); drop stored pending and re-add the
  // current pending snapshot, minus any that have since posted.
  const existing = loadJSON(TX_FILE, []);
  const existingPosted = existing.filter(t => !(t._akahu && t._akahu.pending));
  const postedIds = new Set(existingPosted.map(t => t._akahu && t._akahu.id).filter(Boolean));
  const newPosted = postedConv.filter(t => !postedIds.has(t._akahu && t._akahu.id));
  newPosted.forEach(t => { if (t._akahu && t._akahu.id) postedIds.add(t._akahu.id); });

  const pendingToKeep = pendingConv.filter(t => !postedIds.has(t._akahu && t._akahu.id));

  const merged = [...existingPosted, ...newPosted, ...pendingToKeep]
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  saveJSON(TX_FILE, merged);
  console.log(`[akahu] Posted +${newPosted.length} new | Pending ${pendingToKeep.length} | total ${merged.length}`);

  // lastTxDate tracks POSTED only — pending dates run ahead and are ephemeral, so
  // letting them advance the cursor would skip late-posting transactions.
  const postedDates = [...existingPosted, ...newPosted].map(t => t.date).filter(Boolean).sort();
  const newLastTx = postedDates.length ? postedDates[postedDates.length - 1] : null;
  withMeta(m => {   // re-load + merge so an overlapping refresh/reminder can't revert our fields
    m.lastFetch = new Date().toISOString();
    if (newLastTx) m.lastTxDate = newLastTx;
  });

  try { await checkCardReminder(accounts); } catch (e) { console.error('[reminder] failed (non-fatal):', e.message); }

  return { newCount: newPosted.length, pendingCount: pendingToKeep.length, totalCount: merged.length };
}

// ─── Web push ──────────────────────────────────────────────────
// Optional. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (generate once with
// `npx web-push generate-vapid-keys`) to enable browser push notifications.
// Falls back to a no-op if the keys or the web-push module are absent.
let webpush = null;
try { webpush = require('web-push'); } catch (_) { /* dependency not installed — push disabled */ }
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const PUSH_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
  try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); }
  catch (e) { console.error('[push] invalid VAPID keys — push disabled:', e.message); webpush = null; }
}
function pushConfigured() { return !!(webpush && VAPID_PUBLIC && VAPID_PRIVATE); }
function loadSubs() { return loadJSON(PUSH_FILE, []); }
function saveSubs(s) { try { saveJSON(PUSH_FILE, s); } catch (e) { console.error('[push] could not save subscriptions:', e.message); } }
// Send a push to every stored subscription; prune ones the browser has expired (404/410).
async function sendPush(payload) {
  if (!pushConfigured()) return 0;
  const subs = loadSubs();
  if (!subs.length) return 0;
  const body = JSON.stringify(payload);
  let ok = 0; const keep = [];
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, body); ok++; keep.push(sub); }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) { /* gone — drop it */ } else { keep.push(sub); } }
  }
  if (keep.length !== subs.length) saveSubs(keep);
  return ok;
}

// ─── Credit-card settlement reminder ───────────────────────────
// Cycle: statement closes month-end, payment due the 15th of the next month →
// next due = the next 15th on/after today. Emails once per cycle (deduped on the
// due date) once within CARD_REMINDER_LEAD_DAYS and there's a balance to settle.
function nextCardDue() {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  let d = new Date(t.getFullYear(), t.getMonth(), 15);
  if (d < t) d = new Date(t.getFullYear(), t.getMonth() + 1, 15);
  return { due: d, days: Math.round((d - t) / 86400000) };
}
async function sendMail(subject, text, html) {
  if (!nodemailer || !process.env.SMTP_HOST) throw new Error('email not configured (SMTP_* env / nodemailer)');
  const tx = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587), secure: false, auth: { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD } });
  const to = process.env.CARD_REMINDER_TO || process.env.ALERT_EMAIL_TO || process.env.SMTP_USERNAME;
  await tx.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USERNAME, to, subject, text, html });
  return to;
}
async function checkCardReminder(accounts, force) {
  const emailOn = !!(nodemailer && process.env.SMTP_HOST);
  const pushOn = pushConfigured();
  if (!emailOn && !pushOn && !force) return { sent: false, reason: 'no channels configured' };
  const lead = parseInt(process.env.CARD_REMINDER_LEAD_DAYS || '4', 10);
  const { due, days } = nextCardDue();
  if (!force && days > lead) return { sent: false, reason: 'not due for ' + days + ' days' };
  let accs = accounts; if (!accs) accs = loadJSON(ACCOUNTS_FILE, []);
  const card = (accs || []).find(a => a.type === 'CREDITCARD');
  const cardOwed = card ? Math.abs(Math.min(0, card.balance || 0)) : 0;
  if (!force && cardOwed < 1) return { sent: false, reason: 'nothing to settle' };
  const dueISO = due.getFullYear() + '-' + String(due.getMonth() + 1).padStart(2, '0') + '-' + String(due.getDate()).padStart(2, '0');
  const meta = loadJSON(META_FILE, {});
  if (!force && meta.lastCardReminder === dueISO) return { sent: false, reason: 'already sent this cycle' };
  const n = due.getDate(); const o = (n % 10 === 1 && n % 100 !== 11) ? 'st' : (n % 10 === 2 && n % 100 !== 12) ? 'nd' : (n % 10 === 3 && n % 100 !== 13) ? 'rd' : 'th';
  const dueLabel = n + o + ' ' + due.toLocaleDateString('en-NZ', { month: 'long' });
  const subject = `Credit card: settle in ${days} day${days === 1 ? '' : 's'} (due ${dueLabel})`;
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const text = `Time to settle your credit card.\n\nDue: ${dueLabel} (in ${days} day${days === 1 ? '' : 's'}).\nBalance to settle: $${cardOwed.toFixed(2)}.\n\nReview & settle: ${appUrl}\n`;
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;color:#0f172a"><p>Time to settle <b>your credit card</b>.</p><p><b>Due:</b> ${dueLabel} (in ${days} day${days === 1 ? '' : 's'})<br><b>Balance to settle:</b> $${cardOwed.toFixed(2)}</p><p><a href="${appUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Review &amp; settle →</a></p></div>`;
  // Both channels fire off the same cycle trigger; a failure in one never blocks the other.
  let emailedTo = null, pushed = 0;
  if (emailOn) { try { emailedTo = await sendMail(subject, text, html); } catch (e) { console.error('[reminder] email failed:', e.message); } }
  if (pushOn) { try { pushed = await sendPush({ title: 'Credit card due', body: `Settle $${cardOwed.toFixed(2)} by ${dueLabel} (in ${days} day${days === 1 ? '' : 's'})`, url: appUrl, tag: 'card-reminder' }); } catch (e) { console.error('[reminder] push failed:', e.message); } }
  if (!force && (emailedTo || pushed)) withMeta(m => { m.lastCardReminder = dueISO; });   // don't re-fire this cycle; a forced test doesn't consume it
  console.log('[reminder] card settlement · due', dueISO, '· $' + cardOwed.toFixed(2), '· email:', emailedTo || 'off', '· push:', pushed);
  return { sent: !!(emailedTo || pushed), to: emailedTo, pushed, days, dueISO, cardOwed };
}

// ─── API routes ───────────────────────────────────────────────

// ─── CORS / access control ─────────────────────────────────────
// Cloudflare Access (email OTP) gates the public edge and is the primary auth
// layer. The tracker JS on the same origin sends fetch() requests to /api/*.
// We reflect only known origins instead of a blanket wildcard.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ||
  [process.env.APP_URL, 'http://localhost:3000', 'http://127.0.0.1:3000'].filter(Boolean).join(','))
  .split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '25mb' }));

// Optional app-layer enforcement of Cloudflare Access identity (defence in
// depth). OFF by default so a header-name surprise can't lock anyone out;
// enable with REQUIRE_CF_ACCESS=1 after confirming the header arrives. Local
// requests (the 6am cron fetch) always bypass.
const REQUIRE_CF_ACCESS = process.env.REQUIRE_CF_ACCESS === '1';
const ALLOWED_EMAIL = (process.env.ALLOWED_EMAIL || '').toLowerCase();
function isLocalReq(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
app.use('/api', (req, res, next) => {
  if (!REQUIRE_CF_ACCESS || isLocalReq(req)) return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase();
  if (!email) return res.status(401).json({ ok: false, error: 'No Cloudflare Access identity' });
  if (ALLOWED_EMAIL && email !== ALLOWED_EMAIL) return res.status(403).json({ ok: false, error: 'Forbidden' });
  next();
});

// Serve vendored front-end assets (Chart.js) from the repo, same-origin — no CDN.
app.use('/vendor', express.static(path.join(__dirname, 'vendor'), { maxAge: '1y', immutable: true }));

// PWA assets. sw.js must be reachable at the root so its scope covers the whole app;
// it's served no-cache so a new service worker is picked up promptly.
app.use('/icons', express.static(path.join(__dirname, 'icons'), { maxAge: '30d' }));
app.get('/sw.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('application/javascript'); res.sendFile(path.join(__dirname, 'sw.js')); });
app.get('/manifest.webmanifest', (req, res) => { res.type('application/manifest+json'); res.sendFile(path.join(__dirname, 'manifest.webmanifest')); });

// Serve budget tracker HTML at root
const trackerFile = path.join(__dirname, 'index.html');
if (fs.existsSync(trackerFile)) {
  app.get('/', (req, res) => res.sendFile(trackerFile));
} else {
  app.get('/', (req, res) => res.send(`
    <h1>Francs Server</h1>
    <p>Place index.html in ${__dirname} to serve the budget tracker.</p>
    <p><a href="/api/status">API Status</a></p>
  `));
}

// Health check — useful for Cloudflare tunnel / uptime monitoring
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// API status
app.get('/api/status', (req, res) => {
  const meta = loadJSON(META_FILE, { lastFetch: null, lastTxDate: null });
  const tx = loadJSON(TX_FILE, []);
  const accounts = loadJSON(ACCOUNTS_FILE, []);
  res.json({
    ok: true,
    lastFetch: meta.lastFetch,
    lastBalances: meta.lastBalances || null,
    lastTxDate: meta.lastTxDate,
    transactionCount: tx.length,
    accountCount: accounts.length,
    accounts: accounts.map(a => ({ name: a.name, bank: a.bank, number: a.number, balance: a.balance }))
  });
});

// Credit-card settlement reminder — status / manual send. ?force=1 bypasses the
// lead-time, balance, and once-per-cycle checks to send a test email now.
app.get('/api/card-reminder', async (req, res) => {
  try { const r = await checkCardReminder(null, req.query.force === '1' || req.query.test === '1'); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Web-push subscription management ──
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!pushConfigured()) return res.status(503).json({ ok: false, error: 'push not configured' });
  res.json({ key: VAPID_PUBLIC });
});
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || typeof sub.endpoint !== 'string') return res.status(400).json({ ok: false, error: 'invalid subscription' });
  const subs = loadSubs();
  if (!subs.find(s => s.endpoint === sub.endpoint)) { subs.push(sub); saveSubs(subs); }
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', (req, res) => {
  const ep = req.body && req.body.endpoint;
  if (ep) saveSubs(loadSubs().filter(s => s.endpoint !== ep));
  res.json({ ok: true });
});
app.post('/api/push/test', async (req, res) => {
  if (!pushConfigured()) return res.status(503).json({ ok: false, error: 'push not configured' });
  try { const sent = await sendPush({ title: 'Francs', body: 'Test notification — push is working.', url: '/', tag: 'test' }); res.json({ ok: true, sent }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Fetch transactions from Akahu (manual trigger from UI or cron script)
app.post('/api/fetch', async (req, res) => {
  try {
    console.log('[api] Manual fetch triggered');
    const result = await runFetch();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[api] Fetch error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Refresh balances + investments only — pulls current account balances (and crypto)
// and logs them, WITHOUT importing transactions / touching the settlement flow.
app.post('/api/refresh-balances', async (req, res) => {
  try {
    console.log('[api] Balance refresh triggered');
    const accounts = await fetchAccounts();
    let cryptoTotal = 0;
    try { cryptoTotal = (await fetchCryptoData()).total; } catch (e) { console.error('crypto fetch failed (non-fatal):', e.message); }
    logBalances(accounts, cryptoTotal ? { crypto: cryptoTotal } : null);
    const at = new Date().toISOString();
    withMeta(m => { m.lastBalances = at; });   // re-load + merge so a concurrent fetch isn't reverted
    res.json({ ok: true, accountCount: accounts.length, at });
  } catch (e) {
    console.error('[api] Balance refresh error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get transactions for the budget tracker
// Query params: from (ISO date), to (ISO date)
app.get('/api/transactions', (req, res) => {
  const tx = loadJSON(TX_FILE, []);
  let filtered = tx;

  if (req.query.from) {
    const from = new Date(req.query.from);
    filtered = filtered.filter(t => new Date(t.date) >= from);
  }
  if (req.query.to) {
    const to = new Date(req.query.to);
    filtered = filtered.filter(t => new Date(t.date) <= to);
  }

  // Strip internal Akahu IDs for the client; surface the useful enrichment.
  const cleaned = filtered.map(t => {
    const { _akahu, ...rest } = t;
    return {
      ...rest,
      akahuId: _akahu?.id || null,
      cardSuffix: _akahu?.cardSuffix || null,
      merchantHint: _akahu?.merchant || null,
      merchantId: _akahu?.merchantId || null,
      categoryHint: _akahu?.akahuCategory || null,
      groupHint: _akahu?.akahuGroup || null,
      conversion: _akahu?.conversion || null,
      pending: _akahu?.pending || false
    };
  });

  res.json({
    ok: true,
    count: cleaned.length,
    transactions: cleaned
  });
});

// Get accounts
app.get('/api/accounts', (req, res) => {
  const accounts = loadJSON(ACCOUNTS_FILE, []);
  res.json({ ok: true, accounts });
});

// Reconstructed historical balances (account number → [{date, balance}]), derived
// from imported bank statements. Display-only: feeds the Trend graphs so they show
// history older than the live Akahu feed. Empty object if no statements imported.
app.get('/api/balance-history', (req, res) => {
  res.json({ ok: true, history: loadJSON(BALANCE_HISTORY_FILE, {}) });
});

// Daily snapshots of all account balances (date -> { accountId: balance }).
app.get('/api/balance-log', (req, res) => {
  res.json({ ok: true, log: loadJSON(BALANCE_LOG_FILE, {}) });
});

// Crypto holdings valued live via CoinGecko (5-minute cache).
let _cryptoCache = { at: 0, data: null };
app.get('/api/crypto', async (req, res) => {
  const now = Date.now();
  if (_cryptoCache.data && (now - _cryptoCache.at) < 300000) return res.json(_cryptoCache.data);
  try {
    const d = await fetchCryptoData();
    const out = { ok: true, holdings: d.holdings, total: d.total, updatedAt: new Date().toISOString() };
    _cryptoCache = { at: now, data: out };
    res.json(out);
  } catch (e) { res.json({ ok: false, error: e.message, holdings: [], total: 0 }); }
});

// ─── Server-owned shared state ─────────────────────────────────
// One shared budget document (config + ledger + settlement history + migrated
// pre-Akahu periods) so everyone sees the same data on every device.
// This replaces per-browser localStorage as the source of truth; the client
// keeps a local cache/backup and syncs here. Transactions themselves stay in
// transactions.json and are served via /api/transactions — state holds only the
// budget overlay (categories, funding, settlements, history).
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// Keep a rolling set of timestamped snapshots of the irreplaceable state file,
// taken just before every overwrite so a bad write is always recoverable.
function snapshotState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const dir = path.join(DATA_DIR, 'state-snapshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(STATE_FILE, path.join(dir, 'state-' + stamp + '.json'));
    const snaps = fs.readdirSync(dir).filter(f => f.startsWith('state-')).sort();
    while (snaps.length > 40) fs.unlinkSync(path.join(dir, snaps.shift()));
  } catch (e) { console.error('State snapshot failed (non-fatal):', e.message); }
}

app.get('/api/state', (req, res) => {
  let wrap;
  try { wrap = loadJSONStrict(STATE_FILE); }
  catch (e) { console.error('state.json unreadable:', e.message); return res.status(500).json({ ok: false, error: 'state unreadable' }); }
  if (!wrap) return res.json({ ok: true, state: null, version: 0, updatedAt: null });
  res.json({
    ok: true,
    state: wrap.state,
    version: wrap.version || 0,
    updatedAt: wrap.updatedAt || null,
    updatedBy: wrap.updatedBy || null
  });
});

app.put('/api/state', (req, res) => {
  const body = req.body || {};
  if (typeof body.state === 'undefined') {
    return res.status(400).json({ ok: false, error: 'Missing state in body' });
  }
  // Structural validation: reject null / a string / a bare {} / anything missing the core arrays,
  // which would otherwise be written verbatim and propagated to every device. force:true bypasses.
  const s = body.state;
  if (!body.force && (typeof s !== 'object' || s === null || Array.isArray(s) || !Array.isArray(s.periods) || !Array.isArray(s.categories))) {
    return res.status(400).json({ ok: false, error: 'Invalid state shape (need an object with periods[] and categories[]); pass force:true to override' });
  }
  let current;
  try { current = loadJSONStrict(STATE_FILE); }
  catch (e) { console.error('Refusing PUT over unreadable state.json:', e.message); return res.status(500).json({ ok: false, error: 'existing state unreadable — not overwriting' }); }
  const currentVersion = (current && current.version) || 0;
  // Optimistic concurrency: a client that based its edit on an older version is
  // rejected (so a second device can't silently clobber the first). Pass
  // force:true to override after the client has reconciled.
  if (!body.force && typeof body.baseVersion === 'number' && body.baseVersion !== currentVersion) {
    return res.status(409).json({
      ok: false,
      error: 'Version conflict',
      currentVersion,
      state: current ? current.state : null
    });
  }
  // Shrink tripwire: refuse a write that drops most of the ledger (a wiped or half-migrated client)
  // unless forced. The client's existing 409 handler re-adopts the returned (larger) state.
  const curPeriods = (current && current.state && Array.isArray(current.state.periods)) ? current.state.periods.length : 0;
  const newPeriods = Array.isArray(s.periods) ? s.periods.length : 0;
  if (!body.force && curPeriods >= 10 && newPeriods < curPeriods * 0.5) {
    return res.status(409).json({ ok: false, error: 'Refusing to shrink ledger from ' + curPeriods + ' to ' + newPeriods + ' periods; pass force:true if intended', currentVersion, state: current ? current.state : null });
  }
  snapshotState();   // copy the current file aside BEFORE overwriting (the recovery layer)
  const wrap = {
    state: body.state,
    version: currentVersion + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: req.headers['cf-access-authenticated-user-email'] || 'unknown'
  };
  saveJSON(STATE_FILE, wrap);
  res.json({ ok: true, version: wrap.version, updatedAt: wrap.updatedAt });
});

// ─── Start server ─────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`[server] Francs Server running at http://${HOST}:${PORT}`);
  console.log(`[server] Data dir: ${DATA_DIR}`);
  console.log(`[server] Endpoints: /api/status, POST /api/fetch, /api/transactions, /api/accounts, /health`);
  // Loud warning if reachable beyond localhost without any auth: the API serves your finances
  // and accepts writes (PUT /api/state) with no login unless REQUIRE_CF_ACCESS is enabled.
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1' && !REQUIRE_CF_ACCESS) {
    console.warn('');
    console.warn(`[server] WARNING: bound to ${HOST} — reachable beyond localhost with NO authentication.`);
    console.warn('[server] WARNING: anyone who can reach this port can read your finances and OVERWRITE your data.');
    console.warn('[server] WARNING: only expose it behind Cloudflare Access (REQUIRE_CF_ACCESS=1 + ALLOWED_EMAIL) or a VPN.');
    console.warn('');
  }
});
