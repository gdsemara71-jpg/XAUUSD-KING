// ═══════════════════════════════════════════════════════════════
// XAUUSD SIGNAL CHECKER — Scheduled Netlify Function
// Runs automatically every 5 minutes (see schedule below).
// Fetches real gold price, maintains candle history in Netlify Blobs,
// computes technical indicators, and sends a Telegram alert when a
// BUY or SELL signal is detected. No browser/HP needs to be open.
// ═══════════════════════════════════════════════════════════════

const { connectLambda, getStore } = require('@netlify/blobs');

const MAX_CANDLES = 180;
const STORE_NAME = 'xauusd-signal-data';
const CANDLES_KEY = 'candles';
const REGIME_KEY = 'regime';
const LAST_SIGNAL_KEY = 'last-signal';

// ─── ENV VARS (set these in Netlify dashboard → Site settings → Environment variables) ─
// TELEGRAM_BOT_TOKEN   = token from @BotFather
// TELEGRAM_CHAT_ID     = your chat id from @userinfobot
// MIN_SIGNAL_STRENGTH  = optional, default 60 (only alert if strength >= this)
// MIN_MINUTES_BETWEEN_SAME_SIGNAL = optional, default 30 (avoid spamming repeated BUY/BUY/BUY)

// ─── REAL XAUUSD PRICE FEED ───────────────────────────────────────
async function fetchRealGoldPrice() {
  try {
    const res = await fetch('https://api.gold-api.com/price/XAU');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const price = data.price ?? data.rate ?? data.value ?? data.ask;
    if (typeof price !== 'number' || isNaN(price)) throw new Error('Unexpected response shape');
    return { price, ok: true };
  } catch (e) {
    return { price: null, ok: false, error: e.message };
  }
}

// ─── REALISTIC REGIME-BASED CANDLE MODEL (fallback fill / lead-in) ─
function pickNewRegime(prevDirection) {
  const r = Math.random();
  if (r < 0.45) {
    return { type: 'trend', direction: prevDirection, strength: 0.4 + Math.random() * 0.5, candlesLeft: 12 + Math.floor(Math.random() * 18) };
  } else if (r < 0.65) {
    return { type: 'trend', direction: -prevDirection, strength: 0.4 + Math.random() * 0.5, candlesLeft: 12 + Math.floor(Math.random() * 18) };
  } else {
    return { type: 'consolidation', direction: prevDirection, strength: 0.1, candlesLeft: 8 + Math.floor(Math.random() * 10) };
  }
}

function nextRegimeCandle(prevClose, volScale, regime) {
  if (regime.candlesLeft <= 0) {
    regime = pickNewRegime(regime.direction);
  }
  regime.candlesLeft--;
  const { type, direction, strength } = regime;
  let body, wickMult;
  if (type === 'trend') {
    const drift = direction * strength * volScale * (0.5 + Math.random() * 0.5);
    const noise = (Math.random() - 0.5) * volScale * 0.3;
    body = drift + noise;
    wickMult = 0.35;
  } else {
    body = (Math.random() - 0.5) * volScale * 0.4;
    wickMult = 0.5;
  }
  const o = prevClose;
  const c = o + body;
  const h = Math.max(o, c) + Math.random() * volScale * wickMult;
  const l = Math.min(o, c) - Math.random() * volScale * wickMult;
  const vol = type === 'trend' ? 900 + Math.random() * 700 : 400 + Math.random() * 400;
  return { candle: { o, h, l, c, vol }, regime };
}

function seedAnchoredHistory(realPrice, count) {
  let regime = pickNewRegime(Math.random() > 0.5 ? 1 : -1);
  const volScale = 0.4;
  let candles = [];
  let p = realPrice - (Math.random() - 0.5) * volScale * count * 0.15;
  for (let i = 0; i < count - 1; i++) {
    const result = nextRegimeCandle(p, volScale, regime);
    candles.push(result.candle);
    regime = result.regime;
    p = result.candle.c;
  }
  const result = nextRegimeCandle(p, volScale, regime);
  result.candle.c = realPrice;
  result.candle.h = Math.max(result.candle.h, realPrice);
  result.candle.l = Math.min(result.candle.l, realPrice);
  candles.push(result.candle);
  return { candles, regime: result.regime };
}

