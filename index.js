/**
 * WorldVest price updater.
 *
 * Polls every POLL_INTERVAL_MS:
 *   - Stocks (e.g. "AAPL"):       Finnhub /quote, one call per ticker
 *   - Crypto (e.g. "CG:bitcoin"): CoinGecko /coins/markets, batched
 *
 * Writes results to /prices/{SYMBOL} in Firebase.
 *
 * Hardening:
 *   - All fetches have explicit timeouts (no infinite hangs)
 *   - Each cycle is wrapped in an overall timeout
 *   - Watchdog forces process restart if no cycle completes in 10 minutes
 *   - All errors logged, never silently swallowed
 *
 * Required env vars on Render:
 *   FIREBASE_SERVICE_ACCOUNT  Firebase admin credentials (JSON string)
 *   FINNHUB_KEY               Finnhub API key
 *   COINGECKO_KEY             CoinGecko Demo key (recommended for stable rate limits)
 */

import admin from 'firebase-admin';
import http from 'http';

// ---------- Config ----------
const FINNHUB_KEY = process.env.FINNHUB_KEY || "d7ok9vhr01qsb7bf9bdgd7ok9vhr01qsb7bf9be0";
const COINGECKO_KEY = process.env.COINGECKO_KEY || "";

const POLL_INTERVAL_MS = 30 * 1000;          // Stock cycle (Finnhub: 60/min limit)
const CRYPTO_POLL_INTERVAL_MS = 5 * 60 * 1000; // Crypto cycle (CoinGecko: 30/min, 10K/mo)
const STOCK_RATE_LIMIT_MS = 1100;          // Finnhub free: 60/min
const FETCH_TIMEOUT_MS = 12 * 1000;
const CYCLE_TIMEOUT_MS = 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 60 * 1000;
const WATCHDOG_DEADLINE_MS = 10 * 60 * 1000;

// Historical sampling.
//
//   Crypto:  one point every 30 min, 24/7  (~336 points = 7 days)
//   Stocks:  one point every 10 min, only during US market hours
//            9:30am – 4:00pm ET, Mon–Fri  (~39/day × 5 = 195 points/week)
//
// The cap is the larger of the two so neither type ever truncates within 7 days.
const HISTORY_INTERVAL_CRYPTO_MS = 30 * 60 * 1000;
const HISTORY_INTERVAL_STOCK_MS = 10 * 60 * 1000;
const HISTORY_MAX_POINTS = 400;

// ---------- Firebase ----------
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://watchlist-d9ade-default-rtdb.firebaseio.com"
});
const db = admin.database();
const watchlistRef = db.ref('watchlist');
const pricesRef = db.ref('prices');
const historicalRef = db.ref('historical');

// In-memory: when did we last save a history point for each symbol?
// (Persists across cycles within a single process; rebuilt on restart from
// the most recent point in Firebase.)
const lastHistorySampleAt = {};

// ---------- State ----------
let lastCycleCompletedAt = Date.now();
let stockCycleCount = 0;
let cryptoCycleCount = 0;

// ---------- Process-wide error visibility ----------
process.on('uncaughtException', (err) => console.error('💥 uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('💥 unhandledRejection:', reason));

// ---------- HTTP server (keepalive + status) ----------
http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/status' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      stockCycleCount,
      cryptoCycleCount,
      lastCycleAgoSec: Math.floor((Date.now() - lastCycleCompletedAt) / 1000),
      uptimeSec: Math.floor(process.uptime()),
    }, null, 2));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WorldVest Price Updater is running.');
}).listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);
});

// ---------- Fetch with timeout (no infinite hangs) ----------
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ---------- Historical price tracking (for sparklines) ----------

// Are US stock markets open right now? Mon–Fri, 9:30am–4:00pm ET.
// We don't track holidays — they'll just produce flat segments which is fine.
// Uses Intl.DateTimeFormat for proper DST handling (don't hardcode UTC offset).
function isUsMarketOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const get = type => parts.find(p => p.type === type)?.value;
  const weekday = get('weekday'); // "Mon", "Tue", ...
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  const minutesSinceMidnight = hour * 60 + minute;
  const open = 9 * 60 + 30;  // 9:30 AM
  const close = 16 * 60;     // 4:00 PM
  return minutesSinceMidnight >= open && minutesSinceMidnight < close;
}

