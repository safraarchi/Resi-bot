# 📦 Bot Otomasi Resi Telegram (A4 Grid 2x2 Ready-to-Print)

Bot Telegram lokal untuk mengumpulkan resi pengiriman (file PDF Shopee, bosCOD, TikTok, J&T, maupun teks manual), lalu secara otomatis menyusun dan menggabungkannya ke dalam **1 file PDF ukuran A4 (Grid 2x2 = 4 resi per lembar)** lengkap dengan garis pembatas potong siap cetak.

---

## ✨ Fitur Unggulan Terbaru

1. **🔄 Deteksi Cerdas & Auto-Rotasi 90° ke Kiri**:
   - Resi persegi atau landscape (seperti **bosCOD $100 \times 100$ mm** atau label landscape Shopee) otomatis diputar 90° ke kiri (*counter-clockwise*).
   - Menjamin sisi panjangnya mengisi penuh tinggi kuadran vertikal A4, sehingga teks dan barcode tampil maksimal, besar, tajam, dan tidak terpotong!
2. **📝 Label Manual Otomatis Sesuai Contoh Foto**:
   - Cukup kirim format teks pesanan manual, bot otomatis membuatkan **label berbingkai sudut melengkung (*rounded rectangle*)**.
   - Kolom `Nama`, `D/A` (Alamat), `No HP`, serta `SIP: SAFRA` & `HP: 0856-9733-7041` (otomatis terisi default).
   - Daftar barang dan status bayar (`SUDAH TF` / `COD`) otomatis tertata rapi di bawah kotak.
3. **⌨️ Tombol Navigasi Permanen di Layar Bawah**:
   - `[ 🖨️ Cetak Resi Baru ]` : Memproses semua resi yang belum dicetak ke 1 file PDF A4 saat ini juga.
   - `[ 📊 Cek Antrean ]` : Menampilkan jumlah resi yang sedang antre menunggu cetak.
   - `[ 📝 Format Manual ]` : Menampilkan format teks yang siap di-copy & diisi.
   - `[ ℹ️ Bantuan ]` : Panduan lengkap penggunaan.
4. **📅 Siklus Antrean Harian Bersih (Anti Dobel Cetak)**:
   - Setiap kali tombol cetak ditekan (atau jam 14:00 tiba), file yang sudah digabung **langsung dipindahkan ke folder arsip bertanggal** (`storage/archive/YYYY-MM-DD/`).
   - Antrean kembali `0` resi. Jika besok ada 4 resi baru, resi hari kemarin **tidak akan ikut tercetak lagi**!
5. **⏰ Auto-Print Jam 14:00 WIB (Cadangan Otomatis)**:
   - Jika admin lupa menekan tombol cetak, bot otomatis menggabungkan seluruh resi pada jam 14:00 WIB setiap hari.

---

## 🚀 Panduan Menjalankan Bot

### Langkah 1: Isi Token Telegram di File `.env`
Buka file [`.env`](file:///c:/Users/Lenovo/Desktop/yusuf/Bot-resi/.env) di folder ini, lalu isi `BOT_TOKEN`:
```env
BOT_TOKEN=123456789:AAHxyz_TokenDariBotFather
```
*(Opsional: Anda juga bisa mengubah default nama pengirim `DEFAULT_SIP=SAFRA` dan `DEFAULT_HP=0856-9733-7041` di file `.env` ini).*

### Langkah 2: Jalankan Bot
Cukup **klik dua kali** file:
👉 [`start_bot.bat`](file:///c:/Users/Lenovo/Desktop/yusuf/Bot-resi/start_bot.bat)

---

## 📱 Cara Menginput Resi Manual di Telegram

Cukup kirim chat dengan awalan **/manual**, contoh:

```text
/manual
Nama: Anton Ekawirawan
Alamat: Jl. Tiga No. 17, KPR, PT. IKPP, Perawang Tualang Siak Riau
No HP: 0882-7107-9535
Keterangan: POC Biang 2 L, Pasta 1 Kg (SUDAH TF)
```

> [!NOTE]
> * Baris **Keterangan** boleh diisi catatan pesanan/COD, atau **dikosongkan** jika tidak ada catatan (bagian bawah label akan otomatis bersih tanpa tulisan).
> * Bot hanya akan memproses teks yang diawali dengan **/manual**, sehingga seluruh chat obrolan bebas anggota di grup tidak akan pernah terganggu!

---

---

## ⌨️ Daftar Perintah & Cara Penggunaan Praktis

| Perintah / Aksi | Fungsi & Cara Pakai |
| :--- | :--- |
| **Reply "batal"** | **Batalkan 1 Resi Tertentu:** Cukup balas/reply pesan file PDF atau teks `/manual` yang ingin dibatalkan dengan mengetik kata `batal`. Resi langsung dikeluarkan dari antrean. |
| **`/cetak`** | Menggabungkan seluruh antrean saat ini ke dalam **1 file PDF A4 Grid 2x2** siap cetak. |
| **`/list`** atau **`/daftar`** | Menampilkan **rincian nomor urut & nama penerima** seluruh resi yang sedang mengantre saat ini (audit sebelum print). |
| **`/status`** | Cek jumlah total resi yang sedang antre dan estimasi lembar kertas A4. |
| **`/ulang`** atau **`/terakhir`** | **Cetak Ulang (Reprint):** Mengirimkan kembali file PDF gabungan terakhir yang dicetak hari ini jika printer macet/tinta habis. |
| **`/cetak_ini`** | **Cetak Urgent Satuan:** Balas/reply pesan resi tertentu dengan `/cetak_ini` untuk mencetak 1 resi itu saja tanpa menunggu kloter batch. |
| **`/manual`** | Mengirimkan template kosong format resi manual (tinggal salin). |
| **Revisi Alamat** | Jika salah ketik data `/manual`, cukup balas/reply pesan chat `/manual` lama tersebut dengan data baru, bot otomatis mengganti data lama. |

---

## 📁 Struktur Penyimpanan Folder (Rapi Per Tanggal)
Semua file otomatis tertata dan dipisahkan per tanggal:
- `storage/queue/` : Folder resi baru yang sedang menunggu giliran dicetak.
- `storage/output/YYYY-MM-DD/` : Arsip file PDF A4 gabungan siap cetak per tanggal (`RESI_A4_YYYY-MM-DD_HH-mm.pdf`).
- `storage/archive/YYYY-MM-DD/batch_.../` : Arsip file satuan yang sudah selesai diproses per tanggal batch.
- `storage/archive/YYYY-MM-DD/cancelled/` : Arsip catatan resi yang dibatalkan oleh staf.

