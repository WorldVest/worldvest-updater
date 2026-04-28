import admin from 'firebase-admin';
import WebSocket from 'ws';

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const firebaseConfig = { /* Paste your Firebase Admin config here later */ };

admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
  databaseURL: "https://watchlist-d9ade.firebaseio.com"
});

const db = admin.database();
const watchlistRef = db.ref('watchlist');
const pricesRef = db.ref('prices');

let ws = null;
let subscribed = new Set();

function connect() {
  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

  ws.on('open', () => {
    console.log('✅ Connected to Finnhub');
    subscribeToWatchlist();
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'trade') {
      msg.data.forEach(t => {
        pricesRef.child(t.s).set({
          price: t.p,
          timestamp: t.t
        });
      });
    }
  });

  ws.on('close', () => setTimeout(connect, 3000));
}

async function subscribeToWatchlist() {
  const snap = await watchlistRef.once('value');
  const list = snap.val() || {};

  Object.keys(list).forEach(symbol => {
    if (!subscribed.has(symbol)) {
      ws.send(JSON.stringify({ type: 'subscribe', symbol: symbol }));
      subscribed.add(symbol);
    }
  });
}

// Auto subscribe when someone adds a stock
watchlistRef.on('child_added', (snap) => {
  const symbol = snap.key;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', symbol }));
    subscribed.add(symbol);
  }
});

connect();
console.log('🚀 WorldVest Price Updater Running...');
