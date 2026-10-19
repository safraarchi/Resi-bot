const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { parseShippingText } = require('./src/pdfService');
const productCatalogService = require('./src/productCatalogService');
const financeService = require('./src/financeService');

console.log('====================================================');
console.log('🧪 MEMULAI TEST UNIT & INTEGRASI SISTEM KEUANGAN (UPDATE)');
console.log('====================================================\n');

// ------------------------------------------------------------------
// 1. Test Text Parser untuk Manual Shipping & Fleksibilitas Format Harga
// ------------------------------------------------------------------
console.log('▶ Test 1: Pengujian Parsing Harga Fleksibel (/manual)...');

// Format: 39.000
const t1 = parseShippingText('/manual\nNama: Budi\nAlamat: Riau\nNo HP: 08123\nHarga: 39.000\nKeterangan: Barang A');
assert.strictEqual(t1.nominal, 39000, 'Harga 39.000 harus bernilai 39000');
console.log('  ✅ [PASS] Format "Harga: 39.000" -> Rp 39.000');

// Format: 390000
const t2 = parseShippingText('/manual\nNama: Budi\nAlamat: Riau\nNo HP: 08123\nHarga: 390000\nKeterangan: Barang B');
assert.strictEqual(t2.nominal, 390000, 'Harga 390000 harus bernilai 390000');
console.log('  ✅ [PASS] Format "Harga: 390000" -> Rp 390.000');

// Format: 390rb
const t3 = parseShippingText('/manual\nNama: Budi\nAlamat: Riau\nNo HP: 08123\nHarga: 390rb\nKeterangan: Barang C');
assert.strictEqual(t3.nominal, 390000, 'Harga 390rb harus bernilai 390000');
console.log('  ✅ [PASS] Format "Harga: 390rb" -> Rp 390.000');

// Format: 39k
const t4 = parseShippingText('/manual\nNama: Budi\nAlamat: Riau\nNo HP: 08123\nHarga: 39k\nKeterangan: Barang D');
assert.strictEqual(t4.nominal, 39000, 'Harga 39k harus bernilai 39000');
console.log('  ✅ [PASS] Format "Harga: 39k" -> Rp 39.000');

// Format: Rp 395.000
const t5 = parseShippingText('/manual\nNama: Budi\nAlamat: Riau\nNo HP: 08123\nHarga: Rp 395.000\nKeterangan: Barang E');
assert.strictEqual(t5.nominal, 395000, 'Harga Rp 395.000 harus bernilai 395000');
console.log('  ✅ [PASS] Format "Harga: Rp 395.000" -> Rp 395.000');

// ------------------------------------------------------------------
// 2. Test Klasifikasi Toko (Fertipro, Yosa Farm, Interfarm, Utamigro)
// ------------------------------------------------------------------
console.log('\n▶ Test 2: Pengujian Klasifikasi Toko (Store Classification)...');

// Yosa Farm rule
const sYosa = productCatalogService.resolvePricing({
  sku: 'BIANG-SAWIT-YOSA',
  product: 'Biang Sawit Yosafarm Formula Kocor',
  qty: 1,
});
assert.strictEqual(sYosa.toko, 'Yosa Farm', 'Harus terdeteksi sebagai Yosa Farm');
console.log('  ✅ [PASS] Resi dengan SKU/keterangan "yosa farm" -> Toko: "Yosa Farm"');

const sYosa2 = productCatalogService.resolvePricing({
  sku: '-',
  product: 'Paket Sawit Yosa',
  keterangan: 'Orderan Yosa Farm',
  nominal: 395000,
});
assert.strictEqual(sYosa2.toko, 'Yosa Farm');
console.log('  ✅ [PASS] Input manual ada kata "Yosa Farm" -> Toko: "Yosa Farm"');

// Fertipro rule
const sFerti = productCatalogService.resolvePricing({
  sku: 'FP-PAKET-1HA',
  product: 'Paket Fertipro Sawit 1 Hektar',
  qty: 1,
});
assert.strictEqual(sFerti.toko, 'Fertipro', 'Harus terdeteksi sebagai Fertipro');
console.log('  ✅ [PASS] Resi dengan SKU "FP-..." / "fertipro" -> Toko: "Fertipro"');

