const fs = require('fs');
const path = require('path');
const config = require('./config');
const { resolvePricing } = require('./productCatalogService');

const PENDING_FILE = config.PATHS.PENDING_FINANCE;

/**
 * Load offline pending transactions
 */
function loadPendingBatches() {
  if (!fs.existsSync(PENDING_FILE)) return [];
  try {
    const raw = fs.readFileSync(PENDING_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('[FINANCE] Gagal membaca pending_finance.json:', err.message);
    return [];
  }
}

/**
 * Save offline pending transactions
 */
function savePendingBatches(batches) {
  try {
    const dir = path.dirname(PENDING_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(batches, null, 2), 'utf8');
  } catch (err) {
    console.error('[FINANCE] Gagal menyimpan pending_finance.json:', err.message);
  }
}

/**
 * Format currency to IDR string (e.g. "Rp 395.000")
 */
function formatRupiah(num) {
  const n = Number(num) || 0;
  return 'Rp ' + n.toLocaleString('id-ID');
}

/**
 * Send HTTP POST to Google Apps Script Web App
 */
async function postToGoogleSheets(payload) {
  const webhookUrl = config.GOOGLE_SHEET_WEBHOOK_URL;
  if (!webhookUrl || !webhookUrl.startsWith('http')) {
    return {
      success: false,
      reason: 'NO_WEBHOOK_URL',
      message: 'GOOGLE_SHEET_WEBHOOK_URL belum diisi di .env'
    };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }

    const resJson = await response.json().catch(() => ({ status: 'success' }));
    return {
      success: true,
      data: resJson,
    };
  } catch (err) {
    return {
      success: false,
      reason: 'NETWORK_OR_TIMEOUT',
      message: err.message,
    };
  }
}

/**
 * Process a batch of manifest items, resolve catalog pricing, and sync to Google Sheets
 */