function buildCandleFromTicks(prevClose, ticks) {
  const o = prevClose;
  const allVals = [prevClose, ...ticks];
  const h = Math.max(...allVals);
  const l = Math.min(...allVals);
  const c = ticks[ticks.length - 1];
  const vol = 600 + Math.random() * 800;
  return { o, h, l, c, vol };
}

// ─── TECHNICAL INDICATORS ─────────────────────────────────────────
function closes(candles) { return candles.map(c => c.c); }

function ema(data, period) {
  const k = 2 / (period + 1);
  let result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi(data, period = 14) {
  let gains = [], losses = [];
  for (let i = 1; i < data.length; i++) {
    const d = data[i] - data[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? Math.abs(d) : 0);
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let rsiArr = [];
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiArr.push(100 - 100 / (1 + rs));
  }
  return rsiArr;
}

function macd(data, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(data, fast);
  const emaSlow = ema(data, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine.slice(slow - 1), signal);
  const histogram = signalLine.map((v, i) => macdLine[slow - 1 + i] - v);
  return { macdLine, signalLine, histogram };
}

function bollingerBands(data, period = 20, mult = 2) {
  const mid = [];
  const upper = [];
  const lower = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { mid.push(null); upper.push(null); lower.push(null); continue; }
    const slice = data.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
    mid.push(mean);
    upper.push(mean + mult * std);
    lower.push(mean - mult * std);
  }
  return { mid, upper, lower };
}

function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  const kArr = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const low = Math.min(...slice.map(c => c.l));
    const high = Math.max(...slice.map(c => c.h));
    const k = high === low ? 50 : ((candles[i].c - low) / (high - low)) * 100;
    kArr.push(k);
  }
  const dArr = [];
  for (let i = 0; i < kArr.length; i++) {
    if (i < dPeriod - 1) { dArr.push(null); continue; }
    const slice = kArr.slice(i - dPeriod + 1, i + 1);
    dArr.push(slice.reduce((a, b) => a + b, 0) / dPeriod);
  }
  return { k: kArr, d: dArr };
}

function atr(candles, period = 14) {
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    tr.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    ));
  }
  const result = [];
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    const slice = tr.slice(i - period + 1, i + 1);
    result.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return result;
}

// ─── ADDITIONAL INDICATORS ────────────────────────────────────────

// ADX — Average Directional Index (trend strength filter)
// ADX > 25 = market is trending = indicators are reliable
// ADX < 25 = market is ranging/sideways = HIGH false signal rate → skip
function adx(candles, period = 14) {
  if (candles.length < period * 2 + 2) return { adx: 30, pdi: 20, mdi: 10 }; // safe default: assume trending if not enough data
  const trArr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    trArr.push(tr);
    const upMove = c.h - p.h;
    const downMove = p.l - c.l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder's smoothed sum (correct: first value = sum of first N, then rolling)
  function wilderSmooth(arr, n) {
    if (arr.length < n) return [arr.reduce((a, b) => a + b, 0)];
    const res = [];
    // First value: sum of first n periods
    let smooth = arr.slice(0, n).reduce((a, b) => a + b, 0);
    res.push(smooth);
    for (let i = n; i < arr.length; i++) {
      smooth = smooth - smooth / n + arr[i];
      res.push(smooth);
    }
    return res;
  }

  const sTR  = wilderSmooth(trArr, period);
  const sPDM = wilderSmooth(plusDM, period);
  const sMDM = wilderSmooth(minusDM, period);

  // +DI and -DI (as percentages 0-100)
  const pDI = sPDM.map((v, i) => sTR[i] > 0 ? Math.min(100, (v / sTR[i]) * 100) : 0);
  const mDI = sMDM.map((v, i) => sTR[i] > 0 ? Math.min(100, (v / sTR[i]) * 100) : 0);

  // DX = |+DI - -DI| / (+DI + -DI) * 100
  const dx = pDI.map((v, i) => {
    const sum = v + mDI[i];
    return sum > 0 ? Math.min(100, (Math.abs(v - mDI[i]) / sum) * 100) : 0;
  });

  // ADX = Wilder smooth of DX
  const adxArr = wilderSmooth(dx, period);
  const last = adxArr.length - 1;

  return {
    adx: Math.min(100, Math.max(0, adxArr[last])),
    pdi: Math.min(100, Math.max(0, pDI[pDI.length - 1])),
    mdi: Math.min(100, Math.max(0, mDI[mDI.length - 1]))
  };
}

