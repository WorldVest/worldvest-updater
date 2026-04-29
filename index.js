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

// In-memory caches so we don't pound Firebase on every WS tick
const cryptoPrevClose = {};   // {symbol: {price, date}}
const lastPercentWrite = {};  // {symbol: timestamp} — throttle percent writes

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WorldVest Price Updater is running...');
});
server.listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);
});

function isCrypto(symbol) { return symbol.includes(':'); }
function todayUTC() { return new Date().toISOString().slice(0,10); }

// ---------- Finnhub /quote (stocks only) ----------
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
  console.log(`[quote] refreshing ${symbols.filter(s => !isCrypto(s)).length} stock symbols`);
  for (const symbol of symbols) {
    if (isCrypto(symbol)) continue;
    const q = await fetchQuote(symbol);
    if (!q) continue;
    await pricesRef.child(symbol).update({
      price: q.price,
      percent: q.percent,
      prevClose: q.prevClose,
      updatedAt: Date.now(),
    });
    await new Promise(r => setTimeout(r, 1100));
  }
}

// ---------- Crypto prevClose seeding (once per UTC day, in memory) ----------
async function seedCryptoPrevClose(symbol, currentPrice) {
  if (!currentPrice || currentPrice <= 0) return;
  const today = todayUTC();
  const cached = cryptoPrevClose[symbol];
  if (cached && cached.date === today) return; // already seeded today

  // Try to read existing prevClose from Firebase first (so restarts don't reset)
  const snap = await pricesRef.child(symbol).once('value');
  const existing = snap.val() || {};
  if (existing.prevClose && existing.prevCloseDate === today) {
    cryptoPrevClose[symbol] = { price: existing.prevClose, date: today };
    console.log(`[crypto-seed] ${symbol} loaded existing prevClose=${existing.prevClose}`);
    return;
  }

  // First time today — anchor today's prevClose to current price
  cryptoPrevClose[symbol] = { price: currentPrice, date: today };
  await pricesRef.child(symbol).update({
    prevClose: currentPrice,
    prevCloseDate: today,
  });
  console.log(`[crypto-seed] ${symbol} new prevClose=${currentPrice}`);
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
    if (msg.type !== 'trade' || !msg.data) return;

    // Pick most recent trade per symbol within this batch
    const latest = {};
    msg.data.forEach(t => {
      if (!latest[t.s] || t.t > latest[t.s].t) latest[t.s] = t;
    });

    Object.values(latest).forEach(t => {
      const sym = t.s;
      const price = t.p;

      // Build the update for this tick
      const update = { price, updatedAt: Date.now() };

      // Crypto: compute percent in memory and include in this single write
      if (isCrypto(sym)) {
        const cached = cryptoPrevClose[sym];
        if (cached && cached.price > 0) {
          const pct = ((price - cached.price) / cached.price) * 100;
          // Throttle percent writes to once every 2s per symbol so we don't
          // spam Firebase / re-render the UI on every tick
          const now = Date.now();
          if (!lastPercentWrite[sym] || now - lastPercentWrite[sym] > 2000) {
            update.percent = pct;
            lastPercentWrite[sym] = now;
          }
        } else {
          // Not seeded yet — fire-and-forget seed; next tick will compute
          seedCryptoPrevClose(sym, price).catch(() => {});
        }
      }

      pricesRef.child(sym).update(update).catch(err => {
        console.warn(`[ws-write] ${sym} failed:`, err.message);
      });
    });
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
  delete cryptoPrevClose[symbol];
  delete lastPercentWrite[symbol];
  pricesRef.child(symbol).remove();
});

connectWebSocket();
setInterval(refreshAllQuotes, QUOTE_INTERVAL_MS);
setTimeout(refreshAllQuotes, 3000);

console.log('🚀 WorldVest Updater Running (WS + /quote)');
