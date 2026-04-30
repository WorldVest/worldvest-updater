/**
 * WorldVest price updater (polling edition).
 *
 * Every POLL_INTERVAL_MS:
 *   - Read /watchlist from Firebase
 *   - For stocks (plain ticker like "AAPL"): hit Finnhub /quote
 *   - For crypto (id like "CG:bitcoin" or legacy "BINANCE:BTCUSDT"):
 *     hit CoinGecko /coins/markets in one batched call
 *   - Write results to /prices/{SYMBOL}
 *
 * No WebSocket. No watchdog. No reconnect drama. Polling tolerates
 * Render spin-downs, network blips, and silent failures — every
 * cycle starts fresh from a Firebase read.
 */

import admin from 'firebase-admin';
import http from 'http';

const FINNHUB_KEY = process.env.FINNHUB_KEY || "d7ok9vhr01qsb7bf9bdgd7ok9vhr01qsb7bf9be0";
const POLL_INTERVAL_MS = 15 * 1000;
const STOCK_RATE_LIMIT_MS = 1100; // Finnhub free: 60/min — be polite

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
// Stock:        "AAPL"             (no colon)
// New crypto:   "CG:hyperliquid"   (prefix + CoinGecko id)
// Legacy crypto:"BINANCE:BTCUSDT"  (Finnhub WS format we used before)
function classify(symbol) {
  if (symbol.startsWith('CG:')) {
    return { kind: 'crypto', cgId: symbol.slice(3) };
  }
  if (symbol.includes(':')) {
    // Legacy BINANCE:BTCUSDT — derive a CoinGecko id by base symbol
    const pair = symbol.split(':')[1] || '';
    const base = pair.replace(/USDT$|USD$|USDC$|BUSD$/i, '').toLowerCase();
    return { kind: 'crypto', cgId: LEGACY_BASE_TO_CG[base] || null };
  }
  return { kind: 'stock' };
}

// Map of legacy base symbols → CoinGecko ids (for backward compat with
// watchlists added before this rewrite). Anything not in here will get
// re-added via the new search bar.
const LEGACY_BASE_TO_CG = {
  btc:'bitcoin', eth:'ethereum', sol:'solana', xrp:'ripple', bnb:'binancecoin',
  ada:'cardano', doge:'dogecoin', avax:'avalanche-2', link:'chainlink',
  dot:'polkadot', matic:'matic-network', ltc:'litecoin', trx:'tron',
  bch:'bitcoin-cash', atom:'cosmos', near:'near', uni:'uniswap',
  xlm:'stellar', apt:'aptos', arb:'arbitrum', op:'optimism',
  inj:'injective-protocol', fil:'filecoin', sui:'sui', etc:'ethereum-classic',
};

// ---------- Finnhub /quote for stocks ----------
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

// ---------- CoinGecko /coins/markets for crypto (batched) ----------
async function fetchCryptoBatch(cgIds) {
  if (cgIds.length === 0) return {};
  const ids = cgIds.join(',');
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&price_change_percentage=24h`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.warn(`[crypto] batch HTTP ${res.status}`);
      return {};
    }
    const data = await res.json();
    if (!Array.isArray(data)) return {};
    const out = {};
    for (const coin of data) {
      out[coin.id] = {
        price: Number(coin.current_price ?? 0),
        percent: Number(coin.price_change_percentage_24h ?? 0),
        prevClose: 0, // not used for crypto display
      };
    }
    return out;
  } catch (e) {
    console.warn('[crypto] batch failed:', e.message);
    return {};
  }
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

  // Bucket symbols by kind
  const stocks = [];
  const cryptoIds = [];
  const cryptoSymToId = {}; // symbol → cgId
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

  // ----- Crypto: one batched call -----
  if (cryptoIds.length > 0) {
    const cryptoData = await fetchCryptoBatch([...new Set(cryptoIds)]);
    for (const [sym, cgId] of Object.entries(cryptoSymToId)) {
      const d = cryptoData[cgId];
      if (!d) continue;
      try {
        await pricesRef.child(sym).update({
          price: d.price,
          percent: d.percent,
          updatedAt: Date.now(),
        });
      } catch (e) {
        console.warn(`[crypto] write ${sym} failed:`, e.message);
      }
    }
  }

  // ----- Stocks: one call each, throttled -----
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

// ---------- Watchlist removal cleanup ----------
watchlistRef.on('child_removed', (snap) => {
  pricesRef.child(snap.key).remove().catch(() => {});
});

// ---------- Boot ----------
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

console.log('🚀 WorldVest Updater Running (polling, 15s interval)');
loop();
