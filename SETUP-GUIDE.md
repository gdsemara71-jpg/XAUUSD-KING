# Setup Sinyal Otomatis XAUUSD → Telegram (24/7, Tanpa Buka HP)

Panduan ini akan membuat sistem yang berjalan otomatis di server Netlify, mengecek market setiap 5 menit, dan mengirim notifikasi Telegram saat ada sinyal BUY/SELL — semua tanpa Anda perlu membuka HP atau browser.

---

## Bagian 1: Upload ke GitHub (dari HP)

1. Buka **github.com** di browser HP Anda, login.
2. Tap ikon **+** di pojok kanan atas → **New repository**.
3. Beri nama repo, misal `xauusd-signal-bot`. Pilih **Private** (supaya token tidak terlihat publik). Tap **Create repository**.
4. Di halaman repo kosong, tap **uploading an existing file**.
5. Upload SEMUA file dan folder berikut (pertahankan struktur foldernya):
   - `netlify.toml`
   - `package.json`
   - `netlify/functions/check-signal.js`
   - `public/index.html`
6. Tap **Commit changes**.

> Tips: kalau GitHub mobile web sulit upload folder bertingkat, gunakan app **GitHub** resmi (tersedia di Play Store/App Store) — fiturnya lebih lengkap untuk upload dari HP, termasuk bisa upload folder.

---

## Bagian 2: Hubungkan ke Netlify

1. Buka **netlify.com**, login (atau daftar pakai akun GitHub Anda langsung — lebih cepat).
2. Tap **Add new site** → **Import an existing project**.
3. Pilih **GitHub**, izinkan akses, lalu pilih repo `xauusd-signal-bot` yang baru dibuat.
4. Build settings akan otomatis terbaca dari `netlify.toml`. Biarkan default, tap **Deploy site**.
5. Tunggu sampai status menjadi **Published** (biasanya 1-2 menit).

---

## Bagian 3: Atur Environment Variables (Token Telegram)

Ini langkah PALING PENTING — tanpa ini, function tidak akan bisa kirim notifikasi.

1. Di dashboard site Netlify Anda, tap **Site configuration** → **Environment variables**.
2. Tap **Add a variable** → **Add a single variable**, lalu isi satu-satu:

   | Key | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | Token dari @BotFather Anda |
   | `TELEGRAM_CHAT_ID` | Chat ID dari @userinfobot Anda |
   | `MIN_SIGNAL_STRENGTH` | `60` (opsional, sinyal di bawah 60% strength tidak akan dikirim) |
   | `MIN_MINUTES_BETWEEN_SAME_SIGNAL` | `30` (opsional, jeda minimal sebelum sinyal arah sama dikirim ulang) |

3. Setelah semua tersimpan, tap **Deploys** → **Trigger deploy** → **Deploy site** (supaya environment variable baru diterapkan ke function).

---

## Bagian 4: Verifikasi Scheduled Function Aktif

1. Tap tab **Functions** di dashboard Netlify.
2. Anda akan lihat function bernama **check-signal** dengan label **Scheduled**.
3. Tap function tersebut untuk melihat **logs** — di sini Anda bisa lihat history eksekusi (setiap 5 menit) dan hasil sinyal yang terdeteksi.

Anda **tidak perlu menunggu** 5 menit untuk tes pertama. Bisa langsung trigger manual:
1. Di tab **Functions**, tap **check-signal**.
2. Cari tombol **Trigger function** atau gunakan tab **Deploys** → terminal/CLI kalau tersedia di plan Anda. Kalau tidak ada tombol trigger manual di UI, cukup tunggu 5 menit — cron akan otomatis jalan sendiri.

---

## Bagaimana Cara Kerjanya

- Setiap 5 menit, Netlify otomatis menjalankan `check-signal.js` di server (bukan di HP Anda).
- Function ini fetch harga emas real dari API publik, hitung indikator (RSI, MACD, EMA, dst), dan tentukan sinyal BUY/SELL/WAIT.
- History candle disimpan di **Netlify Blobs** (database kecil otomatis) supaya data tetap berkesinambungan antar-eksekusi, bukan random ulang.
- Kalau sinyal BUY/SELL terdeteksi dengan strength ≥ 60% (bisa diatur), pesan otomatis terkirim ke Telegram Anda.
- Sinyal yang sama tidak akan di-spam berulang dalam 30 menit (bisa diatur) untuk menghindari notifikasi berlebihan.

## Mengubah Pengaturan Nanti

Untuk mengganti `MIN_SIGNAL_STRENGTH` atau interval cron, edit:
- Environment variable → lewat dashboard Netlify (Bagian 3), tidak perlu edit kode.
- Interval cron → edit baris `schedule` di file `netlify.toml`: `schedule = "*/5 * * * *"`. Format ini berarti "setiap 5 menit". Untuk setiap 15 menit gunakan `"*/15 * * * *"`. Setelah edit, commit ulang lewat GitHub agar Netlify re-deploy otomatis.

## Limitasi Penting

- Plan gratis Netlify Functions punya batas eksekusi bulanan — untuk cron tiap 5 menit (≈8.640x/bulan), ini biasanya masih dalam batas gratis untuk function sederhana seperti ini, tapi pantau usage di dashboard kalau ragu.
- API harga emas gratis yang dipakai (`gold-api.com`) tidak memberi data historis OHLC penuh, hanya harga live — jadi sebagian candle awal tetap model simulasi realistis, bukan data pasar 100% historis asli. Ini cukup untuk sinyal scalping jangka pendek, tapi bukan pengganti data institutional-grade.
- Tidak ada jaminan win-rate tertentu. Selalu gunakan manajemen risiko sendiri saat membuka posisi manual berdasarkan sinyal ini.
