import admin from 'firebase-admin';
import WebSocket from 'ws';
import http from 'http';

const FINNHUB_KEY = process.env.FINNHUB_KEY || "d7ok9vhr01qsb7bf9bdgd7ok9vhr01qsb7bf9be0";

// Cadence
const QUOTE_INTERVAL_MS = 30 * 1000;
const HISTORICAL_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Anchor for the "Mar 30" column
const ANCHOR_DATE = new Date(Date.UTC(2025, 2, 30)); // Mar 30, 2025

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://watchlist-d9ade-default-rtdb.firebaseio.com"
});

const db = admin.database();
const watchlistRef = db.ref('watchlist');
const pricesRef = db.ref('prices');
const historicalRef = db.ref('historical');

let ws = null;
let subscribed = new Set();
let heartbeatInterval = null;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WorldVest Price Updater is running...');
});
server.listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);
});

async function fetchQuote(symbol) {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`
    );
    if (!res.ok) { console.warn(`[quote] ${symbol} HTTP ${res.status}`); return null; }
    const q = await res.json();
    if (!q || (q.c === 0 && q.pc === 0)) return null;
    return {
      change:    Number(q.d  ?? 0),
      percent:   Number(q.dp ?? 0),
      high:      Number(q.h  ?? 0),
      low:       Number(q.l  ?? 0),
      open:      Number(q.o  ?? 0),
      prevClose: Number(q.pc ?? 0),
      restPrice: Number(q.c  ?? 0),
    };
  } catch (e) {
    console.warn(`[quote] ${symbol} failed:`, e.message);
    return null;
  }
}

async function refreshAllQuotes() {
  const snap = await watchlistRef.once('value');
  const list = snap.val() || {};
  const symbols = Object.keys(list);
  if (symbols.length === 0) return;
  console.log(`[quote] refreshing ${symbols.length} symbols`);
  for (const symbol of symbols) {
    const q = await fetchQuote(symbol);
    if (!q) continue;
    const existing = (await pricesRef.child(symbol).once('value')).val() || {};
    const price = existing.price && existing.price > 0 ? existing.price : q.restPrice;
    await pricesRef.child(symbol).update({
      price, change: q.change, percent: q.percent,
      high: q.high, low: q.low, open: q.open, prevClose: q.prevClose,
      updatedAt: Date.now(),
    });
    await new Promise(r => setTimeout(r, 1100));
  }
}

async function fetchCandleRange(symbol, fromTs, toTs) {
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${fromTs}&to=${toTs}&token=${FINNHUB_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 403) console.warn(`[candle] ${symbol} 403 — free plan likely blocks /stock/candle`);
      else console.warn(`[candle] ${symbol} HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data || data.s !== 'ok' || !Array.isArray(data.c) || data.c.length === 0) return null;
    return data;
  } catch (e) {
    console.warn(`[candle] ${symbol} failed:`, e.message);
    return null;
  }
}

function closeOnOrBefore(candles, targetTs) {
  if (!candles?.t?.length) return null;
  let best = null;
  for (let i = 0; i < candles.t.length; i++) {
    if (candles.t[i] <= targetTs) best = candles.c[i];
    else break;
  }
  return best;
}