async function recordBatchTransactions(manifestList, batchId, customTimestamp = null) {
  if (!manifestList || manifestList.length === 0) {
    return null;
  }

  const now = new Date();
  const defaultTimestampStr = `${now.toISOString().slice(0, 10)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const timestampStr = customTimestamp || defaultTimestampStr;

  const transactions = [];
  let totalBatchNominal = 0;
  let totalCod = 0;
  let totalTransfer = 0;
  let matchedCatalogCount = 0;
  let unresolvedCount = 0;
  const unresolvedList = [];
  const storeBreakdown = {};

  for (const item of manifestList) {
    const d = item.details || {};
    
    const finalNominalInput = (item.nominal && item.nominal > 0) ? item.nominal : (d.nominal || 0);
    const finalTokoInput = item.toko || d.toko || '';
    const isManual = item.type === 'manual' || d.type === 'manual' || (item.fileName && item.fileName.includes('text_resi'));
    const isBoscod = Boolean(item.isBoscod || d.isBoscod || item.type === 'jnt' || d.type === 'jnt' || (d.expedition && d.expedition.includes('bosCOD')) || (item.expedition && item.expedition.includes('bosCOD')));

    // Resolve price and store from catalog or explicit input
    const pricing = resolvePricing({
      sku: isManual ? '-' : d.sku,
      product: d.product,
      title: item.title,
      qty: d.qty || 1,
      nominal: finalNominalInput,
      paymentMethod: d.paymentMethod,
      isCod: d.paymentMethod === 'COD',
      notes: item.keterangan || d.product,
      toko: finalTokoInput,
      sender: item.senderName || item.sip || d.sender,
      rawText: item.rawText,
      isManual: isManual,
      isBoscod: isBoscod,
      type: isManual ? 'manual' : (isBoscod ? 'boscod' : (item.type || d.type)),
      expedition: d.expedition || item.expedition,
    });

    const totalNominal = pricing.totalNominal;
    totalBatchNominal += totalNominal;

    const store = pricing.toko || 'Safra';
    if (!storeBreakdown[store]) {
      storeBreakdown[store] = { count: 0, nominal: 0, cod: 0, transfer: 0, missingPriceCount: 0 };
    }
    storeBreakdown[store].count += 1;
    storeBreakdown[store].nominal += totalNominal;

    if (pricing.paymentMethod === 'COD') {
      totalCod += totalNominal;
      storeBreakdown[store].cod += totalNominal;
    } else {
      totalTransfer += totalNominal;
      storeBreakdown[store].transfer += totalNominal;
    }

    if (pricing.priceSource && pricing.priceSource.includes('MASTER_CSV')) {
      matchedCatalogCount++;
    } else if (pricing.priceSource === 'UNRESOLVED' || pricing.priceStatus === '⚠️ PERLU INPUT HARGA') {
      unresolvedCount++;
      storeBreakdown[store].missingPriceCount += 1;
      unresolvedList.push({
        resi: d.resi || (isManual ? 'MANUAL' : '-'),
        recipient: d.recipient || item.recipient || item.title || '-',
        sku: isManual ? '-' : (pricing.sku || '-'),
        product: isManual ? (d.product && d.product !== '-' ? d.product : (item.keterangan || item.title || 'Resi Manual')) : (pricing.productName || d.product || '-'),
        toko: store,
      });
    }

    transactions.push({
      resi: d.resi || (isManual ? 'MANUAL' : '-'),
      toko: store,
      recipient: d.recipient || item.recipient || item.title || '-',
      phone: d.phone || item.phone || '-',
      expedition: d.expedition || (d.type === 'shopee' ? 'Shopee (SPX)' : (d.type === 'jnt' ? 'J&T Cargo (bosCOD)' : (isManual ? 'Manual (Kurir)' : 'Manual'))),
      sku: isManual ? '-' : (pricing.sku || '-'),
      product: isManual ? (d.product && d.product !== '-' ? d.product : (item.keterangan || item.title || 'Resi Manual')) : (pricing.productName || d.product || '-'),
      qty: pricing.qty || 1,
      unitPrice: pricing.unitPrice || 0,
      totalNominal: totalNominal,
      paymentMethod: pricing.paymentMethod || 'NON-COD',
      paymentStatus: d.paymentStatus || pricing.paymentStatus || 'TERKIRIM',
      priceSource: pricing.priceSource || '-',
      priceStatus: pricing.priceStatus || (totalNominal > 0 ? 'HARGA OK' : '⚠️ PERLU INPUT HARGA'),
      notes: pricing.notes || '-',
    });
  }

  const payload = {
    action: 'record_batch',
    batchId: batchId || `batch_${now.toISOString().slice(0, 10)}`,
    timestamp: timestampStr,
    storeBreakdown,
    transactions,
  };

  const summary = {
    batchId: payload.batchId,
    totalTransactions: transactions.length,
    totalBatchNominal,
    totalCod,
    totalTransfer,
    matchedCatalogCount,
    unresolvedCount,
    unresolvedList,
    storeBreakdown,
    syncedToGoogleSheet: false,
    offlineQueued: false,
    errorNotice: null,
  };

  // Attempt to sync to Google Sheets
  const postResult = await postToGoogleSheets(payload);

  if (postResult.success) {
    summary.syncedToGoogleSheet = true;
    console.log(`[FINANCE SUCCESS] Berhasil mencatat ${transactions.length} transaksi ke Google Sheets (Batch: ${payload.batchId}). Total: ${formatRupiah(totalBatchNominal)}`);
    
    // Flush any previous offline pending batches
    flushPendingTransactions().catch(() => {});
  } else {
    // If failed, save to pending buffer for later retry
    summary.offlineQueued = true;
    summary.errorNotice = postResult.message;
    const pending = loadPendingBatches();
    pending.push(payload);
    savePendingBatches(pending);

    if (postResult.reason === 'NO_WEBHOOK_URL') {
      console.log(`[FINANCE NOTE] GOOGLE_SHEET_WEBHOOK_URL belum diisi. Data ${transactions.length} transaksi disimpan ke storage/pending_finance.json`);
    } else {
      console.warn(`[FINANCE OFFLINE BUFFER] Gagal kirim ke Google Sheets (${postResult.message}). Disimpan ke antrean offline.`);
    }
  }

  return summary;
}

/**
 * Sync entire master products CSV to Google Sheet's 'Master_Product' tab
 */
async function syncMasterCatalogToGoogleSheets(catalogProducts) {
  if (!catalogProducts || catalogProducts.length === 0) return { success: false, message: 'No catalog items' };
  const payload = {
    action: 'sync_master_products',
    timestamp: new Date().toISOString(),
    products: catalogProducts.map(p => ({
      toko: p.toko,
      sku: p.sku,
      nama: p.nama,
      hargaStandar: p.hargaStandar,
      hargaGrosir: p.hargaGrosir,
      platform: p.platform,
      keterangan: p.keterangan,
    })),
  };
  return await postToGoogleSheets(payload);
}

/**
 * Flush any offline queued batches to Google Sheets
 */
async function flushPendingTransactions() {
  const pending = loadPendingBatches();
  if (pending.length === 0) return 0;

  const webhookUrl = config.GOOGLE_SHEET_WEBHOOK_URL;
  if (!webhookUrl || !webhookUrl.startsWith('http')) return 0;

  console.log(`[FINANCE RETRY] Mencoba mengirim ulang ${pending.length} batch offline ke Google Sheets...`);
  const remaining = [];
  let flushedCount = 0;

  for (const batch of pending) {
    const res = await postToGoogleSheets(batch);
    if (res.success) {
      flushedCount += batch.transactions ? batch.transactions.length : 1;
    } else {
      remaining.push(batch);
    }
  }

  savePendingBatches(remaining);
  if (flushedCount > 0) {
    console.log(`[FINANCE RETRY] Sukses menyinkronkan ${flushedCount} transaksi offline yang tertunda!`);
  }
  return flushedCount;
}

/**
 * Format clean HTML message for Telegram after batch merge
 */
function formatFinanceReportMessage(summary) {
  if (!summary) return '';

  let msg = `📊 <b>Laporan Omzet Batch:</b> <b>${formatRupiah(summary.totalBatchNominal)}</b> (${summary.totalTransactions} paket)\n`;

  // Store Breakdown
  const storeEntries = Object.entries(summary.storeBreakdown || {});
  if (storeEntries.length > 0) {
    const storeLines = storeEntries.map(([sName, sData]) => `• <b>${sName}:</b> ${sData.count} pkt (${formatRupiah(sData.nominal)})`);
    msg += storeLines.join('\n') + '\n';
  }

  // Unpriced items alert (concise single lines)
  if (summary.unresolvedList && summary.unresolvedList.length > 0) {
    msg += `\n⚠️ <b>PERINGATAN RESI BELUM ADA HARGA (${summary.unresolvedList.length} Paket):</b>\n`;
    summary.unresolvedList.forEach((u, idx) => {
      msg += `• <code>${u.resi}</code> — ${u.recipient} (${u.toko})\n`;
    });
  }

  if (summary.syncedToGoogleSheet) {
    msg += `\n✅ <i>Tersinkron ke Google Sheets</i>`;
  } else if (summary.offlineQueued) {
    msg += `\nℹ️ <i>Tersimpan di antrean offline lokal</i>`;
  }

  return msg;
}

module.exports = {
  recordBatchTransactions,
  syncMasterCatalogToGoogleSheets,
  flushPendingTransactions,
  formatFinanceReportMessage,
  formatRupiah,
};