// Interfarm rule
const sInter = productCatalogService.resolvePricing({
  sku: 'SAWITGAMBUT',
  product: 'Paket Sawit Gambut',
  qty: 1,
});
assert.strictEqual(sInter.toko, 'Interfarm');
console.log('  ✅ [PASS] Resi dengan SKU "SAWITGAMBUT" -> Toko: "Interfarm"');

// Utamigro rule
const sUtami = productCatalogService.resolvePricing({
  sku: 'UGKOPI',
  product: 'Pupuk Kopi Booster',
  qty: 1,
});
assert.strictEqual(sUtami.toko, 'Utamigro');
console.log('  ✅ [PASS] Resi dengan SKU "UGKOPI" -> Toko: "Utamigro"');

// Rule: Toko kosong, ":", atau "-" otomatis masuk ke Safra
const sColon = productCatalogService.resolvePricing({
  isManual: true,
  toko: ':',
  product: 'Produk Tanpa Toko Khusus',
  nominal: 100000,
});
assert.strictEqual(sColon.toko, 'Safra', 'Toko ":" harus otomatis masuk ke Safra');
console.log('  ✅ [PASS] Toko ":" -> Otomatis masuk ke Safra');

const sEmpty = productCatalogService.resolvePricing({
  isManual: true,
  toko: '',
  product: 'Produk Tanpa Toko Khusus',
  nominal: 100000,
});
assert.strictEqual(sEmpty.toko, 'Safra', 'Toko kosong "" harus otomatis masuk ke Safra');
console.log('  ✅ [PASS] Toko kosong "" -> Otomatis masuk ke Safra');

const sDash = productCatalogService.resolvePricing({
  isManual: true,
  toko: '-',
  product: 'Produk Tanpa Toko Khusus',
  nominal: 100000,
});
assert.strictEqual(sDash.toko, 'Safra', 'Toko "-" harus otomatis masuk ke Safra');
console.log('  ✅ [PASS] Toko "-" -> Otomatis masuk ke Safra');

// Test parseShippingText dengan template Toko: : dan Toko: kosong
const parsedTextColon = parseShippingText(
  '/manual\nNama: H. Budi\nAlamat: Jl. Melati No. 5\nNo HP: 08123456789\nToko: :\nHarga: 250000\nKeterangan: Paket Khusus'
);
assert.strictEqual(parsedTextColon.toko, 'Safra', 'Text format "Toko: :" harus menghasilkan toko "Safra"');
console.log('  ✅ [PASS] Format text /manual dengan "Toko: :" -> Otomatis toko "Safra"');

const parsedTextEmpty = parseShippingText(
  '/manual\nNama: H. Budi\nAlamat: Jl. Melati No. 5\nNo HP: 08123456789\nToko: \nHarga: 250000\nKeterangan: Paket Khusus'
);
assert.strictEqual(parsedTextEmpty.toko, 'Safra', 'Text format "Toko: " harus menghasilkan toko "Safra"');
console.log('  ✅ [PASS] Format text /manual dengan "Toko: " (kosong) -> Otomatis toko "Safra"');

const parsedTextNoToko = parseShippingText(
  '/manual\nNama: H. Budi\nAlamat: Jl. Melati No. 5\nNo HP: 08123456789\nHarga: 250000\nKeterangan: Paket Khusus'
);
assert.strictEqual(parsedTextNoToko.toko, 'Safra', 'Text format /manual tanpa baris Toko harus menghasilkan toko "Safra"');
console.log('  ✅ [PASS] Format text /manual tanpa baris Toko -> Otomatis toko "Safra"');

// ------------------------------------------------------------------
// 3. Test Master Product Catalog & Fallback Peringatan Harga
// ------------------------------------------------------------------
console.log('\n▶ Test 3: Pengujian Master Catalog (430+ Produk) & Status Peringatan Harga...');

const catalog = productCatalogService.getMasterProducts();
assert.ok(catalog.length >= 400, `Katalog harus memuat minimal 400 produk, saat ini: ${catalog.length}`);
console.log(`  ✅ [PASS] Berhasil me-load ${catalog.length} produk dari storage/master_products.csv`);

// Unknown product alert
const sUnpriced = productCatalogService.resolvePricing({
  sku: 'SKU-TIDAK-DIKENAL-XYZ',
  product: 'Produk Misterius Belum Terdaftar',
  qty: 1,
});
assert.strictEqual(sUnpriced.totalNominal, 0);
assert.strictEqual(sUnpriced.priceStatus, '⚠️ PERLU INPUT HARGA');
console.log('  ✅ [PASS] Produk belum terdaftar di CSV menghasilkan status "⚠️ PERLU INPUT HARGA"');

