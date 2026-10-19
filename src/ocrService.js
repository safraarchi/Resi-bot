const sharp = require('sharp');
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
 * Recognize text from an image buffer (PNG/JPG/WEBP) with sharp preprocessing
 * @param {Buffer} imageBuffer 
 * @returns {Promise<string>} Recognized text
 */
async function recognizeReceiptImage(imageBuffer) {
  if (!imageBuffer) return '';
  try {
    let processedBuffer = imageBuffer;
    try {
      const meta = await sharp(imageBuffer).metadata();
      // Upscale resolusi jika gambar kecil agar detail teks dan angka tabel (seperti Qty) tajam
      const targetWidth = Math.max(1600, (meta.width || 800) * 2);
      processedBuffer = await sharp(imageBuffer)
        .resize({ width: targetWidth, withoutEnlargement: false })
        .sharpen({ sigma: 1.5 })
        .normalize()
        .toBuffer();
    } catch (procErr) {
      console.warn('[OCR PREPROCESS] Gagal memproses dengan sharp, fallback ke buffer asli:', procErr.message);
      processedBuffer = imageBuffer;
    }

    const worker = await getWorker();
    const result = await worker.recognize(processedBuffer);
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
  const combined = text + '\n' + caption;

  let resi = '-';
  let recipient = '-';
  let phone = '-';
  let product = '-';
  let sku = '-';
  let qty = 1;
  let expedition = 'Ekspedisi (Foto)';
  let nominal = options.explicitPrice || 0;
  let isCod = /COD/i.test(combined) && !/NON-COD/i.test(combined);

  // 1. Detect Resi (SPX, J&T, Cargo, etc.)
  const spxMatches = combined.match(/(?:SPXID|SPX)[A-Z0-9]{8,22}/gi);
  const jntMatch = combined.match(/(?:JP|JX|JY|JS|JD)[0-9]{8,15}/i);
  const cargoMatch = combined.match(/(?:300|301|302)[0-9]{9,13}/);
  const genericResi = combined.match(/(?:No\.?\s*Resi|Resi|Waybill|Tracking\s*No)\s*[:=]?\s*([A-Z0-9]{8,25})/i);

  if (spxMatches && spxMatches.length > 0) {
    // Ambil resi SPX terpanjang & terbersih (misal SPXID06636125006A)
    resi = spxMatches.sort((a, b) => b.length - a.length)[0].toUpperCase();
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
  const recMatch = combined.match(/(?:Penerima|Kepada|Nama(?:\s*Lengkap)?|Customer|Consignee)\s*[:=]?\s*([a-zA-Z\s]{3,35})/i);
  if (recMatch) {
    let cleanRec = cleanLine(recMatch[1]);
    cleanRec = cleanRec.replace(/\b(?:HOME|OFFICE|EINE|IEEE|KAB|KEC|JL|JALAN|DESA|DUSUN).*$/i, '').trim();
    if (cleanRec.length >= 3) {
      recipient = cleanRec;
    }
  } else if (phone !== '-') {
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

  // 4. Detect Table Rows & Qty (Shopee / Marketplace: # Nama Produk SKU Variasi Qty)
  const tableHeaderIdx = lines.findIndex(l => /Nama\s*Produk/i.test(l) && /(?:SKU|Variasi|Qty|Qu|y)/i.test(l));
  if (tableHeaderIdx !== -1) {
    for (let i = tableHeaderIdx + 1; i < Math.min(lines.length, tableHeaderIdx + 5); i++) {
      const rowLine = lines[i];
      if (/Pesan:|SPXID|Barcode/i.test(rowLine)) break;

      // Deteksi Qty di ujung baris produk (misal "... Kemasan 1 Kg 6" atau "... 6")
      const endQtyMatch = rowLine.match(/(?:Kemasan[^\d]*\d+\s*(?:kg|gr|g|l|ml|cc))?\s*(\d{1,3})\s*[:;]?\s*$/i) ||
                          rowLine.match(/\b(\d{1,3})\s*[:;]?\s*$/);
      if (endQtyMatch) {
        const qVal = parseInt(endQtyMatch[1], 10);
        if (qVal > 0 && qVal <= 500) {
          qty = qVal;
        }
      }

      // Deteksi SKU dari baris tabel
      if (sku === '-') {
        const skuCandidates = rowLine.match(/\b([A-Z0-9_\-]{5,22})\b/g);
        if (skuCandidates) {
          for (const cand of skuCandidates) {
            let upperCand = cand.toUpperCase();
            upperCand = upperCand.replace(/I(?=KG|L|GR|PC)/gi, '1').replace(/l(?=KG|L|GR|PC)/gi, '1');
            if (!['SHOPEE', 'VARIASI', 'INTERFARM', 'FERTIPRO', 'KEMASAN', 'BOOSTER'].includes(upperCand)) {
              sku = upperCand;
              break;
            }
          }
        }
      }

      // Deteksi Nama Produk dari baris tabel (bukan header tabel)
      if (product === '-' || /SKU\s*Variasi/i.test(product)) {
        let cleanProd = rowLine.replace(/^\d+\s+/, '')
          .replace(/\b(?:PASTASAWIT|FP-|BIANG|UG)[A-Z0-9_\-]*\b.*$/i, '')
          .replace(/\bKemasan\s*\d+.*$/i, '')
          .trim();
        if (cleanProd.length > 5) {
          product = cleanProd;
        }
      }
    }
  }

  // 5. Fallback Qty jika tidak terdeteksi dari tabel
  if (qty === 1) {
    const qtyMatch = combined.match(/(?:Qty|Jumlah|Pcs|Total\s*Barang)\s*[:=]?\s*(\d+)/i) ||
                     combined.match(/(\d+)\s*(?:pcs|paket|botol|btl|jerigen|box)\b/i);
    if (qtyMatch) {
      const qVal = parseInt(qtyMatch[1], 10);
      if (qVal > 0 && qVal <= 500) qty = qVal;
    }
  }

  // 6. Cross-verify berat label (contoh: Berat: 6600 gr dengan Kemasan 1 Kg -> 6 pcs)
  if (qty === 1) {
    const beratMatch = combined.match(/Berat\s*[:=]?\s*(\d+)\s*(?:gr|gram)/i);
    if (beratMatch) {
      const totalGr = parseInt(beratMatch[1], 10);
      const kemasanMatch = combined.match(/Kemasan\s*(\d+(?:[\.,]\d+)?)\s*(?:kg|liter|l|gr|gram)/i);
      if (kemasanMatch) {
        let unitGr = parseFloat(kemasanMatch[1].replace(',', '.'));
        if (/kg|liter|l/i.test(kemasanMatch[0])) unitGr *= 1000;
        if (unitGr >= 100) {
          const estQty = Math.round(totalGr / unitGr);
          if (estQty >= 2 && estQty <= 100) {
            qty = estQty;
          }
        }
      }
    }
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

  // 7. Detect Nominal / COD
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

  // 8. Normalisasi SKU (e.g. PASTASAWITIKG -> PASTASAWIT1KG)
  if (sku !== '-') {
    sku = sku.replace(/I(?=KG|L|GR|PC)/gi, '1').replace(/l(?=KG|L|GR|PC)/gi, '1');
  }

  // Fallback Product name jika masih kosong
  if (product === '-' || /SKU\s*Variasi/i.test(product)) {
    for (const l of lines) {
      if (/booster|pupuk|sawit|fertipro|yosa|paket|liter|jerigen|pasta|humat/i.test(l) &&
          !/pengirim|penerima|alamat|jalan|bank|cod|sku/i.test(l)) {
        product = l;
        break;
      }
    }
  }

  const explicitStoreRaw = options.explicitStore || extractStoreFromText(combined) || '';
  const cleanExplicitStore = (explicitStoreRaw && !/^[:\-\s]+$/.test(String(explicitStoreRaw).trim())) ? String(explicitStoreRaw).trim() : '';

  // 9. Resolve with Master Product Catalog
  const resolved = resolvePricing({
    sku: (isBoscod || sku === '-') ? '-' : sku,
    product: product !== '-' ? product : '',
    title: product !== '-' ? product : options.fileName || '',
    rawText: combined,
    nominal: nominal,
    qty: qty,
    toko: cleanExplicitStore,
    sender: sender,
    isCod: isCod,
    isBoscod: isBoscod,
    isManual: false,
  });

  let finalToko = resolved.toko || cleanExplicitStore || 'Safra';
  if (!finalToko || /^[:\-\s]+$/.test(String(finalToko).trim())) {
    finalToko = 'Safra';
  }
  const finalSku = (resolved.sku && resolved.sku !== '-') ? resolved.sku : (sku !== '-' ? sku : '-');
  const finalProduct = (resolved.productName && resolved.productName !== 'Produk') ? resolved.productName : (product !== '-' ? product : 'Paket');
  const finalNominal = (resolved.totalNominal > 0) ? resolved.totalNominal : (resolved.unitPrice > 0 ? resolved.unitPrice * qty : nominal);

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
