/**
 * WorldVest price updater.
 *
 * Polls every POLL_INTERVAL_MS:
 *   - Stocks (e.g. "AAPL"): Finnhub /quote — one call per ticker, throttled
 *   - Crypto (e.g. "CG:bitcoin" or "BINANCE:BTCUSDT"): Binance /api/v3/ticker/24hr
 *     — one batched call for all coins at once, no key required
 *
 * Writes results to /prices/{SYMBOL} in Firebase.
 *
 * Coins not listed on Binance (e.g. HYPE/Hyperliquid) will show "—" in the UI.
 */

import admin from 'firebase-admin';
import http from 'http';

const FINNHUB_KEY = process.env.FINNHUB_KEY || "d7ok9vhr01qsb7bf9bdgd7ok9vhr01qsb7bf9be0";
const POLL_INTERVAL_MS = 15 * 1000;
const STOCK_RATE_LIMIT_MS = 1100; // Finnhub free tier: 60/min

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://watchlist-d9ade-default-rtdb.firebaseio.com"
});

const db = admin.database();
const watchlistRef = db.ref('watchlist');
const pricesRef = db.ref('prices');

// ---------- HTTP keepalive (Render Web Service requirement) ----------
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WorldVest Price Updater is running.');
}).listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);
});

// ---------- Symbol classification ----------
//   "AAPL"             → stock
//   "CG:bitcoin"       → crypto, base "BTC" → Binance "BTCUSDT"
//   "BINANCE:BTCUSDT"  → legacy crypto, already in Binance format
//
// CoinGecko ID → Binance base symbol mapping. CoinGecko IDs are slugs
// (e.g. "bitcoin", "ethereum"); Binance uses ticker symbols (BTC, ETH).
const CG_ID_TO_BINANCE_BASE = {
  bitcoin: 'BTC',         ethereum: 'ETH',          solana: 'SOL',
  ripple: 'XRP',          binancecoin: 'BNB',       cardano: 'ADA',
  dogecoin: 'DOGE',       'avalanche-2': 'AVAX',    chainlink: 'LINK',
  polkadot: 'DOT',        'matic-network': 'MATIC', litecoin: 'LTC',
  tron: 'TRX',            'bitcoin-cash': 'BCH',    cosmos: 'ATOM',
  near: 'NEAR',           uniswap: 'UNI',           stellar: 'XLM',
  aptos: 'APT',           arbitrum: 'ARB',          optimism: 'OP',
  'injective-protocol': 'INJ', filecoin: 'FIL',     sui: 'SUI',
  'ethereum-classic': 'ETC', zcash: 'ZEC',          monero: 'XMR',
  shiba: 'SHIB',          'shiba-inu': 'SHIB',      pepe: 'PEPE',
  toncoin: 'TON',         'the-open-network': 'TON', vechain: 'VET',
  algorand: 'ALGO',       hedera: 'HBAR',           render: 'RENDER',
  'render-token': 'RENDER', fantom: 'FTM',          sonic: 'S',
  internet: 'ICP',        'internet-computer': 'ICP',
  fetch: 'FET',           'fetch-ai': 'FET',        ondo: 'ONDO',
  jupiter: 'JUP',         'jupiter-exchange-solana': 'JUP',
  bonk: 'BONK',           celestia: 'TIA',          worldcoin: 'WLD',
  'worldcoin-wld': 'WLD', sei: 'SEI',               'sei-network': 'SEI',
  'kaspa': 'KAS',         'official-trump': 'TRUMP', 'pi-network': 'PI',
};

// Binance symbol → quote currency. Try USDT first (most liquid).
function classify(symbol) {
  if (symbol.startsWith('CG:')) {
    const cgId = symbol.slice(3).toLowerCase();
    const base = CG_ID_TO_BINANCE_BASE[cgId] || cgId.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return { kind: 'crypto', binanceSymbol: base + 'USDT' };
  }
  if (symbol.includes(':')) {
    // Legacy "BINANCE:BTCUSDT" format
    return { kind: 'crypto', binanceSymbol: symbol.split(':')[1] };
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

// ---------- Binance /api/v3/ticker/24hr (crypto, batched) ----------
async function fetchCryptoBatch(binanceSymbols) {
  if (binanceSymbols.length === 0) return {};

  // Binance accepts symbols as a JSON-encoded array in the query string.
  const symbolsParam = JSON.stringify([...new Set(binanceSymbols)]);
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      // Binance returns 400 if any symbol in the batch is invalid.
      // Fall back to per-symbol fetching so one bad coin doesn't kill all.
      if (res.status === 400) {
        console.warn('[crypto] batch had invalid symbols, falling back to per-symbol');
        return await fetchCryptoOneByOne(binanceSymbols);
      }
      console.warn(`[crypto] batch HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return {};
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      console.warn('[crypto] response not an array:', JSON.stringify(data).slice(0, 200));
      return {};
    }
    const out = {};
    for (const t of data) {
      out[t.symbol] = {
        price: Number(t.lastPrice ?? 0),
        percent: Number(t.priceChangePercent ?? 0),
      };
    }
    console.log(`[crypto] got ${Object.keys(out).length} tickers from Binance`);
    return out;
  } catch (e) {
    console.warn('[crypto] batch failed:', e.message);
    return {};
  }
}

// Fallback when batch fails due to one invalid symbol — fetch each separately,
// skipping any that 400. Keeps the rest of the watchlist working.
async function fetchCryptoOneByOne(binanceSymbols) {
  const out = {};
  for (const sym of binanceSymbols) {
    try {
      const res = await fetch(
        `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(sym)}`
      );
      if (!res.ok) {
        console.warn(`[crypto] ${sym} not on Binance (HTTP ${res.status})`);
        continue;
      }
      const t = await res.json();
      out[sym] = {
        price: Number(t.lastPrice ?? 0),
        percent: Number(t.priceChangePercent ?? 0),
      };
    } catch (e) {
      console.warn(`[crypto] ${sym} failed:`, e.message);
    }
  }
  return out;
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
  const cryptoSymToBinance = {}; // watchlist symbol → Binance symbol
  for (const sym of symbols) {
    const c = classify(sym);
    if (c.kind === 'stock') stocks.push(sym);
    else if (c.kind === 'crypto' && c.binanceSymbol) cryptoSymToBinance[sym] = c.binanceSymbol;
  }

  console.log(`[cycle] ${stocks.length} stocks, ${Object.keys(cryptoSymToBinance).length} crypto`);

  // ----- Crypto: one batched Binance call -----
  const cryptoSyms = Object.values(cryptoSymToBinance);
  if (cryptoSyms.length > 0) {
    const data = await fetchCryptoBatch(cryptoSyms);
    let written = 0;
    for (const [sym, binSym] of Object.entries(cryptoSymToBinance)) {
      const d = data[binSym];
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
    console.log(`[crypto] wrote ${written}/${cryptoSyms.length} prices`);
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

// ---------- Cleanup when a ticker is removed ----------
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

console.log('🚀 WorldVest Updater Running (Finnhub stocks + Binance crypto)');
console.log(`   FINNHUB_KEY: ${FINNHUB_KEY ? '✓ set' : '✗ MISSING'}`);
loop();
