// ============================================================================
// SCALPER ENGINE - 24/7 SERVER
// Runs the scanning/trading simulation continuously on the server.
// All visitors see the SAME state because it's read from Firebase, which
// only this server writes to.
// ============================================================================

const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

// ---------------------------------------------------------------------------
// FIREBASE SETUP
// Credentials come from an environment variable (set on Render), never from
// a committed file. FIREBASE_SERVICE_ACCOUNT should contain the *entire*
// contents of the downloaded JSON key, as a single-line string.
// FIREBASE_DB_URL is the https://xxx.firebaseio.com URL from your console.
// ---------------------------------------------------------------------------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();
const stateRef = db.ref('engineState');
const configRef = db.ref('botConfig');
const scannerRef = db.ref('scannerSnapshot');

// ---------------------------------------------------------------------------
// IN-MEMORY STATE (mirrors structure from the original front-end script)
// This is the working copy; we push snapshots of it to Firebase on change.
// ---------------------------------------------------------------------------
let botConfig = {
  maxConcurrentTrades: 4,
  defaultLeverage: 50,
  targetTimeframe: "1m",
  targetMode: "auto100",
  tpPercent: 2.0,
  slPercent: 0.6,
  isInitialized: false
};

let engineState = {
  isRunning: false,
  walletBalance: 10000.00,
  positions: [],
  tradeHistory: [],
  logs: [],
  bestTradesBatches: [],
  signalWeights: { emaTrendCross: 25, rsiMacdMomentum: 25, bollingerMeanReversion: 25, volumeVolatilityDelta: 25 },
  patternWeights: { threeBlackCrows: 20, threeWhiteSoldiers: 20, engulfingStructures: 20, doubleTopBottom: 20, headAndShoulders: 20 },
  strategyStats: {
    emaTrendCross: { wins: 0, total: 0 }, rsiMacdMomentum: { wins: 0, total: 0 }, bollingerMeanReversion: { wins: 0, total: 0 }, volumeVolatilityDelta: { wins: 0, total: 0 },
    threeBlackCrows: { wins: 0, total: 0 }, threeWhiteSoldiers: { wins: 0, total: 0 }, engulfingStructures: { wins: 0, total: 0 }, doubleTopBottom: { wins: 0, total: 0 }, headAndShoulders: { wins: 0, total: 0 }
  }
};

let tradeAssetWatchlist = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'AVAXUSDT', 'ADAUSDT'];
let fullSymbolUniverseLoaded = false;
let runtimeLivePrices = {};
let candleHistoryStore = {};
const MAX_SCAN_UNIVERSE_SIZE = 100;

let symbolCooldownMap = {};
const SYMBOL_COOLDOWN_MS = 3 * 60 * 1000;
const MIN_POSITION_HOLD_MS = 60 * 1000;

let backgroundScannerThread = null;
let symbolUniverseRefreshThread = null;
let priceTickThread = null;
let candleRefreshThread = null;
let lastScannerRowsPayload = { rows: [], scannedCount: 0, signalCount: 0 };

// ---------------------------------------------------------------------------
// LOAD PERSISTED STATE FROM FIREBASE ON BOOT (so a Render restart doesn't
// wipe progress — Render's free filesystem is ephemeral, but Firebase isn't)
// ---------------------------------------------------------------------------
async function loadPersistedStateOnBoot() {
  try {
    const [stateSnap, configSnap] = await Promise.all([stateRef.get(), configRef.get()]);
    if (configSnap.exists()) botConfig = { ...botConfig, ...configSnap.val() };
    if (stateSnap.exists()) {
      const loaded = stateSnap.val();
      engineState = {
        ...engineState,
        ...loaded,
        positions: loaded.positions || [],
        tradeHistory: loaded.tradeHistory || [],
        logs: loaded.logs || [],
        bestTradesBatches: loaded.bestTradesBatches || []
      };
    }
    console.log('[BOOT] Restored state from Firebase.');
  } catch (err) {
    console.warn('[BOOT] Could not load prior state, starting fresh.', err.message);
  }
}

function persistConfig() {
  configRef.set(botConfig).catch(err => console.error('Firebase config write failed:', err.message));
}

