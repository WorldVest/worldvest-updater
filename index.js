import admin from 'firebase-admin';
import WebSocket from 'ws';
import http from 'http';

const FINNHUB_KEY = process.env.FINNHUB_KEY || "d7ok9vhr01qsb7bf9bdgd7ok9vhr01qsb7bf9be0";
const QUOTE_INTERVAL_MS = 30 * 1000;

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://watchlist-d9ade-default-rtdb.firebaseio.com"
});

const db = admin.database();
const watchlistRef = db.ref('watchlist');
const pricesRef = db.ref('prices');

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

function isCrypto(symbol) { return symbol.includes(':'); }

// ---------- Finnhub /quote (stocks only — gives us percent change) ----------
async function fetchQuote(symbol) {
  if (isCrypto(symbol)) return null;
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`
    );
    if (!res.ok) { console.warn(`[quote] ${symbol} HTTP ${res.status}`); return null; }
    const q = await res.json();
    if (!q || (q.c === 0 && q.pc === 0)) return null;
    return {
      price:     Number(q.c  ?? 0),
      percent:   Number(q.dp ?? 0),
      prevClose: Number(q.pc ?? 0),
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
    if (isCrypto(symbol)) continue;
    const q = await fetchQuote(symbol);
    if (!q) continue;
    const existing = (await pricesRef.child(symbol).once('value')).val() || {};
    const price = existing.price && existing.price > 0 ? existing.price : q.price;
    await pricesRef.child(symbol).update({
      price,
      percent: q.percent,
      prevClose: q.prevClose,
      updatedAt: Date.now(),
    });
    await new Promise(r => setTimeout(r, 1100));
  }
}

// For crypto: compute % change from yesterday's close at midnight UTC.
// We snapshot the price near midnight and store as `prevClose`. Then % is
// just (price - prevClose) / prevClose.
async function ensureCryptoPrevClose(symbol, currentPrice) {
  if (!currentPrice || currentPrice <= 0) return;
  const existing = (await pricesRef.child(symbol).once('value')).val() || {};
  const today = new Date().toISOString().slice(0,10);
  if (existing.prevCloseDate === today && existing.prevClose) return; // already set
  // First time we see this crypto today — anchor today's prevClose to current
  // price. Real prev close is tricky without a paid feed; this gives an
  // intra-day delta that's close enough for a watchlist.
  await pricesRef.child(symbol).update({
    prevClose: currentPrice,
    prevCloseDate: today,
  });
}

function recomputeCryptoPercent(symbol, price) {
  pricesRef.child(symbol).once('value').then(snap => {
    const v = snap.val() || {};
    if (v.prevClose && v.prevClose > 0) {
      const pct = ((price - v.prevClose) / v.prevClose) * 100;
      pricesRef.child(symbol).update({ percent: pct });
    }
  });
}

// ---------- WebSocket ----------
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
        if (isCrypto(t.s)) {
          ensureCryptoPrevClose(t.s, t.p).then(() => recomputeCryptoPercent(t.s, t.p));
        }
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
    if (!isCrypto(symbol)) {
      fetchQuote(symbol).then(q => {
        if (q) {
          pricesRef.child(symbol).update({
            price: q.price, percent: q.percent,
            prevClose: q.prevClose, updatedAt: Date.now(),
          });
        }
      });
    }
  }
});

watchlistRef.on('child_removed', (snap) => {
  const symbol = snap.key;
  if (ws && ws.readyState === WebSocket.OPEN && subscribed.has(symbol)) {
    ws.send(JSON.stringify({ type: 'unsubscribe', symbol }));
    subscribed.delete(symbol);
  }
  pricesRef.child(symbol).remove();
});

connectWebSocket();
setInterval(refreshAllQuotes, QUOTE_INTERVAL_MS);
setTimeout(refreshAllQuotes, 3000);

console.log('🚀 WorldVest Updater Running (WS + /quote)');
