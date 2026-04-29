import admin from 'firebase-admin';
import WebSocket from 'ws';
import http from 'http';

const FINNHUB_KEY = "d7ok9vhr01qsb7bf9bdgd7ok9vhr01qsb7bf9be0";

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

// HTTP server for Render
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WorldVest Price Updater is running...');
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);
});

function connectWebSocket() {
  if (ws) ws.close();

  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

  ws.on('open', () => {
    console.log('✅ Connected to Finnhub WebSocket');
    subscribeToCurrentWatchlist();
    
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'trade' && msg.data) {
      msg.data.forEach(t => {
        pricesRef.child(t.s).set({
          price: t.p,
          timestamp: Date.now()
        });
      });
    }
  });

  ws.on('close', () => {
    console.log('Connection closed. Reconnecting...');
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    setTimeout(connectWebSocket, 5000);
  });
}

async function subscribeToCurrentWatchlist() {
  const snapshot = await watchlistRef.once('value');
  const list = snapshot.val() || {};
  Object.keys(list).forEach(symbol => {
    if (!subscribed.has(symbol)) {
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
  }
});

connectWebSocket();
console.log('🚀 WorldVest Updater Running...');