async function refreshHistoricalForSymbol(symbol, currentPrice) {
  if (!currentPrice || currentPrice <= 0) return;
  const now = Math.floor(Date.now() / 1000);
  const yearAgo = now - 380 * 24 * 60 * 60;

  const candles = await fetchCandleRange(symbol, yearAgo, now);
  if (!candles) {
    await historicalRef.child(symbol).set({ available: false, updatedAt: Date.now() });
    return;
  }

  const oneMonthAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const price1M = closeOnOrBefore(candles, oneMonthAgo);

  const anchorTs = Math.floor(ANCHOR_DATE.getTime() / 1000);
  const priceAnchor = closeOnOrBefore(candles, anchorTs);

  const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const yearStartTs = Math.floor(yearStart.getTime() / 1000);
  const priceYTD = closeOnOrBefore(candles, yearStartTs);

  const yrLow = candles.l && candles.l.length
    ? Math.min(...candles.l.filter(v => v > 0))
    : null;

  const pct = (base) => base && base > 0 ? ((currentPrice - base) / base) * 100 : null;

  await historicalRef.child(symbol).set({
    available: true,
    pct1M: pct(price1M),
    pctAnchor: pct(priceAnchor),
    pctYTD: pct(priceYTD),
    yrLow: yrLow,
    anchorDate: ANCHOR_DATE.toISOString().slice(0,10),
    updatedAt: Date.now(),
  });
  console.log(`[hist] ${symbol} 1M=${pct(price1M)?.toFixed(2)}% YTD=${pct(priceYTD)?.toFixed(2)}% yrLow=${yrLow}`);
}

async function refreshAllHistorical() {
  const snap = await watchlistRef.once('value');
  const list = snap.val() || {};
  const symbols = Object.keys(list);
  if (symbols.length === 0) return;
  console.log(`[hist] refreshing ${symbols.length} symbols`);
  for (const symbol of symbols) {
    const priceSnap = await pricesRef.child(symbol).once('value');
    const cur = priceSnap.val()?.price;
    if (!cur) continue;
    await refreshHistoricalForSymbol(symbol, cur);
    await new Promise(r => setTimeout(r, 1500));
  }
}

function connectWebSocket() {
  if (ws) ws.close();
  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

  ws.on('open', () => {
    console.log('✅ Connected to Finnhub WebSocket');
    subscribed.clear();
    subscribeToCurrentWatchlist();
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25000);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'trade' && msg.data) {
      const latest = {};
      msg.data.forEach(t => { latest[t.s] = t; });
      Object.values(latest).forEach(t => {
        pricesRef.child(t.s).update({ price: t.p, updatedAt: Date.now() });
      });
    }
  });

  ws.on('error', (err) => console.warn('WS error:', err.message));
  ws.on('close', () => {
    console.log('Connection closed. Reconnecting in 5s...');
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    setTimeout(connectWebSocket, 5000);
  });
}

async function subscribeToCurrentWatchlist() {
  const snapshot = await watchlistRef.once('value');
  const list = snapshot.val() || {};
  Object.keys(list).forEach(symbol => {
    if (!subscribed.has(symbol) && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', symbol }));
      subscribed.add(symbol);
    }
  });
}

watchlistRef.on('child_added', (snap) => {
  const symbol = snap.key;
  if (ws && ws.readyState === WebSocket.OPEN && !subscribed.has(symbol)) {
    ws.send(JSON.stringify({ type: 'subscribe', symbol }));
    subscribed.add(symbol);
    console.log(`[ws] subscribed ${symbol}`);
    fetchQuote(symbol).then(async q => {
      if (q) {
        await pricesRef.child(symbol).update({
          price: q.restPrice, change: q.change, percent: q.percent,
          high: q.high, low: q.low, open: q.open, prevClose: q.prevClose,
          updatedAt: Date.now(),
        });
        await refreshHistoricalForSymbol(symbol, q.restPrice);
      }
    });
  }
});

watchlistRef.on('child_removed', (snap) => {
  const symbol = snap.key;
  if (ws && ws.readyState === WebSocket.OPEN && subscribed.has(symbol)) {
    ws.send(JSON.stringify({ type: 'unsubscribe', symbol }));
    subscribed.delete(symbol);
  }
  pricesRef.child(symbol).remove();
  historicalRef.child(symbol).remove();
});

connectWebSocket();
setInterval(refreshAllQuotes, QUOTE_INTERVAL_MS);
setInterval(refreshAllHistorical, HISTORICAL_INTERVAL_MS);
setTimeout(refreshAllQuotes, 3000);
setTimeout(refreshAllHistorical, 8000);

console.log('🚀 WorldVest Updater Running (WS + /quote + historical)');
