const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

/**
 * Clean whitespace without truncating strings
 */
function cleanTitle(str) {
  if (!str || str === '-') return '-';
  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Extract recipient, product title, SKU, and Qty from a PDF file
 * @param {string} filePath - Absolute path to PDF file
 * @param {Object} [metaItem] - Optional metadata item from queue
 */
async function extractLabelDetails(filePath, metaItem = {}) {
  // If it's a manual label and already has recipient in metadata
  if (metaItem.type === 'manual') {
    let recipient = metaItem.recipient || '-';
    let rawProduct = metaItem.keterangan || metaItem.title || 'Produk';
    let sku = '-';
    let qty = 1;

    const qMatch = rawProduct.match(/^(\d+)\s*(?:paket|pcs|btl|botol|kg|jerigen)?\s*(.*)$/i);
    if (qMatch) {
      qty = parseInt(qMatch[1], 10);
      rawProduct = qMatch[2] || qMatch[0];
    }
    sku = rawProduct.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12) || 'MANUAL';

    return {
      recipient,
      product: rawProduct || 'Produk',
      sku,
      qty,
      resi: 'MANUAL',
      type: 'manual',
      fileName: path.basename(filePath),
    };
  }

  try {
    if (!fs.existsSync(filePath)) {
      return {
        recipient: metaItem.recipient || metaItem.title || '-',
        product: metaItem.title || '-',
        sku: '-',
        qty: 1,
        resi: '-',
        type: 'file',
        fileName: path.basename(filePath),
      };
    }

    const buf = fs.readFileSync(filePath);
    const parser = new PDFParse(new Uint8Array(buf));
    await parser.load();
    const page = await parser.doc.getPage(1);
    const textContent = await page.getTextContent();
    const items = textContent.items.map(it => it.str).filter(s => s && s.trim());
    const fullText = items.join(' | ');

    let recipient = metaItem.recipient || '-';
    let product = '-';
    let sku = '-';
    let qty = 1;
    let resi = '-';

    // 1. Manual label format
    if (fullText.includes('Nama | :') || fullText.includes('SIP | :')) {
      const namaIdx = items.findIndex(s => s.trim() === 'Nama');
      if (namaIdx !== -1) {
        const colonIdx = items.indexOf(':', namaIdx);
        if (colonIdx !== -1 && items[colonIdx + 1]) {
          recipient = items[colonIdx + 1].trim();
        }
      }
      const lastItem = items[items.length - 1];
      if (lastItem && !lastItem.includes('0856-') && !lastItem.includes('SAFRA')) {
        let pText = lastItem;
        const qMatch = pText.match(/^(\d+)\s*(?:paket|pcs|btl|botol|kg|jerigen)?\s*(.*)$/i);
        if (qMatch) {
          qty = parseInt(qMatch[1], 10);
          pText = qMatch[2] || qMatch[0];
        }
        product = pText;
        sku = pText.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 12);
      }
      return { recipient, product, sku, qty, resi: 'MANUAL', type: 'manual', fileName: path.basename(filePath) };
    }

    // 2. Shopee format
    if (fullText.includes('Nama Produk') || fullText.includes('SKU')) {
      const resiMatch = fullText.match(/(?:No\.\s*Resi:\s*\|?\s*|SPXID)([A-Z0-9]{10,20})/i);
      if (resiMatch) resi = resiMatch[0].replace(/.*\|/g, '').trim();

      // Recipient in Shopee: anchor to seller phone number and filtered recipient candidates
      const cleanItems = items.filter(s => s && !s.startsWith('SPXID') && s !== '#');
      const phoneIdx = cleanItems.findIndex(s => /^(?:628|08)\d{8,13}$/.test(s.trim()));
      if (phoneIdx !== -1) {
        const isCandidate = (str) => {
          if (!str) return false;
          const s = str.trim();
          return (
            s.length > 2 &&
            s.length < 50 &&
            !/penerima|pengirim|berat|batas|resi|cod|qty|sku|variasi/i.test(s) &&
            !/^(?:jalan|jl\.|jl\s|rt|rw|dusun|desa|perumahan|kab|kec|blok|gang|no\.)/i.test(s) &&
            !/^(?:interfarm|utamigro)/i.test(s)
          );
        };
        for (let offset of [1, -1, 2, -2]) {
          const idx = phoneIdx + offset;
          if (idx >= 0 && idx < cleanItems.length && isCandidate(cleanItems[idx])) {
            recipient = cleanItems[idx].trim();
            break;
          }
        }
      }

      // Extract Product, SKU, Qty from Shopee table
      const headerIdx = items.findIndex(s => s.trim().toLowerCase() === 'qty');
      if (headerIdx !== -1) {
        let pNameParts = [];
        let pSku = '';
        let pQty = 1;
        let curr = headerIdx + 1;
        if (items[curr] && items[curr].trim() === '1') curr++;

        while (curr < items.length && !items[curr].startsWith('Pesan:')) {
          const token = items[curr].trim();
          const isSkuToken = /^[A-Z0-9_-]{4,25}/.test(token) &&
            !token.includes(',') &&
            !token.startsWith('SPXID') &&
            !token.startsWith('KAB.');

          if (isSkuToken) {
            pSku = token;
            curr++;
            break;
          }
          pNameParts.push(token);
          curr++;
        }

        while (curr < items.length && !items[curr].startsWith('Pesan:')) {
          const token = items[curr].trim();
          if (/^\d+$/.test(token)) {
            pQty = parseInt(token, 10);
            break;
          }
          curr++;
        }

        product = pNameParts.join(' ').trim() || '-';
        sku = pSku.trim() || '-';
        qty = pQty;
      }

      return { recipient, product, sku, qty, resi, type: 'shopee', fileName: path.basename(filePath) };
    }

    // 3. J&T Cargo / bosCOD format
    if (fullText.includes('PENERIMA :') || fullText.includes('No. Resi:')) {
      const resiMatch = fullText.match(/No\.\s*Resi:\s*([A-Z0-9]+)/i);
      if (resiMatch) resi = resiMatch[1];

      const penIdx = items.findIndex(s => s.includes('PENERIMA'));
      if (penIdx !== -1 && items[penIdx + 1]) {
        recipient = items[penIdx + 1].trim();
      }

      const isiIdx = items.findIndex(s => s.trim() === 'ISI:');
      if (isiIdx !== -1 && items[isiIdx + 1]) {
        product = items[isiIdx + 1].trim();
      }

      const qtyIdx = items.findIndex(s => s.trim() === 'QTY:');
      if (qtyIdx !== -1 && items[qtyIdx + 1]) {
        const qVal = parseInt(items[qtyIdx + 1].trim(), 10);
        if (!isNaN(qVal)) qty = qVal;
      }

      const orderIdMatch = fullText.match(/Order ID:\s*([A-Z0-9]+)/i);
      if (orderIdMatch) sku = orderIdMatch[1];

      return { recipient, product, sku, qty, resi, type: 'jnt', fileName: path.basename(filePath) };
    }

    return {
      recipient: recipient !== '-' ? recipient : (metaItem.title || path.basename(filePath)),
      product: product !== '-' ? product : 'Paket',
      sku: '-',
      qty: 1,
      resi: resi !== '-' ? resi : '-',
      type: 'pdf',
      fileName: path.basename(filePath),
    };
  } catch (err) {
    return {
      recipient: metaItem.recipient || metaItem.title || path.basename(filePath),
      product: metaItem.keterangan || metaItem.title || '-',
      sku: '-',
      qty: 1,
      resi: '-',
      type: 'error',
      fileName: path.basename(filePath),
    };
  }
}

