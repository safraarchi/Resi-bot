const fs = require('fs');
const path = require('path');
const { PATHS } = require('./config');

const CSV_FILE = path.join(PATHS.STORAGE, 'master_products.csv');

// In-memory cache
let cachedProducts = [];
let lastMtimeMs = 0;

/**
 * Standard RFC-4180 compliant CSV line parser handling quotes and commas
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let inQuotes = false;
  let current = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++; // Skip escaped double-quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(current.trim());
      current = '';
    } else if ((ch === '\r' || ch === '\n') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(current.trim());
      current = '';
      if (row.length > 0 && row.some(c => c.length > 0)) {
        rows.push(row);
      }
      row = [];
    } else {
      current += ch;
    }
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current.trim());
    if (row.some(c => c.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

/**
 * Clean & parse numeric currency (e.g. "85000", "Rp 85.000", "85rb")
 */
function parsePrice(raw) {
  if (raw === null || raw === undefined) return 0;
  const str = String(raw).trim().toLowerCase();
  if (!str) return 0;

  if (/(\d+(?:[\.,]\d+)?)\s*(?:jt|juta)/i.test(str)) {
    const m = str.match(/(\d+(?:[\.,]\d+)?)\s*(?:jt|juta)/i);
    return Math.round(parseFloat(m[1].replace(',', '.')) * 1000000);
  }
  if (/(\d+(?:[\.,]\d+)?)\s*(?:rb|k|ribu)/i.test(str)) {
    const m = str.match(/(\d+(?:[\.,]\d+)?)\s*(?:rb|k|ribu)/i);
    return Math.round(parseFloat(m[1].replace(',', '.')) * 1000);
  }

  const clean = str.replace(/[^0-9]/g, '');
  const n = parseInt(clean, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Extract numeric price from free-form message text / caption / reply
 * Examples: "39000", "rp 39.000", "39.000", "39rb", "39k", "395000", "harga 39000", "total 395rb"
 */
function extractPriceFromText(text) {
  if (!text) return 0;
  const str = String(text).trim();
  if (!str) return 0;

  // 1. Keyword with price: "harga: 39000", "nominal 39.000", "rp 39.000", "rp39000"
  const kwMatch = str.match(/(?:harga|nominal|nilai|total|rp\.?)\s*[:=]?\s*(?:rp\.?\s*)?([0-9\.\,]+(?:\s*(?:rb|k|ribu|jt|juta))?)/i);
  if (kwMatch) {
    const p = parsePrice(kwMatch[1]);
    if (p > 0) return p;
  }

  // 2. Suffix notation: "39rb", "39.5k", "395rb", "1.2jt", "39 ribu"
  const suffixMatch = str.match(/\b([0-9\.\,]+)\s*(?:rb|k|ribu|jt|juta)\b/i);
  if (suffixMatch) {
    const p = parsePrice(suffixMatch[0]);
    if (p > 0) return p;
  }

  // 3. Dot/comma currency formatted: "39.000", "395.000", "1.500.000"
  const dotPriceMatch = str.match(/\b([1-9][0-9]{0,2}(?:\.[0-9]{3})+)\b/);
  if (dotPriceMatch) {
    const p = parsePrice(dotPriceMatch[1]);
    if (p > 0) return p;
  }

  // 4. Raw digits between 1.000 and 50.000.000 (excluding phone numbers starting with 08 or 62)
  const plainNumMatches = str.match(/\b([1-9][0-9]{3,7})\b/g);
  if (plainNumMatches) {
    for (const numStr of plainNumMatches) {
      const val = parseInt(numStr, 10);
      if (val >= 1000 && val <= 50000000) {
        return val;
      }
    }
  }

  return 0;
}

/**
 * Extract store name if explicitly mentioned in text
 * Examples: "Fertipro 395000", "Yosa 390.000", "Alwiwin", "Interfarm"
 */
function extractStoreFromText(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  if (s.includes('fertipro')) return 'Fertipro';
  if (s.includes('yosa')) return 'Yosa Farm';
  if (s.includes('interfarm')) return 'Interfarm';
  if (s.includes('utamigro')) return 'Utamigro';
  if (s.includes('alwiwin')) return 'Alwiwin Store';
  if (s.includes('safra')) return 'Safra';
  return null;
}

/**
 * Normalize strings for fuzzy keyword comparison
 */
function normalizeText(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract volume/weight specification (ml, cc, liter, gram, kg) from text
 */
function extractSizeSpec(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();

  // Volume: Liter / L
  const lMatch = s.match(/(\d+(?:[\.,]\d+)?)\s*(?:liter|ltr|l\b)/i);
  if (lMatch) {
    const val = parseFloat(lMatch[1].replace(',', '.'));
    return { type: 'volume', ml: Math.round(val * 1000) };
  }

  // Volume: ML / CC
  const mlMatch = s.match(/(\d+(?:[\.,]\d+)?)\s*(?:ml|cc)\b/i);
  if (mlMatch) {
    const val = parseFloat(mlMatch[1].replace(',', '.'));
    return { type: 'volume', ml: Math.round(val) };
  }

  // Weight: KG (converted to equivalent liquid volume / ml: 0.5 kg ≈ 500 ml)
  const kgMatch = s.match(/(\d+(?:[\.,]\d+)?)\s*(?:kg|kilogram)\b/i);
  if (kgMatch) {
    const val = parseFloat(kgMatch[1].replace(',', '.'));
    return { type: 'weight', ml: Math.round(val * 1000) };
  }

  // Weight: GR / Gram (250 gr ≈ 250 ml/g)
  const grMatch = s.match(/(\d+(?:[\.,]\d+)?)\s*(?:gr|gram|g\b)/i);
  if (grMatch) {
    const val = parseFloat(grMatch[1].replace(',', '.'));
    return { type: 'weight', ml: Math.round(val) };
  }

  return null;
}

/**
 * Cross-store matching against Interfarm catalog based on product keywords and packaging (ml / weight)
 */
function findBestInterfarmMatch(params = {}, catalog = []) {
  const { title, rawText, keterangan, fileName, sku } = params;
  const combined = `${title || ''} ${rawText || ''} ${keterangan || ''} ${fileName || ''}`.toLowerCase();
  const searchTokens = normalizeText(combined).split(/\s+/).filter(w => w.length > 2 && !['pdf', 'file', 'paket', 'default', 'dan', 'untuk', 'dengan', 'yang'].includes(w));
  const querySize = extractSizeSpec(combined);

  const interfarmItems = catalog.filter(p => p.toko.toLowerCase() === 'interfarm' && p.hargaStandar > 0);
  if (interfarmItems.length === 0) return null;

  let bestMatch = null;
  let highestScore = 0;

  // Key targeted subjects (animal species, crops, active compounds)
  const KEY_SUBJECTS = new Set([
    'anjing', 'kucing', 'ayam', 'bebek', 'babi', 'sapi', 'kambing', 'domba',
    'lele', 'bandeng', 'nila', 'gabus', 'gurameh', 'ikan',
    'sawit', 'kopi', 'durian', 'cabai', 'cabe', 'padi', 'jagung', 'kakao', 'tebu',
    'singkong', 'ubi', 'semangka', 'kubis', 'sawi', 'bayam', 'kacangpanjang', 'pinang',
    'bawang', 'jahe', 'trichoderma', 'decomposer', 'biohumat', 'humat', 'asam'
  ]);

  for (const prod of interfarmItems) {
    const prodTarget = `${prod.normalizedNama} ${normalizeText(prod.kemasan)} ${normalizeText(prod.keterangan)} ${prod.sku.toLowerCase()}`;
    const prodSize = extractSizeSpec(`${prod.kemasan} ${prod.nama}`);

    let score = 0;

    for (const token of searchTokens) {
      if (prodTarget.includes(token)) {
        if (KEY_SUBJECTS.has(token)) {
          score += 15;
        } else if (['vitamin', 'pupuk', 'booster', 'obat', 'suplemen', 'probiotik', 'biang', 'ekstrak'].includes(token)) {
          score += 4;
        } else {
          score += 1.5;
        }
      }
    }

    // Size / volume matching
    if (querySize && prodSize) {
      if (querySize.ml === prodSize.ml) {
        score += 20; // Exact volume/weight match bonus
      } else {
        score -= 25; // Severe penalty for size mismatch (e.g. 500ml vs 1L)
      }
    }

    if (score > highestScore && score >= 18) {
      highestScore = score;
      bestMatch = { item: prod, score };
    }
  }

  return bestMatch ? bestMatch.item : null;
}

/**
 * Load master products from storage/master_products.csv with Hot-Reload
 */
function getMasterProducts(forceReload = false) {
  try {
    if (!fs.existsSync(CSV_FILE)) {
      return cachedProducts;
    }

    const stat = fs.statSync(CSV_FILE);
    if (!forceReload && cachedProducts.length > 0 && stat.mtimeMs === lastMtimeMs) {
      return cachedProducts;
    }

    const raw = fs.readFileSync(CSV_FILE, 'utf8');
    const parsedRows = parseCsv(raw);
    if (parsedRows.length <= 1) {
      return cachedProducts;
    }

    // Skip header line (Row 0)
    const header = parsedRows[0].map(h => h.toLowerCase());
    const skuIdx = header.indexOf('sku') !== -1 ? header.indexOf('sku') : 1;
    const nameIdx = header.findIndex(h => h.includes('nama') || h.includes('barang'));
    const priceIdx = header.findIndex(h => h.includes('harga standar') || h.includes('harga'));
    const wholesaleIdx = header.findIndex(h => h.includes('harga grosir'));
    const tokoIdx = header.indexOf('toko') !== -1 ? header.indexOf('toko') : 0;
    const kategoriIdx = header.indexOf('kategori');
    const kemasanIdx = header.indexOf('kemasan');
    const platformIdx = header.indexOf('platform') !== -1 ? header.indexOf('platform') : 5;
    const notesIdx = header.findIndex(h => h.includes('keterangan'));

    const list = [];
    for (let r = 1; r < parsedRows.length; r++) {
      const row = parsedRows[r];
      if (!row || row.length === 0) continue;

      const rawSku = (row[skuIdx] || '').trim();
      const rawName = (row[nameIdx >= 0 ? nameIdx : 2] || '').trim();
      const rawPrice = row[priceIdx >= 0 ? priceIdx : 6];
      const rawWholesale = wholesaleIdx >= 0 ? row[wholesaleIdx] : null;

      if (!rawSku && !rawName) continue;

      const price = parsePrice(rawPrice);
      const wholesalePrice = rawWholesale ? parsePrice(rawWholesale) : price;

      list.push({
        toko: tokoIdx >= 0 ? (row[tokoIdx] || '').trim() : '',
        sku: rawSku,
        cleanSku: normalizeText(rawSku).replace(/\s+/g, ''),
        nama: rawName,
        normalizedNama: normalizeText(rawName),
        kategori: kategoriIdx >= 0 ? (row[kategoriIdx] || '').trim() : '',
        kemasan: kemasanIdx >= 0 ? (row[kemasanIdx] || '').trim() : '',
        hargaStandar: price,
        hargaGrosir: wholesalePrice,
        platform: platformIdx >= 0 ? (row[platformIdx] || '').trim() : '',
        keterangan: notesIdx >= 0 ? (row[notesIdx] || '').trim() : '',
      });
    }

    cachedProducts = list;
    lastMtimeMs = stat.mtimeMs;
    console.log(`[CATALOG] Berhasil memuat ${cachedProducts.length} produk dari master_products.csv`);
    return cachedProducts;
  } catch (err) {
    console.error('[CATALOG ERROR] Gagal membaca master_products.csv:', err.message);
    return cachedProducts;
  }
}

/**
 * Determine store name based on specific business rules:
 * 1. Yosa Farm: If contains 'yosa farm', 'yosafarm', or 'yosa'
 * 2. Fertipro: If contains 'fertipro' or SKU starts with 'FP-'
 * 3. Catalog match Toko: Interfarm, Utamigro, Safra, Minimarket ID, etc.
 * 4. Fallback heuristics from SKU or sender
 */
function resolveStore(params = {}) {
  const { toko, sku, product, rawText, keterangan, sender } = params;
  const combined = `${toko || ''} ${sku || ''} ${product || ''} ${rawText || ''} ${keterangan || ''} ${sender || ''}`.toLowerCase();

  // Rule 1: Yosa Farm (Highest precedence per user instruction)
  if (combined.includes('yosa farm') || combined.includes('yosafarm') || /\byosa\b/.test(combined)) {
    return 'Yosa Farm';
  }

  // Rule 2: Fertipro
  if (combined.includes('fertipro') || (sku && String(sku).toUpperCase().startsWith('FP-'))) {
    return 'Fertipro';
  }

  // Rule 3: Direct Toko from catalog match
  if (toko) {
    const t = String(toko).trim();
    if (/fertipro/i.test(t)) return 'Fertipro';
    if (/utamigro/i.test(t)) return 'Utamigro';
    if (/interfarm/i.test(t)) return 'Interfarm';
    if (/safra/i.test(t)) return 'Safra';
    if (/minimarket/i.test(t)) return 'Minimarket ID';
    if (/alwiwin/i.test(t)) return 'Alwiwin Store';
    return t;
  }

  // Rule 4: SKU heuristics
  if (sku) {
    const s = String(sku).toUpperCase();
    if (s.startsWith('UG')) return 'Utamigro';
    if (s.startsWith('IF') || s.startsWith('SB') || s.startsWith('PB') || s.startsWith('VP')) return 'Interfarm';
    if (s.startsWith('SMH') || s.startsWith('MANUAL')) return 'Safra';
  }

  // Rule 5: Sender or Default (exclude Telegram handles like @username or Staff)
  if (sender && sender !== 'SAFRA' && sender !== 'Sistem' && sender !== 'Staff' && !sender.startsWith('@')) {
    return sender;
  }
  return 'Safra';
}

/**
 * 4-Tier Pricing Resolution Engine:
 * Tier 1: Explicit price (from COD label or /manual explicit input)
 * Tier 2: Exact SKU lookup in master_products.csv
 * Tier 3: Fuzzy keyword match on product title
 * Tier 4: Fallback (Rp 0, status PERLU REVIEW HARGA / PERLU INPUT HARGA)
 */
function resolvePricing(item = {}) {
  const explicitNominal = parsePrice(item.nominal || item.explicitNominal || 0);
  const qty = Math.max(1, parseInt(item.qty, 10) || 1);
  const isCod = Boolean(item.isCod || (item.paymentMethod && item.paymentMethod.toUpperCase().includes('COD')));
  const isManual = Boolean(item.isManual) || item.type === 'manual' || item.sku === 'manual' || item.sku === 'MANUAL';

  // Khusus Resi /manual: Tidak perlu pendeteksi SKU & tidak ambil harga dari database katalog kita.
  // 1) Jika ada harga yang diinputkan (misal "Harga: 39.000" / "390rb"), gunakan harga tersebut.
  // 2) Jika tidak ada harga, biarkan Rp 0 (unpriced) tanpa mencari di database/katalog.
  if (isManual) {
    const toko = resolveStore({
      toko: item.toko,
      sku: '-',
      product: item.product || item.title,
      rawText: item.rawText,
      keterangan: item.keterangan || item.notes,
      sender: item.sender || item.sip,
    });

    if (explicitNominal > 0) {
      const unitPrice = Math.round(explicitNominal / qty);
      return {
        toko,
        sku: '-',
        productName: item.product || item.title || 'Resi Manual',
        qty,
        unitPrice,
        totalNominal: explicitNominal,
        paymentMethod: isCod ? 'COD' : (item.paymentMethod || 'TRANSFER'),
        paymentStatus: item.paymentStatus || 'TERKIRIM',
        priceStatus: 'HARGA OK',
        priceSource: 'MANUAL_INPUT',
        matchedCatalogItem: null,
        notes: item.notes || item.keterangan || '-',
      };
    }

    // Jika tidak ada harganya, biarkan Rp 0 (unpriced)
    return {
      toko,
      sku: '-',
      productName: item.product || item.title || 'Resi Manual',
      qty,
      unitPrice: 0,
      totalNominal: 0,
      paymentMethod: isCod ? 'COD' : (item.paymentMethod || 'NON-COD'),
      paymentStatus: item.paymentStatus || 'TERKIRIM',
      priceStatus: '⚠️ PERLU INPUT HARGA',
      priceSource: 'UNRESOLVED',
      matchedCatalogItem: null,
      notes: 'Resi Manual (Belum ada harga)',
    };
  }

  // Tier 1: Explicit Nominal (from COD label or user input)
  if (explicitNominal > 0) {
    const unitPrice = Math.round(explicitNominal / qty);
    const toko = resolveStore({
      toko: item.toko,
      sku: item.sku,
      product: item.product || item.title,
      rawText: item.rawText,
      keterangan: item.keterangan || item.notes,
      sender: item.sender || item.sip,
    });

    return {
      toko,
      sku: item.sku || '-',
      productName: item.product || item.title || 'Produk',
      qty,
      unitPrice,
      totalNominal: explicitNominal,
      paymentMethod: isCod ? 'COD' : (item.paymentMethod || 'TRANSFER'),
      paymentStatus: 'TERKIRIM',
      priceStatus: 'HARGA OK',
      priceSource: isCod ? 'LABEL_COD' : 'EXPLICIT_INPUT',
      matchedCatalogItem: null,
      notes: item.notes || item.keterangan || '-',
    };
  }

  const catalog = getMasterProducts();
  const searchSku = (item.sku || '').trim();
  const cleanSearchSku = normalizeText(searchSku).replace(/\s+/g, '');
  const searchTitle = normalizeText(item.product || item.title || '');

  // Tier 2: Match by exact SKU in catalog
  if (cleanSearchSku && cleanSearchSku !== '-' && cleanSearchSku !== 'manual') {
    const matched = catalog.find(p => 
      p.cleanSku === cleanSearchSku || 
      p.sku.toLowerCase() === searchSku.toLowerCase()
    );

    if (matched && matched.hargaStandar > 0) {
      const total = matched.hargaStandar * qty;
      const toko = resolveStore({
        toko: item.toko || matched.toko,
        sku: matched.sku,
        product: matched.nama || item.product,
        rawText: item.rawText,
        keterangan: item.keterangan || item.notes,
        sender: item.sender || item.sip,
      });

      return {
        toko,
        sku: matched.sku,
        productName: matched.nama || item.product,
        qty,
        unitPrice: matched.hargaStandar,
        totalNominal: total,
        paymentMethod: isCod ? 'COD' : 'NON-COD',
        paymentStatus: 'TERKIRIM',
        priceStatus: 'HARGA OK',
        priceSource: 'MASTER_CSV_SKU',
        matchedCatalogItem: matched,
        notes: item.notes || item.keterangan || '-',
      };
    }
  }

  // Tier 3: Fuzzy / Keyword Match on Product Title
  if (searchTitle && searchTitle !== '-' && searchTitle !== 'paket' && searchTitle !== 'produk') {
    let bestMatch = null;
    let highestScore = 0;

    const GENERIC_WORDS = new Set(['pupuk', 'booster', 'paket', 'liter', 'organik', 'cair', 'tanaman', 'khusus', 'asli', 'promo', 'untuk', 'dengan', 'dan', 'obat', 'cairan', 'formula', 'variasi', 'kemasan']);
    const searchTokens = searchTitle.split(' ').filter(w => w.length > 2);

    for (const prod of catalog) {
      if (!prod.hargaStandar || prod.hargaStandar <= 0) continue;

      let score = 0;
      const targetTokens = `${prod.normalizedNama} ${normalizeText(prod.keterangan)}`.split(' ');

      // Count overlapping keyword tokens with distinct weighting
      for (const token of searchTokens) {
        const isGeneric = GENERIC_WORDS.has(token);
        const weight = isGeneric ? 0.5 : 3.0;

        if (targetTokens.includes(token)) {
          score += weight;
        } else if (!isGeneric && targetTokens.some(t => t.includes(token) || token.includes(t))) {
          score += 1.5;
        }
      }

      // Exact substring boost if searchTitle is specific enough
      if (searchTitle.length >= 8 && prod.normalizedNama.includes(searchTitle)) {
        score += 8;
      }

      if (score > highestScore && score >= 5.0) {
        highestScore = score;
        bestMatch = prod;
      }
    }

    if (bestMatch) {
      const total = bestMatch.hargaStandar * qty;
      const toko = resolveStore({
        toko: item.toko || bestMatch.toko,
        sku: bestMatch.sku || item.sku,
        product: bestMatch.nama || item.product,
        rawText: item.rawText,
        keterangan: item.keterangan || item.notes,
        sender: item.sender || item.sip,
      });

      return {
        toko,
        sku: bestMatch.sku || item.sku || '-',
        productName: bestMatch.nama || item.product,
        qty,
        unitPrice: bestMatch.hargaStandar,
        totalNominal: total,
        paymentMethod: isCod ? 'COD' : 'NON-COD',
        paymentStatus: 'TERKIRIM',
        priceStatus: 'HARGA OK',
        priceSource: 'MASTER_CSV_TITLE',
        matchedCatalogItem: bestMatch,
        notes: item.notes || item.keterangan || '-',
      };
    }
  }

  // Tier 3B: Cross-Store Interfarm Fallback Match (Matching by subject keywords and packaging ml/weight)
  const interfarmFallback = findBestInterfarmMatch({
    title: item.product || item.title,
    rawText: item.rawText,
    keterangan: item.keterangan || item.notes,
    fileName: item.fileName,
    sku: item.sku
  }, catalog);

  if (interfarmFallback) {
    const total = interfarmFallback.hargaStandar * qty;
    const toko = resolveStore({
      toko: item.toko,
      sku: item.sku || interfarmFallback.sku,
      product: item.product || item.title || interfarmFallback.nama,
      rawText: item.rawText,
      keterangan: item.keterangan || item.notes,
      sender: item.sender || item.sip,
    });

    return {
      toko,
      sku: interfarmFallback.sku,
      productName: item.product || interfarmFallback.nama,
      qty,
      unitPrice: interfarmFallback.hargaStandar,
      totalNominal: total,
      paymentMethod: isCod ? 'COD' : (item.paymentMethod || 'NON-COD'),
      paymentStatus: 'TERKIRIM',
      priceStatus: 'HARGA OK',
      priceSource: 'INTERFARM_FALLBACK',
      matchedCatalogItem: interfarmFallback,
      notes: `Harga disamakan dengan katalog Interfarm: ${interfarmFallback.sku} (${interfarmFallback.kemasan || interfarmFallback.nama})`,
    };
  }

  // Tier 4: Fallback (unresolved while CSV is being updated by user)
  const fallbackToko = resolveStore({
    toko: item.toko,
    sku: item.sku,
    product: item.product || item.title,
    rawText: item.rawText,
    keterangan: item.keterangan || item.notes,
    sender: item.sender || item.sip,
  });

  return {
    toko: fallbackToko,
    sku: item.sku || '-',
    productName: item.product || item.title || 'Produk',
    qty,
    unitPrice: 0,
    totalNominal: 0,
    paymentMethod: isCod ? 'COD' : (item.paymentMethod || 'NON-COD'),
    paymentStatus: 'PERLU REVIEW HARGA',
    priceStatus: '⚠️ PERLU INPUT HARGA',
    priceSource: 'UNRESOLVED',
    matchedCatalogItem: null,
    notes: (item.sku && item.sku !== '-' ? `⚠️ SKU '${item.sku}' belum ada di master_products.csv. Silakan input harga!` : '⚠️ Belum terdaftar di master_products.csv. Silakan input harga!'),
  };
}

module.exports = {
  CSV_FILE,
  getMasterProducts,
  resolvePricing,
  resolveStore,
  parsePrice,
  extractPriceFromText,
  extractStoreFromText,
  extractSizeSpec,
  findBestInterfarmMatch,
};
