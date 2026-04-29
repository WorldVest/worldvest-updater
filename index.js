import admin from 'firebase-admin';
import WebSocket from 'ws';

const FINNHUB_KEY = process.env.FINNHUB_KEY;

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://watchlist-d9ade-default-rtdb.firebaseio.com"
});

const db = admin.database();
const watchlistRef = db.ref('watchlist');
const pricesRef = db.ref('prices');

let ws = null;
let subscribed = new Set();

function connectWebSocket() {
  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

  ws.on('open', () => {
    console.log('✅ Connected to Finnhub WebSocket');
    subscribeToCurrentWatchlist();
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
    setTimeout(connectWebSocket, 5000);
  });
}

async function subscribeToCurrentWatchlist() {
  const snapshot = await watchlistRef.once('value');
  const list = snapshot.val() || {};
  Object.keys(list).forEach(symbol => {
    if (!subscribed.has(symbol)) {
      ws.send(JSON.stringify({ type: 'subscribe', symbol: symbol }));
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
console.log('🚀 WorldVest Updater started on Render');
