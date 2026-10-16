const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PATHS } = require('./config');
const { createLabelFromText, parseShippingText, convertImageToPdf } = require('./pdfService');

const META_FILE = path.join(PATHS.STORAGE, 'queue_meta.json');

// Ensure directories exist
function ensureDirs(dateStr) {
  const dirs = [PATHS.STORAGE, PATHS.QUEUE, PATHS.OUTPUT, PATHS.ARCHIVE];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  if (dateStr) {
    const outputDateDir = path.join(PATHS.OUTPUT, dateStr);
    const archiveDateDir = path.join(PATHS.ARCHIVE, dateStr);
    const cancelledDateDir = path.join(PATHS.ARCHIVE, dateStr, 'cancelled');
    [outputDateDir, archiveDateDir, cancelledDateDir].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
  }
}

const todayStr = () => new Date().toISOString().slice(0, 10);
ensureDirs(todayStr());

/**
 * Load queue metadata from JSON
 */
function loadMeta() {
  ensureDirs();
  if (!fs.existsSync(META_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(META_FILE, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.error('Gagal membaca queue_meta.json:', err.message);
    return [];
  }
}

/**
 * Save queue metadata to JSON
 */
function saveMeta(list) {
  ensureDirs();
  try {
    fs.writeFileSync(META_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.error('Gagal menyimpan queue_meta.json:', err.message);
  }
}

/**
 * Calculate MD5 hash for buffer
 */
function getHash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function normalizePath(p) {
  if (!p) return '';
  return path.resolve(p).toLowerCase();
}

/**
 * Synchronize metadata with actual disk files in storage/queue/
 */
function syncQueue() {
  ensureDirs();
  const existingFiles = fs.readdirSync(PATHS.QUEUE)
    .filter(file => file.toLowerCase().endsWith('.pdf'))
    .map(file => path.resolve(PATHS.QUEUE, file));

  let metaList = loadMeta();

  // 1. Remove entries whose files no longer exist on disk
  metaList = metaList.filter(item => item && item.filePath && fs.existsSync(item.filePath));

  // 2. Deduplicate metaList by normalized lower-case path (keep items with messageId/sender over auto-created)
  metaList.sort((a, b) => {
    const aScore = (a.messageId ? 10 : 0) + (a.senderName && a.senderName !== 'Sistem' ? 5 : 0);
    const bScore = (b.messageId ? 10 : 0) + (b.senderName && b.senderName !== 'Sistem' ? 5 : 0);
    return bScore - aScore;
  });

  const dedupedMeta = [];
  const seenPaths = new Set();
  for (const item of metaList) {
    const norm = normalizePath(item.filePath);
    if (!seenPaths.has(norm)) {
      seenPaths.add(norm);
      item.filePath = path.resolve(item.filePath);
      dedupedMeta.push(item);
    }
  }
  metaList = dedupedMeta;

  // 3. Add untracked files found on disk
  for (const filePath of existingFiles) {
    const norm = normalizePath(filePath);
    if (!seenPaths.has(norm)) {
      const baseName = path.basename(filePath);
      let fileHash = '';
      try {
        fileHash = getHash(fs.readFileSync(filePath));
      } catch (_) {}

      // If an item in meta already has this hash, point it to this file
      const existingHashItem = metaList.find(it => it.fileHash && it.fileHash === fileHash);
      if (existingHashItem) {
        existingHashItem.filePath = filePath;
        seenPaths.add(norm);
        continue;
      }

      const newItem = {
        id: `auto_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        fileName: baseName,
        filePath: filePath,
        type: baseName.includes('text_resi') ? 'manual' : 'pdf',
        title: baseName,
        fileHash: fileHash,
        messageId: null,
        chatId: null,
        senderName: 'Sistem',
        createdAt: new Date().toISOString(),
        dateStr: todayStr(),
      };
      metaList.push(newItem);
      seenPaths.add(norm);
    }
  }

  saveMeta(metaList);
  return metaList;
}

/**
 * Add incoming PDF to the queue with deduplication and metadata
 */
async function addPdfToQueue(arg1, arg2) {
  const dateStr = todayStr();
  ensureDirs(dateStr);

  let filename, buffer, messageId, chatId, senderName;
  if (typeof arg1 === 'object' && arg1.buffer) {
    filename = arg1.filename || 'resi.pdf';
    buffer = arg1.buffer;
    messageId = arg1.messageId || null;
    chatId = arg1.chatId || null;
    senderName = arg1.senderName || 'Staff';
  } else {
    filename = arg1;
    buffer = arg2;
    messageId = null;
    chatId = null;
    senderName = 'Staff';
  }

  const fileHash = getHash(buffer);
  const metaList = syncQueue();

  // Check duplicate in current queue
  const duplicate = metaList.find(item => item.fileHash === fileHash);
  if (duplicate) {
    return {
      isDuplicate: true,
      existingItem: duplicate,
      totalInQueue: metaList.length,
    };
  }

  const safeName = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const timestamp = Date.now();
  const targetPath = path.join(PATHS.QUEUE, `${timestamp}_${safeName}`);
  fs.writeFileSync(targetPath, buffer);

  const newItem = {
    id: `pdf_${timestamp}`,
    fileName: filename,
    filePath: targetPath,
    type: 'pdf',
    title: filename,
    fileHash: fileHash,
    nominal: (typeof arg1 === 'object' && arg1.nominal) ? arg1.nominal : 0,
    toko: (typeof arg1 === 'object' && arg1.toko) ? arg1.toko : '',
    caption: (typeof arg1 === 'object' && arg1.caption) ? arg1.caption : '',
    botReplyMessageId: null,
    messageId: messageId,
    chatId: chatId,
    senderName: senderName,
    createdAt: new Date().toISOString(),
    dateStr: dateStr,
  };

  metaList.push(newItem);
  saveMeta(metaList);

  return {
    isDuplicate: false,
    filePath: targetPath,
    item: newItem,
    totalInQueue: metaList.length,
  };
}

/**
 * Convert plain text to A6 PDF and add to the queue (supports revision via reply)
 */
async function addTextToQueue(arg1) {
  const dateStr = todayStr();
  ensureDirs(dateStr);

  let rawText, messageId, chatId, senderName, replyToMessageId;
  if (typeof arg1 === 'object' && arg1.rawText) {
    rawText = arg1.rawText;
    messageId = arg1.messageId || null;
    chatId = arg1.chatId || null;
    senderName = arg1.senderName || 'Staff';
    replyToMessageId = arg1.replyToMessageId || null;
  } else {
    rawText = arg1;
    messageId = null;
    chatId = null;
    senderName = 'Staff';
    replyToMessageId = null;
  }

  const parsed = parseShippingText(rawText);
  let metaList = syncQueue();

  // Scenario: Revision (User replied to an earlier /manual message with updated data)
  if (replyToMessageId) {
    const oldIndex = metaList.findIndex(item => item.messageId === replyToMessageId);
    if (oldIndex !== -1) {
      const oldItem = metaList[oldIndex];
      // Delete old PDF file from queue
      if (fs.existsSync(oldItem.filePath)) {
        try { fs.unlinkSync(oldItem.filePath); } catch (_) {}
      }

      // Generate new updated PDF
      const pdfBuffer = await createLabelFromText(rawText);
      const timestamp = Date.now();
      const targetPath = path.join(PATHS.QUEUE, `${timestamp}_text_resi.pdf`);
      fs.writeFileSync(targetPath, pdfBuffer);

      const updatedItem = {
        ...oldItem,
        filePath: targetPath,
        title: `${parsed.recipient} - ${parsed.address.slice(0, 30)}`,
        recipient: parsed.recipient,
        address: parsed.address,
        phone: parsed.phone,
        toko: parsed.toko || '',
        sip: parsed.sip || '',
        keterangan: parsed.keterangan || '',
        nominal: parsed.nominal || 0,
        paymentMethod: parsed.paymentMethod || 'NON-COD',
        paymentStatus: parsed.paymentStatus || 'TERKIRIM',
        status: parsed.explicitStatus || parsed.paymentStatus || 'TERKIRIM',
        fileHash: getHash(pdfBuffer),
        messageId: messageId || oldItem.messageId,
        updatedAt: new Date().toISOString(),
      };

      metaList[oldIndex] = updatedItem;
      saveMeta(metaList);

      return {
        isRevision: true,
        oldItem: oldItem,
        item: updatedItem,
        parsed: parsed,
        totalInQueue: metaList.length,
      };
    }
  }

  // Check duplicate manual resi (only consider duplicate if recipient, phone, and keterangan are all identical)
  if (parsed.recipient && parsed.recipient !== '-' && parsed.phone && parsed.phone !== '-') {
    const cleanPhone = parsed.phone.replace(/\D/g, '');
    const duplicate = metaList.find(
      item => item.type === 'manual' &&
              (item.recipient || '').toLowerCase().trim() === parsed.recipient.toLowerCase().trim() &&
              (item.phone || '').replace(/\D/g, '') === cleanPhone &&
              (item.keterangan || '').toLowerCase().trim() === (parsed.keterangan || '').toLowerCase().trim()
    );
    if (duplicate) {
      return {
        isDuplicate: true,
        existingItem: duplicate,
        totalInQueue: metaList.length,
      };
    }
  }

  // Generate A6 PDF
  const pdfBuffer = await createLabelFromText(rawText);
  const timestamp = Date.now();
  const targetPath = path.join(PATHS.QUEUE, `${timestamp}_text_resi.pdf`);
  fs.writeFileSync(targetPath, pdfBuffer);

  const title = parsed.recipient !== '-' ? `${parsed.recipient} (${parsed.address.slice(0, 25)})` : 'Resi Manual';
  const newItem = {
    id: `manual_${timestamp}`,
    fileName: `text_resi_${timestamp}.pdf`,
    filePath: targetPath,
    type: 'manual',
    title: title,
    recipient: parsed.recipient,
    address: parsed.address,
    phone: parsed.phone,
    toko: parsed.toko || '',
    sip: parsed.sip || '',
    keterangan: parsed.keterangan || '',
    nominal: parsed.nominal || 0,
    paymentMethod: parsed.paymentMethod || 'NON-COD',
    paymentStatus: parsed.paymentStatus || 'TERKIRIM',
    status: parsed.explicitStatus || parsed.paymentStatus || 'TERKIRIM',
    fileHash: getHash(pdfBuffer),
    messageId: messageId,
    chatId: chatId,
    senderName: senderName,
    createdAt: new Date().toISOString(),
    dateStr: dateStr,
  };

  metaList.push(newItem);
  saveMeta(metaList);

  return {
    isDuplicate: false,
    filePath: targetPath,
    item: newItem,
    parsed: parsed,
    totalInQueue: metaList.length,
  };
}

/**
 * Add image to queue
 */
async function addImageToQueue(arg1, arg2) {
  const dateStr = todayStr();
  ensureDirs(dateStr);

  let filename, buffer, messageId, chatId, senderName;
  if (typeof arg1 === 'object' && arg1.buffer) {
    filename = arg1.filename || 'screenshot.jpg';
    buffer = arg1.buffer;
    messageId = arg1.messageId || null;
    chatId = arg1.chatId || null;
    senderName = arg1.senderName || 'Staff';
  } else {
    filename = arg1;
    buffer = arg2;
    messageId = null;
    chatId = null;
    senderName = 'Staff';
  }

  const pdfBuffer = await convertImageToPdf(buffer);
  const fileHash = getHash(pdfBuffer);
  const metaList = syncQueue();

  const duplicate = metaList.find(item => item.fileHash === fileHash);
  if (duplicate) {
    return {
      isDuplicate: true,
      existingItem: duplicate,
      totalInQueue: metaList.length,
    };
  }

  const safeName = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const timestamp = Date.now();
  const targetPath = path.join(PATHS.QUEUE, `${timestamp}_img_${safeName}.pdf`);
  fs.writeFileSync(targetPath, pdfBuffer);

  const isObj = typeof arg1 === 'object';
  const recipient = (isObj && arg1.recipient) ? arg1.recipient : '-';
  const product = (isObj && arg1.product) ? arg1.product : '-';
  const sku = (isObj && arg1.sku) ? arg1.sku : '-';
  const qty = (isObj && arg1.qty) ? arg1.qty : 1;
  const resi = (isObj && arg1.resi) ? arg1.resi : '-';
  const expedition = (isObj && arg1.expedition) ? arg1.expedition : 'Ekspedisi (Foto)';
  const nominal = (isObj && arg1.nominal) ? arg1.nominal : 0;
  const toko = (isObj && arg1.toko) ? arg1.toko : '';
  const caption = (isObj && arg1.caption) ? arg1.caption : '';
  const ocrText = (isObj && arg1.ocrText) ? arg1.ocrText : '';

  const displayTitle = (recipient !== '-' && recipient !== 'Penerima')
    ? `${recipient} (${product !== '-' ? product : 'Foto Resi'})`
    : `Foto Resi: ${filename}`;

  const newItem = {
    id: `img_${timestamp}`,
    fileName: filename,
    filePath: targetPath,
    type: 'photo',
    title: displayTitle,
    recipient: recipient,
    phone: (isObj && arg1.phone) ? arg1.phone : '-',
    product: product,
    sku: sku,
    qty: qty,
    resi: resi,
    expedition: expedition,
    fileHash: fileHash,
    nominal: nominal,
    toko: toko,
    caption: caption,
    ocrText: ocrText,
    paymentMethod: (isObj && arg1.paymentMethod) ? arg1.paymentMethod : 'NON-COD',
    paymentStatus: 'TERKIRIM',
    botReplyMessageId: null,
    messageId: messageId,
    chatId: chatId,
    senderName: senderName,
    createdAt: new Date().toISOString(),
    dateStr: dateStr,
  };

  metaList.push(newItem);
  saveMeta(metaList);

  return {
    isDuplicate: false,
    filePath: targetPath,
    item: newItem,
    totalInQueue: metaList.length,
  };
}

/**
 * Cancel a specific queue item by the Telegram messageId it was sent in
 */
function cancelQueueItemByMessageId(targetMessageId) {
  const metaList = syncQueue();
  const index = metaList.findIndex(item => item.messageId && item.messageId === targetMessageId);

  if (index === -1) {
    return { found: false };
  }

  const item = metaList[index];
  const dateStr = todayStr();
  ensureDirs(dateStr);

  // Move cancelled file to archive/date/cancelled folder for audit record
  const cancelledDir = path.join(PATHS.ARCHIVE, dateStr, 'cancelled');
  if (fs.existsSync(item.filePath)) {
    try {
      const destPath = path.join(cancelledDir, path.basename(item.filePath));
      fs.renameSync(item.filePath, destPath);
    } catch (_) {
      try { fs.unlinkSync(item.filePath); } catch (_) {}
    }
  }

  metaList.splice(index, 1);
  saveMeta(metaList);

  return {
    found: true,
    item: item,
    totalInQueue: metaList.length,
  };
}

/**
 * Cancel queue item by list index (1-based, e.g. /batal 2)
 */
function cancelQueueItemByIndex(oneBasedIndex) {
  const metaList = syncQueue();
  const idx = oneBasedIndex - 1;

  if (idx < 0 || idx >= metaList.length) {
    return { found: false };
  }

  const item = metaList[idx];
  const dateStr = todayStr();
  ensureDirs(dateStr);

  const cancelledDir = path.join(PATHS.ARCHIVE, dateStr, 'cancelled');
  if (fs.existsSync(item.filePath)) {
    try {
      const destPath = path.join(cancelledDir, path.basename(item.filePath));
      fs.renameSync(item.filePath, destPath);
    } catch (_) {
      try { fs.unlinkSync(item.filePath); } catch (_) {}
    }
  }

  metaList.splice(idx, 1);
  saveMeta(metaList);

  return {
    found: true,
    item: item,
    totalInQueue: metaList.length,
  };
}

/**
 * Get all files currently waiting in the queue (for pdfService merge)
 */
function getQueueFiles() {
  const metaList = syncQueue();
  return metaList.map(item => item.filePath).filter(fp => fs.existsSync(fp));
}

/**
 * Get detailed queue items for /list audit
 */
function getQueueItems() {
  return syncQueue();
}

/**
 * Get count of items in the queue
 */
function getQueueCount() {
  return syncQueue().length;
}

/**
 * Clear the current queue completely
 */
function clearQueue() {
  const metaList = syncQueue();
  let count = 0;
  for (const item of metaList) {
    if (fs.existsSync(item.filePath)) {
      try {
        fs.unlinkSync(item.filePath);
        count++;
      } catch (err) {
        console.error(`Gagal menghapus ${item.filePath}:`, err.message);
      }
    }
  }
  saveMeta([]);
  return count;
}

/**
 * Move processed files in queue to an archive folder organized by date and batchId
 */
function archiveQueue(batchId) {
  const dateStr = todayStr();
  ensureDirs(dateStr);

  const archiveDir = path.join(PATHS.ARCHIVE, dateStr, batchId || `batch_${Date.now()}`);
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const metaList = syncQueue();
  const archivedItems = [];

  for (const item of metaList) {
    if (fs.existsSync(item.filePath)) {
      try {
        const dest = path.join(archiveDir, path.basename(item.filePath));
        fs.renameSync(item.filePath, dest);
        archivedItems.push({ ...item, archivedPath: dest });
      } catch (err) {
        console.error(`Gagal memindahkan file ke arsip: ${item.filePath}`, err.message);
      }
    }
  }

  // Save batch metadata into the archive folder for permanent audit trail
  try {
    fs.writeFileSync(
      path.join(archiveDir, 'batch_meta.json'),
      JSON.stringify({ batchId, dateStr, count: archivedItems.length, items: archivedItems }, null, 2),
      'utf8'
    );
  } catch (_) {}

  // Reset active queue metadata
  saveMeta([]);

  return {
    archiveDir,
    archivedCount: archivedItems.length,
  };
}

/**
 * Find the latest merged output PDF file for reprint (/ulang)
 */
function getLatestOutputFile(dateStr = todayStr()) {
  ensureDirs(dateStr);

  // Check today's date output directory first
  const dateOutputDir = path.join(PATHS.OUTPUT, dateStr);
  let candidates = [];

  if (fs.existsSync(dateOutputDir)) {
    const files = fs.readdirSync(dateOutputDir)
      .filter(f => f.toLowerCase().endsWith('.pdf'))
      .map(f => {
        const full = path.join(dateOutputDir, f);
        return { filename: f, filePath: full, mtime: fs.statSync(full).mtimeMs };
      });
    candidates.push(...files);
  }

  // Also check root output directory or yesterday if today has none yet
  if (candidates.length === 0 && fs.existsSync(PATHS.OUTPUT)) {
    const entries = fs.readdirSync(PATHS.OUTPUT, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const subDir = path.join(PATHS.OUTPUT, ent.name);
        const subFiles = fs.readdirSync(subDir)
          .filter(f => f.toLowerCase().endsWith('.pdf'))
          .map(f => {
            const full = path.join(subDir, f);
            return { filename: f, filePath: full, mtime: fs.statSync(full).mtimeMs };
          });
        candidates.push(...subFiles);
      } else if (ent.name.toLowerCase().endsWith('.pdf')) {
        const full = path.join(PATHS.OUTPUT, ent.name);
        candidates.push({ filename: ent.name, filePath: full, mtime: fs.statSync(full).mtimeMs });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Sort newest first
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0];
}

/**
 * Update price (and optional store) for a queue item referenced by Telegram messageId
 * Matches either the original document/text messageId or the bot confirmation reply messageId
 */
function updateQueueItemPrice(targetMsgId, price, customToko = null) {
  if (!targetMsgId || !price) return null;
  const metaList = syncQueue();
  const item = metaList.find(it => 
    (it.messageId && it.messageId === targetMsgId) || 
    (it.botReplyMessageId && it.botReplyMessageId === targetMsgId)
  );

  if (!item) return null;

  item.nominal = price;
  if (customToko) item.toko = customToko;
  item.priceSource = 'EXPLICIT_REPLY';
  item.updatedAt = new Date().toISOString();
  saveMeta(metaList);
  return item;
}

/**
 * Link bot confirmation messageId to the queue item
 */
function setBotReplyMessageId(targetMsgId, botMsgId) {
  if (!targetMsgId || !botMsgId) return;
  const metaList = syncQueue();
  const item = metaList.find(it => it.messageId && it.messageId === targetMsgId);
  if (item) {
    item.botReplyMessageId = botMsgId;
    saveMeta(metaList);
  }
}

/**
 * Find queue item by messageId
 */
function getQueueItemByMessageId(targetMsgId) {
  if (!targetMsgId) return null;
  const metaList = syncQueue();
  return metaList.find(it => 
    (it.messageId && it.messageId === targetMsgId) || 
    (it.botReplyMessageId && it.botReplyMessageId === targetMsgId)
  ) || null;
}

module.exports = {
  addPdfToQueue,
  addTextToQueue,
  addImageToQueue,
  cancelQueueItemByMessageId,
  cancelQueueItemByIndex,
  updateQueueItemPrice,
  setBotReplyMessageId,
  getQueueItemByMessageId,
  getQueueFiles,
  getQueueItems,
  getQueueCount,
  clearQueue,
  archiveQueue,
  getLatestOutputFile,
  ensureDirs,
  todayStr,
};
