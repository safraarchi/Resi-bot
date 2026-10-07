const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const queueService = require('./src/queueService');
const { mergeLabelsToA4, parseShippingText } = require('./src/pdfService');
const { initScheduler } = require('./src/cronService');
const { authMiddleware, adminOnly } = require('./src/authMiddleware');

if (!config.BOT_TOKEN) {
  console.log(`
====================================================================
⚠️ PERINGATAN: BOT_TOKEN BELUM DIISI!
====================================================================
Langkah mudah mengaktifkan bot:
1. Buka Telegram dan cari bot: @BotFather
2. Ketik perintah: /newbot dan ikuti instruksi (beri nama bot).
3. Copy API Token yang diberikan oleh BotFather.
4. Buka file '.env' di folder ini, lalu tempel token tersebut:
   BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
5. Jalankan bot kembali dengan perintah: npm start
====================================================================
`);
  process.exit(1);
}

const bot = new Telegraf(config.BOT_TOKEN);

// Global Error Handler to keep bot always running
bot.catch((err, ctx) => {
  console.error('[TELEGRAF ERROR]', err.message || err);
});

// Helper to escape HTML characters
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Global Security Middleware: Blocks unauthorized users silently if configured
bot.use(authMiddleware);

// Remember the primary target chat ID where receipts should be sent
let lastActiveChatId = config.getPrimaryTargetChatId();

function updateActiveChat(chatId) {
  if (config.isAllowedChat(chatId)) {
    lastActiveChatId = chatId;
  }
}

// Register simple commands in Telegram UI
const COMMANDS_LIST = [
  { command: 'cetak', description: '🖨️ Cetak & gabungkan semua resi ke PDF A4' },
  { command: 'list', description: '📋 Cek rincian daftar resi dalam antrean' },
  { command: 'status', description: '📊 Cek jumlah total resi menunggu' },
  { command: 'ulang', description: '🔄 Kirim ulang file cetak PDF terakhir' },
  { command: 'manual', description: '📝 Ambil contoh format resi manual' },
  { command: 'batal', description: '🗑️ Batalkan resi (reply chat dengan kata "batal")' },
];

bot.telegram.setMyCommands(COMMANDS_LIST).catch(() => {});
bot.telegram.setMyCommands(COMMANDS_LIST, { scope: { type: 'all_group_chats' } }).catch(() => {});
bot.telegram.setMyCommands(COMMANDS_LIST, { scope: { type: 'all_private_chats' } }).catch(() => {});

/**
 * Perform merge and send output to chat (organized into storage/output/YYYY-MM-DD/)
 */