// ------------------------------------------------------------------
// 4. Test Finance Service Batch Breakdown & Telegram HTML Alert
// ------------------------------------------------------------------
console.log('\n▶ Test 4: Pengujian Batch Breakdown Toko & Notifikasi Telegram...');

const mockManifestList = [
  {
    recipient: 'Pak Budi',
    phone: '08123456789',
    details: {
      resi: 'SPXID10001',
      recipient: 'Pak Budi',
      phone: '08123456789',
      expedition: 'Shopee (SPX)',
      sku: 'FP-PAKET-1HA',
      product: 'Paket Fertipro Sawit',
      qty: 1,
    }
  },
  {
    recipient: 'Pak Yosa',
    phone: '085697337041',
    details: {
      resi: 'JNT998877',
      recipient: 'Pak Yosa',
      phone: '085697337041',
      expedition: 'J&T Cargo (bosCOD)',
      sku: 'BIANG-SAWIT-YOSA',
      product: 'Biang Sawit Yosafarm',
      qty: 2,
    }
  },
  {
    recipient: 'Pak Joko (Resi Belum Ada Harga)',
    phone: '081999888777',
    details: {
      resi: 'JNT_UNPRICED',
      recipient: 'Pak Joko',
      phone: '081999888777',
      expedition: 'J&T Cargo',
      sku: 'PRODUK-BARU-BELUM-ADA',
      product: 'Pupuk Belum Didaftarkan',
      qty: 1,
    }
  }
];

