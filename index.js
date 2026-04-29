import admin from 'firebase-admin';
import WebSocket from 'ws';
import http from 'http';

const FINNHUB_KEY = process.env.FINNHUB_KEY || "d7ok9vhr01qsb7bf9bdgd7ok9vhr01qsb7bf9be0";

// How often to refresh full quote data (change, %, high, low, open, prevClose).
// Trade ticks from the WebSocket update price live; this fills in the rest.
const QUOTE_INTERVAL_MS = 30 * 1000; // 30s

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
let quoteInterval = null;

// ---------- HTTP keepalive (Render free Web Service) ----------
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WorldVest Price Updater is running...');
});
server.listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);
});

// ---------- REST /quote enrichment ----------
// Called periodically for every symbol in the watchlist. Updates fields the
// trade stream doesn't carry (change, percent, day high/low, open, prevClose).
async function fetchQuote(symbol) {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`
    );
    if (!res.ok) {
      console.warn(`[quote] ${symbol} HTTP ${res.status}`);
      return null;
    }
    const q = await res.json();
    // Finnhub returns zeros when a symbol is unknown / market closed forever
    if (!q || (q.c === 0 && q.pc === 0)) return null;
    return {
      change:    Number(q.d  ?? 0),
      percent:   Number(q.dp ?? 0),
      high:      Number(q.h  ?? 0),
      low:       Number(q.l  ?? 0),
      open:      Number(q.o  ?? 0),
      prevClose: Number(q.pc ?? 0),
      // Use REST 'c' as a price fallback in case WS hasn't ticked yet
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

    // Merge with whatever the WS has already written (don't overwrite live price)
    const existing = (await pricesRef.child(symbol).once('value')).val() || {};
    const price = existing.price && existing.price > 0 ? existing.price : q.restPrice;

    await pricesRef.child(symbol).update({
      price,
      change: q.change,
      percent: q.percent,
      high: q.high,
      low: q.low,
      open: q.open,
      prevClose: q.prevClose,
      updatedAt: Date.now(),
    });

    // Stay polite to Finnhub free tier (60/min)
    await new Promise(r => setTimeout(r, 1100));
  }
}

// ---------- WebSocket (real-time trade stream) ----------
function connectWebSocket() {
  if (ws) ws.close();

  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

  ws.on('open', () => {
    console.log('✅ Connected to Finnhub WebSocket');
    subscribed.clear();
    subscribeToCurrentWatchlist();

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'trade' && msg.data) {
      // Keep only the most recent trade per symbol in this batch
      const latest = {};
      msg.data.forEach(t => { latest[t.s] = t; });

      Object.values(latest).forEach(t => {
        // Merge so we don't wipe change/percent/etc. from the REST poll
        pricesRef.child(t.s).update({
          price: t.p,
          updatedAt: Date.now(),
        });
      });
    }
  });

  ws.on('error', (err) => {
    console.warn('WS error:', err.message);
  });

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

// React to watchlist changes
watchlistRef.on('child_added', (snap) => {
  const symbol = snap.key;
  if (ws && ws.readyState === WebSocket.OPEN && !subscribed.has(symbol)) {
    ws.send(JSON.stringify({ type: 'subscribe', symbol }));
    subscribed.add(symbol);
    console.log(`[ws] subscribed ${symbol}`);
    // Pull initial quote data immediately so the UI fills in fast
    fetchQuote(symbol).then(q => {
      if (q) {
        pricesRef.child(symbol).update({
          price: q.restPrice,
          change: q.change,
          percent: q.percent,
          high: q.high,
          low: q.low,
          open: q.open,
          prevClose: q.prevClose,
          updatedAt: Date.now(),
        });
      }
    });
  }
});

watchlistRef.on('child_removed', (snap) => {
  const symbol = snap.key;
  if (ws && ws.readyState === WebSocket.OPEN && subscribed.has(symbol)) {
    ws.send(JSON.stringify({ type: 'unsubscribe', symbol }));
    subscribed.delete(symbol);
    console.log(`[ws] unsubscribed ${symbol}`);
  }
  // Clean up the price entry so the UI removes the row cleanly
  pricesRef.child(symbol).remove();
});

// ---------- Boot ----------
connectWebSocket();

// Kick off the periodic REST poll
quoteInterval = setInterval(refreshAllQuotes, QUOTE_INTERVAL_MS);
// Run once immediately at startup
setTimeout(refreshAllQuotes, 3000);

console.log('🚀 WorldVest Updater Running (WebSocket + REST quote enrichment)');