function persistState() {
  // Trim logs/history sent to Firebase to keep payload size sane
  const trimmed = {
    ...engineState,
    logs: engineState.logs.slice(0, 35),
    tradeHistory: engineState.tradeHistory.slice(0, 300)
  };
  stateRef.set(trimmed).catch(err => console.error('Firebase state write failed:', err.message));
}

function persistScannerSnapshot() {
  scannerRef.set(lastScannerRowsPayload).catch(err => console.error('Firebase scanner write failed:', err.message));
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
function pushTerminalLog(tag, info) {
  const time = new Date().toLocaleTimeString();
  engineState.logs.unshift({ time, tag, info });
  if (engineState.logs.length > 35) engineState.logs.pop();
  console.log(`[${time}] #${tag} ${info.replace(/<[^>]+>/g, '')}`);
}

// ---------------------------------------------------------------------------
// BINANCE DATA FETCHING
// ---------------------------------------------------------------------------
async function loadFullFuturesSymbolUniverse() {
  try {
    const response = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
    if (!response.ok) throw new Error("exchangeInfo fetch failed.");
    const data = await response.json();
    const liveUsdtPerpetuals = (data.symbols || [])
      .filter(s => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
      .map(s => s.symbol);

    if (liveUsdtPerpetuals.length > 0) {
      const majors = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
      const rest = liveUsdtPerpetuals.filter(s => !majors.includes(s));
      tradeAssetWatchlist = [...majors.filter(m => liveUsdtPerpetuals.includes(m)), ...rest].slice(0, MAX_SCAN_UNIVERSE_SIZE);
      fullSymbolUniverseLoaded = true;
      pushTerminalLog("UNIVERSE", `Loaded ${liveUsdtPerpetuals.length} live USDT-margined perpetual futures from Binance. Actively scanning top ${tradeAssetWatchlist.length} by priority.`);
    }
  } catch (err) {
    console.warn("Could not load full symbol universe, using fallback watchlist.", err.message);
    pushTerminalLog("UNIVERSE", "Could not reach Binance exchangeInfo endpoint. Falling back to a 7-coin default watchlist.");
  }
}

async function updateLivePricesFromPublicFuturesAPI() {
  try {
    const response = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
    if (!response.ok) throw new Error("API stream lag.");
    const data = await response.json();
    data.forEach(item => {
      if (tradeAssetWatchlist.includes(item.symbol)) {
        runtimeLivePrices[item.symbol] = parseFloat(item.price);
      }
    });
  } catch (err) { console.warn("Futures price feed delay.", err.message); }
}

async function refreshAllCandleHistories() {
  const interval = botConfig.targetTimeframe || '1m';
  for (let i = 0; i < tradeAssetWatchlist.length; i++) {
    const symbol = tradeAssetWatchlist[i];
    try {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=100`;
      const response = await fetch(url);
      if (!response.ok) continue;
      const raw = await response.json();
      candleHistoryStore[symbol] = raw.map(c => ({
        time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]),
        close: parseFloat(c[4]), volume: parseFloat(c[5])
      }));
    } catch (err) { /* skip symbol this cycle on failure, retried next refresh */ }
    if (i % 5 === 4) await new Promise(r => setTimeout(r, 150));
  }
}

// ---------------------------------------------------------------------------
// TECHNICAL INDICATOR MATH (unchanged from the original, real-data based)
// ---------------------------------------------------------------------------
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcMACD(closes) {
  if (closes.length < 26) return null;
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (ema12 === null || ema26 === null) return null;
  const macdLine = ema12 - ema26;
  const priorEma12 = calcEMA(closes.slice(0, -1), 12);
  const priorEma26 = calcEMA(closes.slice(0, -1), 26);
  const priorMacd = (priorEma12 !== null && priorEma26 !== null) ? priorEma12 - priorEma26 : macdLine;
  return { macd: macdLine, momentum: macdLine - priorMacd, signal: priorMacd };
}

function calcBollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { upper: mean + mult * stdDev, lower: mean - mult * stdDev, middle: mean };
}

function calcVolumeDelta(candles) {
  if (candles.length < 10) return null;
  const recentAvg = candles.slice(-5).reduce((a, c) => a + c.volume, 0) / 5;
  const priorAvg = candles.slice(-20, -5).reduce((a, c) => a + c.volume, 0) / 15;
  if (priorAvg === 0) return null;
  return recentAvg / priorAvg;
}

function detectCandlePatterns(candles) {
  const found = [];
  if (candles.length < 3) return found;
  const [c3, c2, c1] = candles.slice(-3);

  const isBearish = c => c.close < c.open;
  const isBullish = c => c.close > c.open;
  const bodySize = c => Math.abs(c.close - c.open);

  if (isBearish(c3) && isBearish(c2) && isBearish(c1) && c2.close < c3.close && c1.close < c2.close) {
    found.push('threeBlackCrows');
  }
  if (isBullish(c3) && isBullish(c2) && isBullish(c1) && c2.close > c3.close && c1.close > c2.close) {
    found.push('threeWhiteSoldiers');
  }
  if (isBullish(c1) && isBearish(c2) && c1.open <= c2.close && c1.close >= c2.open && bodySize(c1) > bodySize(c2)) {
    found.push('engulfingStructures');
  }
  if (isBearish(c1) && isBullish(c2) && c1.open >= c2.close && c1.close <= c2.open && bodySize(c1) > bodySize(c2)) {
    found.push('engulfingStructures');
  }
  const recent = candles.slice(-15);
  if (recent.length >= 10) {
    const highs = recent.map(c => c.high), lows = recent.map(c => c.low);
    const maxHigh = Math.max(...highs), minLow = Math.min(...lows);
    const peakCount = highs.filter(h => Math.abs(h - maxHigh) / maxHigh < 0.0015).length;
    const troughCount = lows.filter(l => Math.abs(l - minLow) / minLow < 0.0015).length;
    if (peakCount >= 2) found.push('doubleTopBottom');
    if (troughCount >= 2) found.push('doubleTopBottom');
  }
  if (recent.length >= 9) {
    const seg = recent.slice(-9);
    const left = Math.max(seg[0].high, seg[1].high, seg[2].high);
    const mid = Math.max(seg[3].high, seg[4].high, seg[5].high);
    const right = Math.max(seg[6].high, seg[7].high, seg[8].high);
    if (mid > left * 1.003 && mid > right * 1.003 && Math.abs(left - right) / left < 0.01) {
      found.push('headAndShoulders');
    }
  }
  return found;
}

function evaluateRealSignalsForSymbol(symbol) {
  const candles = candleHistoryStore[symbol];
  if (!candles || candles.length < 26) return null;

  const closes = candles.map(c => c.close);
  const lastClose = closes[closes.length - 1];

  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const rsi = calcRSI(closes, 14);
  const macdData = calcMACD(closes);
  const boll = calcBollinger(closes, 20, 2);
  const volRatio = calcVolumeDelta(candles);
  const patterns = detectCandlePatterns(candles);

  const activeSignals = [];
  let longVotes = 0, shortVotes = 0;

  if (ema9 !== null && ema21 !== null) {
    const emaCrossStrength = Math.abs(ema9 - ema21) / ema21;
    if (emaCrossStrength > 0.0005) {
      activeSignals.push('emaTrendCross');
      if (ema9 > ema21) longVotes++; else shortVotes++;
    }
  }
  if (rsi !== null && macdData !== null) {
    const rsiActionable = rsi < 40 || rsi > 60;
    const macdActionable = Math.abs(macdData.momentum) > 0;
    if (rsiActionable || (macdActionable && Math.abs(macdData.macd) > Math.abs(macdData.signal) * 0.1)) {
      activeSignals.push('rsiMacdMomentum');
      if (rsi < 40 && macdData.momentum > 0) longVotes += 1.5;
      else if (rsi > 60 && macdData.momentum < 0) shortVotes += 1.5;
      else if (macdData.momentum > 0) longVotes += 0.5;
      else shortVotes += 0.5;
    }
  }
  if (boll !== null) {
    const bandWidth = boll.upper - boll.lower;
    const pctFromMiddle = Math.abs(lastClose - boll.middle) / (bandWidth / 2);
    if (pctFromMiddle > 0.75) {
      activeSignals.push('bollingerMeanReversion');
      if (lastClose <= boll.lower) longVotes += 1.5;
      else if (lastClose >= boll.upper) shortVotes += 1.5;
      else if (lastClose < boll.middle) longVotes++;
      else shortVotes++;
    }
  }
  if (volRatio !== null && volRatio > 1.2) {
    activeSignals.push('volumeVolatilityDelta');
    const priorClose = closes[closes.length - 2];
    if (lastClose > priorClose) longVotes += 1.0; else shortVotes += 1.0;
  }

  const direction = longVotes >= shortVotes ? 'Long' : 'Short';
  return { activeSignals, patterns, direction, lastClose, longVotes, shortVotes };
}

// ---------------------------------------------------------------------------
// CORE SCAN / TRADE LOGIC
// ---------------------------------------------------------------------------
function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function allocatePositionLiabilityContract(symbol, side, entryPrice, signalsUsed, patternsUsed, totalAsymmetricScore) {
  if (engineState.positions.some(p => p.symbol === symbol)) return;

  const cooldownUntil = symbolCooldownMap[symbol];
  if (cooldownUntil && Date.now() < cooldownUntil) return;

  const cashAllocationPercentageMultiplier = 5.0;
  const marginSizeCalculated = engineState.walletBalance * (cashAllocationPercentageMultiplier / 100);
  const sizeNotional = marginSizeCalculated * botConfig.defaultLeverage;

  const varianceFactorTp = botConfig.tpPercent / 100;
  const varianceFactorSl = botConfig.slPercent / 100;

  const tpPrice = side === 'Long' ? entryPrice * (1 + varianceFactorTp) : entryPrice * (1 - varianceFactorTp);
  const slPrice = side === 'Long' ? entryPrice * (1 - varianceFactorSl) : entryPrice * (1 + varianceFactorSl);

  const openLiabilityPositionContractObject = {
    id: "SCALP-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    symbol, direction: side, leverage: botConfig.defaultLeverage,
    entryPrice, margin: parseFloat(marginSizeCalculated.toFixed(2)),
    notional: parseFloat(sizeNotional.toFixed(2)), quantity: parseFloat((sizeNotional / entryPrice).toFixed(4)),
    sl: parseFloat(slPrice.toPrecision(6)), tp: parseFloat(tpPrice.toPrecision(6)),
    signalsUsed, patternsUsed, scoreIndex: (totalAsymmetricScore * 100).toFixed(1),
    timestampStr: new Date().toLocaleTimeString(), dateString: new Date().toLocaleDateString(),
    openTimestampMs: Date.now(), openTimestampStr: new Date().toLocaleTimeString()
  };

  engineState.positions.push(openLiabilityPositionContractObject);
  pushTerminalLog("FAST_OPEN", `Dispatched Scalp Contract: ${symbol} ${side} x${botConfig.defaultLeverage}.`);
  persistState();
}

function backpropagateNeuralModifierWeights() {
  Object.keys(engineState.signalWeights).forEach(k => {
    const stats = engineState.strategyStats[k];
    if (stats.total > 0) {
      engineState.signalWeights[k] = parseFloat((10 + ((stats.wins / stats.total) * 40)).toFixed(2));
    }
  });
  Object.keys(engineState.patternWeights).forEach(k => {
    const stats = engineState.strategyStats[k];
    if (stats.total > 0) {
      engineState.patternWeights[k] = parseFloat((10 + ((stats.wins / stats.total) * 40)).toFixed(2));
    }
  });
}

function evaluateBestTradesMilestone() {
  const totalCompleted = engineState.tradeHistory.length;
  if (totalCompleted > 0 && totalCompleted % 20 === 0) {
    const alreadyCovered = engineState.bestTradesBatches.reduce((sum, b) => sum + b.tradesCovered, 0);
    if (totalCompleted > alreadyCovered) {
      generateBestTradesBatchReport(totalCompleted);
    }
  }
}

function generateBestTradesBatchReport(totalCompletedAtCheckpoint) {
  const batchTrades = engineState.tradeHistory.slice(0, 20);
  const indicatorTally = {};
  const patternTally = {};

  batchTrades.forEach(trade => {
    const snap = trade.snapshot;
    const won = trade.pnl > 0;
    (snap.signalsUsed || []).forEach(sig => {
      if (!indicatorTally[sig]) indicatorTally[sig] = { wins: 0, total: 0 };
      indicatorTally[sig].total++;
      if (won) indicatorTally[sig].wins++;
    });
    (snap.patternsUsed || []).forEach(pat => {
      if (!patternTally[pat]) patternTally[pat] = { wins: 0, total: 0 };
      patternTally[pat].total++;
      if (won) patternTally[pat].wins++;
    });
  });

  const rankByWinRate = (tally) => Object.keys(tally)
    .map(key => ({ key, wins: tally[key].wins, total: tally[key].total, winRate: tally[key].total > 0 ? (tally[key].wins / tally[key].total) * 100 : 0 }))
    .sort((a, b) => b.winRate - a.winRate || b.total - a.total);

  const rankedIndicators = rankByWinRate(indicatorTally);
  const rankedPatterns = rankByWinRate(patternTally);

  const batchWins = batchTrades.filter(t => t.pnl > 0).length;
  const batchPnl = batchTrades.reduce((sum, t) => sum + t.pnl, 0);

  const batchReport = {
    batchNumber: engineState.bestTradesBatches.length + 1,
    tradesCovered: totalCompletedAtCheckpoint,
    winRate: batchTrades.length > 0 ? (batchWins / batchTrades.length) * 100 : 0,
    netPnl: batchPnl,
    rankedIndicators,
    rankedPatterns,
    bestIndicator: rankedIndicators.length > 0 ? rankedIndicators[0].key : 'N/A',
    bestPattern: rankedPatterns.length > 0 ? rankedPatterns[0].key : 'N/A',
    generatedAt: new Date().toLocaleString()
  };

  engineState.bestTradesBatches.unshift(batchReport);
  pushTerminalLog("ANALYSIS", `20-trade checkpoint reached (Batch #${batchReport.batchNumber}). Best indicator: ${batchReport.bestIndicator.toUpperCase()}, best pattern: ${batchReport.bestPattern.toUpperCase()}.`);
}

function settleTerminatedContractPosition(targetContractUid, structuralExitReason, closurePriceValue) {
  const arrayLocationIndex = engineState.positions.findIndex(p => p.id === targetContractUid);
  if (arrayLocationIndex === -1) return;

  const positionInstance = engineState.positions[arrayLocationIndex];
  const settlementPrice = closurePriceValue || runtimeLivePrices[positionInstance.symbol] || positionInstance.entryPrice;

  const calculationTickDifferenceDelta = settlementPrice - positionInstance.entryPrice;
  let computedAbsoluteYieldResult = positionInstance.direction === 'Long' ? calculationTickDifferenceDelta * positionInstance.quantity : -calculationTickDifferenceDelta * positionInstance.quantity;

  computedAbsoluteYieldResult = computedAbsoluteYieldResult - (positionInstance.notional * 0.0006);
  engineState.walletBalance += computedAbsoluteYieldResult;

  const isProfitableOutcome = computedAbsoluteYieldResult > 0;

  positionInstance.signalsUsed.forEach(sigKey => {
    if (engineState.strategyStats[sigKey]) {
      engineState.strategyStats[sigKey].total++;
      if (isProfitableOutcome) engineState.strategyStats[sigKey].wins++;
    }
  });
  positionInstance.patternsUsed.forEach(patKey => {
    if (engineState.strategyStats[patKey]) {
      engineState.strategyStats[patKey].total++;
      if (isProfitableOutcome) engineState.strategyStats[patKey].wins++;
    }
  });

  backpropagateNeuralModifierWeights();

  const closeTimestampMs = Date.now();
  const openTimestampMs = positionInstance.openTimestampMs || closeTimestampMs;
  const durationMs = closeTimestampMs - openTimestampMs;

  const historyArchivePayload = {
    timestamp: new Date().toLocaleTimeString(),
    closeTimestampMs,
    openTimestampStr: positionInstance.openTimestampStr || positionInstance.timestampStr,
    openTimestampMs,
    durationStr: formatDuration(durationMs),
    durationMs,
    dateStr: positionInstance.dateString || new Date().toLocaleDateString(),
    symbol: positionInstance.symbol, direction: positionInstance.direction,
    pnl: computedAbsoluteYieldResult, volume: positionInstance.notional,
    margin: positionInstance.margin, leverage: positionInstance.leverage,
    entryPrice: positionInstance.entryPrice, exitPrice: settlementPrice,
    reason: structuralExitReason,
    snapshot: positionInstance
  };

  engineState.tradeHistory.unshift(historyArchivePayload);
  engineState.positions.splice(arrayLocationIndex, 1);

  symbolCooldownMap[positionInstance.symbol] = Date.now() + SYMBOL_COOLDOWN_MS;

  pushTerminalLog("SETTLEMENT", `Settle Complete: ${positionInstance.symbol}. Net yield output: ${computedAbsoluteYieldResult.toFixed(2)} USDT`);

  evaluateBestTradesMilestone();
  persistState();
}

function processActiveExposureRiskBoundaries() {
  for (let i = engineState.positions.length - 1; i >= 0; i--) {
    const positionObject = engineState.positions[i];
    const heldForMs = Date.now() - (positionObject.openTimestampMs || Date.now());
    if (heldForMs < MIN_POSITION_HOLD_MS) continue;

    const liveMarketMarkPriceTickValue = runtimeLivePrices[positionObject.symbol] || positionObject.entryPrice;

    let tradeBoundaryBreached = false;
    let terminationReasonString = "";

    if (positionObject.direction === 'Long') {
      if (liveMarketMarkPriceTickValue <= positionObject.sl) { tradeBoundaryBreached = true; terminationReasonString = "Stop-Loss Target Hit (Contained Micro Risk)"; }
      else if (liveMarketMarkPriceTickValue >= positionObject.tp) { tradeBoundaryBreached = true; terminationReasonString = "Take-Profit Target Hit (100% ROE Captured)"; }
    } else {
      if (liveMarketMarkPriceTickValue >= positionObject.sl) { tradeBoundaryBreached = true; terminationReasonString = "Stop-Loss Target Hit (Contained Micro Risk)"; }
      else if (liveMarketMarkPriceTickValue <= positionObject.tp) { tradeBoundaryBreached = true; terminationReasonString = "Take-Profit Target Hit (100% ROE Captured)"; }
    }

    if (tradeBoundaryBreached) {
      settleTerminatedContractPosition(positionObject.id, terminationReasonString, liveMarketMarkPriceTickValue);
    }
  }
}

function runAsymmetricScannerEvaluationCycle() {
  if (!engineState.isRunning) return;

  const rows = [];
  const metricIndicatorsKeys = Object.keys(engineState.signalWeights);
  let scannedCount = 0;
  let signalCount = 0;

  tradeAssetWatchlist.forEach(symbol => {
    const activeMarkValue = runtimeLivePrices[symbol] || 0.00;
    if (activeMarkValue === 0) return;

    const evaluation = evaluateRealSignalsForSymbol(symbol);
    if (!evaluation) return;

    scannedCount++;

    const { activeSignals, patterns: activePatterns, direction: biasDirection } = evaluation;
    if (activeSignals.length === 0 && activePatterns.length === 0) return;
    signalCount++;

    let totalPotentialIndicatorValue = 0; let runningIndicatorValueEarned = 0;
    metricIndicatorsKeys.forEach(k => {
      totalPotentialIndicatorValue += engineState.signalWeights[k];
      if (activeSignals.includes(k)) runningIndicatorValueEarned += engineState.signalWeights[k];
    });
    const indicatorsSubRatio = totalPotentialIndicatorValue > 0 ? (runningIndicatorValueEarned / totalPotentialIndicatorValue) : 0;

    const chartsPatternsKeys = Object.keys(engineState.patternWeights);
    let totalPotentialPatternValue = 0; let runningPatternValueEarned = 0;
    chartsPatternsKeys.forEach(k => {
      totalPotentialPatternValue += engineState.patternWeights[k];
      if (activePatterns.includes(k)) runningPatternValueEarned += engineState.patternWeights[k];
    });
    const patternsSubRatio = totalPotentialPatternValue > 0 ? (runningPatternValueEarned / totalPotentialPatternValue) : 0;

    const combinedWeightedConfluenceIndex = (indicatorsSubRatio * 0.80) + (patternsSubRatio * 0.20);

    const isOnCooldown = symbolCooldownMap[symbol] && Date.now() < symbolCooldownMap[symbol];
    const cooldownRemaining = isOnCooldown ? Math.ceil((symbolCooldownMap[symbol] - Date.now()) / 1000) : 0;

    rows.push({
      symbol, price: activeMarkValue,
      indicatorsLabel: activeSignals.length > 0 ? activeSignals.map(s => s.toUpperCase()).join(', ') : 'NONE',
      patternsLabel: activePatterns.length > 0 ? activePatterns.map(p => p.toUpperCase()).join(', ') : 'NONE',
      indicatorsPct: (indicatorsSubRatio * 80).toFixed(1),
      patternsPct: (patternsSubRatio * 20).toFixed(1),
      direction: biasDirection,
      score: (combinedWeightedConfluenceIndex * 100).toFixed(1),
      isOnCooldown, cooldownRemaining
    });

    if (!isOnCooldown && combinedWeightedConfluenceIndex >= 0.62 && engineState.positions.length < botConfig.maxConcurrentTrades) {
      allocatePositionLiabilityContract(symbol, biasDirection, activeMarkValue, activeSignals, activePatterns, combinedWeightedConfluenceIndex);
    }
  });

  lastScannerRowsPayload = { rows, scannedCount, signalCount };
  persistScannerSnapshot();
}

// ---------------------------------------------------------------------------
// ENGINE START / STOP CONTROL
// ---------------------------------------------------------------------------
function startEngineLoops() {
  if (backgroundScannerThread) return; // already running
  runAsymmetricScannerEvaluationCycle();
  backgroundScannerThread = setInterval(runAsymmetricScannerEvaluationCycle, 3000);
}

function stopEngineLoops() {
  if (backgroundScannerThread) {
    clearInterval(backgroundScannerThread);
    backgroundScannerThread = null;
  }
}

// ---------------------------------------------------------------------------
// EXPRESS APP
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint for UptimeRobot - keeps Render free instance awake
app.get('/health', (req, res) => res.status(200).send('OK'));

// Full state snapshot (viewer can also just use Firebase directly, but this
// is provided as a convenience / fallback)
app.get('/api/state', (req, res) => {
  res.json({ botConfig, engineState, scanner: lastScannerRowsPayload, watchlist: tradeAssetWatchlist });
});

app.post('/api/init', (req, res) => {
  const { maxConcurrentTrades, defaultLeverage, targetMode, manualTp, manualSl } = req.body;

  botConfig.maxConcurrentTrades = parseInt(maxConcurrentTrades) || 4;
  botConfig.defaultLeverage = parseInt(defaultLeverage) || 50;
  botConfig.targetTimeframe = "1m";
  botConfig.targetMode = targetMode || 'auto100';

  if (botConfig.targetMode === 'auto100') {
    const tp = 100 / botConfig.defaultLeverage;
    botConfig.tpPercent = tp;
    botConfig.slPercent = tp * 0.4;
  } else {
    botConfig.tpPercent = parseFloat(manualTp) || 0.4;
    botConfig.slPercent = parseFloat(manualSl) || 0.2;
  }

  botConfig.isInitialized = true;
  pushTerminalLog("FAST_BOOT", `High Frequency Engine configured. 1m micro targets locked: TP: ${botConfig.tpPercent.toFixed(2)}% | SL: ${botConfig.slPercent.toFixed(2)}%.`);
  persistConfig();
  persistState();
  res.json({ botConfig });
});

app.post('/api/toggle', (req, res) => {
  if (!botConfig.isInitialized) return res.status(400).json({ error: 'Engine not initialized yet.' });

  if (engineState.isRunning) {
    engineState.isRunning = false;
    stopEngineLoops();
    pushTerminalLog("CORE", "High velocity analysis modules paused.");
  } else {
    engineState.isRunning = true;
    pushTerminalLog("CORE", "Micro-scalp identification matrix deployed.");
    startEngineLoops();
  }
  persistConfig();
  persistState();
  res.json({ isRunning: engineState.isRunning });
});

app.post('/api/config/leverage', (req, res) => {
  const lev = parseInt(req.body.value);
  if (!lev || lev < 1 || lev > 125) return res.status(400).json({ error: 'Leverage must be 1-125.' });
  botConfig.defaultLeverage = lev;
  pushTerminalLog("CONFIG", `Leverage updated live to x${lev}.`);
  persistConfig();
  persistState();
  res.json({ ok: true });
});

app.post('/api/config/max-trades', (req, res) => {
  const max = parseInt(req.body.value);
  if (!max || max < 1 || max > 20) return res.status(400).json({ error: 'Max trades must be 1-20.' });
  botConfig.maxConcurrentTrades = max;
  pushTerminalLog("CONFIG", `Max concurrent open position limit updated live to ${max}.`);
  persistConfig();
  persistState();
  res.json({ ok: true });
});

app.post('/api/config/timeframe', async (req, res) => {
  const tf = req.body.value;
  botConfig.targetTimeframe = tf;
  pushTerminalLog("CONFIG", `Scan timeframe switched live to ${tf}. Re-fetching candle history...`);
  persistConfig();
  persistState();
  res.json({ ok: true });
  refreshAllCandleHistories().then(() => pushTerminalLog("CONFIG", `Candle history reloaded at ${tf}.`));
});

app.post('/api/position/:id/edit', (req, res) => {
  const { id } = req.params;
  const { tp, sl, leverage } = req.body;
  const targetPosition = engineState.positions.find(p => p.id === id);
  if (!targetPosition) return res.status(404).json({ error: 'Position not found.' });

  const newTp = parseFloat(tp), newSl = parseFloat(sl), newLev = parseInt(leverage);
  if (isNaN(newTp) || isNaN(newSl) || isNaN(newLev) || newLev < 1 || newLev > 125) {
    return res.status(400).json({ error: 'Invalid TP/SL/Leverage values.' });
  }
  if (targetPosition.direction === 'Long' && (newTp <= targetPosition.entryPrice || newSl >= targetPosition.entryPrice)) {
    return res.status(400).json({ error: 'For Long, TP must be above and SL below entry.' });
  }
  if (targetPosition.direction === 'Short' && (newTp >= targetPosition.entryPrice || newSl <= targetPosition.entryPrice)) {
    return res.status(400).json({ error: 'For Short, TP must be below and SL above entry.' });
  }

  targetPosition.tp = newTp;
  targetPosition.sl = newSl;
  if (newLev !== targetPosition.leverage) {
    targetPosition.leverage = newLev;
    targetPosition.notional = parseFloat((targetPosition.margin * newLev).toFixed(2));
    targetPosition.quantity = parseFloat((targetPosition.notional / targetPosition.entryPrice).toFixed(4));
  }

  pushTerminalLog("MANUAL_EDIT", `${targetPosition.symbol} updated -> TP: ${newTp}, SL: ${newSl}, Leverage: x${newLev}.`);
  persistState();
  res.json({ ok: true });
});

app.post('/api/position/:id/close', (req, res) => {
  const { id } = req.params;
  const targetPosition = engineState.positions.find(p => p.id === id);
  if (!targetPosition) return res.status(404).json({ error: 'Position not found.' });
  const currentPrice = runtimeLivePrices[targetPosition.symbol] || targetPosition.entryPrice;
  settleTerminatedContractPosition(id, 'Manual User Settle Request Initiated', currentPrice);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// BOOT SEQUENCE
// ---------------------------------------------------------------------------
async function boot() {
  await loadPersistedStateOnBoot();
  await loadFullFuturesSymbolUniverse();
  await updateLivePricesFromPublicFuturesAPI();
  await refreshAllCandleHistories();

  // If the engine was running before a restart, resume it automatically
  if (engineState.isRunning) {
    pushTerminalLog("RECOVERY", "Engine was running before restart — resuming scan loop automatically.");
    startEngineLoops();
  }

  // Real tick poll: refresh mark prices every 2s, check SL/TP boundaries
  priceTickThread = setInterval(async () => {
    await updateLivePricesFromPublicFuturesAPI();
    if (engineState.positions.length > 0) processActiveExposureRiskBoundaries();
  }, 2000);

  // Candle history refresh every 20s
  candleRefreshThread = setInterval(refreshAllCandleHistories, 20000);

  // Refresh symbol universe once an hour (catches new listings/delistings)
  symbolUniverseRefreshThread = setInterval(loadFullFuturesSymbolUniverse, 60 * 60 * 1000);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Scalper engine server listening on port ${PORT}`));
}

boot();
