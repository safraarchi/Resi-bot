const Tesseract = require('tesseract.js');
const { parsePrice, resolveStore, resolvePricing, extractPriceFromText, extractStoreFromText } = require('./productCatalogService');

let workerPromise = null;

/**
 * Get or initialize singleton Tesseract worker
 */
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await Tesseract.createWorker('eng');
      return worker;
    })();
  }
  return await workerPromise;
}

/**
 * Recognize text from an image buffer (PNG/JPG/WEBP)
 * @param {Buffer} imageBuffer 
 * @returns {Promise<string>} Recognized text
 */
async function recognizeReceiptImage(imageBuffer) {
  if (!imageBuffer) return '';
  try {
    const worker = await getWorker();
    const result = await worker.recognize(imageBuffer);
    return (result && result.data && result.data.text) ? result.data.text.trim() : '';
  } catch (err) {
    console.error('[OCR ERROR] Gagal mengenali gambar:', err.message);
    return '';
  }
}

/**
 * Clean whitespace and lines
 */
function cleanLine(str) {
  if (!str) return '';
  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Parse structured shipping & product details from OCR text
 * @param {string} ocrText - Raw recognized text from image
 * @param {Object} [options] - Optional caption, explicitPrice, explicitStore, fileName
 */
function parseReceiptOcrText(ocrText, options = {}) {
  const text = (ocrText || '').trim();
  const caption = (options.caption || '').trim();
  const combined = `${text}\n${caption}`;

  let resi = '-';
  let recipient = '-';
  let phone = '-';
  let product = '-';
  let sku = '-';
  let qty = 1;
  let expedition = 'Ekspedisi (Foto)';
  let nominal = options.explicitPrice || 0;
  let isCod = /COD/i.test(combined) && !/NON-COD/i.test(combined);

  // 1. Detect Resi
  const spxMatch = combined.match(/(?:SPXID|SPX)[A-Z0-9]{8,22}/i);
  const jntMatch = combined.match(/(?:JP|JX|JY|JS|JD)[0-9]{8,15}/i);
  const cargoMatch = combined.match(/(?:300|301|302)[0-9]{9,13}/);
  const genericResi = combined.match(/(?:No\.?\s*Resi|Resi|Waybill|Tracking\s*No)\s*[:=]?\s*([A-Z0-9]{8,25})/i);

  if (spxMatch) {
    resi = spxMatch[0].toUpperCase();
    expedition = 'Shopee (SPX)';
  } else if (jntMatch) {
    resi = jntMatch[0].toUpperCase();
    expedition = resi.startsWith('JY') ? 'J&T Express (TikTok Shop)' : 'J&T Express';
  } else if (cargoMatch) {
    resi = cargoMatch[0];
    expedition = 'J&T Cargo (bosCOD)';
  } else if (genericResi) {
    resi = genericResi[1].toUpperCase();
  }

  // 2. Detect Phone Number
  const phoneMatch = combined.match(/(?:08|628|\+628)[0-9\-\s]{8,15}/);
  if (phoneMatch) {
    phone = phoneMatch[0].replace(/[^0-9]/g, '');
    if (phone.startsWith('62')) phone = '0' + phone.slice(2);
  }

  // 3. Detect Recipient Name
  const lines = text.split('\n').map(l => cleanLine(l)).filter(Boolean);
  const recMatch = combined.match(/(?:Penerima|Kepada|Nama(?:\s*Lengkap)?|Customer|Consignee)\s*[:=]?\s*([^\r\n]{3,40})/i);
  if (recMatch && !/pengirim|shopee|ekspedisi|berat|cod|produk|barang/i.test(recMatch[1])) {
    recipient = cleanLine(recMatch[1]);
  } else if (phone !== '-') {
    // Look around the line containing the phone number
    const pIdx = lines.findIndex(l => l.includes(phone) || l.includes(phone.slice(3)));
    if (pIdx !== -1) {
      for (let offset of [-1, 1, -2, 2]) {
        const candidate = lines[pIdx + offset];
        if (candidate && candidate.length >= 3 && candidate.length <= 40 &&
            !/penerima|pengirim|berat|resi|cod|qty|sku|variasi|jalan|jl\.|rt|rw|kec\.|kab\./i.test(candidate)) {
          recipient = candidate;
          break;
        }
      }
    }
  }

  // 4. Detect Qty
  const qtyMatch = combined.match(/(?:Qty|Jumlah|Pcs|Total\s*Barang)\s*[:=]?\s*(\d+)/i) ||
                   combined.match(/(\d+)\s*(?:pcs|paket|botol|btl|jerigen|box)\b/i);
  if (qtyMatch) {
    const qVal = parseInt(qtyMatch[1], 10);
    if (qVal > 0 && qVal <= 1000) qty = qVal;
  }

  // Detect bosCOD format & sender
  const isBoscod = /bosCOD|boscod|cargo/i.test(combined) || (combined.includes('PENERIMA') && combined.includes('PENGIRIM'));
  if (isBoscod) {
    expedition = 'J&T Cargo (bosCOD)';
  }

  let sender = '';
  const pengirimMatch = combined.match(/(?:PENGIRIM|Pengirim|Dari)\s*[:=]?\s*([^\r\n]{3,35})/i);
  if (pengirimMatch && !/penerima|alamat|jalan|resi|isi|qty|cod/i.test(pengirimMatch[1])) {
    sender = cleanLine(pengirimMatch[1]);
  }

  // 5. Detect Nominal / COD (Prioritaskan harga pada label resi bosCOD / COD)
  if (nominal === 0) {
    const codMatch = combined.match(/(?:COD|Nilai\s*COD|Total\s*COD|Tagihan|Cargo\s*\|\s*COD)[\s\|:=]*(?:Rp\.?\s*)?([0-9\.\,]+)/i);
    if (codMatch) {
      const p = parsePrice(codMatch[1]);
      if (p > 0) {
        nominal = p;
        isCod = true;
      }
    }
  }
  if (nominal === 0) {
    const anyRpMatch = combined.match(/Rp\s*([0-9]{1,3}(?:\.[0-9]{3})+|[0-9]{4,8})/i);
    if (anyRpMatch) {
      const p = parsePrice(anyRpMatch[1]);
      if (p > 0) {
        nominal = p;
        isCod = true;
      }
    }
  }
  if (nominal === 0 && caption) {
    nominal = extractPriceFromText(caption);
  }

  // 6. Detect SKU & Product from text
  const skuMatch = combined.match(/(?:SKU|Kode\s*Barang|Order\s*ID)\s*[:=]?\s*([A-Z0-9_\-]{4,25})/i);
  if (skuMatch) {
    sku = skuMatch[1].trim();
  }
  if (isBoscod && /^\d{12,20}$/.test(sku)) {
    sku = '-';
  }

  const prodMatch = combined.match(/(?:Nama\s*Produk|Produk|Barang|Isi|Item)\s*[:=]?\s*([^\n\r]+)/i);
  if (prodMatch) {
    product = cleanLine(prodMatch[1]);
  } else {
    // Find candidate product line
    for (const l of lines) {
      if (/booster|pupuk|sawit|fertipro|yosa|paket|liter|jerigen|pasta|humat/i.test(l) &&
          !/pengirim|penerima|alamat|jalan|bank|cod/i.test(l)) {
        product = l;
        break;
      }
    }
  }

  // 7. Resolve with Master Product Catalog (exact SKU, fuzzy title, store & standard price)
  const resolved = resolvePricing({
    sku: (isBoscod || sku === '-') ? '-' : sku,
    product: product !== '-' ? product : '',
    title: product !== '-' ? product : options.fileName || '',
    rawText: combined,
    nominal: nominal,
    qty: qty,
    toko: options.explicitStore || extractStoreFromText(combined) || '',
    sender: sender,
    isCod: isCod,
    isBoscod: isBoscod,
    isManual: false,
  });

  const finalToko = resolved.toko || options.explicitStore || extractStoreFromText(combined) || 'Safra';
  const finalSku = (resolved.sku && resolved.sku !== '-') ? resolved.sku : (sku !== '-' ? sku : '-');
  const finalProduct = (resolved.productName && resolved.productName !== 'Produk') ? resolved.productName : (product !== '-' ? product : 'Paket');
  const finalNominal = (resolved.totalNominal > 0) ? resolved.totalNominal : nominal;

  return {
    resi: resi !== '-' ? resi : '-',
    recipient: recipient !== '-' ? recipient : 'Penerima',
    phone: phone !== '-' ? phone : '-',
    product: finalProduct,
    sku: finalSku,
    qty: qty,
    nominal: finalNominal,
    unitPrice: resolved.unitPrice || (qty > 0 ? Math.round(finalNominal / qty) : 0),
    toko: finalToko,
    expedition: expedition,
    paymentMethod: isCod ? 'COD' : 'NON-COD',
    paymentStatus: 'TERKIRIM',
    priceStatus: resolved.priceStatus || (finalNominal > 0 ? 'HARGA OK' : '⚠️ PERLU INPUT HARGA'),
    priceSource: resolved.priceSource || (finalNominal > 0 ? 'OCR_DETECTED' : 'UNRESOLVED'),
    ocrText: text,
  };
}

module.exports = {
  recognizeReceiptImage,
  parseReceiptOcrText,
};
