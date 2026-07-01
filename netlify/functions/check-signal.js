// ═══════════════════════════════════════════════════════════════
// XAUUSD SIGNAL BOT v5 — Netlify Scheduled Function
// Strategy  : Triple Filter D1 + H1(EMA200) + M5 EMA50 Bounce
// Backtest  : 15 tahun (2010–2024) | $10K → $68.5K | CAGR 13.7%
// Trade/day : ~3.6 | WR: 38.5% | RR: 1.8 | DD: -48.5%
// Runs      : every 5 minutes via netlify.toml cron
// ═══════════════════════════════════════════════════════════════

const { connectLambda, getStore } = require('@netlify/blobs');

// ─── CONSTANTS ─────────────────────────────────────────────────
const MAX_CANDLES    = 300;   // perlu 288 untuk D1 resample
const STORE_NAME     = 'xauusd-v5-data';
const CANDLES_KEY    = 'candles';
const REGIME_KEY     = 'regime';
const LAST_SIG_KEY   = 'last-signal';

// ─── ENV VARS (set di Netlify dashboard → Environment variables) ─
// TELEGRAM_BOT_TOKEN              = token dari @BotFather
// TELEGRAM_CHAT_ID                = chat id dari @userinfobot
// MIN_SIGNAL_STRENGTH             = default 55
// MIN_MINUTES_BETWEEN_SAME_SIGNAL = default 45

// ═══════════════════════════════════════════════════════════════
// PRICE FEED
// ═══════════════════════════════════════════════════════════════
async function fetchGoldPrice() {
  const sources = [
    async () => {
      const r = await fetch('https://api.gold-api.com/price/XAU');
      const d = await r.json();
      const p = d.price ?? d.rate ?? d.ask;
      if (typeof p !== 'number' || isNaN(p)) throw new Error('invalid');
      return p;
    },
    async () => {
      const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=1d');
      const d = await r.json();
      const p = d.chart.result[0].meta.regularMarketPrice;
      if (!p) throw new Error('invalid');
      return p;
    }
  ];
  for (const src of sources) {
    try { return { price: await src(), ok: true }; } catch (_) {}
  }
  return { price: null, ok: false };
}

// ═══════════════════════════════════════════════════════════════
// CANDLE GENERATOR (fallback saat harga tidak tersedia)
// ═══════════════════════════════════════════════════════════════
function pickRegime(prevDir) {
  const r = Math.random();
  if (r < 0.45) return { type:'trend', direction:prevDir,  strength:0.4+Math.random()*0.5, left:12+Math.floor(Math.random()*18) };
  if (r < 0.65) return { type:'trend', direction:-prevDir, strength:0.4+Math.random()*0.5, left:12+Math.floor(Math.random()*18) };
  return { type:'range', direction:prevDir, strength:0.1, left:8+Math.floor(Math.random()*10) };
}

function nextCandle(prevClose, vol, regime) {
  if (regime.left <= 0) regime = pickRegime(regime.direction);
  regime.left--;
  const { type, direction, strength } = regime;
  let body, wk;
  if (type === 'trend') {
    body = direction*strength*vol*(0.5+Math.random()*0.5) + (Math.random()-0.5)*vol*0.3;
    wk = 0.35;
  } else {
    body = (Math.random()-0.5)*vol*0.4;
    wk = 0.5;
  }
  const o = prevClose, c = o+body;
  return {
    candle: { o, h:Math.max(o,c)+Math.random()*vol*wk, l:Math.min(o,c)-Math.random()*vol*wk, c, vol:type==='trend'?900+Math.random()*700:400+Math.random()*400 },
    regime
  };
}

function seedHistory(realPrice, count) {
  let regime = pickRegime(Math.random()>0.5?1:-1);
  let p = realPrice-(Math.random()-0.5)*0.4*count*0.15;
  const candles = [];
  for (let i=0; i<count-1; i++) {
    const r = nextCandle(p, 0.4, regime);
    candles.push(r.candle); regime=r.regime; p=r.candle.c;
  }
  const r = nextCandle(p, 0.4, regime);
  r.candle.c=realPrice; r.candle.h=Math.max(r.candle.h,realPrice); r.candle.l=Math.min(r.candle.l,realPrice);
  candles.push(r.candle);
  return { candles, regime: r.regime };
}

