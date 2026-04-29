import admin from 'firebase-admin';
import WebSocket from 'ws';
import http from 'http';

const FINNHUB_KEY = process.env.FINNHUB_KEY || "d7ok9vhr01qsb7bf9bdgd7ok9vhr01qsb7bf9be0";
const QUOTE_INTERVAL_MS = 30 * 1000;
const WATCHDOG_INTERVAL_MS = 60 * 1000;     // check WS health every 60s
const STALE_THRESHOLD_MS = 90 * 1000;       // if no trades in 90s, force reconnect

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
let watchdogInterval = null;
let lastTradeAt = 0;
let lastPongAt = 0;
let wsConnectAttempts = 0;
let writeFailures = 0;

const cryptoPrevClose = {};
const lastPercentWrite = {};

// ---------- Process-wide error visibility ----------
process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 unhandledRejection:', reason);
});

// ---------- HTTP keepalive + status endpoint ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      wsState: ws ? ws.readyState : -1,
      subscribed: Array.from(subscribed),
      lastTradeAt: lastTradeAt ? new Date(lastTradeAt).toISOString() : null,
      lastTradeAgoSec: lastTradeAt ? Math.floor((Date.now() - lastTradeAt) / 1000) : null,
      lastPongAt: lastPongAt ? new Date(lastPongAt).toISOString() : null,
      wsConnectAttempts,
      writeFailures,
    }, null, 2));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WorldVest Price Updater is running. /status for diagnostics.');
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
  try {
    const snap = await watchlistRef.once('value');
    const list = snap.val() || {};
    const symbols = Object.keys(list).filter(s => !isCrypto(s));
    if (symbols.length === 0) return;
    console.log(`[quote] refreshing ${symbols.length} stock symbols`);
    for (const symbol of symbols) {
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
  } catch (e) {
    console.error('[quote] refresh cycle failed:', e.message);
  }
}

async function seedCryptoPrevClose(symbol, currentPrice) {
  if (!currentPrice || currentPrice <= 0) return;
  const today = todayUTC();
  const cached = cryptoPrevClose[symbol];
  if (cached && cached.date === today) return;
  try {
    const snap = await pricesRef.child(symbol).once('value');
    const existing = snap.val() || {};
    if (existing.prevClose && existing.prevCloseDate === today) {
      cryptoPrevClose[symbol] = { price: existing.prevClose, date: today };
      return;
    }
    cryptoPrevClose[symbol] = { price: currentPrice, date: today };
    await pricesRef.child(symbol).update({
      prevClose: currentPrice,
      prevCloseDate: today,
    });
    console.log(`[crypto-seed] ${symbol} new prevClose=${currentPrice}`);
  } catch (e) {
    console.warn(`[crypto-seed] ${symbol} failed:`, e.message);
  }
}

// ---------- WebSocket with hard reconnect ----------
function forceReconnect(reason) {
  console.warn(`🔄 forceReconnect: ${reason}`);
  try {
    if (ws) {
      ws.removeAllListeners();
      ws.terminate(); // hard kill, don't wait for close handshake
    }
  } catch (e) {
    console.warn('forceReconnect cleanup failed:', e.message);
  }
  ws = null;
  subscribed.clear();
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  setTimeout(connectWebSocket, 2000);
}

function connectWebSocket() {
  wsConnectAttempts++;
  console.log(`📡 WS connect attempt #${wsConnectAttempts}`);

  try {
    ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  } catch (e) {
    console.error('WS construction failed:', e.message);
    setTimeout(connectWebSocket, 5000);
    return;
  }

  ws.on('open', () => {
    console.log('✅ Connected to Finnhub WebSocket');
    lastTradeAt = Date.now(); // reset stale timer on connect
    lastPongAt = Date.now();
    subscribed.clear();
    subscribeToCurrentWatchlist();

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch (e) {
          console.warn('ping send failed:', e.message);
          forceReconnect('ping send failed');
        }
      }
    }, 25000);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'pong' || msg.type === 'ping') {
      lastPongAt = Date.now();
      return;
    }
    if (msg.type === 'error') {
      console.warn('WS error message from Finnhub:', JSON.stringify(msg));
      return;
    }
    if (msg.type !== 'trade' || !msg.data) return;

    lastTradeAt = Date.now();

    const latest = {};
    msg.data.forEach(t => {
      if (!latest[t.s] || t.t > latest[t.s].t) latest[t.s] = t;
    });

    Object.values(latest).forEach(t => {
      const sym = t.s;
      const price = t.p;
      const update = { price, updatedAt: Date.now() };

      if (isCrypto(sym)) {
        const cached = cryptoPrevClose[sym];
        if (cached && cached.price > 0) {
          const pct = ((price - cached.price) / cached.price) * 100;
          const now = Date.now();
          if (!lastPercentWrite[sym] || now - lastPercentWrite[sym] > 2000) {
            update.percent = pct;
            lastPercentWrite[sym] = now;
          }
        } else {
          seedCryptoPrevClose(sym, price).catch(() => {});
        }
      }

      pricesRef.child(sym).update(update).catch(err => {
        writeFailures++;
        console.warn(`[ws-write] ${sym} failed (#${writeFailures}):`, err.message);
      });
    });
  });

  ws.on('error', (err) => {
    console.warn('WS error event:', err.message);
  });

  ws.on('close', (code, reason) => {
    console.log(`WS closed: code=${code} reason=${reason || '(none)'}`);
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    setTimeout(connectWebSocket, 3000);
  });

  ws.on('unexpected-response', (req, res) => {
    console.warn(`WS unexpected-response: HTTP ${res.statusCode}`);
    forceReconnect(`HTTP ${res.statusCode}`);
  });
}

