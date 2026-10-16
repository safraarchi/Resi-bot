# 📦 Bot Resi Telegram & Financial Intelligence System (A4 Grid 2x2)

Sistem otomasi percetakan resi dan manajemen keuangan terpadu untuk tim ekspedisi & e-commerce. Mengumpulkan resi dari berbagai sumber (**PDF Shopee, TikTok Shop, bosCOD / J&T Cargo, Foto/OCR, dan Resi Manual**), menyusunnya ke dalam **1 file PDF A4 (Grid 2x2 = 4 label per lembar)** siap cetak, serta mencatat omzet & laporan keuangan secara otomatis ke **Google Sheets & Web Dashboard Real-Time**.

---

## 🌟 Fitur Utama Sistem

### 1. 🖨️ Otomasi Cetak Label A4 Grid 2x2
- **Grid 2x2 Siap Cetak:** Menggabungkan 4 resi ke dalam 1 lembar A4 lengkap dengan garis potong presisi.
- **Auto-Rotasi 90° Cerdas:** Resi bujur sangkar atau landscape (seperti **bosCOD 100x100 mm** atau Shopee thermal) otomatis diputar 90° ke kiri (*counter-clockwise*) agar mengisi penuh halaman vertikal tanpa terpotong.
- **Label Resi Manual Otomatis:** Menghasilkan label berbingkai sudut melengkung (*rounded rectangle*) dengan header toko/pengirim, alamat pembeli, barcode, dan rincian barang.
- **Pencetakan Langsung (Direct Print):** Cetak langsung ke printer fisik (misal: EPSON L3250) dalam format Hitam Putih (Monochrome) via perintah `/print`.

### 2. 📸 Deteksi Foto Resi (OCR Terpadu)
- Kirim foto/screenshot resi fisik dari handphone ke chat Telegram.
- Bot secara otomatis mengekstrak **No. Resi, Nama Penerima, Nomor HP, Nama Produk, SKU, Qty, Toko, dan Nilai COD/Harga** menggunakan engine OCR Tesseract.

### 3. 💰 Financial Intelligence & Multi-Toko
- **Klasifikasi Multi-Toko Otomatis:** Mendukung klasifikasi pesanan ke berbagai cabang:
  - 🌾 **Fertipro**
  - 🌿 **Yosa Farm**
  - 📦 **Interfarm**
  - 🌱 **Utamigro**
  - 👤 **Safra**
  - 🏪 **Alwiwin Store**
- **Prioritas Harga Custom via Reply:** Cukup balas file PDF/foto resi dengan nominal harga (contoh: `39000`, `Rp 39.000`, `390rb`, `39k`, `1.5jt`), harga tersebut diprioritaskan utama ke omzet.
- **Pencocokan Master Produk (480+ SKU):** Resi otomatis mencocokkan harga standar dari database `master_products.csv`.
- **Ketahanan Jaringan Offline:** Jika internet lambat atau Google Sheets tidak merespons, data order otomatis disimpan ke antrean offline lokal dan di-retry saat online kembali.