/**
 * Extract details for all queue items in batch
 */
async function getManifestForQueue(queueItems) {
  const list = [];
  for (const item of queueItems) {
    const details = await extractLabelDetails(item.filePath, item);
    list.push({ ...item, details });
  }
  return list;
}

/**
 * Format /list response with Nama, Judul Barang, SKU, and Qty
 */
function formatListMessage(manifestList) {
  if (!manifestList || manifestList.length === 0) {
    return `📭 <b>Antrean Masih Kosong</b>\nBelum ada resi yang menunggu cetak saat ini. Silakan kirim file PDF atau ketik /manual.`;
  }

  const pagesEstimate = Math.ceil(manifestList.length / 4);
  let totalQty = 0;

  let msg = `📋 <b>DAFTAR RESI DALAM ANTREAN (${manifestList.length} Paket):</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  manifestList.forEach((it, index) => {
    const num = index + 1;
    const d = it.details || {};
    const rec = d.recipient && d.recipient !== '-' ? d.recipient : (it.recipient || it.title || 'Penerima');
    const prod = cleanTitle(d.product && d.product !== '-' ? d.product : (it.keterangan || it.title || 'Barang'));
    const sku = d.sku && d.sku !== '-' ? d.sku : '-';
    const qty = d.qty || 1;
    totalQty += qty;

    msg += `<b>${num}. 👤 ${rec}</b>\n`;
    msg += `   📦 <b>Barang:</b> ${prod}\n`;
    msg += `   🏷️ <b>SKU:</b> <code>${sku}</code> | <b>Qty:</b> ${qty} pcs\n\n`;
  });

  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📊 <b>Total Paket:</b> ${manifestList.length} | <b>Total Barang:</b> ${totalQty} pcs\n`;
  msg += `📄 <b>Kertas A4:</b> ${pagesEstimate} lembar (Grid 2x2)\n\n`;
  msg += `👉 <i>Ketik /cetak untuk satukan ke PDF A4, atau /print untuk langsung cetak ke printer.</i>`;

  return msg;
}

/**
 * Format Packing Manifest Summary sent upon printing
 */
function formatPackingSummary(manifestList, batchName = '') {
  if (!manifestList || manifestList.length === 0) return '';

  let totalQty = 0;
  let summary = `📦 <b>REKAP PACKING BARANG (${batchName || 'Batch Baru'})</b>\n`;
  summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  manifestList.forEach((it, index) => {
    const num = index + 1;
    const d = it.details || {};
    const rec = d.recipient && d.recipient !== '-' ? d.recipient : (it.recipient || it.title || 'Penerima');
    const prod = cleanTitle(d.product && d.product !== '-' ? d.product : (it.keterangan || it.title || 'Barang'));
    const sku = d.sku && d.sku !== '-' ? d.sku : '-';
    const qty = d.qty || 1;
    totalQty += qty;

    summary += `${num}. 👤 <b>${rec}</b>\n`;
    summary += `   📦 <b>Barang:</b> ${prod}\n`;
    summary += `   🏷️ SKU: <code>${sku}</code> | <b>Qty:</b> ${qty} pcs\n\n`;
  });

  summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  summary += `📊 <b>Total Paket Fisik:</b> ${manifestList.length} paket\n`;
  summary += `📦 <b>Total Jumlah Barang:</b> ${totalQty} pcs\n`;
  summary += `<i>Cocokkan jumlah kardus/barang di atas sebelum di-pickup kurir!</i>`;

  return summary;
}

module.exports = {
  extractLabelDetails,
  getManifestForQueue,
  formatListMessage,
  formatPackingSummary,
};