(async () => {
  const summary = await financeService.recordBatchTransactions(mockManifestList, 'batch_test_stores');
  assert.ok(summary);
  assert.strictEqual(summary.totalTransactions, 3);
  assert.strictEqual(summary.unresolvedCount, 1, 'Harus ada 1 transaksi yang belum ada harga');
  assert.strictEqual(summary.unresolvedList.length, 1);
  assert.strictEqual(summary.unresolvedList[0].resi, 'JNT_UNPRICED');

  assert.ok(summary.storeBreakdown['Fertipro'], 'Harus ada breakdown Fertipro');
  assert.ok(summary.storeBreakdown['Yosa Farm'], 'Harus ada breakdown Yosa Farm');
  console.log('  ✅ [PASS] Breakdown per Toko (Fertipro, Yosa Farm) berhasil dihitung');

  const reportMsg = financeService.formatFinanceReportMessage(summary);
  assert.ok(reportMsg.includes('Fertipro'));
  assert.ok(reportMsg.includes('Yosa Farm'));
  assert.ok(reportMsg.includes('PERINGATAN RESI BELUM ADA HARGA'));
  assert.ok(reportMsg.includes('JNT_UNPRICED'));
  console.log('  ✅ [PASS] Notifikasi Telegram menyertakan Breakdown Toko & Peringatan Resi Belum Ada Harga');

  // ------------------------------------------------------------------
  // 5. Test Khusus /manual: Tidak ada pendeteksi SKU & Tidak Ambil dari Database
  // ------------------------------------------------------------------
  console.log('\n▶ Test 5: Pengujian Khusus Resi /manual (Tanpa SKU & Tanpa Ambil Database)...');

  // Case A: Manual dengan harga sendiri (misal 350.000 meskipun di database produk ini 395.000)
  const manualWithPrice = productCatalogService.resolvePricing({
    isManual: true,
    product: 'Paket Fertipro Sawit 1 Hektar',
    nominal: 350000,
    qty: 1,
  });
  assert.strictEqual(manualWithPrice.totalNominal, 350000, 'Harus pakai harga yang diinputkan');
  assert.strictEqual(manualWithPrice.sku, '-', 'SKU manual harus "-" tanpa pendeteksi SKU');
  assert.strictEqual(manualWithPrice.priceSource, 'MANUAL_INPUT');
  assert.strictEqual(manualWithPrice.priceStatus, 'HARGA OK');
  console.log('  ✅ [PASS] /manual dengan harga custom -> Memakai harga sendiri (Rp 350.000) & SKU "-"');

  // Case B: Manual TANPA harga (meskipun nama produk ada di database, TIDAK BOLEH ambil harga database)
  const manualNoPrice = productCatalogService.resolvePricing({
    isManual: true,
    product: 'Paket Fertipro Sawit 1 Hektar', // ada di master_products.csv (395.000)
    nominal: 0,
    qty: 1,
  });
  assert.strictEqual(manualNoPrice.totalNominal, 0, 'Jika manual tanpa harga, harus tetap Rp 0 (tidak ambil dari database)');
  assert.strictEqual(manualNoPrice.sku, '-', 'SKU manual harus "-"');
  assert.strictEqual(manualNoPrice.priceStatus, '⚠️ PERLU INPUT HARGA');
  assert.strictEqual(manualNoPrice.priceSource, 'UNRESOLVED');
  assert.strictEqual(manualNoPrice.matchedCatalogItem, null);
  console.log('  ✅ [PASS] /manual tanpa harga -> Tetap Rp 0 ("⚠️ PERLU INPUT HARGA") & TIDAK ambil dari database');

  // Case C: Non-manual (PDF Shopee/J&T) dengan nama produk sama -> Tetap ambil dari database
  const nonManual = productCatalogService.resolvePricing({
    isManual: false,
    sku: 'FP-PAKET-1HA',
    product: 'Paket Fertipro Sawit 1 Hektar',
    nominal: 0,
    qty: 1,
  });
  assert.strictEqual(nonManual.totalNominal, 395000, 'Non-manual harus tetap mengambil harga dari katalog');
  assert.strictEqual(nonManual.priceStatus, 'HARGA OK');
  console.log('  ✅ [PASS] Non-manual (PDF) -> Tetap mengambil dari database katalog (Rp 395.000)');

  // ------------------------------------------------------------------
  // 6. Test Pendeteksian OCR Foto Resi (Shopee, J&T, Status Terkirim)
  // ------------------------------------------------------------------
  console.log('\n▶ Test 6: Pengujian OCR Foto Resi & Standarisasi Status TERKIRIM...');
  const ocrService = require('./src/ocrService');

  const samplePhotoText = 'SPX Express\nSPXID04829182910\nPenerima: Nurdin IBS\n081234567890\nNama Produk: Paket Fertipro Sawit 1 Hektar\nSKU: FP-PAKET-1HA\nQty: 2\nCOD: Rp 790.000';
  const parsedOcr = ocrService.parseReceiptOcrText(samplePhotoText);

  assert.strictEqual(parsedOcr.resi, 'SPXID04829182910');
  assert.strictEqual(parsedOcr.recipient, 'Nurdin IBS');
  assert.strictEqual(parsedOcr.sku, 'FP-PAKET-1HA');
  assert.strictEqual(parsedOcr.qty, 2);
  assert.strictEqual(parsedOcr.nominal, 790000);
  assert.strictEqual(parsedOcr.toko, 'Fertipro');
  assert.strictEqual(parsedOcr.paymentStatus, 'TERKIRIM', 'Semua status COD/Non-COD harus TERKIRIM (Bukan Menunggu Cair)');
  console.log('  ✅ [PASS] OCR Foto Resi berhasil mendeteksi SKU, Qty, Resi, Toko & Harga secara otomatis');
  console.log('  ✅ [PASS] Status order berhasil distandarisasi ke "TERKIRIM" (Tidak ada lagi "MENUNGGU CAIR")');

  // ------------------------------------------------------------------
  // 7. Test Khusus Resi bosCOD: Prioritaskan Harga Resi & Anti-Salah Toko
  // ------------------------------------------------------------------
  console.log('\n▶ Test 7: Pengujian Khusus Resi bosCOD (Prioritas Harga Resi & Anti-Salah Toko)...');
  const manifestService = require('./src/manifestService');

  // Case A: Sample/2.pdf (bosCOD Darwin - Paket Pasta 2 pcs, COD Rp 789.957, Pengirim: Interfarm)
  const boscodDetails1 = await manifestService.extractLabelDetails(path.join(__dirname, 'Sample', '2.pdf'));
  assert.strictEqual(boscodDetails1.nominal, 789957, 'Nominal harus Rp 789.957 langsung dari resi bosCOD');
  assert.strictEqual(boscodDetails1.toko, 'Interfarm', 'Toko harus Interfarm (dari Pengirim), bukan Fertipro');
  assert.strictEqual(boscodDetails1.isBoscod, true);

  const pricing1 = productCatalogService.resolvePricing({
    nominal: boscodDetails1.nominal,
    product: boscodDetails1.product,
    qty: boscodDetails1.qty,
    sender: boscodDetails1.sender,
    toko: boscodDetails1.toko,
    isBoscod: true,
  });
  assert.strictEqual(pricing1.totalNominal, 789957, 'Total omzet harus Rp 789.957 dari label resi, bukan database');
  assert.strictEqual(pricing1.toko, 'Interfarm', 'Toko harus Interfarm, BUKAN Fertipro!');
  assert.strictEqual(pricing1.priceSource, 'RESI_BOSCOD');
  console.log('  ✅ [PASS] bosCOD Darwin -> Memakai harga resi (Rp 789.957) & Toko Interfarm (Bukan Fertipro)');

  // Case B: Sample/conth/4.pdf (bosCOD Halbert - PAKET PASTA (FREE POC 5 L), COD Rp 1.185.000, Pengirim: Safra)
  const boscodDetails2 = await manifestService.extractLabelDetails(path.join(__dirname, 'Sample', 'conth', '4.pdf'));
  assert.strictEqual(boscodDetails2.nominal, 1185000, 'Nominal harus Rp 1.185.000 langsung dari resi bosCOD');
  assert.strictEqual(boscodDetails2.toko, 'Safra', 'Toko harus Safra (dari Pengirim), bukan Fertipro');

  const pricing2 = productCatalogService.resolvePricing({
    nominal: boscodDetails2.nominal,
    product: boscodDetails2.product,
    qty: boscodDetails2.qty,
    sender: boscodDetails2.sender,
    toko: boscodDetails2.toko,
    isBoscod: true,
  });
  assert.strictEqual(pricing2.totalNominal, 1185000);
  assert.strictEqual(pricing2.toko, 'Safra', 'Toko harus Safra, BUKAN Fertipro!');
  console.log('  ✅ [PASS] bosCOD Halbert -> Memakai harga resi (Rp 1.185.000) & Toko Safra (Bukan Fertipro)');

  // Case C: bosCOD tanpa harga di label -> Tetap Rp 0 dan butuh input (TIDAK BOLEH tebak database jadi Fertipro)
  const boscodNoPrice = productCatalogService.resolvePricing({
    isBoscod: true,
    product: 'Paket Pasta (Free POC 5L)',
    nominal: 0,
    qty: 1,
    sender: 'Interfarm',
  });
  assert.strictEqual(boscodNoPrice.totalNominal, 0, 'bosCOD tanpa harga harus tetap Rp 0');
  assert.strictEqual(boscodNoPrice.priceStatus, '⚠️ PERLU INPUT HARGA');
  assert.notStrictEqual(boscodNoPrice.toko, 'Fertipro', 'bosCOD tidak boleh sembarangan mencocokkan ke Fertipro');
  console.log('  ✅ [PASS] bosCOD tanpa harga -> Tetap Rp 0 ("⚠️ PERLU INPUT HARGA") & tidak salah tebak ke Fertipro');

  // Case D: Resi 201831121275 (Suparlan - PAKET FERTIPRO, COD Rp 395.000, Pengirim: FERTIPRO.ID)
  const fileSuparlan = path.join(__dirname, 'storage', 'archive', '2026-10-17', 'batch_2026-10-17_14-07', '1792206605454_201831121275.pdf');
  if (fs.existsSync(fileSuparlan)) {
    const detailsSuparlan = await manifestService.extractLabelDetails(fileSuparlan);
    assert.strictEqual(detailsSuparlan.resi, '201831121275');
    assert.strictEqual(detailsSuparlan.nominal, 395000, 'Nominal harus Rp 395.000 langsung dari resi bosCOD Suparlan');
    assert.strictEqual(detailsSuparlan.toko, 'Fertipro');

    const pricingSuparlan = productCatalogService.resolvePricing({
      nominal: detailsSuparlan.nominal,
      product: detailsSuparlan.product,
      qty: detailsSuparlan.qty,
      sender: detailsSuparlan.sender,
      toko: detailsSuparlan.toko,
      isBoscod: true,
    });
    assert.strictEqual(pricingSuparlan.totalNominal, 395000, 'Total harus Rp 395.000 (bukan 1.185.000)!');
    assert.strictEqual(pricingSuparlan.priceSource, 'RESI_BOSCOD');

    // Uji jika tanpa harga di label: Harus mendeteksi Paket 1 Ha (395.000), BUKAN 3 Ha (1.185.000)
    const pricingSuparlanNoPrice = productCatalogService.resolvePricing({
      nominal: 0,
      product: detailsSuparlan.product, // "PAKET FERTIPRO"
      qty: 1,
      sender: detailsSuparlan.sender,
      toko: detailsSuparlan.toko,
      isBoscod: true,
    });
    assert.strictEqual(pricingSuparlanNoPrice.totalNominal, 395000, 'Jika tanpa harga, harus mendeteksi Paket 1 Ha (Rp 395.000), bukan 3 Ha!');
    assert.strictEqual(pricingSuparlanNoPrice.sku, 'FP-PAKET-1HA', 'SKU harus FP-PAKET-1HA');
    console.log('  ✅ [PASS] Resi 201831121275 (Suparlan) -> Harga Rp 395.000 dari label & default Paket 1 Ha (bukan 3 Ha)');
  }

  // Case E: Resi 201830492960 (Syamsul Arifin)
  const fileSyamsul = path.join(__dirname, 'storage', 'archive', '2026-10-17', 'batch_2026-10-17_14-07', '1792121801977_201830492960.pdf');
  if (fs.existsSync(fileSyamsul)) {
    const detailsSyamsul = await manifestService.extractLabelDetails(fileSyamsul);
    assert.strictEqual(detailsSyamsul.resi, '201830492960');
    assert.strictEqual(detailsSyamsul.nominal, 395000, 'Nominal Syamsul harus Rp 395.000');
    const pricingSyamsul = productCatalogService.resolvePricing({
      nominal: detailsSyamsul.nominal,
      product: detailsSyamsul.product,
      qty: detailsSyamsul.qty,
      sender: detailsSyamsul.sender,
      toko: detailsSyamsul.toko,
      isBoscod: true,
    });
    assert.strictEqual(pricingSyamsul.totalNominal, 395000);
    assert.strictEqual(pricingSyamsul.sku, 'FP-PAKET-1HA');
    console.log('  ✅ [PASS] Resi 201830492960 (Syamsul Arifin) -> Harga Rp 395.000 & SKU FP-PAKET-1HA');
  }

  // Case F: Aturan Fertipro 3 Ha: "jadi misal ada yang beli 3 ha gitu barti harganya di kali 3 dari 1 ha gitu"
  const pricing3HaNoPrice = productCatalogService.resolvePricing({
    nominal: 0,
    product: 'Paket Fertipro Sawit 3 Ha',
    qty: 1,
    toko: 'Fertipro',
    isBoscod: true,
  });
  assert.strictEqual(pricing3HaNoPrice.qty, 3, 'Qty harus 3');
  assert.strictEqual(pricing3HaNoPrice.unitPrice, 395000, 'Unit price harus 395.000 (1 Ha)');
  assert.strictEqual(pricing3HaNoPrice.totalNominal, 1185000, 'Total harus 3 * 395.000 = 1.185.000');
  assert.strictEqual(pricing3HaNoPrice.sku, 'FP-PAKET-1HA', 'SKU tetap FP-PAKET-1HA (tidak ada bundle 3ha)');
  console.log('  ✅ [PASS] Fertipro 3 Ha tanpa harga di label -> 3 x Rp 395.000 = Rp 1.185.000 (SKU: FP-PAKET-1HA)');

  // Case G: Prioritas Label Resi: "tapi kita prioristaskan dlu harga di bos cod itu berapa harganya dulu"
  const pricing3HaWithLabelPrice = productCatalogService.resolvePricing({
    nominal: 395000, // Label hanya tertera 395.000
    product: 'Paket Fertipro Sawit 3 Ha',
    qty: 1,
    toko: 'Fertipro',
    isBoscod: true,
  });
  assert.strictEqual(pricing3HaWithLabelPrice.totalNominal, 395000, 'Harus prioritas harga label Rp 395.000!');
  assert.strictEqual(pricing3HaWithLabelPrice.sku, 'FP-PAKET-1HA');
  console.log('  ✅ [PASS] Prioritas Label bosCOD: Walau tertulis 3 Ha tapi label Rp 395.000 -> Total tetap Rp 395.000');

  // Bersihkan pending buffer dari test
  fs.writeFileSync(path.join(__dirname, 'storage', 'pending_finance.json'), '[]', 'utf8');

  console.log('\n====================================================');
  console.log('🎉 SELURUH TEST BERHASIL (ALL 15+ TESTS PASSED 100%)!');
  console.log('====================================================');
})();
