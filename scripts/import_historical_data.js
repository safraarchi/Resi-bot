/**
 * Script to import historical batches from 2026-10-08 to 2026-10-15 into Google Sheets
 */
const fs = require('fs');
const path = require('path');
const { getManifestForQueue } = require('../src/manifestService');
const financeService = require('../src/financeService');

const BATCHES = [
  { dir: 'storage/archive/2026-10-08/batch_2026-10-08_15-13', batchId: 'batch_2026-10-08_15-13', timestamp: '2026-10-08 15:13:00' },
  { dir: 'storage/archive/2026-10-09/batch_2026-10-09_13-04', batchId: 'batch_2026-10-09_13-04', timestamp: '2026-10-09 13:04:00' },
  { dir: 'storage/archive/2026-10-09/batch_2026-10-09_13-15', batchId: 'batch_2026-10-09_13-15', timestamp: '2026-10-09 13:15:00' },
  { dir: 'storage/archive/2026-10-09/batch_2026-10-09_15-01', batchId: 'batch_2026-10-09_15-01', timestamp: '2026-10-09 15:01:00' },
  { dir: 'storage/archive/2026-10-10/batch_2026-10-10_13-32', batchId: 'batch_2026-10-10_13-32', timestamp: '2026-10-10 13:32:00' },
  { dir: 'storage/archive/2026-10-12/batch_2026-10-12_10-54', batchId: 'batch_2026-10-12_10-54', timestamp: '2026-10-12 10:54:00' },
  { dir: 'storage/archive/2026-10-13/batch_2026-10-13_13-46', batchId: 'batch_2026-10-13_13-46', timestamp: '2026-10-13 13:46:00' },
  { dir: 'storage/archive/2026-10-13/batch_2026-10-13_14-16', batchId: 'batch_2026-10-13_14-16', timestamp: '2026-10-13 14:16:00' },
  { dir: 'storage/archive/2026-10-14/batch_2026-10-14_13-48', batchId: 'batch_2026-10-14_13-48', timestamp: '2026-10-14 13:48:00' },
  { dir: 'storage/archive/2026-10-15/batch_2026-10-15_13-57', batchId: 'batch_2026-10-15_13-57', timestamp: '2026-10-15 13:57:00' },
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runImport() {
  console.log('====================================================');
  console.log('🚀 MEMULAI IMPORT DATA HISTORIS DARI TANGGAL 8 OKTOBER');
  console.log('====================================================\n');

  let totalImportedBatches = 0;
  let totalImportedOrders = 0;
  let grandTotalNominal = 0;
  const storeBreakdownTotal = {};

  for (let i = 0; i < BATCHES.length; i++) {
    const b = BATCHES[i];
    const metaPath = path.join(__dirname, '..', b.dir, 'batch_meta.json');
    if (!fs.existsSync(metaPath)) {
      console.warn(`[SKIP] Batch meta tidak ditemukan: ${metaPath}`);
      continue;
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    console.log(`[${i + 1}/${BATCHES.length}] Memproses ${b.batchId} (${meta.items.length} resi, Waktu: ${b.timestamp})...`);

    // Map item paths to archivedPath or local batch dir
    const items = meta.items.map(it => {
      let resolvedPath = it.archivedPath;
      if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        resolvedPath = path.join(__dirname, b.dir, path.basename(it.filePath || it.fileName));
      }
      return {
        ...it,
        filePath: resolvedPath,
      };
    });

    const manifestList = await getManifestForQueue(items);

    // Record batch to Google Sheets with custom timestamp
    const res = await financeService.recordBatchTransactions(manifestList, b.batchId, b.timestamp);

    if (res && res.syncedToGoogleSheet) {
      totalImportedBatches++;
      totalImportedOrders += res.totalTransactions;
      grandTotalNominal += res.totalBatchNominal;

      console.log(`  ✅ Berhasil kirim ${res.totalTransactions} orderan ke Google Sheets! Total Omzet: Rp ${res.totalBatchNominal.toLocaleString('id-ID')}`);

      // Accumulate store breakdown
      for (const [store, sData] of Object.entries(res.storeBreakdown || {})) {
        if (!storeBreakdownTotal[store]) {
          storeBreakdownTotal[store] = { count: 0, nominal: 0 };
        }
        storeBreakdownTotal[store].count += sData.count;
        storeBreakdownTotal[store].nominal += sData.nominal;
      }
    } else {
      console.error(`  ❌ Gagal mengirim batch ${b.batchId}:`, res ? res.errorNotice : 'Unknown error');
    }

    // Delay between batches to prevent Apps Script congestion
    await sleep(1500);
  }

  console.log('\n====================================================');
  console.log('🎉 PROSES IMPORT DATA HISTORIS SELESAI!');
  console.log('====================================================');
  console.log(`📦 Total Batch Terkirim : ${totalImportedBatches} batch`);
  console.log(`📋 Total Orderan Masuk : ${totalImportedOrders} transaksi`);
  console.log(`💰 Grand Total Omzet   : Rp ${grandTotalNominal.toLocaleString('id-ID')}`);
  console.log('\n📊 Breakdown per Toko:');
  for (const [store, sData] of Object.entries(storeBreakdownTotal)) {
    console.log(`  • ${store.padEnd(14)}: ${String(sData.count).padStart(2)} paket | Rp ${sData.nominal.toLocaleString('id-ID')}`);
  }
}

runImport().catch(err => {
  console.error('[FATAL ERROR]', err);
});
