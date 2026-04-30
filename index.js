/**
 * WorldVest price updater.
 *
 * Polls every POLL_INTERVAL_MS:
 *   - Stocks: Finnhub /quote (one call per ticker, throttled)
 *   - Crypto: CoinGecko /coins/markets (one batched call for all coins)
 *
 * Writes to /prices/{SYMBOL} in Firebase.
 *
 * Env vars on Render:
 *   FIREBASE_SERVICE_ACCOUNT  (required)
 *   FINNHUB_KEY               (optional, has fallback)
 *   COINGECKO_KEY             (recommended — free Demo key, 30 calls/min)
 */

import admin from 'firebase-admin';
import http from 'http';

const FINNHUB_KEY = process.env.FINNHUB_KEY || "d7ok9vhr01qsb7bf9bdgd7ok9vhr01qsb7bf9be0";
const COINGECKO_KEY = process.env.COINGECKO_KEY || "";
const POLL_INTERVAL_MS = 30 * 1000;     // 30s — comfortable inside 30/min limit
const STOCK_RATE_LIMIT_MS = 1100;       // Finnhub free: 60/min

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://watchlist-d9ade-default-rtdb.firebaseio.com"
});

const db = admin.database();
const watchlistRef = db.ref('watchlist');
const pricesRef = db.ref('prices');

// ---------- HTTP keepalive ----------
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WorldVest Price Updater is running.');
}).listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);
});

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
    const res = await fetch(
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
    console.warn(`[stock] ${symbol} failed:`, e.message);
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

  // Retry up to 3x with exponential backoff on rate-limit errors
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        const wait = attempt * 2000;
        console.warn(`[crypto] 429 rate-limited (attempt ${attempt}/3), waiting ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        console.warn(`[crypto] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return {};
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        console.warn('[crypto] response not an array:', JSON.stringify(data).slice(0, 200));
        return {};
      }
      const out = {};
      for (const coin of data) {
        out[coin.id] = {
          price: Number(coin.current_price ?? 0),
          percent: Number(coin.price_change_percentage_24h ?? 0),
        };
      }
      console.log(`[crypto] got ${data.length} coins from CoinGecko`);
      return out;
    } catch (e) {
      console.warn(`[crypto] attempt ${attempt} failed:`, e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  return {};
}

// ---------- One poll cycle ----------
async function pollCycle() {
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

  console.log(`[cycle] ${stocks.length} stocks, ${cryptoIds.length} crypto`);

  // Crypto: one batched call
  if (cryptoIds.length > 0) {
    const data = await fetchCryptoBatch(cryptoIds);
    let written = 0;
    for (const [sym, cgId] of Object.entries(cryptoSymToId)) {
      const d = data[cgId];
      if (!d) {
        console.warn(`[crypto] no data for ${sym} (cgId=${cgId})`);
        continue;
      }
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
    console.log(`[crypto] wrote ${written}/${Object.keys(cryptoSymToId).length} prices`);
  }

  // Stocks: one call each, throttled
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

// ---------- Cleanup ----------
watchlistRef.on('child_removed', (snap) => {
  pricesRef.child(snap.key).remove().catch(() => {});
});

// ---------- Main loop ----------
async function loop() {
  while (true) {
    try {
      await pollCycle();
    } catch (e) {
      console.error('[loop] cycle error:', e.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

console.log('🚀 WorldVest Updater Running (Finnhub stocks + CoinGecko crypto)');
console.log(`   FINNHUB_KEY:   ${FINNHUB_KEY ? '✓ set' : '✗ MISSING'}`);
console.log(`   COINGECKO_KEY: ${COINGECKO_KEY ? '✓ set (Demo, 30/min)' : '⚠ unset (using public 5-15/min)'}`);
console.log(`   POLL_INTERVAL: ${POLL_INTERVAL_MS / 1000}s`);
loop();
