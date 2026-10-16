const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const queueService = require('./src/queueService');
const { mergeLabelsToA4, parseShippingText } = require('./src/pdfService');
const { getManifestForQueue, formatListMessage, formatPackingSummary } = require('./src/manifestService');
const { printPdfMonochrome, getAvailablePrinters } = require('./src/printerService');
const { initScheduler } = require('./src/cronService');
const { authMiddleware, adminOnly } = require('./src/authMiddleware');
const financeService = require('./src/financeService');
const productCatalogService = require('./src/productCatalogService');
const ocrService = require('./src/ocrService');

// Global Process Error Handlers to keep Node process resilient
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err && err.message ? err.message : err);
});

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

// Silence unnecessary standardFontDataUrl warning from pdfjs
const originalWarn = console.warn;
console.warn = function(...args) {
  if (typeof args[0] === 'string' && args[0].includes('standardFontDataUrl')) return;
  originalWarn.apply(console, args);
};

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

// Helper to check if a Telegram message still exists in the chat (detects deleted/pulled messages)
async function isMessageAlive(chatId, messageId) {
  if (!chatId || !messageId) return true;
  try {
    await bot.telegram.editMessageReplyMarkup(chatId, messageId, null, {});
    return true;
  } catch (err) {
    if (err.message && err.message.includes('message to edit not found')) {
      return false; // Pesan telah dihapus/ditarik dari chat!
    }
    return true; // Pesan masih ada di grup
  }
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
  { command: 'print', description: '🖨️ Cetak fisik EPSON L3250 + kirim PDF & rekap' },
  { command: 'gabung', description: '📄 Gabung PDF A4 & rekap saja (tanpa print fisik)' },
  { command: 'cetak', description: '🖨️ Cetak langsung ke EPSON L3250 (alias /print)' },
  { command: 'list', description: '📋 Cek daftar antrean: Nama, Barang, SKU, Qty' },
  { command: 'status', description: '📊 Cek jumlah total resi menunggu' },
  { command: 'ulang', description: '🔄 Kirim ulang file cetak PDF terakhir' },
  { command: 'manual', description: '📝 Ambil contoh format resi manual' },
  { command: 'harga', description: '💰 Tandai harga resi (reply file + nominal)' },
  { command: 'batal', description: '🗑️ Batalkan resi (reply chat dengan kata "batal")' },
];

bot.telegram.setMyCommands(COMMANDS_LIST).catch(() => {});
bot.telegram.setMyCommands(COMMANDS_LIST, { scope: { type: 'all_group_chats' } }).catch(() => {});
bot.telegram.setMyCommands(COMMANDS_LIST, { scope: { type: 'all_private_chats' } }).catch(() => {});

/**
 * Perform merge and send output to chat (organized into storage/output/YYYY-MM-DD/)
 */
