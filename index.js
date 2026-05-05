/**
 * WorldVest server.
 *
 * Two responsibilities:
 *   1. Price updater — polls Finnhub (stocks) + CoinGecko (crypto) every
 *      30s and writes to /prices in Firebase.
 *   2. Agent proxy — exposes /agent endpoint so the browser can talk to
 *      Gemini without ever seeing the API key. Tool calls (get_watchlist,
 *      get_price, etc.) execute here, server-side, with access to Firebase
 *      and Finnhub.
 *
 * Required env vars on Render:
 *   FIREBASE_SERVICE_ACCOUNT  (Firebase admin credentials, JSON)
 *   FINNHUB_KEY               (Finnhub API key)
 *   COINGECKO_KEY             (CoinGecko Demo key, recommended)
 *   GEMINI_API_KEY            (Gemini API key, NEW for agent)
 *   ALLOWED_ORIGIN            (Optional, defaults to https://worldvest.xyz)
 */

import admin from 'firebase-admin';
import http from 'http';
import { GoogleGenerativeAI } from '@google/generative-ai';

const FINNHUB_KEY = process.env.FINNHUB_KEY || "d7ok9vhr01qsb7bf9bdgd7ok9vhr01qsb7bf9be0";
const COINGECKO_KEY = process.env.COINGECKO_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://worldvest.xyz";

const POLL_INTERVAL_MS = 30 * 1000;
const STOCK_RATE_LIMIT_MS = 1100;
const FETCH_TIMEOUT_MS = 12 * 1000;
const CYCLE_TIMEOUT_MS = 5 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 60 * 1000;
const WATCHDOG_DEADLINE_MS = 10 * 60 * 1000;

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://watchlist-d9ade-default-rtdb.firebaseio.com"
});

const db = admin.database();
const watchlistRef = db.ref('watchlist');
const pricesRef = db.ref('prices');

let lastCycleCompletedAt = Date.now();
let cycleCount = 0;
let agentCallCount = 0;