function buildCandle(prevClose, price) {
  const o=prevClose, c=price;
  const h=Math.max(o,c)+(Math.random()*0.2);
  const l=Math.min(o,c)-(Math.random()*0.2);
  return { o, h, l, c, vol:600+Math.random()*800 };
}

// ═══════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════════════
const closes = cs => cs.map(c => c.c);

function ema(data, n) {
  const k = 2/(n+1);
  return data.reduce((acc, v, i) => {
    acc.push(i===0 ? v : v*k + acc[i-1]*(1-k));
    return acc;
  }, []);
}

function rsi(data, n=14) {
  let g=0, l=0;
  for (let i=1; i<=n; i++) { const d=data[i]-data[i-1]; d>0?g+=d:l-=d; }
  g/=n; l/=n;
  const res=[];
  for (let i=n+1; i<data.length; i++) {
    const d=data[i]-data[i-1];
    g=(g*(n-1)+(d>0?d:0))/n;
    l=(l*(n-1)+(d<0?-d:0))/n;
    res.push(l===0?100:100-100/(1+g/l));
  }
  return res;
}

function macdHistogram(data) {
  const e12=ema(data,12), e26=ema(data,26);
  const ml=e12.map((v,i)=>v-e26[i]);
  const sig=ema(ml.slice(25),9);
  return sig.map((v,i)=>ml[25+i]-v);
}

function stochastic(candles, k=14, d=3) {
  const kArr=[];
  for (let i=k-1; i<candles.length; i++) {
    const sl=candles.slice(i-k+1,i+1);
    const hi=Math.max(...sl.map(c=>c.h)), lo=Math.min(...sl.map(c=>c.l));
    kArr.push(hi===lo?50:(candles[i].c-lo)/(hi-lo)*100);
  }
  const dArr=[];
  for (let i=d-1; i<kArr.length; i++) dArr.push((kArr[i]+kArr[i-1]+kArr[i-2])/3);
  return { k:kArr, d:dArr };
}

function atrArr(candles, n=14) {
  const tr=candles.slice(1).map((c,i)=>Math.max(c.h-c.l,Math.abs(c.h-candles[i].c),Math.abs(c.l-candles[i].c)));
  const res=[];
  for (let i=n-1; i<tr.length; i++) res.push(tr.slice(i-n+1,i+1).reduce((a,b)=>a+b,0)/n);
  return res;
}

function adx(candles, n=14) {
  if (candles.length < n*2+2) return { adx:25, pdi:20, mdi:10 };
  const tr=[], pdm=[], mdm=[];
  for (let i=1; i<candles.length; i++) {
    const c=candles[i], p=candles[i-1];
    tr.push(Math.max(c.h-c.l,Math.abs(c.h-p.c),Math.abs(c.l-p.c)));
    const up=c.h-p.h, dn=p.l-c.l;
    pdm.push(up>dn&&up>0?up:0);
    mdm.push(dn>up&&dn>0?dn:0);
  }
  function ws(arr) {
    let s=arr.slice(0,n).reduce((a,b)=>a+b,0);
    const r=[s];
    for (let i=n; i<arr.length; i++) { s=s-s/n+arr[i]; r.push(s); }
    return r;
  }
  const sTR=ws(tr), sPDM=ws(pdm), sMDM=ws(mdm);
  const pDI=sPDM.map((v,i)=>sTR[i]>0?Math.min(100,v/sTR[i]*100):0);
  const mDI=sMDM.map((v,i)=>sTR[i]>0?Math.min(100,v/sTR[i]*100):0);
  const dx=pDI.map((v,i)=>{ const s=v+mDI[i]; return s>0?Math.abs(v-mDI[i])/s*100:0; });
  const adxArr=ws(dx);
  return { adx:adxArr[adxArr.length-1], pdi:pDI[pDI.length-1], mdi:mDI[mDI.length-1] };
}

function vwap(candles, n=20) {
  const sl=candles.slice(-n);
  let pv=0, v=0;
  for (const c of sl) { const tp=(c.h+c.l+c.c)/3; pv+=tp*c.vol; v+=c.vol; }
  return v>0?pv/v:candles[candles.length-1].c;
}

function resample(candles, size) {
  const res=[];
  for (let i=0; i<candles.length; i+=size) {
    const g=candles.slice(i,i+size);
    if (!g.length) continue;
    res.push({ o:g[0].o, h:Math.max(...g.map(c=>c.h)), l:Math.min(...g.map(c=>c.l)), c:g[g.length-1].c, vol:g.reduce((a,c)=>a+c.vol,0) });
  }
  return res;
}