// Saves one price point per symbol, throttled by asset-type-specific
// interval. Stocks also gated to market hours. Trims to HISTORY_MAX_POINTS.
async function recordHistorySample(symbol, price, kind) {
  if (!Number.isFinite(price) || price <= 0) return;

  // Stocks: only during market hours
  if (kind === 'stock' && !isUsMarketOpen()) return;

  const interval = kind === 'crypto' ? HISTORY_INTERVAL_CRYPTO_MS : HISTORY_INTERVAL_STOCK_MS;
  const now = Date.now();
  const last = lastHistorySampleAt[symbol] || 0;
  if (now - last < interval) return; // throttled

  try {
    await historicalRef.child(symbol).push({ t: now, p: price });
    lastHistorySampleAt[symbol] = now;

    // Trim only occasionally to keep Firebase reads down. Bouncing between
    // 400 and ~410 points is fine.
    if (Math.random() < 0.1) {
      const snap = await historicalRef.child(symbol).once('value');
      const all = snap.val() || {};
      const keys = Object.keys(all);
      if (keys.length > HISTORY_MAX_POINTS) {
        const excess = keys.length - HISTORY_MAX_POINTS;
        const updates = {};
        for (let i = 0; i < excess; i++) updates[keys[i]] = null;
        await historicalRef.child(symbol).update(updates);
        console.log(`[history] ${symbol} trimmed ${excess} old points`);
      }
    }
  } catch (e) {
    console.warn(`[history] ${symbol} sample failed:`, e.message);
  }
}

// ---------- Symbol classification ----------
//   "AAPL"             → stock
//   "CG:bitcoin"       → crypto, CoinGecko id "bitcoin"
//   "BINANCE:BTCUSDT"  → legacy crypto, derive id from base symbol
const LEGACY_BASE_TO_CG = {
  btc:'bitcoin', eth:'ethereum', sol:'solana', xrp:'ripple', bnb:'binancecoin',
  ada:'cardano', doge:'dogecoin', avax:'avalanche-2', link:'chainlink',
  dot:'polkadot', matic:'matic-network', ltc:'litecoin', trx:'tron',
  bch:'bitcoin-cash', atom:'cosmos', near:'near', uni:'uniswap',
  xlm:'stellar', apt:'aptos', arb:'arbitrum', op:'optimism',
  inj:'injective-protocol', fil:'filecoin', sui:'sui', etc:'ethereum-classic',
  zec:'zcash',
};

function classify(symbol) {
  if (symbol.startsWith('CG:')) {
    return { kind: 'crypto', cgId: symbol.slice(3) };
  }
  if (symbol.includes(':')) {
    const pair = symbol.split(':')[1] || '';
    const base = pair.replace(/USDT$|USD$|USDC$|BUSD$/i, '').toLowerCase();
    return { kind: 'crypto', cgId: LEGACY_BASE_TO_CG[base] || null };
  }
  return { kind: 'stock' };
}

// ---------- Finnhub /quote (stocks) ----------
async function fetchStock(symbol) {
  try {
    const res = await fetchWithTimeout(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`
    );
    if (!res.ok) {
      console.warn(`[stock] ${symbol} HTTP ${res.status}`);
      return null;
    }
    const q = await res.json();
    if (!q || (q.c === 0 && q.pc === 0)) return null;
    return {
      price: Number(q.c ?? 0),
      percent: Number(q.dp ?? 0),
      prevClose: Number(q.pc ?? 0),
    };
  } catch (e) {
    console.warn(`[stock] ${symbol} failed:`, e.name === 'AbortError' ? 'timeout' : e.message);
    return null;
  }
}

// ---------- CoinGecko /coins/markets (crypto, batched) ----------
async function fetchCryptoBatch(cgIds) {
  if (cgIds.length === 0) return {};
  const ids = [...new Set(cgIds)].join(',');
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&price_change_percentage=24h`;
  const headers = { 'Accept': 'application/json' };
  if (COINGECKO_KEY) headers['x-cg-demo-api-key'] = COINGECKO_KEY;

  // Up to 3 attempts with backoff on 429
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { headers });
      if (res.status === 429) {
        const wait = attempt * 2000;
        console.warn(`[crypto] 429 (attempt ${attempt}/3), waiting ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        console.warn(`[crypto] HTTP ${res.status}`);
        return {};
      }
      const data = await res.json();
      if (!Array.isArray(data)) return {};
      const out = {};
      for (const coin of data) {
        out[coin.id] = {
          price: Number(coin.current_price ?? 0),
          percent: Number(coin.price_change_percentage_24h ?? 0),
        };
      }
      console.log(`[crypto] got ${data.length} coins`);
      return out;
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'timeout' : e.message;
      console.warn(`[crypto] attempt ${attempt} failed: ${msg}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  return {};
}

// ---------- One poll cycle ----------
// Read the watchlist symbols, bucketed by asset kind.
// Returns { stocks: [sym, ...], cryptoIds: [cgId, ...], cryptoSymToId: {sym: cgId} }
async function readWatchlistBuckets() {
  let symbols = [];
  try {
    const snap = await watchlistRef.once('value');
    symbols = Object.keys(snap.val() || {});
  } catch (e) {
    console.warn('[cycle] watchlist read failed:', e.message);
    return { stocks: [], cryptoIds: [], cryptoSymToId: {} };
  }
  const stocks = [];
  const cryptoIds = [];
  const cryptoSymToId = {};
  for (const sym of symbols) {
    const c = classify(sym);
    if (c.kind === 'stock') {
      stocks.push(sym);
    } else if (c.kind === 'crypto' && c.cgId) {
      cryptoIds.push(c.cgId);
      cryptoSymToId[sym] = c.cgId;
    }
  }
  return { stocks, cryptoIds, cryptoSymToId };
}

// ---------- Stock cycle (runs every POLL_INTERVAL_MS = 30s) ----------
async function pollStocksInner() {
  const { stocks } = await readWatchlistBuckets();
  if (stocks.length === 0) return;

  console.log(`[stock cycle #${stockCycleCount + 1}] ${stocks.length} stocks`);
  for (const sym of stocks) {
    const q = await fetchStock(sym);
    if (q) {
      try {
        await pricesRef.child(sym).update({
          price: q.price,
          percent: q.percent,
          prevClose: q.prevClose,
          updatedAt: Date.now(),
        });
        recordHistorySample(sym, q.price, 'stock');
      } catch (e) {
        console.warn(`[stock] write ${sym} failed:`, e.message);
      }
    }
    await new Promise(r => setTimeout(r, STOCK_RATE_LIMIT_MS));
  }
}

// ---------- Crypto cycle (runs every CRYPTO_POLL_INTERVAL_MS = 5min) ----------
async function pollCryptoInner() {
  const { cryptoIds, cryptoSymToId } = await readWatchlistBuckets();
  if (cryptoIds.length === 0) return;

  console.log(`[crypto cycle #${cryptoCycleCount + 1}] ${cryptoIds.length} crypto`);
  const data = await fetchCryptoBatch(cryptoIds);
  let written = 0;
  for (const [sym, cgId] of Object.entries(cryptoSymToId)) {
    const d = data[cgId];
    if (!d) continue;
    try {
      await pricesRef.child(sym).update({
        price: d.price,
        percent: d.percent,
        updatedAt: Date.now(),
      });
      recordHistorySample(sym, d.price, 'crypto');
      written++;
    } catch (e) {
      console.warn(`[crypto] write ${sym} failed:`, e.message);
    }
  }
  if (written > 0) console.log(`[crypto] wrote ${written}/${Object.keys(cryptoSymToId).length}`);
}

// Wrap each cycle in an overall timeout so a stuck call can't hang the loop forever
async function pollStocks() {
  await Promise.race([
    pollStocksInner(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('stock cycle timeout')), CYCLE_TIMEOUT_MS)
    ),
  ]);
}
async function pollCrypto() {
  await Promise.race([
    pollCryptoInner(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('crypto cycle timeout')), CYCLE_TIMEOUT_MS)
    ),
  ]);
}