async function processBatchAndSend(chatId, triggeredBy = 'manual') {
  const queueFiles = queueService.getQueueFiles();
  const count = queueFiles.length;

  if (count === 0) {
    if (triggeredBy === 'manual' && chatId) {
      await bot.telegram.sendMessage(
        chatId,
        '⚠️ <b>Antrean masih kosong!</b>\nBelum ada resi (PDF atau /manual) yang masuk untuk dicetak.',
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    return;
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
  const batchId = `batch_${dateStr}_${timeStr}`;

  // Organize output by date folder: storage/output/YYYY-MM-DD/
  const outputDateDir = path.join(config.PATHS.OUTPUT, dateStr);
  if (!fs.existsSync(outputDateDir)) {
    fs.mkdirSync(outputDateDir, { recursive: true });
  }

  const outputFileName = `RESI_A4_${dateStr}_${timeStr}.pdf`;
  const outputPath = path.join(outputDateDir, outputFileName);

  let statusMsg = null;
  if (chatId) {
    statusMsg = await bot.telegram.sendMessage(
      chatId,
      `⏳ Menyusun <b>${count}</b> resi ke dalam PDF A4 (Grid 2x2 / 4 resi per lembar)...`,
      { parse_mode: 'HTML' }
    ).catch(() => null);
  }

  try {
    const mergeResult = await mergeLabelsToA4(queueFiles, outputPath);

    // Send the compiled PDF document
    if (chatId) {
      await bot.telegram.sendDocument(
        chatId,
        { source: outputPath, filename: outputFileName },
        {
          caption: `✅ <b>PENGGABUNGAN RESI SELESAI!</b>\n\n` +
                   `📦 <b>Total Resi:</b> ${mergeResult.totalLabels} resi\n` +
                   `📄 <b>Jumlah Halaman A4:</b> ${mergeResult.totalPages} lembar\n` +
                   `✂️ <b>Format:</b> Grid 2x2 (4 resi per lembar A4)\n` +
                   `⏰ <b>Waktu:</b> ${now.toLocaleTimeString('id-ID')} WIB\n\n` +
                   `<i>File siap langsung dicetak! Antrean sudah diarsipkan per tanggal untuk batch berikutnya.</i>`,
          parse_mode: 'HTML',
        }
      );

      if (statusMsg) {
        try {
          await bot.telegram.deleteMessage(chatId, statusMsg.message_id);
        } catch (_) {}
      }
    }

    // Archive processed queue files organized into storage/archive/YYYY-MM-DD/batchId/
    queueService.archiveQueue(batchId);
    console.log(`[BATCH SUCCESS] ${mergeResult.totalLabels} resi digabung ke ${outputFileName} (diarsipkan ke ${batchId})`);
  } catch (err) {
    console.error('[MERGE ERROR]', err);
    if (chatId) {
      await bot.telegram.sendMessage(chatId, `❌ Gagal menggabungkan resi: ${err.message}`).catch(() => {});
    }
  }
}

// Format template text
function sendManualTemplate(ctx) {
  updateActiveChat(ctx.chat.id);
  const templateMsg =
    `📋 <b>FORMAT INPUT RESI MANUAL:</b>\n\n` +
    `<i>Salin format di bawah ini, isi data pembeli, lalu kirim ke chat ini:</i>\n\n` +
    `<pre>/manual\nNama: \nAlamat: \nNo HP: \nKeterangan: </pre>\n\n` +
    `💡 <b>Catatan Pengisian:</b>\n` +
    `• Awali chat selalu dengan <b>/manual</b>\n` +
    `• <b>Keterangan</b> : Boleh diisi (misal pesanan, barang, COD) atau biarkan KOSONG jika tidak ada.\n` +
    `• Pengirim otomatis: <b>${escapeHtml(config.DEFAULT_SIP || 'SAFRA')}</b> (${escapeHtml(config.DEFAULT_HP || '0856-9733-7041')})`;

  ctx.reply(templateMsg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Klik Untuk Salin Format /manual', copy_text: { text: '/manual\nNama: \nAlamat: \nNo HP: \nKeterangan: ' } }]
      ]
    }
  }).catch(() => {});
}

// Start command
bot.start((ctx) => {
  updateActiveChat(ctx.chat.id);
  const welcomeText =
    `👋 <b>Halo! Bot Resi Siap Cetak (A4 Grid 2x2)</b>\n\n` +
    `📌 <b>Panduan Penggunaan Cepat:</b>\n` +
    `1. <b>Resi PDF:</b> Langsung kirim file PDF ke sini.\n` +
    `2. <b>Resi Manual:</b> Kirim chat dengan awalan <b>/manual</b>.\n` +
    `3. <b>Batal Resi:</b> Balas (reply) chat resi dengan kata <b>batal</b>.\n` +
    `4. <b>Cetak:</b> Ketik <b>/cetak</b> untuk satukan ke 1 PDF A4.\n` +
    `5. <b>Cek Daftar:</b> Ketik <b>/list</b> untuk melihat rincian antrean.\n` +
    `6. <b>Cetak Ulang:</b> Ketik <b>/ulang</b> jika kertas macet/butuh file terakhir.`;

  ctx.reply(welcomeText, { parse_mode: 'HTML' }).catch(() => {});
});