process.on('uncaughtException', (err) => console.error('💥 uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('💥 unhandledRejection:', reason));

// ============ Gemini setup ============
let gemini = null;
if (GEMINI_API_KEY) {
  gemini = new GoogleGenerativeAI(GEMINI_API_KEY);
}

const SYSTEM_PROMPT = `You are WORLDVEST AGENT, a friendly and knowledgeable finance assistant for a small group of friends and family who track stocks and crypto together.

Your style:
- Conversational and direct, not academic
- Use plain English; explain jargon when it comes up
- Concise by default — one or two paragraphs unless they ask for depth
- Use real numbers from your tools, never make up prices, percentages, or stats
- Reference the user's actual watchlist when relevant ("you're tracking AAPL...")

Hard rules:
- NEVER give specific buy/sell advice. If asked "should I buy X?", explain factors to consider but don't recommend an action.
- If you don't have data, say so. Don't guess or fabricate.
- Use your tools to fetch live data — don't rely on memory for current prices, breaking news, or recent events.
- If a question isn't finance/markets-related, you can still answer it briefly and steer back to markets.

When using tools:
- For "how's my watchlist doing", call get_watchlist
- For "what's [TICKER] at" or "how's NVDA today", call get_price
- For "what's happening in markets" or "any news today", call get_market_news
- For news about a specific company, call get_stock_news

Format prices like $123.45, percentages with sign like +2.34% or -1.12%.`;

const TOOLS = [{
  functionDeclarations: [
    {
      name: "get_watchlist",
      description: "Get the list of all stocks and crypto currently being tracked on the WorldVest watchlist, including their current price and 1-day percent change.",
      parameters: { type: "OBJECT", properties: {} }
    },
    {
      name: "get_price",
      description: "Get the current price and 1-day percent change for a specific stock ticker. Use for stocks already on the watchlist or any other US stock symbol.",
      parameters: {
        type: "OBJECT",
        properties: {
          symbol: { type: "STRING", description: "The stock ticker symbol, e.g. AAPL, NVDA, TSLA" }
        },
        required: ["symbol"]
      }
    },
    {
      name: "get_market_news",
      description: "Get the latest general market news headlines from major financial sources.",
      parameters: {
        type: "OBJECT",
        properties: {
          count: { type: "NUMBER", description: "Number of headlines to return (default 5, max 10)" }
        }
      }
    },
    {
      name: "get_stock_news",
      description: "Get the latest news headlines for a specific stock ticker.",
      parameters: {
        type: "OBJECT",
        properties: {
          symbol: { type: "STRING", description: "The stock ticker symbol" },
          count: { type: "NUMBER", description: "Number of headlines to return (default 3, max 5)" }
        },
        required: ["symbol"]
      }
    }
  ]
}];

// ---------- Tool implementations (server-side) ----------
function isCrypto(symbol) {
  return symbol.startsWith('CG:') || symbol.includes(':');
}
function prettySym(symbol) {
  if (symbol.startsWith('CG:')) return symbol.slice(3).toUpperCase();
  if (symbol.includes(':')) {
    const pair = symbol.split(':')[1] || '';
    return pair.replace(/USDT$|USD$|USDC$|BUSD$/i, '');
  }
  return symbol;
}

async function tool_get_watchlist() {
  const [wlSnap, prSnap] = await Promise.all([
    watchlistRef.once('value'),
    pricesRef.once('value'),
  ]);
  const watchlist = wlSnap.val() || {};
  const prices = prSnap.val() || {};
  const items = Object.keys(watchlist).map(sym => {
    const w = watchlist[sym] || {};
    const p = prices[sym] || {};
    return {
      symbol: prettySym(sym),
      name: w.name || '',
      type: isCrypto(sym) ? 'crypto' : 'stock',
      price: p.price ?? null,
      percent_change_1d: p.percent ?? null,
    };
  });
  return { count: items.length, items };
}

async function tool_get_price({ symbol }) {
  if (!symbol) return { error: "symbol required" };
  const sym = String(symbol).toUpperCase();
  const snap = await pricesRef.child(sym).once('value');
  const cached = snap.val();
  if (cached && cached.price) {
    return {
      symbol: sym,
      price: cached.price,
      percent_change_1d: cached.percent ?? null,
      source: "watchlist"
    };
  }
  try {
    const res = await fetchWithTimeout(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`);
    const q = await res.json();
    if (!q || (q.c === 0 && q.pc === 0)) {
      return { error: `No data found for ${sym}. It may not be a valid US stock ticker.` };
    }
    return {
      symbol: sym,
      price: Number(q.c),
      percent_change_1d: Number(q.dp),
      prev_close: Number(q.pc),
      day_high: Number(q.h),
      day_low: Number(q.l),
      source: "finnhub_live"
    };
  } catch (e) {
    return { error: "Failed to fetch price: " + e.message };
  }
}

async function tool_get_market_news({ count = 5 } = {}) {
  const n = Math.max(1, Math.min(10, Number(count) || 5));
  try {
    const res = await fetchWithTimeout(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`);
    const items = await res.json();
    const top = (items || [])
      .filter(it => it.headline)
      .slice(0, n)
      .map(it => ({
        headline: it.headline,
        source: it.source,
        summary: (it.summary || '').slice(0, 300),
        published_minutes_ago: it.datetime ? Math.floor((Date.now()/1000 - it.datetime) / 60) : null,
        url: it.url
      }));
    return { count: top.length, headlines: top };
  } catch (e) {
    return { error: "Failed to fetch news: " + e.message };
  }
}

async function tool_get_stock_news({ symbol, count = 3 } = {}) {
  if (!symbol) return { error: "symbol required" };
  const n = Math.max(1, Math.min(5, Number(count) || 3));
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0,10);
  try {
    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fmt(weekAgo)}&to=${fmt(today)}&token=${FINNHUB_KEY}`;
    const res = await fetchWithTimeout(url);
    const items = await res.json();
    const top = (items || [])
      .filter(it => it.headline)
      .sort((a,b) => (b.datetime||0) - (a.datetime||0))
      .slice(0, n)
      .map(it => ({
        headline: it.headline,
        source: it.source,
        summary: (it.summary || '').slice(0, 300),
        published_hours_ago: it.datetime ? Math.floor((Date.now()/1000 - it.datetime) / 3600) : null,
        url: it.url
      }));
    return { symbol, count: top.length, headlines: top };
  } catch (e) {
    return { error: "Failed to fetch stock news: " + e.message };
  }
}

const TOOL_FUNCTIONS = {
  get_watchlist: tool_get_watchlist,
  get_price: tool_get_price,
  get_market_news: tool_get_market_news,
  get_stock_news: tool_get_stock_news,
};

// ---------- Agent turn handler ----------
async function handleAgentTurn(history, userText) {
  if (!gemini) {
    throw new Error("Gemini not configured (missing GEMINI_API_KEY)");
  }
  const model = gemini.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT,
    tools: TOOLS,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  });

  // Convert client conversation history to SDK shape and start chat
  const chat = model.startChat({ history });

  let result = await chat.sendMessage(userText);
  const toolsCalled = [];
  let safetyLoopCounter = 0;

  while (safetyLoopCounter++ < 6) {
    const response = result.response;
    const fnCalls = response.functionCalls?.() || [];

    if (fnCalls.length === 0) {
      // Final text answer
      const text = response.text();
      return { text: text || '(No response from agent.)', tools: toolsCalled };
    }

    // Execute each tool
    const fnResponses = [];
    for (const call of fnCalls) {
      toolsCalled.push(call.name);
      let toolResult;
      try {
        const fn = TOOL_FUNCTIONS[call.name];
        toolResult = fn ? await fn(call.args || {}) : { error: `Unknown tool: ${call.name}` };
      } catch (e) {
        toolResult = { error: e.message };
      }
      fnResponses.push({
        functionResponse: { name: call.name, response: { result: toolResult } }
      });
    }

    // Send all tool results back to the model in one message
    result = await chat.sendMessage(fnResponses);
  }

  return { text: '(Agent stopped after too many tool calls. Try a simpler question.)', tools: toolsCalled };
}

// ============ HTTP server (keepalive + agent endpoint) ============
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Status / keepalive
  if (req.method === 'GET' && (req.url === '/status' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      cycleCount,
      agentCallCount,
      lastCycleAgoSec: Math.floor((Date.now() - lastCycleCompletedAt) / 1000),
      geminiConfigured: !!gemini,
    }));
    return;
  }

  // Agent endpoint
  if (req.method === 'POST' && req.url === '/agent') {
    try {
      if (!gemini) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Agent not configured. Set GEMINI_API_KEY in Render env vars." }));
        return;
      }
      const body = await readJsonBody(req);
      const { history = [], message = '' } = body;
      if (!message || typeof message !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "message (string) is required" }));
        return;
      }
      // Cap history length defensively (client also caps, but trust nothing)
      const safeHistory = Array.isArray(history) ? history.slice(-40) : [];

      agentCallCount++;
      const result = await handleAgentTurn(safeHistory, message.slice(0, 4000));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: result.text, tools: result.tools }));
    } catch (e) {
      console.error('[agent] error:', e);
      const status = /quota|rate|429/i.test(e.message) ? 429 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Agent error' }));
    }
    return;
  }

  // Default
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WorldVest server running.');
});
server.listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);
});

// ============ PRICE UPDATER ============
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

const LEGACY_BASE_TO_CG = {
  btc:'bitcoin', eth:'ethereum', sol:'solana', xrp:'ripple', bnb:'binancecoin',
  ada:'cardano', doge:'dogecoin', avax:'avalanche-2', link:'chainlink',
  dot:'polkadot', matic:'matic-network', ltc:'litecoin', trx:'tron',
  bch:'bitcoin-cash', atom:'cosmos', near:'near', uni:'uniswap',
  xlm:'stellar', apt:'aptos', arb:'arbitrum', op:'optimism',
  inj:'injective-protocol', fil:'filecoin', sui:'sui', etc:'ethereum-classic',
  zec:'zcash',
};

function classify(symbol) {
  if (symbol.startsWith('CG:')) {
    return { kind: 'crypto', cgId: symbol.slice(3) };
  }
  if (symbol.includes(':')) {
    const pair = symbol.split(':')[1] || '';
    const base = pair.replace(/USDT$|USD$|USDC$|BUSD$/i, '').toLowerCase();
    return { kind: 'crypto', cgId: LEGACY_BASE_TO_CG[base] || null };
  }
  return { kind: 'stock' };
}

async function fetchStock(symbol) {
  try {
    const res = await fetchWithTimeout(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`
    );
    if (!res.ok) { console.warn(`[stock] ${symbol} HTTP ${res.status}`); return null; }
    const q = await res.json();
    if (!q || (q.c === 0 && q.pc === 0)) return null;
    return {
      price: Number(q.c ?? 0),
      percent: Number(q.dp ?? 0),
      prevClose: Number(q.pc ?? 0),
    };
  } catch (e) {
    console.warn(`[stock] ${symbol} failed:`, e.name === 'AbortError' ? 'timeout' : e.message);
    return null;
  }
}

