const path = require('path');
const fs = require('fs');
const queueService = require('./src/queueService');
const { createLabelFromText, mergeLabelsToA4, parseShippingText } = require('./src/pdfService');

async function runTest() {
  console.log('====================================================');
  console.log('🧪 TESTING UPGRADE: AUTO-ROTATION & PHOTO MANUAL LABEL');
  console.log('====================================================\n');

  // Test 1: Parser and Photo format text label
  const samplePhotoText = `Nama: Anton Ekawirawan
D/A: Jl. Tiga No. 17, KPR, PT. IKPP, Perawang Tualang Siak Riau
No HP: 0882-7107-9535
Barang: POC Biang 2 L, Pasta 1 Kg, Bio Soil 3, Phospat 500, Buvaria, MKP 1 l
Status: SUDAH TF`;

  const parsed = parseShippingText(samplePhotoText);
  console.log('1. Parsed manual photo text:', {
    recipient: parsed.recipient,
    phone: parsed.phone,
    sip: parsed.sip,
    senderPhone: parsed.senderPhone,
    status: parsed.status,
    itemsCount: parsed.items.length,
  });

  const manualPdfBuffer1 = await createLabelFromText(samplePhotoText);
  console.log('✅ Label manual 1 generated successfully (Buffer length:', manualPdfBuffer1.length, 'bytes)');

  const samplePhotoText2 = `Nama: Siti Rahmawati
Alamat: Dusun Sukamaju RT 03 RW 01, Desa Bangun Jaya, Kec. Tambusai Utara, Rokan Hulu, Riau
No HP: 0812-3456-7890
Barang: Paket Biang Kocor Sawit 2 Drum, Perekat 500ml
Status: COD Rp 395.000`;

  const manualPdfBuffer2 = await createLabelFromText(samplePhotoText2);
  console.log('✅ Label manual 2 generated successfully (Buffer length:', manualPdfBuffer2.length, 'bytes)');

  // Clear previous test output
  const testDir = path.join(__dirname, 'test_output');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  const manual1Path = path.join(testDir, 'manual_label_1.pdf');
  const manual2Path = path.join(testDir, 'manual_label_2.pdf');
  fs.writeFileSync(manual1Path, manualPdfBuffer1);
  fs.writeFileSync(manual2Path, manualPdfBuffer2);

  // Test 2: Imposition with auto-rotation on Sample/1.pdf (Shopee landscape) and Sample/2.pdf (bosCOD square)
  const sampleShopee = path.join(__dirname, 'Sample', '1.pdf');
  const sampleBoscod = path.join(__dirname, 'Sample', '2.pdf');

  console.log('\n2. Testing 2x2 Grid A4 Merge with auto-rotation...');
  console.log('Inputs:');
  console.log(' - Quadrant 1 (Top-Left)    : Sample/1.pdf (Shopee Landscape 842x595)');
  console.log(' - Quadrant 2 (Top-Right)   : Sample/2.pdf (bosCOD Square 283x283)');
  console.log(' - Quadrant 3 (Bottom-Left) : manual_label_1.pdf (Photo format Anton Ekawirawan)');
  console.log(' - Quadrant 4 (Bottom-Right): manual_label_2.pdf (Photo format Siti Rahmawati)');

  const mergedOutputPath = path.join(testDir, 'HASIL_A4_PERFECT_BOX.pdf');
  const mergeResult = await mergeLabelsToA4(
    [sampleShopee, sampleBoscod, manual1Path, manual2Path],
    mergedOutputPath
  );

  console.log('\n✅ MERGE RESULT:');
  console.log(' - Total resi   :', mergeResult.totalLabels);
  console.log(' - Total halaman:', mergeResult.totalPages);
  console.log(' - Output file  :', mergeResult.outputPath);

  // Test 3: Queue & Archive lifecycle
  console.log('\n3. Testing Queue & Archive lifecycle...');
  queueService.clearQueue();
  console.log('Queue cleared. Initial count:', queueService.getQueueCount());

  // Add 3 resi to queue
  await queueService.addPdfToQueue('shopee_batch1.pdf', fs.readFileSync(sampleShopee));
  await queueService.addPdfToQueue('boscod_batch1.pdf', fs.readFileSync(sampleBoscod));
  await queueService.addTextToQueue(samplePhotoText);

  console.log('3 resi added to queue. Current queue count:', queueService.getQueueCount());

  // Merge batch 1
  const batch1Out = path.join(testDir, 'BATCH_1_RESULT.pdf');
  await mergeLabelsToA4(queueService.getQueueFiles(), batch1Out);
  const archiveResult = queueService.archiveQueue('test_batch_1');
  console.log('Batch 1 merged & archived to:', archiveResult.archiveDir);
  console.log('Queue count after Batch 1 archive:', queueService.getQueueCount(), '(harus 0)');

  if (queueService.getQueueCount() !== 0) {
    throw new Error('Queue should be 0 after archive!');
  }

  // Next batch (e.g. next day) receives 1 new resi
  await queueService.addTextToQueue(samplePhotoText2);
  console.log('New resi added for next batch. Queue count:', queueService.getQueueCount(), '(harus 1)');

  if (queueService.getQueueCount() !== 1) {
    throw new Error('Queue should only have 1 new resi!');
  }

  // Clean queue after test
  queueService.clearQueue();

  console.log('\n====================================================');
  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