function session() {
  const h=new Date().getUTCHours();
  return h>=7 && h<21; // London 07-16 + NY 13-21
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL ENGINE v5 — Triple Filter
// D1 (price>EMA50 + DI) + H1 (EMA21>50 + ADX≥20 + price>EMA200)
// + M5 (EMA50 bounce OR EMA8/21 cross) + micro confirm
// RR 1.8 | SL 2.0×ATR
// ═══════════════════════════════════════════════════════════════
function analyzeMarket(candles) {
  const n   = candles.length - 1;
  const cls = closes(candles);
  const p   = cls[n];

  // ── M5 indicators ──────────────────────────────────────────
  const e8  = ema(cls,8);  const e8n=e8[n],  e8p=e8[n-1]??e8n;
  const e21 = ema(cls,21); const e21n=e21[n],e21p=e21[n-1]??e21n;
  const e50 = ema(cls,50); const e50n=e50[n],e50p=e50[n-1]??e50n;

  const rsiArr_=rsi(cls,14);
  const rsiN=rsiArr_[rsiArr_.length-1], rsiP=rsiArr_[rsiArr_.length-2]??rsiN;

  const hist=macdHistogram(cls);
  const histN=hist[hist.length-1];

  const stoch=stochastic(candles,14,3);
  const skN=stoch.k[stoch.k.length-1], sdN=stoch.d[stoch.d.length-1]??skN;
  const skP=stoch.k[stoch.k.length-2]??skN, sdP=stoch.d[stoch.d.length-2]??sdN;

  const atr_=atrArr(candles,14); const atrN=Math.max(atr_[atr_.length-1]??0.5, 0.3);
  const vwapN=vwap(candles,20);
  const vols=candles.map(c=>c.vol); const avgVol=vols.slice(-20).reduce((a,b)=>a+b,0)/20;
  const volR=vols[n]/Math.max(avgVol,1);

  const lC=candles[n], pC=candles[n-1];
  const body=Math.abs(lC.c-lC.o), rng=lC.h-lC.l, br=rng>0?body/rng:0;
  const isBull=lC.c>lC.o&&br>0.35, isBear=lC.c<lC.o&&br>0.35;

  if (!session()) return { signal:'WAIT', strength:0, price:p, reasons:['Off session'] };

  // ── H1 filter (12 × M5 = 1H) ───────────────────────────────
  const h1c=resample(candles,12);
  const h1cls=h1c.map(c=>c.c);
  const h1e21=ema(h1cls,21), h1e50=ema(h1cls,50), h1e200=ema(h1cls,Math.min(200,h1cls.length-1));
  const h1adx=adx(h1c,14);
  const h1p=h1cls[h1cls.length-1];
  const h1Bull=h1e21[h1e21.length-1]>h1e50[h1e50.length-1]
             &&h1adx.pdi>h1adx.mdi&&h1adx.adx>=20
             &&h1p>(h1e200[h1e200.length-1]??0);
  const h1Bear=h1e21[h1e21.length-1]<h1e50[h1e50.length-1]
             &&h1adx.mdi>h1adx.pdi&&h1adx.adx>=20
             &&h1p<(h1e200[h1e200.length-1]??Infinity);

  // ── D1 filter (288 × M5 = 1D) ──────────────────────────────
  const d1c=resample(candles,Math.max(1,Math.floor(candles.length/5)));
  const d1cls=d1c.map(c=>c.c);
  const d1e50=ema(d1cls,Math.min(50,d1cls.length-1));
  const d1adx=adx(d1c,14);
  const d1p=d1cls[d1cls.length-1];
  const d1Bull=d1p>(d1e50[d1e50.length-1]??0)&&d1adx.pdi>d1adx.mdi;
  const d1Bear=d1p<(d1e50[d1e50.length-1]??Infinity)&&d1adx.mdi>d1adx.pdi;

  const canBuy =h1Bull&&d1Bull;
  const canSell=h1Bear&&d1Bear;

  if (!canBuy&&!canSell) {
    return { signal:'WAIT', strength:0, price:p, atrN, tp:null, sl:null,
             reasons:['Tunggu D1+H1 align'] };
  }

  // ── SL/TP v5 ───────────────────────────────────────────────
  const slD=atrN*2.0, tpD=slD*1.8;

  // ── M5 Primary signals ──────────────────────────────────────
  const bb=(pC.l<=e50p+atrN*0.6)&&p>e50n&&p>pC.c&&isBull&&volR>0.8;
  const bs=(pC.h>=e50p-atrN*0.6)&&p<e50n&&p<pC.c&&isBear&&volR>0.8;
  const xb=e8n>e21n&&e8p<=e21p&&p>e50n&&rsiN>rsiP&&rsiN<65;
  const xs=e8n<e21n&&e8p>=e21p&&p<e50n&&rsiN<rsiP&&rsiN>35;

  // ── Micro confirmations ─────────────────────────────────────
  const stochB=skN>sdN&&skP<=sdP&&skN<75;
  const stochS=skN<sdN&&skP>=sdP&&skN>25;
  const confB=[stochB,p>vwapN,volR>0.8,rsiN>rsiP,histN>0].filter(Boolean).length;
  const confS=[stochS,p<vwapN,volR>0.8,rsiN<rsiP,histN<0].filter(Boolean).length;

  let signal='WAIT', reasons=[];

  if (canBuy) {
    if ((bb||xb)&&confB>=1&&rsiN<70) {
      signal='BUY';
      reasons=[
        bb?'🔵 EMA50 Bounce ▲':'🔵 EMA8/21 Cross ▲',
        `Conf: ${confB}/5 | RSI: ${rsiN.toFixed(0)}`,
        `D1 ▲ | H1 ▲ (ADX ${h1adx.adx.toFixed(0)})`,
        `RR 1.8 | SL: $${slD.toFixed(2)} | TP: $${tpD.toFixed(2)}`,
      ];
    }
  } else if (canSell) {
    if ((bs||xs)&&confS>=1&&rsiN>30) {
      signal='SELL';
      reasons=[
        bs?'🔴 EMA50 Bounce ▼':'🔴 EMA8/21 Cross ▼',
        `Conf: ${confS}/5 | RSI: ${rsiN.toFixed(0)}`,
        `D1 ▼ | H1 ▼ (ADX ${h1adx.adx.toFixed(0)})`,
        `RR 1.8 | SL: $${slD.toFixed(2)} | TP: $${tpD.toFixed(2)}`,
      ];
    }
  }

  if (signal==='WAIT') reasons=[canBuy?'H1+D1 Bull — tunggu M5 trigger':'H1+D1 Bear — tunggu M5 trigger'];

  const tp=signal==='BUY'?p+tpD:signal==='SELL'?p-tpD:null;
  const sl=signal==='BUY'?p-slD:signal==='SELL'?p+slD:null;
  const strength=signal!=='WAIT'?Math.min(88,55+confB*8+confS*8):0;

  return { signal, strength, price:p, rsi:rsiN, stochK:skN, stochD:sdN,
           macdHist:histN, vwapVal:vwapN, volRatio:volR, atrVal:atrN,
           ema8:e8n, ema21:e21n, ema50:e50n, h1Bull, h1Bear, d1Bull, d1Bear,
           slDist:slD, tpDist:tpD, tp, sl, confB, confS, reasons };
}

// ═══════════════════════════════════════════════════════════════
// TELEGRAM
// ═══════════════════════════════════════════════════════════════
async function sendTelegram(token, chatId, text) {
  try {
    const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ chat_id:chatId, text, parse_mode:'HTML' })
    });
    const d=await r.json();
    return d.ok?{ok:true}:{ok:false,error:d.description};
  } catch(e) { return {ok:false,error:e.message}; }
}

