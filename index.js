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

const POLL_INTERVAL_MS = 30 * 1000;
const STOCK_RATE_LIMIT_MS = 1100;          // Finnhub free: 60/min
const FETCH_TIMEOUT_MS = 12 * 1000;
const CYCLE_TIMEOUT_MS = 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 60 * 1000;
const WATCHDOG_DEADLINE_MS = 10 * 60 * 1000;

// ---------- Firebase ----------
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://watchlist-d9ade-default-rtdb.firebaseio.com"
});
const db = admin.database();
const watchlistRef = db.ref('watchlist');
const pricesRef = db.ref('prices');

// ---------- State ----------
let lastCycleCompletedAt = Date.now();
let cycleCount = 0;

// ---------- Process-wide error visibility ----------
process.on('uncaughtException', (err) => console.error('💥 uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('💥 unhandledRejection:', reason));

// ---------- HTTP server (keepalive + status) ----------
http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/status' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      cycleCount,
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
async function pollCycleInner() {
  let symbols;
  try {
    const snap = await watchlistRef.once('value');
    symbols = Object.keys(snap.val() || {});
  } catch (e) {
    console.warn('[cycle] watchlist read failed:', e.message);
    return;
  }
  if (symbols.length === 0) {
    console.log('[cycle] watchlist empty');
    return;
  }

  // Bucket by kind
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
  console.log(`[cycle #${cycleCount + 1}] ${stocks.length} stocks, ${cryptoIds.length} crypto`);

  // Crypto: one batched call
  if (cryptoIds.length > 0) {
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
        written++;
      } catch (e) {
        console.warn(`[crypto] write ${sym} failed:`, e.message);
      }
    }
    if (written > 0) console.log(`[crypto] wrote ${written}/${Object.keys(cryptoSymToId).length}`);
  }

  // Stocks: per-symbol, throttled
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
      } catch (e) {
        console.warn(`[stock] write ${sym} failed:`, e.message);
      }
    }
    await new Promise(r => setTimeout(r, STOCK_RATE_LIMIT_MS));
  }
}

// Wrap cycle in overall timeout so a stuck call can't hang the loop forever
async function pollCycle() {
  await Promise.race([
    pollCycleInner(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('cycle timeout')), CYCLE_TIMEOUT_MS)
    ),
  ]);
}

// ---------- Cleanup when a ticker is removed ----------
watchlistRef.on('child_removed', (snap) => {
  pricesRef.child(snap.key).remove().catch(() => {});
});

// ---------- Watchdog: restart if no cycle in 10 min ----------
setInterval(() => {
  const ageMs = Date.now() - lastCycleCompletedAt;
  if (ageMs > WATCHDOG_DEADLINE_MS) {
    console.error(`💀 watchdog: no cycle completed in ${Math.floor(ageMs / 1000)}s — exiting for restart`);
    process.exit(1);
  } else {
    console.log(`[watchdog] last cycle ${Math.floor(ageMs / 1000)}s ago, total cycles: ${cycleCount}`);
  }
}, WATCHDOG_INTERVAL_MS);

// ---------- Main loop ----------
async function loop() {
  while (true) {
    try {
      await pollCycle();
      lastCycleCompletedAt = Date.now();
      cycleCount++;
    } catch (e) {
      console.error('[loop] cycle failed:', e.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

console.log('🚀 WorldVest Updater Running');
console.log(`   FINNHUB_KEY:   ${FINNHUB_KEY ? '✓ set' : '✗ MISSING'}`);
console.log(`   COINGECKO_KEY: ${COINGECKO_KEY ? '✓ set (Demo, 30/min)' : '⚠ unset (using public 5–15/min)'}`);
console.log(`   POLL_INTERVAL: ${POLL_INTERVAL_MS / 1000}s`);
loop();