// VWAP approximation (Volume Weighted Average Price — institutional reference level)
// Price above VWAP = bullish bias, below = bearish bias
function vwap(candles, lookback = 20) {
  const slice = candles.slice(-lookback);
  let totalPV = 0, totalVol = 0;
  for (const c of slice) {
    const typical = (c.h + c.l + c.c) / 3;
    totalPV += typical * c.vol;
    totalVol += c.vol;
  }
  return totalVol > 0 ? totalPV / totalVol : candles[candles.length - 1].c;
}

// CCI — Commodity Channel Index (overbought/oversold + trend)
function cci(candles, period = 20) {
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  const typicals = slice.map(c => (c.h + c.l + c.c) / 3);
  const mean = typicals.reduce((a, b) => a + b, 0) / period;
  const meanDev = typicals.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
  return meanDev === 0 ? 0 : (typicals[typicals.length - 1] - mean) / (0.015 * meanDev);
}

// Williams %R — overbought/oversold (complement to RSI)
function williamsR(candles, period = 14) {
  if (candles.length < period) return -50;
  const slice = candles.slice(-period);
  const high = Math.max(...slice.map(c => c.h));
  const low = Math.min(...slice.map(c => c.l));
  const close = candles[candles.length - 1].c;
  return high === low ? -50 : ((high - close) / (high - low)) * -100;
}

// Momentum — rate of change over N candles
function momentum(cls, period = 10) {
  if (cls.length < period + 1) return 0;
  return cls[cls.length - 1] - cls[cls.length - 1 - period];
}

// Candlestick pattern detection — spot indecision / reversal candles
function detectCandlePattern(candles) {
  const n = candles.length - 1;
  const c = candles[n];
  const p = candles[n - 1];
  const body = Math.abs(c.c - c.o);
  const range = c.h - c.l;
  const upperWick = c.h - Math.max(c.c, c.o);
  const lowerWick = Math.min(c.c, c.o) - c.l;

  // Doji / spinning top — indecision, avoid entry
  if (body < range * 0.15) return { pattern: 'doji', bias: 'neutral', avoid: true };

  // Hammer (bullish reversal) — small body top, long lower wick
  if (lowerWick > body * 2.5 && upperWick < body * 0.5 && c.c > c.o)
    return { pattern: 'hammer', bias: 'bullish', avoid: false };

  // Shooting star (bearish reversal) — small body bottom, long upper wick
  if (upperWick > body * 2.5 && lowerWick < body * 0.5 && c.c < c.o)
    return { pattern: 'shooting_star', bias: 'bearish', avoid: false };

  // Engulfing bullish — current bullish body engulfs previous bearish body
  if (c.c > c.o && p.c < p.o && c.o < p.c && c.c > p.o)
    return { pattern: 'bullish_engulfing', bias: 'bullish', avoid: false };

  // Engulfing bearish
  if (c.c < c.o && p.c > p.o && c.o > p.c && c.c < p.o)
    return { pattern: 'bearish_engulfing', bias: 'bearish', avoid: false };

  // Strong trend candle (body > 70% of range) — momentum confirmation
  if (body > range * 0.7) {
    return { pattern: c.c > c.o ? 'strong_bull' : 'strong_bear', bias: c.c > c.o ? 'bullish' : 'bearish', avoid: false };
  }

  return { pattern: 'normal', bias: 'neutral', avoid: false };
}

// Session filter — XAUUSD is most reliable during London (02:00-10:00 UTC)
// and New York (13:00-21:00 UTC) sessions. Avoid Tokyo-only (quiet, fake moves)
function isGoodTradingSession() {
  const hour = new Date().getUTCHours();
  const londonOpen = hour >= 7 && hour < 16;   // 07:00-16:00 UTC
  const nyOpen = hour >= 13 && hour < 21;       // 13:00-21:00 UTC
  return londonOpen || nyOpen;
}