### 4. 📊 Web Dashboard Analytics Modern
Dashboard interaktif berbasis Google Apps Script (`Code.gs`) yang dapat dibuka dari browser HP maupun desktop:
- **KPI Metrics:** Total Omzet, Total Paket Terkirim, Total Paket Retur, dan Rata-rata Nilai Transaksi (AOV).
- **Filter Periode Dinamis:** Pilihan filter *Semua Waktu*, *Tahun Ini*, *Bulan Ini*, atau pilih bulan spesifik (misal: Oktober 2026).
- **Widget Top Produk Terlaris:** Menampilkan produk dengan kontribusi omzet tertinggi lengkap dengan ranking badges (#1 Gold Crown, #2 Silver, #3 Bronze) dan persentase share omzet. Klik produk untuk memfilter daftar transaksi secara instan.
- **Input Order Manual dari Web:** Form modal untuk mencatat pesanan susulan langsung dari dashboard web ke Google Sheets.
- **Edit & Koreksi Harga Interaktif:** Klik tombol edit untuk mengisi harga bagi order yang belum berharga, atau mengubah status pesanan (`TERKIRIM` vs `RETUR`).
- **Grafik Tren Harian:** Visualisasi omzet dan volume paket harian interaktif via Chart.js.

### 5. 💬 Copywriting Telegram Ringkas & Mobile-Friendly
Pesan notifikasi bot di grup Telegram dirancang ringkas (2–3 baris padat) sesuai kaidah micro-copywriting modern, tidak memenuhi layar HP, dan mudah dipindai sekilas (*scannable*).

---

## 📁 Struktur Folder Proyek

```text
Bot-resi/
├── google_apps_script/
│   ├── Code.gs                # Backend Google Apps Script (API Webhook & Web Dashboard)
│   └── README.md              # Panduan setup & deployment Google Apps Script
├── scripts/
│   ├── import_historical_data.js # Script migrasi/import data batch historis
│   ├── add_top_products_widget.js# Script injeksi fitur widget top produk
│   └── update_dashboard.js       # Script utilitas pembaruan dashboard
├── src/
│   ├── authMiddleware.js      # Middleware autentikasi admin/staf Telegram
│   ├── barcodeService.js      # Generator barcode Code-128 untuk label manual
│   ├── config.js              # Manajemen konfigurasi dan environment variables
│   ├── cronService.js         # Penjadwal otomatis penggabungan harian (jam 14:00 WIB)
│   ├── financeService.js      # Sinkronisasi keuangan, webhook, & format laporan
│   ├── manifestService.js     # Parser teks label PDF & rekap manifest barang
│   ├── ocrService.js          # Engine OCR gambar/foto resi via Tesseract
│   ├── pdfService.js          # Generator PDF A6 & penyusun Grid 2x2 PDF A4
│   ├── printerService.js      # Layanan cetak fisik ke printer lokal (Windows)
│   ├── productCatalogService.js # Pencocokan SKU, Toko, & Katalog Harga (480+ produk)
│   └── queueService.js        # Manajemen antrean file resi, metadata, & arsip
├── storage/                   # Penyimpanan file lokal (diabaikan dari Git)
│   ├── master_products.csv    # Database master produk lokal
│   ├── queue/                 # Antrean resi aktif yang menunggu cetak
│   ├── output/                # Hasil kompilasi PDF A4 (per tanggal)
│   └── archive/               # Arsip batch dan resi yang telah selesai diproses
├── index.js                   # Entry point aplikasi bot Telegram
├── package.json               # Konfigurasi dependensi Node.js
├── start_bot.bat              # Script 1-klik untuk menjalankan bot di Windows
├── test_dashboard_html.js     # Unit test validasi sintaks & rendering Web Dashboard
├── test_financial_engine.js   # Unit & integration test sistem keuangan & katalog
├── .env.example               # Contoh template variabel lingkungan
└── README.md                  # Dokumentasi resmi proyek
```

---

## 🚀 Panduan Instalasi & Penggunaan

### 1. Persyaratan Sistem
- **Node.js** v18 atau lebih baru.
- **Windows OS** (disarankan untuk dukungan `pdf-to-printer` otomatis).
- Printer terhubung ke komputer (misal: EPSON L3250 Series).

### 2. Konfigurasi File `.env`
Salin `.env.example` menjadi `.env`, lalu lengkapi isinya:
```env
# Token Bot Telegram dari @BotFather
BOT_TOKEN=123456789:AAHxyz_TokenDariBotFather

# Chat ID Grup / Channel untuk menerima hasil cetak PDF
TARGET_CHAT_ID=-100123456789

# Default Header Pengirim Label Manual
DEFAULT_SIP=SAFRA
DEFAULT_HP=0856-9733-7041

# Nama Printer Komputer (sesuai nama di Control Panel Windows)
PRINTER_NAME=EPSON L3250 Series

# URL Webhook Google Apps Script (Web App URL)
GOOGLE_SHEET_WEBHOOK_URL=https://script.google.com/macros/s/AKfycb.../exec
```

### 3. Menjalankan Bot
Jalankan dependensi dan mulai bot:
```bash
npm install
npm start
```
Atau cukup **klik dua kali** file [`start_bot.bat`](file:///c:/Users/Lenovo/Desktop/yusuf/Bot-resi/start_bot.bat).

---

## 🌐 Setup Web Dashboard & Google Sheets

1. Buka spreadsheet baru di [Google Sheets](https://sheets.google.com).
2. Buka menu **Ekstensi** > **Apps Script**.
3. Buka file [`google_apps_script/Code.gs`](file:///c:/Users/Lenovo/Desktop/yusuf/Bot-resi/google_apps_script/Code.gs) di repositori ini, salin seluruh kodenya, dan tempelkan ke editor Google Apps Script.
4. Klik **Deploy** > **New deployment**:
   - Pilih jenis: **Web app**.
   - Execute as: **Me**.
   - Who has access: **Anyone** (*Siapa saja*).
5. Salin **Web app URL** yang dihasilkan dan masukkan ke file `.env` pada variabel `GOOGLE_SHEET_WEBHOOK_URL`.
6. Akses link Web app URL tersebut melalui browser untuk membuka **Web Dashboard Keuangan**.

---

## ⌨️ Daftar Perintah Telegram

| Perintah / Aksi | Fungsi & Cara Pakai |
| :--- | :--- |
| **Kirim PDF Resi** | Cukup drag/kirim file PDF Shopee, J&T, TikTok, atau bosCOD. Otomatis masuk antrean. |
| **Kirim Foto Resi** | Kirim foto/screenshot resi. OCR bot otomatis membaca nama, resi, produk, dan harga. |
| **`/manual`** | Mengirimkan template format resi manual. |
| **Balas PDF + Harga** | Balas file PDF/foto resi dengan nominal angka (misal: `39000`, `390rb`, atau `Rp 39.000`) untuk menetapkan harga custom prioritas. |
| **`/harga [nominal]`** | Balas file resi dengan perintah `/harga 395.000` untuk menetapkan harga. |
| **`/cetak`** atau **`/gabung`** | Menggabungkan seluruh antrean aktif ke dalam 1 file PDF A4 Grid 2x2 dan menyinkronkan data keuangan ke Google Sheets. |
| **`/print`** | Menggabungkan resi dan langsung mengirimkannya ke printer fisik tanpa membuka PDF manual. |
| **`/list`** atau **`/daftar`** | Menampilkan daftar antrean resi saat ini (nama, barang, qty, dan harga) dalam 1 baris per paket. |
| **`/status`** | Menampilkan jumlah resi yang sedang antre dan estimasi lembar kertas A4 yang dibutuhkan. |
| **Reply `batal`** | Balas pesan resi yang ingin dibatalkan dengan kata `batal` untuk mengeluarkannya dari antrean. |
| **`/ulang`** | Mengirim ulang file PDF A4 terakhir yang dicetak hari ini jika terjadi kendala pada printer. |
| **`/printer`** | Cek status printer yang aktif dan printer yang terdeteksi di Windows. |

---

## 📝 Format Input Resi Manual

Kirim chat dengan format:
```text
/manual
Nama: H. Abdullah
Alamat: Desa Sukamaju RT 02/03, Kec. Tapung, Kampar, Riau
No HP: 08123456789
Toko: Fertipro
Harga: 395.000
Keterangan: Paket 1 Hektar Fertipro
```
> [!NOTE]
> * Baris **Toko** dan **Harga** otomatis disimpan ke pembukuan spreadsheet dan tidak dicetak ke label kertas fisik agar privasi penjualan terjaga.
> * Jika ada revisi alamat/nama, cukup balas (*reply*) pesan `/manual` tersebut dengan data yang baru, bot otomatis mengganti data lama.

---

## 🧪 Pengujian & Verifikasi

Seluruh logika sistem diuji secara berkala dengan automated unit & integration tests:
```bash
# Uji seluruh modul keuangan, katalog produk, OCR, dan routing multi-toko
node test_financial_engine.js

# Uji rendering Web Dashboard Google Apps Script, kalkulasi omzet, & client JS
node test_dashboard_html.js
```

---

## 🔒 Lisensi & Pengembang
Dikelola secara internal untuk operasional logistik & keuangan agrobisnis / e-commerce. Semua hak dilindungi.