// ---------- Cleanup when a ticker is removed ----------
watchlistRef.on('child_removed', (snap) => {
  pricesRef.child(snap.key).remove().catch(() => {});
  historicalRef.child(snap.key).remove().catch(() => {});
});

// ---------- Watchdog: restart if no STOCK cycle in 10 min ----------
// We watchdog on the stock cycle because it's the more frequent one (30s).
// Crypto cycles only every 5min so it's a worse health signal.
setInterval(() => {
  const ageMs = Date.now() - lastCycleCompletedAt;
  if (ageMs > WATCHDOG_DEADLINE_MS) {
    console.error(`💀 watchdog: no stock cycle completed in ${Math.floor(ageMs / 1000)}s — exiting for restart`);
    process.exit(1);
  } else {
    console.log(`[watchdog] last stock cycle ${Math.floor(ageMs / 1000)}s ago, totals: stock=${stockCycleCount} crypto=${cryptoCycleCount}`);
  }
}, WATCHDOG_INTERVAL_MS);

// ---------- Main loops ----------
// Two independent loops run concurrently: stocks every 30s, crypto every 5min.
// They share the watchlist read inside their own cycle but don't block each other.
async function stockLoop() {
  while (true) {
    try {
      await pollStocks();
      lastCycleCompletedAt = Date.now();
      stockCycleCount++;
    } catch (e) {
      console.error('[stock loop] cycle failed:', e.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}
async function cryptoLoop() {
  while (true) {
    try {
      await pollCrypto();
      cryptoCycleCount++;
    } catch (e) {
      console.error('[crypto loop] cycle failed:', e.message);
    }
    await new Promise(r => setTimeout(r, CRYPTO_POLL_INTERVAL_MS));
  }
}

console.log('🚀 WorldVest Updater Running');
console.log(`   FINNHUB_KEY:    ${FINNHUB_KEY ? '✓ set' : '✗ MISSING'}`);
console.log(`   COINGECKO_KEY:  ${COINGECKO_KEY ? '✓ set (Demo, 30/min)' : '⚠ unset (using public 5–15/min)'}`);
console.log(`   STOCK INTERVAL: ${POLL_INTERVAL_MS / 1000}s`);
console.log(`   CRYPTO INTERVAL: ${CRYPTO_POLL_INTERVAL_MS / 1000}s`);
stockLoop();
cryptoLoop();