async function fetchCryptoBatch(cgIds) {
  if (cgIds.length === 0) return {};
  const ids = [...new Set(cgIds)].join(',');
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&price_change_percentage=24h`;
  const headers = { 'Accept': 'application/json' };
  if (COINGECKO_KEY) headers['x-cg-demo-api-key'] = COINGECKO_KEY;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { headers });
      if (res.status === 429) {
        const wait = attempt * 2000;
        console.warn(`[crypto] 429 (attempt ${attempt}/3), waiting ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        console.warn(`[crypto] HTTP ${res.status}`);
        return {};
      }
      const data = await res.json();
      if (!Array.isArray(data)) return {};
      const out = {};
      for (const coin of data) {
        out[coin.id] = {
          price: Number(coin.current_price ?? 0),
          percent: Number(coin.price_change_percentage_24h ?? 0),
        };
      }
      console.log(`[crypto] got ${data.length} coins`);
      return out;
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'timeout' : e.message;
      console.warn(`[crypto] attempt ${attempt} failed: ${msg}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  return {};
}

async function pollCycleInner() {
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
  const cryptoIds = [];
  const cryptoSymToId = {};
  for (const sym of symbols) {
    const c = classify(sym);
    if (c.kind === 'stock') stocks.push(sym);
    else if (c.kind === 'crypto' && c.cgId) {
      cryptoIds.push(c.cgId);
      cryptoSymToId[sym] = c.cgId;
    }
  }

  console.log(`[cycle #${cycleCount + 1}] ${stocks.length} stocks, ${cryptoIds.length} crypto`);

  if (cryptoIds.length > 0) {
    const data = await fetchCryptoBatch(cryptoIds);
    let written = 0;
    for (const [sym, cgId] of Object.entries(cryptoSymToId)) {
      const d = data[cgId];
      if (!d) continue;
      try {
        await pricesRef.child(sym).update({
          price: d.price, percent: d.percent, updatedAt: Date.now(),
        });
        written++;
      } catch (e) {
        console.warn(`[crypto] write ${sym} failed:`, e.message);
      }
    }
    if (written > 0) console.log(`[crypto] wrote ${written}/${Object.keys(cryptoSymToId).length}`);
  }

  for (const sym of stocks) {
    const q = await fetchStock(sym);
    if (q) {
      try {
        await pricesRef.child(sym).update({
          price: q.price, percent: q.percent,
          prevClose: q.prevClose, updatedAt: Date.now(),
        });
      } catch (e) {
        console.warn(`[stock] write ${sym} failed:`, e.message);
      }
    }
    await new Promise(r => setTimeout(r, STOCK_RATE_LIMIT_MS));
  }
}

async function pollCycle() {
  await Promise.race([
    pollCycleInner(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('cycle timeout')), CYCLE_TIMEOUT_MS)
    ),
  ]);
}