async function subscribeToCurrentWatchlist() {
  try {
    const snapshot = await watchlistRef.once('value');
    const list = snapshot.val() || {};
    Object.keys(list).forEach(symbol => {
      if (!subscribed.has(symbol) && ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'subscribe', symbol }));
          subscribed.add(symbol);
          console.log(`[ws] subscribed ${symbol}`);
        } catch (e) {
          console.warn(`subscribe ${symbol} failed:`, e.message);
        }
      }
    });
  } catch (e) {
    console.warn('subscribeToCurrentWatchlist failed:', e.message);
  }
}

watchlistRef.on('child_added', (snap) => {
  const symbol = snap.key;
  if (ws && ws.readyState === WebSocket.OPEN && !subscribed.has(symbol)) {
    try {
      ws.send(JSON.stringify({ type: 'subscribe', symbol }));
      subscribed.add(symbol);
      console.log(`[ws] subscribed ${symbol}`);
    } catch (e) {
      console.warn(`subscribe ${symbol} failed:`, e.message);
    }
    if (!isCrypto(symbol)) {
      fetchQuote(symbol).then(q => {
        if (q) {
          pricesRef.child(symbol).update({
            price: q.price, percent: q.percent,
            prevClose: q.prevClose, updatedAt: Date.now(),
          }).catch(e => console.warn(`initial quote write ${symbol}:`, e.message));
        }
      }).catch(e => console.warn(`fetchQuote ${symbol}:`, e.message));
    }
  }
});

watchlistRef.on('child_removed', (snap) => {
  const symbol = snap.key;
  if (ws && ws.readyState === WebSocket.OPEN && subscribed.has(symbol)) {
    try {
      ws.send(JSON.stringify({ type: 'unsubscribe', symbol }));
    } catch (e) { /* ignore */ }
    subscribed.delete(symbol);
  }
  delete cryptoPrevClose[symbol];
  delete lastPercentWrite[symbol];
  pricesRef.child(symbol).remove().catch(() => {});
});

// ---------- Watchdog: detect a silently dead WS ----------
function startWatchdog() {
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    const wsState = ws ? ws.readyState : -1;
    const tradeAgo = lastTradeAt ? Date.now() - lastTradeAt : Infinity;
    const pongAgo = lastPongAt ? Date.now() - lastPongAt : Infinity;

    console.log(`[watchdog] wsState=${wsState} tradeAgo=${Math.floor(tradeAgo/1000)}s pongAgo=${Math.floor(pongAgo/1000)}s subscribed=${subscribed.size}`);

    // If WS is supposedly open but no trades for too long, kill it
    if (wsState === WebSocket.OPEN && tradeAgo > STALE_THRESHOLD_MS && subscribed.size > 0) {
      forceReconnect(`no trades for ${Math.floor(tradeAgo/1000)}s`);
      return;
    }
    // If WS is in CLOSING/CLOSED state, force reconnect
    if (wsState === WebSocket.CLOSED || wsState === WebSocket.CLOSING) {
      forceReconnect(`ws state ${wsState}`);
    }
  }, WATCHDOG_INTERVAL_MS);
}

connectWebSocket();
startWatchdog();
setInterval(refreshAllQuotes, QUOTE_INTERVAL_MS);
setTimeout(refreshAllQuotes, 3000);

console.log('🚀 WorldVest Updater Running (WS + /quote + watchdog)');
