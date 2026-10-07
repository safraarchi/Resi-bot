const path = require('path');
const fs = require('fs');
const { createLabelFromText, mergeLabelsToA4 } = require('./src/pdfService');

async function test() {
  console.log('Testing PDF label generation...');
  const sampleText1 = `J&T Express
Resi: JX9988776655
Penerima: Budi Santoso (08123456789)
Alamat: Jl. Mawar No. 12, RT 01/RW 02, Menteng, Jakarta Pusat
Pengirim: Toko Herbal Sehat (0855112233)
Catatan: COD Rp 85.000 / 2 Botol Madu Hutan`;

  const sampleText2 = `SiCepat REG
Resi: 002987112233
Penerima: Siti Aminah (087811223344)
Alamat: Perumahan Graha Indah Blok C2 No. 8, Sukajadi, Kota Bandung
Pengirim: Grosir Fashion Bandung
Catatan: 1 Gamis Muslimah Size L`;

  const sampleText3 = `Shopee Xpress
Resi: SPXID048291029
Penerima: Hendra Wijaya (082199887766)
Alamat: Jl. Gajah Mada No. 44, Kel. Bencongan, Kec. Kelapa Dua, Tangerang
Pengirim: Gadget Official Shop
Catatan: Casing HP & Tempered Glass`;

  const sampleText4 = `JNE REG
Resi: JNE0192837465
Penerima: Maya Safitri (089900112233)
Alamat: Jl. Kaliurang KM 5, Gang Pandega Marta No. 15, Sleman, Yogyakarta
Pengirim: Snack Nusantara Jogja
Catatan: 5 Bungkus Keripik Singkong`;

  const sampleText5 = `Anteraja
Resi: 100084729102
Penerima: Rizky Pratama (08381234567)
Alamat: Jl. Pemuda No. 101, Semarang Tengah, Kota Semarang
Pengirim: Toko Sepatu Jaya
Catatan: Sepatu Sneakers Size 42`;

  const buf1 = await createLabelFromText(sampleText1);
  const buf2 = await createLabelFromText(sampleText2);
  const buf3 = await createLabelFromText(sampleText3);
  const buf4 = await createLabelFromText(sampleText4);
  const buf5 = await createLabelFromText(sampleText5);

  const testDir = path.join(__dirname, 'test_output');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  const label1Path = path.join(testDir, 'label1.pdf');
  const label2Path = path.join(testDir, 'label2.pdf');
  const label3Path = path.join(testDir, 'label3.pdf');
  const label4Path = path.join(testDir, 'label4.pdf');
  const label5Path = path.join(testDir, 'label5.pdf');

  fs.writeFileSync(label1Path, buf1);
  fs.writeFileSync(label2Path, buf2);
  fs.writeFileSync(label3Path, buf3);
  fs.writeFileSync(label4Path, buf4);
  fs.writeFileSync(label5Path, buf5);

  console.log('5 sample A6 labels generated successfully.');

  const mergedPath = path.join(testDir, 'HASIL_A4_MERGED.pdf');
  const result = await mergeLabelsToA4([label1Path, label2Path, label3Path, label4Path, label5Path], mergedPath);
  console.log('Merge Result:', result);
  console.log('SUCCESS! File generated at:', mergedPath);
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