watchlistRef.on('child_removed', (snap) => {
  pricesRef.child(snap.key).remove().catch(() => {});
});

setInterval(() => {
  const ageMs = Date.now() - lastCycleCompletedAt;
  if (ageMs > WATCHDOG_DEADLINE_MS) {
    console.error(`💀 watchdog: no cycle completed in ${Math.floor(ageMs / 1000)}s — exiting for restart`);
    process.exit(1);
  } else {
    console.log(`[watchdog] last cycle ${Math.floor(ageMs / 1000)}s ago, total cycles: ${cycleCount}, agent calls: ${agentCallCount}`);
  }
}, WATCHDOG_INTERVAL_MS);

async function loop() {
  while (true) {
    try {
      await pollCycle();
      lastCycleCompletedAt = Date.now();
      cycleCount++;
    } catch (e) {
      console.error('[loop] cycle failed:', e.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

console.log('🚀 WorldVest Server Running');
console.log(`   FINNHUB_KEY:    ${FINNHUB_KEY ? '✓ set' : '✗ MISSING'}`);
console.log(`   COINGECKO_KEY:  ${COINGECKO_KEY ? '✓ set (Demo, 30/min)' : '⚠ unset'}`);
console.log(`   GEMINI_API_KEY: ${GEMINI_API_KEY ? '✓ set' : '⚠ unset (agent disabled)'}`);
console.log(`   ALLOWED_ORIGIN: ${ALLOWED_ORIGIN}`);
console.log(`   POLL_INTERVAL:  ${POLL_INTERVAL_MS / 1000}s`);
loop();