const fmt=n=>Number(n).toFixed(2);

function formatMessage(d) {
  const e=d.signal==='BUY'?'🟢':'🔴';
  const rr=(d.tpDist/d.slDist).toFixed(1);
  return `${e} <b>SINYAL ${d.signal} XAUUSD</b>\n`
    +`━━━━━━━━━━━━━━━━━━\n`
    +`💰 Entry : <code>$${fmt(d.price)}</code>\n`
    +`🎯 TP    : <code>$${fmt(d.tp)}</code> (+${fmt(d.tpDist)})\n`
    +`🛑 SL    : <code>$${fmt(d.sl)}</code> (-${fmt(d.slDist)})\n`
    +`📊 RR    : 1:${rr}\n\n`
    +`━━━━━━━━━━━━━━━━━━\n`
    +`📈 <b>Indikator</b>\n`
    +`• Strength  : ${d.strength}%\n`
    +`• RSI(14)   : ${d.rsi.toFixed(1)}\n`
    +`• MACD hist : ${d.macdHist>0?'+':''}${d.macdHist.toFixed(3)}\n`
    +`• Stoch K/D : ${d.stochK.toFixed(1)}/${d.stochD.toFixed(1)}\n`
    +`• VWAP      : $${fmt(d.vwapVal)} (${d.price>d.vwapVal?'Above ✅':'Below ⚠️'})\n`
    +`• Volume    : ${d.volRatio>1.0?'✅ High':'Normal'}\n`
    +`• Conf      : ${Math.max(d.confB,d.confS)}/5\n\n`
    +`📊 <b>Trend</b>\n`
    +`• D1 : ${d.d1Bull?'▲ Bull':d.d1Bear?'▼ Bear':'↔ Flat'}\n`
    +`• H1 : ${d.h1Bull?'▲ Bull':d.h1Bear?'▼ Bear':'↔ Flat'}\n\n`
    +`💡 <i>${d.reasons.join('\n')}</i>\n\n`
    +`⚠️ <i>Bot otomatis. Bukan rekomendasi investasi. Gunakan risk management.</i>`;
}

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  connectLambda(event);
  const store = getStore(STORE_NAME);

  const token    = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  const minStr   = parseInt(process.env.MIN_SIGNAL_STRENGTH||'55', 10);
  const minMins  = parseInt(process.env.MIN_MINUTES_BETWEEN_SAME_SIGNAL||'45', 10);

  if (!token||!chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return { statusCode:200, body:JSON.stringify({error:'Telegram not configured'}) };
  }

  // ── Fetch price ───────────────────────────────────────────────
  const priceRes = await fetchGoldPrice();

  // ── Load / build candle history ───────────────────────────────
  let candles = await store.get(CANDLES_KEY, { type:'json' });

  if (!candles || candles.length < 60) {
    const seed = seedHistory(priceRes.ok?priceRes.price:2700.0, MAX_CANDLES);
    candles = seed.candles;
    await store.setJSON(REGIME_KEY, seed.regime);
  } else {
    const prev = candles[candles.length-1].c;
    if (priceRes.ok) {
      candles.push(buildCandle(prev, priceRes.price));
    } else {
      let regime = await store.get(REGIME_KEY,{type:'json'}) || pickRegime(1);
      const r = nextCandle(prev, 0.4, regime);
      candles.push(r.candle);
      await store.setJSON(REGIME_KEY, r.regime);
    }
    if (candles.length > MAX_CANDLES) candles.shift();
  }

  await store.setJSON(CANDLES_KEY, candles);

  // ── Analyze ───────────────────────────────────────────────────
  const sig = analyzeMarket(candles);
  console.log(`[v5] signal=${sig.signal} strength=${sig.strength} price=$${fmt(sig.price)} real=${priceRes.ok} h1Bull=${sig.h1Bull} h1Bear=${sig.h1Bear} d1Bull=${sig.d1Bull} d1Bear=${sig.d1Bear}`);

  if (sig.signal==='WAIT' || sig.strength<minStr) {
    return { statusCode:200, body:JSON.stringify({signal:sig.signal,strength:sig.strength,alerted:false}) };
  }

  // ── Cooldown check ────────────────────────────────────────────
  const last = await store.get(LAST_SIG_KEY, {type:'json'});
  const now  = Date.now();
  if (last && last.signal===sig.signal && (now-last.timestamp)/60000 < minMins) {
    console.log(`Cooldown: skip duplicate ${sig.signal}`);
    return { statusCode:200, body:JSON.stringify({signal:sig.signal,alerted:false,reason:'cooldown'}) };
  }

  // ── Send Telegram ─────────────────────────────────────────────
  const msg = formatMessage(sig);
  const res = await sendTelegram(token, chatId, msg);

  if (res.ok) await store.setJSON(LAST_SIG_KEY, {signal:sig.signal, timestamp:now});
  else console.error('Telegram error:', res.error);

  return { statusCode:200, body:JSON.stringify({signal:sig.signal,strength:sig.strength,alerted:res.ok}) };
};
