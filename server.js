const express = require('express');
const path = require('path');
const axios = require('axios');
const admin = require('firebase-admin');

// --- FIREBASE SETUP ---
function loadServiceAccountFromEnv() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = [
    process.env.FIREBASE_PRIVATE_KEY_PART1,
    process.env.FIREBASE_PRIVATE_KEY_PART2
  ].filter(Boolean).join('');

  return {
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, '\n')
  };
}

const serviceAccount = loadServiceAccountFromEnv();
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();
const stateRef = db.ref('engineState');
const configRef = db.ref('botConfig');
const scannerRef = db.ref('scannerSnapshot');

// --- STATE INITIALIZATION ---
let botConfig = { maxConcurrentTrades: 4, defaultLeverage: 50, targetTimeframe: "1m", targetMode: "auto100", tpPercent: 2.0, slPercent: 0.6, isInitialized: false };
let engineState = { isRunning: false, walletBalance: 10000.00, positions: [], tradeHistory: [], logs: [], bestTradesBatches: [], signalWeights: { emaTrendCross: 25, rsiMacdMomentum: 25, bollingerMeanReversion: 25, volumeVolatilityDelta: 25 }, strategyStats: {} };
let tradeAssetWatchlist = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
let runtimeLivePrices = {};
let candleHistoryStore = {};

// --- HELPER FUNCTIONS ---
async function updateLivePrices() {
  try {
    const { data } = await axios.get('https://api.binance.com/api/v3/ticker/price', { timeout: 3000 });
    data.forEach(item => {
      if (tradeAssetWatchlist.includes(item.symbol)) {
        runtimeLivePrices[item.symbol] = parseFloat(item.price);
      }
    });
  } catch (err) {
    console.error("Price fetch error:", err.message);
  }
}

async function refreshAllCandleHistories() {
  const interval = botConfig.targetTimeframe || '1m';
  for (const symbol of tradeAssetWatchlist) {
    try {
      const { data } = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`, { timeout: 3000 });
      candleHistoryStore[symbol] = data.map(c => ({ close: parseFloat(c[4]) }));
    } catch (err) { /* silent skip */ }
  }
}

// --- EXPRESS SERVER ---
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SYSTEM] Scalper engine listening on port ${PORT}`);
    // Start loops after server binds to port
    updateLivePrices();
    refreshAllCandleHistories();
});