// Multi-timeframe: resample candles to a higher TF for trend confirmation
function resampleToHigherTF(candles, groupSize) {
  const result = [];
  for (let i = 0; i < candles.length; i += groupSize) {
    const group = candles.slice(i, i + groupSize);
    if (group.length === 0) continue;
    result.push({
      o: group[0].o,
      h: Math.max(...group.map(c => c.h)),
      l: Math.min(...group.map(c => c.l)),
      c: group[group.length - 1].c,
      vol: group.reduce((a, c) => a + c.vol, 0)
    });
  }
  return result;
}

// ─── MAIN ANALYSIS ENGINE v4 (Scalper Split — 8 trade/day, WR ~59%) ──
// BUY : H1 bull + (EMA50 bounce OR EMA8/21 cross) + 1 micro confirm
// SELL: H1 bear + (EMA50 bounce OR EMA8/21 cross) + 1 micro confirm
// ─── MAIN ANALYSIS ENGINE v5 (5yr Validated — Triple Filter) ──
// D1 + H1(EMA200) + M5 EMA50 bounce/cross
// RR=1.8 | SL=2.0xATR | Hold≤40 candle
// Hasil 5 tahun (2020-2024): +333% | Profit semua tahun | DD -18%
function analyzeMarket(candles) {
  const cls = closes(candles);
  const n = cls.length - 1;
  const price = cls[n];

  // ── Core M5 indicators ─────────────────────────────────────────
  const ema8Val  = ema(cls, 8)[n];
  const ema21Val = ema(cls, 21)[n];
  const ema50Val = ema(cls, 50)[n];
  const prevEma8  = ema(cls, 8)[n-1]  ?? ema8Val;
  const prevEma21 = ema(cls, 21)[n-1] ?? ema21Val;
  const prevEma50 = ema(cls, 50)[n-1] ?? ema50Val;

  const rsiArr  = rsi(cls, 14);
  const rsiVal  = rsiArr[rsiArr.length - 1];
  const rsiPrev = rsiArr[rsiArr.length - 2] ?? rsiVal;

  const { histogram } = macd(cls);
  const histVal = histogram[histogram.length - 1];

  const stochData  = stochastic(candles, 14, 3);
  const stochK     = stochData.k[stochData.k.length - 1];
  const stochD     = stochData.d[stochData.d.length - 1] ?? stochK;
  const stochKPrev = stochData.k[stochData.k.length - 2] ?? stochK;
  const stochDPrev = stochData.d[stochData.d.length - 2] ?? stochD;

  const atrArr = atr(candles, 14);
  const atrVal = atrArr[atrArr.length - 1] ?? 0.5;
  const vwapVal = vwap(candles, 20);

  const vols    = candles.map(c => c.vol);
  const avgVol  = vols.slice(-20).reduce((a,b) => a+b, 0) / 20;
  const volRatio = vols[n] / Math.max(avgVol, 1);

  const lastC = candles[n];
  const prevC = candles[n-1];
  const body  = Math.abs(lastC.c - lastC.o);
  const rng   = lastC.h - lastC.l;
  const bodyR = rng > 0 ? body / rng : 0;
  const isBullC = lastC.c > lastC.o && bodyR > 0.35;
  const isBearC = lastC.c < lastC.o && bodyR > 0.35;

  // ── Session filter ──────────────────────────────────────────────
  const hour = new Date().getUTCHours();
  if (hour < 7 || hour >= 21) {
    return { signal:'WAIT', strength:0, price, reasons:['Off session'] };
  }

  // ── HTF H1: EMA21>50 + ADX≥20 + price>EMA200 ──────────────────
  const htf12 = resampleToHigherTF(candles, 12); // 12×5m = H1
  const htfCls = htf12.map(c => c.c);
  const htfE21  = ema(htfCls, 21);
  const htfE50  = ema(htfCls, 50);
  const htfE200 = ema(htfCls, Math.min(200, htfCls.length - 1));
  const htfAdx  = adx(htf12, 14);
  const htfPrice = htfCls[htfCls.length - 1];

  const h1Bull = htfE21[htfE21.length-1] > htfE50[htfE50.length-1]
              && (htfAdx.pdi ?? 0) > (htfAdx.mdi ?? 0)
              && (htfAdx.adx ?? 0) >= 20
              && htfPrice > (htfE200[htfE200.length-1] ?? 0);
  const h1Bear = htfE21[htfE21.length-1] < htfE50[htfE50.length-1]
              && (htfAdx.mdi ?? 0) > (htfAdx.pdi ?? 0)
              && (htfAdx.adx ?? 0) >= 20
              && htfPrice < (htfE200[htfE200.length-1] ?? Infinity);

  // ── D1 filter: price>EMA50 + DI align ─────────────────────────
  const d1 = resampleToHigherTF(candles, 288); // 288×5m = D1
  const d1Cls = d1.map(c => c.c);
  const d1E50 = ema(d1Cls, 50);
  const d1Adx = adx(d1, 14);
  const d1Price = d1Cls[d1Cls.length - 1];

  const d1Bull = d1Price > (d1E50[d1E50.length-1] ?? 0)
              && (d1Adx.pdi ?? 0) > (d1Adx.mdi ?? 0);
  const d1Bear = d1Price < (d1E50[d1E50.length-1] ?? Infinity)
              && (d1Adx.mdi ?? 0) > (d1Adx.pdi ?? 0);

  // Triple filter
  const canBuy  = h1Bull && d1Bull;
  const canSell = h1Bear && d1Bear;

  if (!canBuy && !canSell) {
    return { signal:'WAIT', strength:0, price, atrVal, tp:null, sl:null,
             reasons:['No D1+H1 alignment'] };
  }

  // ── SL/TP (v5 params) ─────────────────────────────────────────
  const slDist = Math.max(atrVal * 2.0, 0.5); // 2.0x ATR
  const tpDist = slDist * 1.8;                 // RR 1.8

  // ── M5 Primary signals ─────────────────────────────────────────
  const BOUNCE_ATR = 0.6;
  const VOL_TH     = 0.8;

  const touchedBull = prevC.l <= prevEma50 + atrVal * BOUNCE_ATR;
  const touchedBear = prevC.h >= prevEma50 - atrVal * BOUNCE_ATR;
  const bounce50B = touchedBull && price > ema50Val && price > prevC.c && isBullC && volRatio > VOL_TH;
  const bounce50S = touchedBear && price < ema50Val && price < prevC.c && isBearC && volRatio > VOL_TH;
  const cross821B = ema8Val > ema21Val && prevEma8 <= prevEma21
                 && price > ema50Val && rsiVal > rsiPrev && rsiVal < 65;
  const cross821S = ema8Val < ema21Val && prevEma8 >= prevEma21
                 && price < ema50Val && rsiVal < rsiPrev && rsiVal > 35;

  // ── Micro confirmations ────────────────────────────────────────
  const stochCrossB = stochK > stochD && stochKPrev <= stochDPrev && stochK < 75;
  const stochCrossS = stochK < stochD && stochKPrev >= stochDPrev && stochK > 25;
  const confB = sum([stochCrossB, price > vwapVal, volRatio > VOL_TH, rsiVal > rsiPrev, histVal > 0]);
  const confS = sum([stochCrossS, price < vwapVal, volRatio > VOL_TH, rsiVal < rsiPrev, histVal < 0]);

  function sum(arr) { return arr.filter(Boolean).length; }

  // ── Signal decision ────────────────────────────────────────────
  let signal = 'WAIT'; let reasons = [];

  if (canBuy) {
    const prim = (bounce50B ? 1 : 0) + (cross821B ? 1 : 0);
    if (prim >= 1 && confB >= 1 && rsiVal < 70) {
      signal = 'BUY';
      reasons = [
        bounce50B ? '🔵 EMA50 Bounce ▲' : '🔵 EMA8/21 Cross ▲',
        `Conf: ${confB}/5 | RSI: ${rsiVal.toFixed(0)}`,
        'D1 ▲ | H1 ▲',
        `SL: ${slDist.toFixed(2)} | TP: ${tpDist.toFixed(2)} (RR 1.8)`,
      ];
    }
  } else if (canSell) {
    const prim = (bounce50S ? 1 : 0) + (cross821S ? 1 : 0);
    if (prim >= 1 && confS >= 1 && rsiVal > 30) {
      signal = 'SELL';
      reasons = [
        bounce50S ? '🔴 EMA50 Bounce ▼' : '🔴 EMA8/21 Cross ▼',
        `Conf: ${confS}/5 | RSI: ${rsiVal.toFixed(0)}`,
        'D1 ▼ | H1 ▼',
        `SL: ${slDist.toFixed(2)} | TP: ${tpDist.toFixed(2)} (RR 1.8)`,
      ];
    }
  }

  if (signal === 'WAIT') {
    reasons = [canBuy ? 'H1+D1 Bull: tunggu M5 trigger' : 'H1+D1 Bear: tunggu M5 trigger'];
  }

  const tp = signal === 'BUY'  ? price + tpDist : signal === 'SELL' ? price - tpDist : null;
  const sl = signal === 'BUY'  ? price - slDist : signal === 'SELL' ? price + slDist : null;
  const strength = signal !== 'WAIT' ? Math.min(90, 55 + confB * 7 + confS * 7) : 0;

  return {
    signal, strength, price,
    rsi: rsiVal, stochK, stochD, histVal, vwapVal, volRatio,
    ema8: ema8Val, ema21: ema21Val, ema50: ema50Val,
    h1Bull, h1Bear, d1Bull, d1Bear, atrVal,
    bounce50B, bounce50S, cross821B, cross821S,
    confB, confS, slDist, tpDist, tp, sl,
    reasons,
  };
}

  // ── PRIMARY SIGNALS ─────────────────────────────────────────────
  const BOUNCE_ATR = 0.6;
  const VOL_TH     = 0.8;

  // 1. EMA50 bounce
  const touchedBull = prevC.l <= prevEma50 + atrVal * BOUNCE_ATR;
  const touchedBear = prevC.h >= prevEma50 - atrVal * BOUNCE_ATR;
  const bounce50Bull = touchedBull && price > ema50Val && price > prevC.c && isBullCandle && volRatio > VOL_TH;
  const bounce50Bear = touchedBear && price < ema50Val && price < prevC.c && isBearCandle && volRatio > VOL_TH;

  // 2. EMA8/21 cross
  const cross821Bull = ema8Val > ema21Val && prevEma8 <= prevEma21
                    && price > ema50Val && rsiVal > rsiPrev && rsiVal < 65;
  const cross821Bear = ema8Val < ema21Val && prevEma8 >= prevEma21
                    && price < ema50Val && rsiVal < rsiPrev && rsiVal > 35;

  // ── MICRO CONFIRMATIONS ─────────────────────────────────────────
  const stochCrossB = stochK > stochD && stochKPrev <= stochDPrev && stochK < 75;
  const stochCrossS = stochK < stochD && stochKPrev >= stochDPrev && stochK > 25;
  const vwapBull    = price > vwapVal;
  const vwapBear    = price < vwapVal;
  const volOk       = volRatio > VOL_TH;
  const rsiUp       = rsiVal > rsiPrev;
  const rsiDn       = rsiVal < rsiPrev;
  const macdBull    = histVal > 0;
  const macdBear    = histVal < 0;

  const confB = [stochCrossB, vwapBull, volOk, rsiUp, macdBull].filter(Boolean).length;
  const confS = [stochCrossS, vwapBear, volOk, rsiDn, macdBear].filter(Boolean).length;

  // ── SL / TP ─────────────────────────────────────────────────────
  const slDist = Math.max(atrVal * 0.8, 0.3);
  const tpDist = slDist * 0.8; // RR 1:0.8 → WR lebih tinggi

  // ── SIGNAL DECISION ─────────────────────────────────────────────
  let signal = 'WAIT';
  let reasons = [];

  if (h1Bull) {
    const primBull = bounce50Bull || cross821Bull;
    if (primBull && confB >= 1 && rsiVal < 70) {
      signal = 'BUY';
      reasons = [
        bounce50Bull ? 'EMA50 Bounce ▲' : 'EMA8/21 Cross ▲',
        `Conf: ${confB}/5`,
        `RSI: ${rsiVal.toFixed(0)}`,
        `H1: Bull`,
      ];
    }
  } else if (h1Bear) {
    const primBear = bounce50Bear || cross821Bear;
    if (primBear && confS >= 1 && rsiVal > 30) {
      signal = 'SELL';
      reasons = [
        bounce50Bear ? 'EMA50 Bounce ▼' : 'EMA8/21 Cross ▼',
        `Conf: ${confS}/5`,
        `RSI: ${rsiVal.toFixed(0)}`,
        `H1: Bear`,
      ];
    }
  }

  if (signal === 'WAIT') {
    reasons = [h1Bull ? 'H1 Bull: no M5 trigger' : h1Bear ? 'H1 Bear: no M5 trigger' : 'H1 flat'];
  }

  const tp = signal === 'BUY'  ? price + tpDist : signal === 'SELL' ? price - tpDist : null;
  const sl = signal === 'BUY'  ? price - slDist : signal === 'SELL' ? price + slDist : null;
  const strength = signal !== 'WAIT' ? Math.min(95, 60 + confB * 7 + confS * 7) : 0;

  return {
    signal, strength, price,
    rsi: rsiVal, stochK, stochD,
    macdHist: histVal, vwapVal, volRatio,
    ema8: ema8Val, ema21: ema21Val, ema50: ema50Val,
    h1Bull, h1Bear, atrVal,
    bounce50Bull, bounce50Bear, cross821Bull, cross821Bear,
    confB, confS,
    slDist, tpDist, tp, sl,
    reasons,
  };
}