async function processBatchAndSend(chatId, triggeredBy = 'manual', directPrint = false) {
  // Pre-validation: detect & discard any receipts whose Telegram messages were deleted/pulled
  const currentItems = queueService.getQueueItems();
  const deletedItems = [];
  for (const item of currentItems) {
    if (item.messageId && item.chatId) {
      const alive = await isMessageAlive(item.chatId, item.messageId);
      if (!alive) {
        queueService.cancelQueueItemByMessageId(item.messageId);
        deletedItems.push(item);
      }
    }
  }

  if (deletedItems.length > 0 && chatId) {
    const listNames = deletedItems.map(d => `• ${escapeHtml(d.title || d.fileName)}`).join('\n');
    await bot.telegram.sendMessage(
      chatId,
      `ℹ️ <b>Pembersihan Resi Ditarik:</b>\nSebanyak <b>${deletedItems.length}</b> resi otomatis dikeluarkan karena pesannya telah dihapus di grup:\n${listNames}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

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
    const printNote = directPrint ? ' & mengirim ke printer...' : '...';
    statusMsg = await bot.telegram.sendMessage(
      chatId,
      `⏳ Menyusun <b>${count}</b> resi ke dalam PDF A4 (Grid 2x2)${printNote}`,
      { parse_mode: 'HTML' }
    ).catch(() => null);
  }

  try {
    console.log(`[BATCH START] Memproses ${count} resi (directPrint: ${directPrint})...`);
    const mergeResult = await mergeLabelsToA4(queueFiles, outputPath);
    console.log(`[BATCH MERGED] Sukses gabung ${mergeResult.totalLabels} resi ke ${outputPath} (${mergeResult.totalPages} lembar A4).`);

    // Send the compiled PDF document
    if (chatId) {
      console.log(`[BATCH SEND] Mengirim file PDF ke chat ${chatId}...`);
      await bot.telegram.sendDocument(
        chatId,
        { source: outputPath, filename: outputFileName },
        {
          caption: `✅ <b>PDF Siap Cetak:</b> ${mergeResult.totalLabels} resi (${mergeResult.totalPages} lembar A4)\n` +
                   `⏰ ${now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} WIB`,
          parse_mode: 'HTML',
        }
      );

      if (statusMsg) {
        try {
          await bot.telegram.deleteMessage(chatId, statusMsg.message_id);
        } catch (_) {}
      }
    }

    // Generate Packing Manifest Summary
    let manifestText = '';
    try {
      const activeItems = currentItems.filter(it => !deletedItems.includes(it));
      const manifestList = await getManifestForQueue(activeItems);
      manifestText = formatPackingSummary(manifestList, `${dateStr} ${timeStr.replace('-', ':')} WIB`);
    } catch (mErr) {
      console.error('Gagal membuat manifest summary:', mErr);
    }

    if (chatId && manifestText) {
      console.log(`[BATCH MANIFEST] Mengirim rekap packing barang...`);
      await bot.telegram.sendMessage(chatId, manifestText, { parse_mode: 'HTML' }).catch(() => {});
    }

    // Automatic Silent Financial Recording to Google Sheets (Background)
    try {
      console.log(`[BATCH FINANCE] Memproses pencatatan keuangan batch ke Google Sheets secara silent di background...`);
      const activeItems = currentItems.filter(it => !deletedItems.includes(it));
      const manifestList = await getManifestForQueue(activeItems);
      await financeService.recordBatchTransactions(manifestList, batchId);
      console.log(`[BATCH FINANCE] Pencatatan keuangan batch ${batchId} ke Google Sheets selesai.`);
    } catch (fErr) {
      console.error('[FINANCE ERROR] Gagal memproses laporan keuangan:', fErr.message);
    }

    // Direct Silent Printing to Physical Printer in Monochrome (Hitam Putih)
    if (directPrint) {
      console.log(`[BATCH PRINT] Mengirim file ${outputPath} ke printer fisik...`);
      const printRes = await printPdfMonochrome(outputPath);
      if (chatId) {
        if (printRes.success) {
          await bot.telegram.sendMessage(
            chatId,
            `🖨️ <b>Perintah Cetak Berhasil Dikirim ke Printer Fisik!</b>\n` +
            `• <b>Printer:</b> <b>${escapeHtml(printRes.printer)}</b>\n` +
            `• <b>Warna:</b> Hitam Putih (Monochrome)\n` +
            `• <b>Total:</b> ${mergeResult.totalPages} lembar A4\n\n` +
            `<i>Dokumen sedang diproses printer fisik. Anda tidak perlu tekan Ctrl+P manual.</i>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        } else {
          await bot.telegram.sendMessage(
            chatId,
            `⚠️ <b>Gagal Kirim ke Printer Fisik:</b> ${escapeHtml(printRes.error)}\n` +
            `<i>File PDF aman terkirim di atas, Anda tetap dapat mencetak manual lewat PDF.</i>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      }
    }

    // Archive processed queue files organized into storage/archive/YYYY-MM-DD/batchId/
    queueService.archiveQueue(batchId);
    console.log(`[BATCH SUCCESS] ${mergeResult.totalLabels} resi digabung ke ${outputFileName} (diarsipkan ke ${batchId})`);
  } catch (err) {
    console.error('[MERGE ERROR]', err);
    if (statusMsg && chatId) {
      try {
        await bot.telegram.deleteMessage(chatId, statusMsg.message_id);
      } catch (_) {}
    }
    if (chatId) {
      await bot.telegram.sendMessage(chatId, `❌ Gagal memproses resi: ${escapeHtml(err.message)}`).catch(() => {});
    }
  }
}

// Format template text
function sendManualTemplate(ctx) {
  updateActiveChat(ctx.chat.id);
  const templateMsg =
    `📋 <b>Format Resi Manual:</b>\n\n` +
    `<pre>/manual\nNama: \nAlamat: \nNo HP: \nToko: \nHarga: \nKeterangan: </pre>\n\n` +
    `💡 <i>Toko & Harga otomatis masuk ke pembukuan (tidak dicetak ke label kertas fisik).</i>`;

  ctx.reply(templateMsg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Klik Untuk Salin Format /manual', copy_text: { text: '/manual\nNama: \nAlamat: \nNo HP: \nToko: \nHarga: \nStatus: \nKeterangan: ' } }]
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
    `📊 <b>Antrean Belum Cetak:</b> <b>${count}</b> resi (${pagesEstimate} lembar A4)\n` +
    (count > 0
      ? `👉 Ketik <b>/cetak</b> untuk proses, atau <b>/list</b> untuk cek rincian.`
      : `<i>Belum ada resi yang menunggu.</i>`);

  ctx.reply(text, { parse_mode: 'HTML' }).catch(() => {});
}

bot.command('status', sendStatus);

// List / Daftar command (Audit rincian antrean: Nama, Barang, SKU, Qty)
async function sendQueueList(ctx) {
  updateActiveChat(ctx.chat.id);
  const items = queueService.getQueueItems();
  if (items.length === 0) {
    return ctx.reply(
      `📭 <b>Antrean Masih Kosong</b>\nBelum ada resi yang menunggu cetak saat ini. Silakan kirim file PDF atau ketik /manual.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  try {
    const manifestList = await getManifestForQueue(items);
    const listText = formatListMessage(manifestList);
    ctx.reply(listText, { parse_mode: 'HTML' }).catch(() => {});
  } catch (err) {
    console.error('Gagal membuat daftar antrean:', err);
    ctx.reply(`❌ Gagal membaca antrean: ${escapeHtml(err.message)}`).catch(() => {});
  }
}

bot.command(['list', 'daftar', 'antrean', 'queue'], sendQueueList);

// Gabung command (Generates A4 PDF & Sends Packing List without physical printing)
async function handlePrint(ctx) {
  updateActiveChat(ctx.chat.id);
  await processBatchAndSend(ctx.chat.id, 'manual', false);
}

// Print / Cetak command (Generates A4 PDF, Sends Packing List & Prints Monochrome to EPSON L3250)
async function handleDirectPrint(ctx) {
  updateActiveChat(ctx.chat.id);
  await processBatchAndSend(ctx.chat.id, 'manual', true);
}

bot.command(['gabung', 'gabungkan'], handlePrint);
bot.command(['print', 'cetak', 'cetak_langsung', 'direct_print', 'print_langsung'], handleDirectPrint);

// Check printer status command
bot.command(['printer', 'cek_printer'], async (ctx) => {
  updateActiveChat(ctx.chat.id);
  const printers = await getAvailablePrinters();
  const defPrinter = config.PRINTER_NAME || 'EPSON L3250 Series';
  const pList = printers.map(p => `• ${p.name === defPrinter ? '⭐ ' : ''}<b>${escapeHtml(p.name)}</b>`).join('\n') || 'Tidak ada printer terdeteksi';
  ctx.reply(
    `🖨️ <b>INFORMASI PRINTER KOMPUTER:</b>\n\n` +
    `• <b>Printer Aktif:</b> <b>${escapeHtml(defPrinter)}</b>\n` +
    `• <b>Mode Warna:</b> Hitam Putih (Monochrome)\n\n` +
    `<b>Daftar Printer Terdeteksi di Windows:</b>\n${pList}\n\n` +
    `👉 <i>Ketik /print untuk cetak langsung ke printer fisik tanpa perlu buka PDF.</i>`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
});

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

  const alive = await isMessageAlive(ctx.chat.id, ctx.message.message_id);
  if (!alive) return;

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
        (res.parsed.toko ? `🏪 <b>Toko:</b> ${escapeHtml(res.parsed.toko)}\n` : '') +
        (res.parsed.nominal > 0 ? `💰 <b>Harga:</b> Rp ${res.parsed.nominal.toLocaleString('id-ID')}\n` : '') +
        (res.parsed.keterangan ? `📝 <b>Keterangan:</b> ${escapeHtml(res.parsed.keterangan)}\n` : '') +
        `📦 Total antrean: <b>${res.totalInQueue}</b> resi (data lama telah digantikan).`,
        { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
      );
    }

    // Scenario: Duplicate
    if (res.isDuplicate) {
      const orig = res.existingItem || {};
      const senderInfo = orig.senderName ? ` oleh <b>${escapeHtml(orig.senderName)}</b>` : '';
      const timeInfo = orig.createdAt ? ` pada ${new Date(orig.createdAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} WIB` : '';

      return await ctx.reply(
        `⚠️ <b>Resi Manual Duplikat Ditolak!</b>\n` +
        `Data penerima <b>${escapeHtml(orig.recipient || orig.title)}</b> (${escapeHtml(orig.phone)}) sama persis dengan yang sudah dikirim${senderInfo}${timeInfo}.`,
        { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
      );
    }

    // Normal Success
    const infoParts = [];
    if (res.parsed.toko) infoParts.push(`🏪 ${escapeHtml(res.parsed.toko)}`);
    if (res.parsed.nominal > 0) infoParts.push(`💰 <b>${financeService.formatRupiah(res.parsed.nominal)}</b>`);
    if (res.parsed.keterangan) {
      const ketShort = res.parsed.keterangan.length > 25 ? res.parsed.keterangan.slice(0, 25) + '...' : res.parsed.keterangan;
      infoParts.push(escapeHtml(ketShort));
    }

    const replyMsg =
      `✅ <b>Manual Diterima:</b> <b>${escapeHtml(res.parsed.recipient)}</b>${res.parsed.phone && res.parsed.phone !== '-' ? ` (${escapeHtml(res.parsed.phone)})` : ''}\n` +
      (infoParts.length > 0 ? infoParts.join(' • ') + '\n' : '') +
      `📦 Antrean: <b>${res.totalInQueue}</b> resi`;

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

  const alive = await isMessageAlive(ctx.chat.id, ctx.message.message_id);
  if (!alive) {
    console.log(`[SKIP DELETED] Dokumen ID ${ctx.message.message_id} (${fileName}) dilewati karena sudah dihapus di chat.`);
    return;
  }

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const response = await fetch(fileLink.href);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const senderName = ctx.from ? (ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name) : 'Staff';

    const caption = (ctx.message && ctx.message.caption) ? ctx.message.caption.trim() : '';
    const explicitPrice = caption ? productCatalogService.extractPriceFromText(caption) : 0;
    const explicitStore = caption ? productCatalogService.extractStoreFromText(caption) : '';

    const res = await queueService.addPdfToQueue({
      filename: fileName,
      buffer: buffer,
      messageId: ctx.message.message_id,
      chatId: ctx.chat.id,
      senderName: senderName,
      nominal: explicitPrice,
      toko: explicitStore,
      caption: caption,
    });

    if (res.isDuplicate) {
      const orig = res.existingItem || {};
      const senderInfo = orig.senderName ? ` oleh <b>${escapeHtml(orig.senderName)}</b>` : '';
      const timeInfo = orig.createdAt ? ` pada ${new Date(orig.createdAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} WIB` : '';

      return ctx.reply(
        `⚠️ <b>File Duplikat Ditolak!</b>\n` +
        `File <code>${escapeHtml(fileName)}</code> sama persis dengan file yang sudah dikirim${senderInfo}${timeInfo}.`,
        { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
      ).catch(() => {});
    }

    let metaNotice = '';
    if (explicitPrice > 0) {
      metaNotice = `💰 <b>${financeService.formatRupiah(explicitPrice)}</b>${explicitStore ? ` (${escapeHtml(explicitStore)})` : ''} • `;
    }

    const replyMsg = await ctx.reply(
      `📥 <b>PDF Diterima:</b> <code>${escapeHtml(fileName)}</code>\n` +
      `${metaNotice}📦 Antrean: <b>${res.totalInQueue}</b> resi`,
      { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
    ).catch(() => {});

    if (replyMsg && replyMsg.message_id) {
      queueService.setBotReplyMessageId(ctx.message.message_id, replyMsg.message_id);
    }
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

  const alive = await isMessageAlive(ctx.chat.id, ctx.message.message_id);
  if (!alive) return;

  const bestPhoto = photos[photos.length - 1];

  try {
    const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
    const response = await fetch(fileLink.href);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const senderName = ctx.from ? (ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name) : 'Staff';

    const caption = (ctx.message && ctx.message.caption) ? ctx.message.caption.trim() : '';
    const explicitPrice = caption ? productCatalogService.extractPriceFromText(caption) : 0;
    const explicitStore = caption ? productCatalogService.extractStoreFromText(caption) : '';

    // Run OCR detection on the photo
    let ocrText = '';
    let parsed = {};
    try {
      ocrText = await ocrService.recognizeReceiptImage(buffer);
      parsed = ocrService.parseReceiptOcrText(ocrText, {
        caption,
        explicitPrice,
        explicitStore,
        fileName: `foto_${Date.now()}`
      });
    } catch (ocrErr) {
      console.error('[OCR PHOTO ERROR]:', ocrErr.message);
    }

    const res = await queueService.addImageToQueue({
      filename: `foto_${(parsed && parsed.resi && parsed.resi !== '-') ? parsed.resi : Date.now()}`,
      buffer: buffer,
      messageId: ctx.message.message_id,
      chatId: ctx.chat.id,
      senderName: senderName,
      recipient: parsed.recipient || '-',
      phone: parsed.phone || '-',
      product: parsed.product || '-',
      sku: parsed.sku || '-',
      qty: parsed.qty || 1,
      resi: parsed.resi || '-',
      expedition: parsed.expedition || 'Ekspedisi (Foto)',
      nominal: (parsed.nominal && parsed.nominal > 0) ? parsed.nominal : explicitPrice,
      toko: parsed.toko || explicitStore,
      caption: caption,
      ocrText: ocrText,
      paymentMethod: parsed.paymentMethod || 'NON-COD',
      paymentStatus: 'TERKIRIM',
    });

    if (res.isDuplicate) {
      const orig = res.existingItem || {};
      const senderInfo = orig.senderName ? ` oleh <b>${escapeHtml(orig.senderName)}</b>` : '';
      const timeInfo = orig.createdAt ? ` pada ${new Date(orig.createdAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} WIB` : '';

      return ctx.reply(
        `⚠️ <b>Gambar Duplikat Ditolak!</b>\nGambar resi ini sama persis dengan yang sudah dikirim${senderInfo}${timeInfo}.`,
        { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
      ).catch(() => {});
    }

    const finalPriceVal = (parsed.nominal && parsed.nominal > 0) ? parsed.nominal : explicitPrice;
    const line1 = [];
    if (parsed.recipient && parsed.recipient !== '-' && parsed.recipient !== 'Penerima') {
      line1.push(`👤 <b>${escapeHtml(parsed.recipient)}</b>`);
    }
    if (parsed.resi && parsed.resi !== '-') {
      line1.push(`<code>${escapeHtml(parsed.resi)}</code>`);
    }
    if (parsed.toko) {
      line1.push(`🏪 <b>${escapeHtml(parsed.toko)}</b>`);
    }

    const line2 = [];
    if (parsed.product && parsed.product !== '-' && parsed.product !== 'Paket') {
      const prodShort = parsed.product.length > 28 ? parsed.product.slice(0, 28) + '...' : parsed.product;
      line2.push(escapeHtml(prodShort));
    }
    if (finalPriceVal > 0) {
      line2.push(`💰 <b>${financeService.formatRupiah(finalPriceVal)}</b>`);
    }

    let photoReplyText = `📸 <b>Foto Diterima</b>\n`;
    if (line1.length > 0) photoReplyText += line1.join(' • ') + '\n';
    if (line2.length > 0) photoReplyText += line2.join(' • ') + '\n';
    photoReplyText += `📦 Antrean: <b>${res.totalInQueue}</b> resi`;

    const replyMsg = await ctx.reply(
      photoReplyText,
      { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
    ).catch(() => {});

    if (replyMsg && replyMsg.message_id) {
      queueService.setBotReplyMessageId(ctx.message.message_id, replyMsg.message_id);
    }
  } catch (err) {
    console.error('Gagal mengunduh foto resi:', err);
    ctx.reply(`❌ Gagal memproses gambar resi: ${escapeHtml(err.message)}`, {
      reply_to_message_id: ctx.message.message_id,
    }).catch(() => {});
  }
});

// Handle general text messages (catches multi-line /manual, reply with "batal", or reply with price)
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

  // 3. Check if user replies to a PDF resi with price (e.g. "39000", "rp 39.000", "39rb", "harga 39000")
  if (ctx.message.reply_to_message) {
    const replyTargetMsgId = ctx.message.reply_to_message.message_id;
    const cleanText = text.replace(/^\/(?:harga|nominal|setharga)(?:@\w+)?\s*/i, '').trim();
    const priceFromText = productCatalogService.extractPriceFromText(cleanText || text);

    if (priceFromText > 0) {
      const storeFromText = productCatalogService.extractStoreFromText(cleanText || text);
      const updated = queueService.updateQueueItemPrice(replyTargetMsgId, priceFromText, storeFromText);

      if (updated) {
        const itemLabel = updated.title || updated.fileName || 'Resi';
        return ctx.reply(
          `💰 <b>Harga Diset:</b> <b>${financeService.formatRupiah(priceFromText)}</b>${storeFromText ? ` (${escapeHtml(storeFromText)})` : ''}\n` +
          `📄 <code>${escapeHtml(itemLabel)}</code>`,
          { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
        ).catch(() => {});
      }
    }
  }

  // All other normal text chats in group are completely ignored so members can chat freely!
  return next();
});

// Explicit command: /harga [nominal] (reply to PDF)
bot.command(['harga', 'setharga', 'nominal'], async (ctx) => {
  updateActiveChat(ctx.chat.id);
  const text = ctx.message.text.trim();
  const rawArg = text.replace(/^\/(?:harga|setharga|nominal)(?:@\w+)?\s*/i, '').trim();

  if (!ctx.message.reply_to_message) {
    return ctx.reply(
      `💡 <b>Cara Menandai Harga Resi:</b>\n` +
      `Balas (reply) file PDF resi yang dimaksud, lalu ketik nominal harganya (contoh: <code>39000</code>, <code>Rp 39.000</code>, atau <code>39rb</code>).`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  const replyTargetMsgId = ctx.message.reply_to_message.message_id;
  const priceFromText = productCatalogService.extractPriceFromText(rawArg);
  if (priceFromText <= 0) {
    return ctx.reply(
      `⚠️ Nominal harga tidak valid. Contoh: balas pesan PDF dengan <code>39000</code> atau <code>/harga 39.000</code>.`,
      { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
    ).catch(() => {});
  }

  const storeFromText = productCatalogService.extractStoreFromText(rawArg);
  const updated = queueService.updateQueueItemPrice(replyTargetMsgId, priceFromText, storeFromText);
  if (!updated) {
    return ctx.reply(
      `⚠️ Resi tersebut tidak ditemukan di antrean aktif saat ini (mungkin sudah dicetak atau dibatalkan).`,
      { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
    ).catch(() => {});
  }

  const itemLabel = updated.title || updated.fileName || 'Resi';
  return ctx.reply(
    `💰 <b>Harga Diset:</b> <b>${financeService.formatRupiah(priceFromText)}</b>${storeFromText ? ` (${escapeHtml(storeFromText)})` : ''}\n` +
    `📄 <code>${escapeHtml(itemLabel)}</code>`,
    { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id }
  ).catch(() => {});
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

  const catalogCount = productCatalogService.getMasterProducts().length;
  // Flush pending offline finance sync
  financeService.flushPendingTransactions().catch(() => {});

  console.log(`
============================================================
🤖 BOT RESI TELEGRAM (@${me.username}) BERHASIL AKTIF!
============================================================
• Waktu Mulai    : ${new Date().toLocaleString('id-ID')}
• Folder Antrean : ${config.PATHS.QUEUE}
• Folder Output  : ${config.PATHS.OUTPUT} (Organized by Date)
• Printer Fisik  : ${config.PRINTER_NAME || 'EPSON L3250 Series'} (Hitam Putih)
• Laporan Sheet  : ${config.GOOGLE_SHEET_WEBHOOK_URL ? '🟢 Webhook Google Sheets Terpasang' : '⚠️ Offline Mode (storage/pending_finance.json)'}
• Master Katalog : 📦 ${catalogCount} produk aktif (storage/master_products.csv)
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