bot.help(sendManualTemplate);
bot.command(['format', 'template'], sendManualTemplate);

// Status command
function sendStatus(ctx) {
  updateActiveChat(ctx.chat.id);
  const count = queueService.getQueueCount();
  const pagesEstimate = Math.ceil(count / 4);
  const text =
    `📊 <b>Status Antrean Resi Belum Cetak:</b>\n\n` +
    `• Total Resi Menunggu: <b>${count}</b> resi\n` +
    `• Estimasi Kertas A4: <b>${pagesEstimate}</b> lembar (4 resi/lembar)\n\n` +
    (count > 0
      ? `👉 Ketik <b>/cetak</b> untuk proses PDF A4, atau <b>/list</b> untuk melihat rincian nama.`
      : `<i>Belum ada resi. Silakan kirim PDF resi atau ketik /manual.</i>`);

  ctx.reply(text, { parse_mode: 'HTML' }).catch(() => {});
}

bot.command('status', sendStatus);

// List / Daftar command (Audit rincian antrean)
function sendQueueList(ctx) {
  updateActiveChat(ctx.chat.id);
  const items = queueService.getQueueItems();
  if (items.length === 0) {
    return ctx.reply(
      `📭 <b>Antrean Masih Kosong</b>\nBelum ada resi yang menunggu cetak saat ini. Silakan kirim file PDF atau ketik /manual.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  const pagesEstimate = Math.ceil(items.length / 4);
  let listText = `📋 <b>DAFTAR RESI DALAM ANTREAN (${items.length} resi):</b>\n\n`;

  items.forEach((item, index) => {
    const num = index + 1;
    if (item.type === 'manual') {
      const ket = item.keterangan ? ` - <i>${escapeHtml(item.keterangan.slice(0, 25))}</i>` : '';
      listText += `${num}. 📝 <b>[Manual]</b> ${escapeHtml(item.recipient || item.title)}${ket}\n`;
    } else if (item.type === 'photo') {
      listText += `${num}. 📸 <b>[Foto]</b> ${escapeHtml(item.fileName)}\n`;
    } else {
      listText += `${num}. 📄 <b>[PDF]</b> <code>${escapeHtml(item.fileName)}</code>\n`;
    }
  });

  listText +=
    `\n📄 <b>Estimasi:</b> ${pagesEstimate} lembar A4 (Grid 2x2)\n` +
    `👉 <i>Ketik /cetak untuk satukan ke PDF A4.</i>\n` +
    `💡 <i>Untuk membatalkan salah satu, balas chat resinya dengan kata "batal" atau ketik /batal [nomor].</i>`;

  ctx.reply(listText, { parse_mode: 'HTML' }).catch(() => {});
}

bot.command(['list', 'daftar', 'antrean', 'queue'], sendQueueList);

// Print command
async function handlePrint(ctx) {
  updateActiveChat(ctx.chat.id);
  await processBatchAndSend(ctx.chat.id, 'manual');
}

bot.command(['cetak', 'print', 'merge', 'gabung'], handlePrint);

// Reprint command (/ulang atau /terakhir)
async function handleReprint(ctx) {
  updateActiveChat(ctx.chat.id);
  const latest = queueService.getLatestOutputFile();
  if (!latest || !fs.existsSync(latest.filePath)) {
    return ctx.reply(`⚠️ Belum ada file PDF hasil cetak hari ini di sistem.`);
  }

  const dateFormatted = new Date(latest.mtime).toLocaleTimeString('id-ID');
  await ctx.reply(`⏳ Mengambil file PDF cetak terakhir (<code>${escapeHtml(latest.filename)}</code>)...`, { parse_mode: 'HTML' });

  await bot.telegram.sendDocument(
    ctx.chat.id,
    { source: latest.filePath, filename: latest.filename },
    {
      caption:
        `🔄 <b>CETAK ULANG FILE TERAKHIR</b>\n\n` +
        `📄 <b>File:</b> <code>${escapeHtml(latest.filename)}</code>\n` +
        `⏰ <b>Waktu Cetak:</b> ${dateFormatted} WIB\n\n` +
        `<i>File ini dikirim ulang dari arsip tanpa mengubah antrean aktif saat ini.</i>`,
      parse_mode: 'HTML',
    }
  ).catch(err => ctx.reply(`❌ Gagal mengirim ulang file: ${err.message}`));
}

bot.command(['ulang', 'reprint', 'terakhir', 'last'], handleReprint);

// Single label urgent print (/cetak_ini)
async function handlePrintSingle(ctx) {
  updateActiveChat(ctx.chat.id);
  if (!ctx.message || !ctx.message.reply_to_message) {
    return ctx.reply(
      `💡 <b>Cara Cetak Urgent Satuan:</b>\n` +
      `Balas (reply) pesan file PDF atau teks /manual yang dimaksud dengan mengetik <code>/cetak_ini</code>.`,
      { parse_mode: 'HTML' }
    );
  }

  const targetMsgId = ctx.message.reply_to_message.message_id;
  const items = queueService.getQueueItems();
  const item = items.find(it => it.messageId && it.messageId === targetMsgId);

  if (!item || !fs.existsSync(item.filePath)) {
    return ctx.reply(`⚠️ Resi dari pesan tersebut tidak ditemukan di antrean aktif.`);
  }

  await ctx.reply(`⚡ Menyiapkan resi urgent satuan: <b>${escapeHtml(item.title)}</b>...`, { parse_mode: 'HTML' });
  await bot.telegram.sendDocument(
    ctx.chat.id,
    { source: item.filePath, filename: `URGENT_${path.basename(item.filePath)}` },
    {
      caption:
        `⚡ <b>RESI URGENT SATUAN SIAP CETAK</b>\n\n` +
        `📄 <b>Item:</b> ${escapeHtml(item.title)}\n` +
        `<i>Resi tetap berada di antrean reguler, atau balas "batal" jika tidak ingin dicetak lagi saat batch.</i>`,
      parse_mode: 'HTML',
    }
  ).catch(err => ctx.reply(`❌ Gagal mengirim file urgent: ${err.message}`));
}

bot.command(['cetak_ini', 'print_ini', 'urgent'], handlePrintSingle);

// Cancellation handler (/batal [nomor] atau via reply)
function handleCancelCommand(ctx) {
  updateActiveChat(ctx.chat.id);
  const text = ctx.message ? ctx.message.text.trim() : '';

  // 1. If user replied to a message
  if (ctx.message && ctx.message.reply_to_message) {
    const targetMsgId = ctx.message.reply_to_message.message_id;
    const res = queueService.cancelQueueItemByMessageId(targetMsgId);
    if (res.found) {
      return ctx.reply(
        `🗑️ <b>Resi Berhasil Dibatalkan!</b>\n` +
        `📄 <b>Item:</b> ${escapeHtml(res.item.title)}\n` +
        `📦 Sisa antrean: <b>${res.totalInQueue}</b> resi\n` +
        `<i>Resi telah dikeluarkan dari antrean cetak.</i>`,
        { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
      );
    } else {
      return ctx.reply(
        `⚠️ Resi dari pesan tersebut tidak ditemukan di antrean aktif (mungkin sudah pernah dicetak sebelumnya atau bukan resi yang aktif).`,
        { reply_to_message_id: ctx.message.message_id }
      );
    }
  }

  // 2. If user specified a number (e.g. /batal 2)
  const parts = text.split(/\s+/);
  if (parts.length > 1 && /^\d+$/.test(parts[1])) {
    const idx = parseInt(parts[1], 10);
    const res = queueService.cancelQueueItemByIndex(idx);
    if (res.found) {
      return ctx.reply(
        `🗑️ <b>Resi No. ${idx} Berhasil Dibatalkan!</b>\n` +
        `📄 <b>Item:</b> ${escapeHtml(res.item.title)}\n` +
        `📦 Sisa antrean: <b>${res.totalInQueue}</b> resi`,
        { parse_mode: 'HTML' }
      );
    } else {
      return ctx.reply(`⚠️ Tidak ditemukan resi nomor ${idx}. Ketik /list untuk melihat nomor urut antrean.`);
    }
  }

  // 3. Instruction if /batal was typed alone without reply or index
  return ctx.reply(
    `💡 <b>Cara Membatalkan Paket Resi:</b>\n\n` +
    `1. <b>Cara Termudah:</b> Cukup balas (reply) pesan resi/PDF yang ingin dibatalkan dengan mengetik kata <b>batal</b>.\n` +
    `2. <b>Berdasarkan Nomor Antrean:</b> Ketik <code>/batal [nomor]</code> (contoh: <code>/batal 2</code>). Cek nomor urut dengan mengetik /list.\n` +
    `3. <b>Kosongkan Semua Antrean:</b> Ketik <code>/reset_semua</code> (khusus admin).`,
    { parse_mode: 'HTML' }
  );
}

bot.command(['batal', 'cancel', 'hapus'], handleCancelCommand);

// Reset all queue command
bot.command(['reset_semua', 'clear_all'], adminOnly, (ctx) => {
  updateActiveChat(ctx.chat.id);
  const deletedCount = queueService.clearQueue();
  ctx.reply(`🗑️ Seluruh antrean berhasil dikosongkan oleh Admin. Sebanyak <b>${deletedCount}</b> resi dihapus.`, {
    parse_mode: 'HTML',
  }).catch(() => {});
});

// Check chat ID
bot.command('id', (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from ? ctx.from.id : chatId;
  const isAdminUser = config.isAdmin(userId) || config.isAdmin(chatId);
  const isAllowed = config.isAllowedChat(chatId);

  let statusBadge = 'Belum terdaftar di .env';
  if (isAdminUser) {
    statusBadge = '👑 Admin';
  } else if (isAllowed) {
    statusBadge = '✅ Grup/User Terverifikasi';
  }

  const msg =
    `🆔 <b>Informasi Identitas Telegram:</b>\n\n` +
    `• <b>Chat ID:</b> <code>${chatId}</code> (${escapeHtml(ctx.chat.title || ctx.chat.first_name || 'Private')})\n` +
    `• <b>User ID Anda:</b> <code>${userId}</code>\n` +
    `• <b>Status Izin:</b> ${statusBadge}\n\n` +
    `💡 <i>Salin ID di atas dan masukkan ke file <code>.env</code> pada <code>ADMIN_CHAT_ID</code> atau <code>ALLOWED_GROUP_ID</code> untuk mengunci akses bot jika diperlukan.</i>`;

  ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});
});

// Handler for /manual input (with deduplication & revision via reply)
async function handleManualInput(ctx) {
  updateActiveChat(ctx.chat.id);
  const rawText = (ctx.message && ctx.message.text) ? ctx.message.text.trim() : '';
  const body = rawText.replace(/^\/manual(@\w+)?\s*/i, '').trim();

  // If user typed only /manual without body, send the template format
  if (!body || body.length < 5) {
    return sendManualTemplate(ctx);
  }

  try {
    const senderName = ctx.from ? (ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name) : 'Staff';
    const replyToMessageId = ctx.message.reply_to_message ? ctx.message.reply_to_message.message_id : null;

    const res = await queueService.addTextToQueue({
      rawText: body,
      messageId: ctx.message.message_id,
      chatId: ctx.chat.id,
      senderName: senderName,
      replyToMessageId: replyToMessageId,
    });

    // Scenario: Revision
    if (res.isRevision) {
      return await ctx.reply(
        `✏️ <b>Data Resi Berhasil Diperbarui! (Revisi Alamat)</b>\n` +
        `👤 <b>Penerima:</b> ${escapeHtml(res.parsed.recipient)}\n` +
        `📞 <b>No HP:</b> ${escapeHtml(res.parsed.phone)}\n` +
        (res.parsed.keterangan ? `📝 <b>Keterangan:</b> ${escapeHtml(res.parsed.keterangan)}\n` : '') +
        `📦 Total antrean: <b>${res.totalInQueue}</b> resi (data lama telah digantikan).`,
        { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
      );
    }

    // Scenario: Duplicate
    if (res.isDuplicate) {
      return await ctx.reply(
        `⚠️ <b>Resi Manual Duplikat Terdeteksi!</b>\n` +
        `Data atas nama <b>${escapeHtml(res.existingItem.recipient || res.existingItem.title)}</b> (${escapeHtml(res.existingItem.phone)}) sudah ada di antrean.\n` +
        `<i>Jika ingin mengganti/merevisi alamat, silakan balas (reply) pesan yang lama dengan format baru.</i>`,
        { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
      );
    }

    // Normal Success
    const replyMsg =
      `✅ <b>Resi Manual Diterima!</b>\n` +
      `👤 <b>Nama:</b> ${escapeHtml(res.parsed.recipient)}\n` +
      `📞 <b>No HP:</b> ${escapeHtml(res.parsed.phone)}\n` +
      (res.parsed.keterangan ? `📝 <b>Keterangan:</b> ${escapeHtml(res.parsed.keterangan)}\n` : '') +
      `📦 Antrean belum cetak: <b>${res.totalInQueue}</b> resi\n` +
      `<i>Ketik /cetak untuk proses atau /list untuk melihat daftar.</i>`;

    return await ctx.reply(replyMsg, {
      parse_mode: 'HTML',
      reply_to_message_id: ctx.message.message_id,
    });
  } catch (err) {
    console.error('Gagal memproses teks resi manual:', err);
    return await ctx.reply(`❌ Gagal memproses resi manual: ${escapeHtml(err.message)}`, {
      reply_to_message_id: ctx.message.message_id,
    });
  }
}

// Register /manual as a command
bot.command('manual', handleManualInput);

// Handle incoming documents (PDF Resi with deduplication)
bot.on('document', async (ctx) => {
  updateActiveChat(ctx.chat.id);
  const doc = ctx.message.document;
  const fileName = doc.file_name || 'resi.pdf';
  const isPdf = (doc.mime_type === 'application/pdf') || fileName.toLowerCase().endsWith('.pdf');

  if (!isPdf) {
    return; // Ignore non-PDF documents
  }

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const response = await fetch(fileLink.href);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const senderName = ctx.from ? (ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name) : 'Staff';

    const res = await queueService.addPdfToQueue({
      filename: fileName,
      buffer: buffer,
      messageId: ctx.message.message_id,
      chatId: ctx.chat.id,
      senderName: senderName,
    });

    if (res.isDuplicate) {
      return ctx.reply(
        `⚠️ <b>File Duplikat Ditolak!</b>\n` +
        `File <code>${escapeHtml(fileName)}</code> sudah ada di dalam antrean.\n` +
        `<i>Tidak dimasukkan ganda agar kertas stiker tidak terbuang.</i>`,
        { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
      ).catch(() => {});
    }

    ctx.reply(
      `📥 <b>PDF Resi Diterima!</b>\n` +
      `📄 <code>${escapeHtml(fileName)}</code>\n` +
      `📦 Antrean belum cetak: <b>${res.totalInQueue}</b> resi\n` +
      `<i>Ketik /cetak untuk satukan ke PDF A4.</i>`,
      { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
    ).catch(() => {});
  } catch (err) {
    console.error('Gagal mengunduh dokumen:', err);
    ctx.reply(`❌ Gagal menyimpan file resi: ${escapeHtml(err.message)}`, {
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
  }
});

// Handle incoming photos/screenshots
bot.on('photo', async (ctx) => {
  updateActiveChat(ctx.chat.id);
  const photos = ctx.message.photo;
  if (!photos || photos.length === 0) return;

  const bestPhoto = photos[photos.length - 1];

  try {
    const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
    const response = await fetch(fileLink.href);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const senderName = ctx.from ? (ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name) : 'Staff';

    const res = await queueService.addImageToQueue({
      filename: `screenshot_${Date.now()}`,
      buffer: buffer,
      messageId: ctx.message.message_id,
      chatId: ctx.chat.id,
      senderName: senderName,
    });

    if (res.isDuplicate) {
      return ctx.reply(
        `⚠️ <b>Gambar Duplikat Ditolak!</b>\nGambar resi ini sudah pernah dimasukkan ke antrean.`,
        { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
      ).catch(() => {});
    }

    ctx.reply(
      `📸 <b>Gambar Resi Diterima!</b>\n` +
      `📦 Antrean belum cetak: <b>${res.totalInQueue}</b> resi\n` +
      `<i>Ketik /cetak jika ingin proses langsung.</i>`,
      { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
    ).catch(() => {});
  } catch (err) {
    console.error('Gagal mengunduh foto resi:', err);
    ctx.reply(`❌ Gagal memproses gambar resi: ${escapeHtml(err.message)}`, {
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
  }
});

// Handle general text messages (catches multi-line /manual, or reply with "batal" / "cancel")
bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  const lower = text.toLowerCase();
  updateActiveChat(ctx.chat.id);

  // 1. Check if user replies with "batal" / "cancel" to cancel an order
  if (['batal', '/batal', 'cancel', '/cancel', 'hapus', '/hapus'].includes(lower)) {
    return handleCancelCommand(ctx);
  }

  // 2. Check multi-line /manual messages
  if (lower.startsWith('/manual')) {
    return handleManualInput(ctx);
  }

  // All other normal text chats in group are completely ignored so members can chat freely!
  return next();
});

// Initialize Cron Scheduler (Every day at 14:00 WIB by default)
initScheduler(async () => {
  const targetId = config.getPrimaryTargetChatId() || lastActiveChatId;
  if (!targetId) {
    console.log('[CRON] Peringatan: Tidak ada Target Chat ID resmi untuk mengirim hasil gabungan.');
    return;
  }
  console.log(`[CRON] Menjalankan penggabungan batch otomatis jam 14:00 ke chat ${targetId}...`);
  await processBatchAndSend(targetId, 'cron');
});

// Launch Bot
bot.telegram.getMe().then((me) => {
  const secStatus = config.isSecurityActive()
    ? '🔒 AKTIF (Hanya merespons Admin & Grup terdaftar)'
    : '⚠️ TERBUKA (Belum ada ID terdaftar di .env)';

  console.log(`
============================================================
🤖 BOT RESI TELEGRAM (@${me.username}) BERHASIL AKTIF!
============================================================
• Waktu Mulai    : ${new Date().toLocaleString('id-ID')}
• Folder Antrean : ${config.PATHS.QUEUE}
• Folder Output  : ${config.PATHS.OUTPUT} (Organized by Date)
• Fitur Baru     : Cancel via Reply "batal", Anti-Dobel,
                   Revisi /manual, Audit /list, Reprint /ulang
• Jadwal Cron    : ${(!config.CRON_SCHEDULE || ['disabled', 'false', 'none', 'off'].includes(config.CRON_SCHEDULE.toLowerCase())) ? 'DINONAKTIFKAN (Manual via /cetak)' : config.CRON_SCHEDULE}
============================================================
Bot siap menerima PDF & Teks /manual di Telegram!
Tekan CTRL + C di terminal untuk menghentikan.
`);
  return bot.launch({
    dropPendingUpdates: false,
  });
}).catch((err) => {
  console.error('[BOT ERROR] Gagal menjalankan bot:', err.message);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