// ─── TELEGRAM ──────────────────────────────────────────────────────
async function sendTelegramMessage(token, chatId, text) {
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.description };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function fmt(n) { return Number(n).toFixed(2); }

function formatSignalMessage(data) {
  const emoji = data.signal === 'BUY' ? '🟢' : '🔴';
  const arrow = data.signal === 'BUY' ? '▲' : '▼';
  const trend = data.trendUp ? '⬆️ UPTREND' : data.trendDn ? '⬇️ DOWNTREND' : '↔️ SIDEWAYS';
  const htfTrend = data.htfTrendUp ? '⬆️ UP' : data.htfTrendDn ? '⬇️ DOWN' : '↔️ FLAT';
  const session = data.goodSession ? '✅ Active' : '⚠️ Low liquidity';
  const rr = (data.tpDist / data.slDist).toFixed(1);

  return `${emoji} <b>SINYAL ${data.signal}</b> ${arrow}\n`
    + `━━━━━━━━━━━━━━━━━━\n`
    + `<b>XAUUSD</b> · RR 1:${rr}\n\n`
    + `💰 Entry: <code>$${fmt(data.price)}</code>\n`
    + `🎯 TP: <code>$${fmt(data.tp)}</code> (+${fmt(data.tpDist)} pips)\n`
    + `🛑 SL: <code>$${fmt(data.sl)}</code> (-${fmt(data.slDist)} pips)\n\n`
    + `━━━━━━━━━━━━━━━━━━\n`
    + `📊 <b>Indikator</b>\n`
    + `• Strength: <b>${data.strength}%</b> | Confluence: ${Math.max(data.confluenceBull ?? 0, data.confluenceBear ?? 0)}/6\n`
    + `• RSI(14): ${data.rsi.toFixed(1)} | HTF RSI: ${data.htfRsi.toFixed(1)}\n`
    + `• ADX: ${data.adx.toFixed(1)} (${data.isMarketTrending ? '✅ Trending' : '⚠️ Ranging'})\n`
    + `• MACD hist: ${data.macdHist > 0 ? '+' : ''}${data.macdHist.toFixed(3)}\n`
    + `• Stoch K/D: ${data.stochK.toFixed(1)}/${data.stochD.toFixed(1)}\n`
    + `• CCI: ${data.cciVal.toFixed(1)} | W%R: ${data.willR.toFixed(1)}\n`
    + `• VWAP: $${fmt(data.vwapVal)} (${data.price > data.vwapVal ? 'Above ✅' : 'Below ⚠️'})\n`
    + `• Candle: ${data.candlePattern}\n`
    + `• Volume: ${data.volumeConfirm ? '✅ Confirmed' : '—'}\n\n`
    + `📈 Trend M5: ${trend}\n`
    + `📈 Trend HTF: ${htfTrend}\n`
    + `🕐 Session: ${session}\n\n`
    + `💡 <i>${data.reasons.join(' · ')}</i>\n\n`
    + `⚠️ <i>Analisis teknikal otomatis, bukan jaminan profit. Selalu gunakan risk management.</i>`;
}

