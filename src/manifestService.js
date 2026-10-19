const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const { parsePrice } = require('./productCatalogService');

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
    sku = '-';

    return {
      recipient,
      phone: metaItem.phone || '-',
      product: rawProduct || 'Produk',
      sku: '-',
      qty,
      resi: 'MANUAL',
      type: 'manual',
      toko: (metaItem.toko && !/^[:\-\s]+$/.test(String(metaItem.toko).trim())) ? String(metaItem.toko).trim() : 'Safra',
      expedition: 'Manual (Kurir)',
      nominal: metaItem.nominal || 0,
      paymentMethod: metaItem.paymentMethod || 'NON-COD',
      paymentStatus: metaItem.status || metaItem.paymentStatus || 'TERKIRIM',
      fileName: path.basename(filePath),
    };
  }

  // If it's a photo and already has details extracted from OCR in metadata
  if (metaItem.type === 'photo') {
    return {
      recipient: metaItem.recipient && metaItem.recipient !== '-' ? metaItem.recipient : (metaItem.title || 'Penerima'),
      phone: metaItem.phone || '-',
      product: metaItem.product && metaItem.product !== '-' ? metaItem.product : 'Produk',
      sku: metaItem.sku || '-',
      qty: metaItem.qty || 1,
      resi: metaItem.resi || '-',
      type: 'photo',
      toko: (metaItem.toko && !/^[:\-\s]+$/.test(String(metaItem.toko).trim())) ? String(metaItem.toko).trim() : 'Safra',
      expedition: metaItem.expedition || 'Ekspedisi (Foto)',
      nominal: metaItem.nominal || 0,
      paymentMethod: metaItem.paymentMethod || 'NON-COD',
      paymentStatus: metaItem.status || metaItem.paymentStatus || 'TERKIRIM',
      fileName: path.basename(filePath),
    };
  }

  try {
    if (!fs.existsSync(filePath)) {
      return {
        recipient: metaItem.recipient || metaItem.title || '-',
        phone: metaItem.phone || '-',
        product: metaItem.title || '-',
        sku: '-',
        qty: 1,
        resi: '-',
        type: 'file',
        expedition: 'Ekspedisi',
        nominal: metaItem.nominal || 0,
        paymentMethod: metaItem.paymentMethod || 'NON-COD',
        paymentStatus: metaItem.paymentStatus || 'NON-COD',
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
        sku = '-';
      }
      return {
        recipient,
        phone: metaItem.phone || '-',
        product,
        sku: '-',
        qty,
        resi: 'MANUAL',
        type: 'manual',
        toko: metaItem.toko || '',
        expedition: 'Manual (Kurir)',
        nominal: metaItem.nominal || 0,
        paymentMethod: metaItem.paymentMethod || 'NON-COD',
        paymentStatus: metaItem.status || metaItem.paymentStatus || 'TERKIRIM',
        fileName: path.basename(filePath)
      };
    }

    // 2. Shopee format
    if (fullText.includes('Nama Produk') || fullText.includes('SKU')) {
      const resiMatch = fullText.match(/(?:No\.\s*Resi:\s*\|?\s*|SPXID)([A-Z0-9]{10,20})/i);
      if (resiMatch) resi = resiMatch[0].replace(/.*\|/g, '').trim();

      // Recipient in Shopee: anchor to seller phone number and filtered recipient candidates
      const cleanItems = items.filter(s => s && !s.startsWith('SPXID') && s !== '#');
      const phoneIdx = cleanItems.findIndex(s => /^(?:628|08)\d{8,13}$/.test(s.trim()));
      let shopeePhone = phoneIdx !== -1 ? cleanItems[phoneIdx].trim() : '-';

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

      // Check COD in Shopee
      let shopeeNominal = 0;
      let isShopeeCod = /COD/i.test(fullText) && !/Non-COD/i.test(fullText);
      const shopeeCodMatch = fullText.match(/COD\s*[:=]?\s*(?:Rp\.?\s*)?([0-9\.\,]+)/i);
      if (shopeeCodMatch) {
        shopeeNominal = parsePrice(shopeeCodMatch[1]);
        if (shopeeNominal > 0) isShopeeCod = true;
      }

      return {
        recipient,
        phone: shopeePhone,
        product,
        sku,
        qty,
        resi,
        type: 'shopee',
        toko: metaItem.toko || '',
        expedition: 'Shopee (SPX)',
        nominal: (metaItem.nominal && metaItem.nominal > 0) ? metaItem.nominal : shopeeNominal,
        paymentMethod: isShopeeCod ? 'COD' : 'NON-COD',
        paymentStatus: 'TERKIRIM',
        fileName: path.basename(filePath)
      };
    }

    // 3. J&T Cargo / bosCOD format
    if (fullText.includes('PENERIMA :') || fullText.includes('Cargo') || fullText.includes('ISI:') || (fullText.includes('No. Resi:') && !fullText.includes('Nama Produk'))) {
      const resiMatch = fullText.match(/No\.\s*Resi:\s*([A-Z0-9]+)/i);
      if (resiMatch) resi = resiMatch[1];

      const penIdx = items.findIndex(s => s.includes('PENERIMA'));
      if (penIdx !== -1 && items[penIdx + 1]) {
        recipient = items[penIdx + 1].trim();
      }

      let sender = '';
      const pengIdx = items.findIndex(s => s.includes('PENGIRIM'));
      if (pengIdx !== -1 && items[pengIdx + 1]) {
        sender = items[pengIdx + 1].trim();
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
      const orderId = orderIdMatch ? orderIdMatch[1] : '';

      // Ekstraksi Nominal Langsung dari Resi bosCOD (Prioritas Tertinggi)
      let jntNominal = 0;
      let isJntCod = /COD/i.test(fullText) && !/NON-COD/i.test(fullText);

      // 1. Cek item setelah token 'COD' di array items (e.g. ['COD', 'Rp 789.957'])
      const codIdx = items.findIndex(s => s.trim().toUpperCase() === 'COD' || s.trim().toUpperCase().includes('COD'));
      if (codIdx !== -1) {
        for (let off = 1; off <= 3; off++) {
          const nextItem = items[codIdx + off];
          if (nextItem && /Rp\s*[0-9\.\,]+/i.test(nextItem)) {
            jntNominal = parsePrice(nextItem);
            if (jntNominal > 0) {
              isJntCod = true;
              break;
            }
          }
        }
      }

      // 2. Regex pada fullText dengan separator pipe | atau : atau spasi
      if (jntNominal === 0) {
        const jntCodMatch = fullText.match(/(?:COD|Nilai\s*COD|Total\s*COD|Cargo\s*\|\s*COD)[\s\|:=]*(?:Rp\.?\s*)?([0-9\.\,]+)/i);
        if (jntCodMatch) {
          jntNominal = parsePrice(jntCodMatch[1]);
          if (jntNominal > 0) isJntCod = true;
        }
      }

      // 3. Fallback scan format rupiah "Rp xxx.xxx" pada resi
      if (jntNominal === 0) {
        const anyRpMatch = fullText.match(/Rp\s*([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]{4,8})/i);
        if (anyRpMatch) {
          jntNominal = parsePrice(anyRpMatch[1]);
          if (jntNominal > 0) isJntCod = true;
        }
      }

      let jntPhone = '-';
      const jPhoneIdx = items.findIndex(s => /^(?:628|08)\d{8,13}$/.test(s.trim()));
      if (jPhoneIdx !== -1) jntPhone = items[jPhoneIdx].trim();

      // Toko resolution: metaItem.toko > PENGIRIM > Safra
      let determinedToko = metaItem.toko || '';
      if (determinedToko && /^[:\-\s]+$/.test(String(determinedToko).trim())) {
        determinedToko = '';
      }
      if (!determinedToko && sender) {
        if (/interfarm/i.test(sender)) determinedToko = 'Interfarm';
        else if (/safra/i.test(sender)) determinedToko = 'Safra';
        else if (/fertipro/i.test(sender)) determinedToko = 'Fertipro';
        else if (/yosa/i.test(sender)) determinedToko = 'Yosa Farm';
        else if (/utamigro/i.test(sender)) determinedToko = 'Utamigro';
        else determinedToko = (!sender || /^[:\-\s]+$/.test(String(sender).trim())) ? 'Safra' : sender;
      }
      if (!determinedToko) determinedToko = 'Safra';

      return {
        recipient,
        phone: jntPhone,
        product,
        sku: '-', // Jangan gunakan Order ID internal sebagai SKU
        orderId: orderId || '-',
        qty,
        resi,
        type: 'jnt',
        isBoscod: true,
        sender: sender || '-',
        toko: determinedToko,
        expedition: 'J&T Cargo (bosCOD)',
        nominal: (metaItem.nominal && metaItem.nominal > 0) ? metaItem.nominal : jntNominal,
        paymentMethod: isJntCod ? 'COD' : 'NON-COD',
        paymentStatus: 'TERKIRIM',
        fileName: path.basename(filePath)
      };
    }

    // 4. J&T Express / TikTok Shop format (e.g. resi starts with JY, contains jet.co.id or Order Id)
    const joinedText = items.join('');
    if (fullText.includes('jet.co.id') || /JY\d{8,15}/i.test(fullText) || /JY\d{8,15}/i.test(joinedText) || /Order\s*Id\s*:/i.test(joinedText)) {
      let jyResi = '-';
      const resiMatch = (fullText + ' ' + joinedText).match(/(JY\d{8,15})/i);
      if (resiMatch) jyResi = resiMatch[1];

      let sender = '';
      const senderMatch = joinedText.match(/ng\s*i\s*r\s*i\s*m\s*:\s*([A-Za-z0-9\s]+?)(?:Pe\s*ne|Order|Weight|Ship|0\.\d|\n|$)/i);
      if (senderMatch) {
        sender = senderMatch[1].replace(/\s+/g, ' ').replace(/S\s*tore/i, 'Store').trim();
      }

      let recName = recipient !== '-' ? recipient : '-';
      const sPhoneIdx = items.findIndex(s => s.includes('(+62)') && s.includes('813'));
      if (sPhoneIdx !== -1) {
        const nextTokens = [];
        for (let k = sPhoneIdx + 1; k < items.length && k < sPhoneIdx + 6; k++) {
          if (items[k].includes('Perdamean') || items[k].includes('Jalan') || items[k].includes('Kec.') || items[k].includes('Kab.')) break;
          nextTokens.push(items[k]);
        }
        if (nextTokens.length > 0) recName = nextTokens.join('').trim();
      }

      let phone = '-';
      const phoneMatch = (fullText + ' ' + joinedText).match(/\(\+62\)\s*(82[0-9\*]{7,12})/i);
      if (phoneMatch) {
        phone = '0' + phoneMatch[1].replace(/[^0-9\*]/g, '');
      }

      let weightStr = '';
      const weightMatch = (fullText + ' ' + joinedText).match(/(\d+(?:\.\d+)?)\s*KG/i);
      if (weightMatch) weightStr = weightMatch[0];

      let qty = 1;
      const qtyMatch = joinedText.match(/J\s*u\s*m\s*l\s*a\s*h\s*:\s*(\d+)/i);
      if (qtyMatch) qty = parseInt(qtyMatch[1], 10);

      const baseName = path.basename(filePath).replace(/\.pdf$/i, '').replace(/^\d+_/, '').replace(/_/g, ' ');
      const rawProduct = (baseName && !baseName.toLowerCase().includes('default')) ? baseName : (metaItem.title || 'Produk');
      const productWithWeight = rawProduct + (weightStr ? ` (${weightStr})` : '');

      let orderId = '-';
      const orderIdMatch = (fullText + ' ' + joinedText).match(/([0-9]{16,22})/);
      if (orderIdMatch) orderId = orderIdMatch[1];

      const isCod = /COD/i.test(fullText) && !/NON-COD/i.test(fullText);

      return {
        recipient: recName !== '-' ? recName : (metaItem.recipient || 'Customer TikTok'),
        phone,
        product: productWithWeight,
        sku: orderId !== '-' ? orderId : '-',
        qty,
        resi: jyResi !== '-' ? jyResi : '-',
        type: 'jnt_express',
        toko: sender || metaItem.toko || 'Alwiwin Store',
        expedition: 'J&T Express (TikTok Shop)',
        nominal: (metaItem.nominal && metaItem.nominal > 0) ? metaItem.nominal : 0,
        paymentMethod: isCod ? 'COD' : 'NON-COD',
        paymentStatus: 'TERKIRIM',
        fileName: path.basename(filePath)
      };
    }

    return {
      recipient: recipient !== '-' ? recipient : (metaItem.recipient || metaItem.title || path.basename(filePath)),
      phone: metaItem.phone || '-',
      product: product !== '-' ? product : 'Paket',
      sku: '-',
      qty: 1,
      resi: resi !== '-' ? resi : '-',
      type: 'pdf',
      toko: metaItem.toko || '',
      expedition: 'Ekspedisi',
      nominal: (metaItem.nominal && metaItem.nominal > 0) ? metaItem.nominal : 0,
      paymentMethod: metaItem.paymentMethod || 'NON-COD',
      paymentStatus: metaItem.paymentStatus || 'TERKIRIM',
      fileName: path.basename(filePath),
    };
  } catch (err) {
    return {
      recipient: metaItem.recipient || metaItem.title || path.basename(filePath),
      phone: metaItem.phone || '-',
      product: metaItem.keterangan || metaItem.title || '-',
      sku: '-',
      qty: 1,
      resi: '-',
      type: 'error',
      toko: metaItem.toko || '',
      expedition: 'Manual',
      nominal: metaItem.nominal || 0,
      paymentMethod: metaItem.paymentMethod || 'NON-COD',
      paymentStatus: metaItem.paymentStatus || 'NON-COD',
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
    return `📭 <b>Antrean Kosong</b>\nBelum ada resi yang menunggu cetak.`;
  }

  const pagesEstimate = Math.ceil(manifestList.length / 4);
  let totalQty = 0;

  let msg = `📋 <b>Antrean Resi (${manifestList.length} Paket):</b>\n`;

  manifestList.forEach((it, index) => {
    const num = index + 1;
    const d = it.details || {};
    const rec = d.recipient && d.recipient !== '-' ? d.recipient : (it.recipient || it.title || 'Penerima');
    let prod = cleanTitle(d.product && d.product !== '-' ? d.product : (it.keterangan || it.title || 'Barang'));
    if (prod.length > 25) prod = prod.slice(0, 25) + '...';
    const qty = d.qty || 1;
    totalQty += qty;
    const priceVal = (it.nominal && it.nominal > 0) ? it.nominal : (d.nominal || 0);
    const priceStr = priceVal > 0 ? ` • Rp ${priceVal.toLocaleString('id-ID')}` : '';

    msg += `${num}. <b>${rec}</b> — ${prod} (${qty} pcs)${priceStr}\n`;
  });

  msg += `\n📦 Total: <b>${manifestList.length}</b> paket (<b>${totalQty}</b> pcs) • 📄 <b>${pagesEstimate}</b> lembar A4\n` +
         `👉 Ketik <b>/cetak</b> untuk proses.`;

  return msg;
}

/**
 * Format Packing Manifest Summary sent upon printing
 */
function formatPackingSummary(manifestList, batchName = '') {
  if (!manifestList || manifestList.length === 0) return '';

  let totalQty = 0;
  let summary = `📦 <b>Rekap Packing (${batchName || 'Batch Baru'}):</b>\n`;

  manifestList.forEach((it, index) => {
    const num = index + 1;
    const d = it.details || {};
    const rec = d.recipient && d.recipient !== '-' ? d.recipient : (it.recipient || it.title || 'Penerima');
    let prod = cleanTitle(d.product && d.product !== '-' ? d.product : (it.keterangan || it.title || 'Barang'));
    if (prod.length > 28) prod = prod.slice(0, 28) + '...';
    const qty = d.qty || 1;
    totalQty += qty;

    summary += `${num}. <b>${rec}</b> — ${prod} (<b>${qty} pcs</b>)\n`;
  });

  summary += `\n📊 Total: <b>${manifestList.length}</b> paket (<b>${totalQty} pcs</b>)`;

  return summary;
}

module.exports = {
  extractLabelDetails,
  getManifestForQueue,
  formatListMessage,
  formatPackingSummary,
};
