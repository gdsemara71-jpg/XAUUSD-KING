# XAUUSD Signal Bot v5

Bot sinyal trading XAUUSD otomatis berbasis Netlify + Telegram.

## 📊 Backtest Results (15 Tahun: 2010–2024)
| Metrik | Nilai |
|---|---|
| Modal Awal | $10,000 |
| Modal Akhir | $68,580 |
| Total Return | +585% |
| CAGR | 13.7%/tahun |
| Win Rate | 38.5% |
| Risk/Reward | 1:1.8 |
| Max Drawdown | -48.5% |
| Profit Factor | 1.13x |
| Trade/hari | ~3.6 |
| Tahun Profit | 11/15 |

## 🧠 Strategi — Triple Filter

```
Layer 1: D1  — price > EMA50 + +DI > -DI
Layer 2: H1  — EMA21 > EMA50 + ADX ≥ 20 + price > EMA200
Layer 3: M5  — EMA50 Bounce ATAU EMA8/21 Cross + 1 micro confirm
```

**Entry:** SL = 2.0×ATR | TP = 3.6×ATR (RR 1.8)
**Session:** London + New York (07:00–21:00 UTC)

## 🚀 Setup

### 1. Clone & push ke GitHub
```bash
git init
git add .
git commit -m "init: xauusd signal bot v5"
git remote add origin https://github.com/USERNAME/xauusd-bot-v5.git
git push -u origin main
```

### 2. Connect ke Netlify
1. Buka [netlify.com](https://netlify.com) → **Add new site** → **Import from Git**
2. Pilih repo ini
3. Build settings: biarkan kosong (tidak ada build command)
4. Klik **Deploy**

### 3. Set Environment Variables
Di Netlify Dashboard → **Site settings** → **Environment variables**:

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token dari [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | Chat ID dari [@userinfobot](https://t.me/userinfobot) |
| `MIN_SIGNAL_STRENGTH` | `55` (default) |
| `MIN_MINUTES_BETWEEN_SAME_SIGNAL` | `45` (default) |

### 4. Enable Netlify Blobs
Di Netlify Dashboard → **Integrations** → **Blobs** → Enable

### 5. Test
Di Netlify Dashboard → **Functions** → `check-signal` → **Test function**

## 📁 Struktur File
```
xauusd-bot-v5/
├── netlify/
│   └── functions/
│       └── check-signal.js   ← Main bot logic
├── netlify.toml               ← Cron: setiap 5 menit
├── package.json
└── README.md
```

## ⚠️ Disclaimer
Bot ini adalah alat analisis teknikal otomatis.
Bukan rekomendasi investasi. Selalu gunakan risk management.