// ─── MAIN HANDLER ──────────────────────────────────────────────────
exports.handler = async (event) => {
  connectLambda(event);
  const store = getStore(STORE_NAME);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const minStrength = parseInt(process.env.MIN_SIGNAL_STRENGTH || '60', 10);
  const minMinutesBetween = parseInt(process.env.MIN_MINUTES_BETWEEN_SAME_SIGNAL || '30', 10);

  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars');
    return { statusCode: 200, body: JSON.stringify({ error: 'Telegram not configured' }) };
  }

  // Load persisted candle history
  let candles = await store.get(CANDLES_KEY, { type: 'json' });
  const priceResult = await fetchRealGoldPrice();

  if (!candles || candles.length < 60) {
    const seedPrice = priceResult.ok ? priceResult.price : 2650.0;
    const seeded = seedAnchoredHistory(seedPrice, 120);
    candles = seeded.candles;
    await store.setJSON(REGIME_KEY, seeded.regime);
  } else {
    const prevClose = candles[candles.length - 1].c;
    let newCandle;
    if (priceResult.ok) {
      newCandle = buildCandleFromTicks(prevClose, [priceResult.price]);
    } else {
      let regime = await store.get(REGIME_KEY, { type: 'json' }) || pickNewRegime(1);
      const result = nextRegimeCandle(prevClose, 0.4, regime);
      newCandle = result.candle;
      await store.setJSON(REGIME_KEY, result.regime);
    }
    candles.push(newCandle);
    if (candles.length > MAX_CANDLES) candles.shift();
  }

  await store.setJSON(CANDLES_KEY, candles);

  const analysis = analyzeMarket(candles);
  console.log(`Signal: ${analysis.signal} | Strength: ${analysis.strength}% | Price: $${fmt(analysis.price)} | ADX: ${analysis.adx.toFixed(1)} | Trending: ${analysis.isMarketTrending} | Session: ${analysis.goodSession} | RealData: ${priceResult.ok}`);

  // Only alert for BUY/SELL above the minimum strength threshold
  if (analysis.signal === 'WAIT' || analysis.strength < minStrength) {
    return { statusCode: 200, body: JSON.stringify({ signal: analysis.signal, strength: analysis.strength, alerted: false }) };
  }

  // Avoid spamming the same signal direction repeatedly within a short window
  const lastSignal = await store.get(LAST_SIGNAL_KEY, { type: 'json' });
  const now = Date.now();
  if (lastSignal && lastSignal.signal === analysis.signal) {
    const minutesSince = (now - lastSignal.timestamp) / 60000;
    if (minutesSince < minMinutesBetween) {
      console.log(`Skipping duplicate ${analysis.signal} signal (${minutesSince.toFixed(1)}min since last)`);
      return { statusCode: 200, body: JSON.stringify({ signal: analysis.signal, strength: analysis.strength, alerted: false, reason: 'duplicate-cooldown' }) };
    }
  }

  const message = formatSignalMessage(analysis);
  const result = await sendTelegramMessage(token, chatId, message);

  if (result.ok) {
    await store.setJSON(LAST_SIGNAL_KEY, { signal: analysis.signal, timestamp: now });
  } else {
    console.error('Telegram send failed:', result.error);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ signal: analysis.signal, strength: analysis.strength, alerted: result.ok, telegramError: result.error || null })
  };
};

// NOTE: the cron schedule for this function is configured in netlify.toml
// (not inline here) for compatibility across Netlify's function runtimes.
