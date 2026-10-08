const ptp = require('pdf-to-printer');
const config = require('./config');

/**
 * Get list of available printers on the system
 */
async function getAvailablePrinters() {
  try {
    return await ptp.getPrinters();
  } catch (err) {
    console.error('[PRINTER ERROR] Gagal mendeteksi printer:', err.message);
    return [];
  }
}

/**
 * Print PDF file directly to physical printer in Monochrome (Hitam Putih)
 * @param {string} filePath - Absolute path to PDF file
 * @param {string} [targetPrinter] - Optional printer name override
 * @returns {Promise<{ success: boolean, printer: string, error?: string }>}
 */
async function printPdfMonochrome(filePath, targetPrinter = null) {
  try {
    const printerName = targetPrinter || process.env.PRINTER_NAME || 'EPSON L3250 Series';
    console.log(`[PRINTER] Mencetak ${filePath} ke "${printerName}" dengan setting HITAM PUTIH...`);

    await ptp.print(filePath, {
      printer: printerName,
      monochrome: true, // Hitam Putih / Grayscale
    });

    console.log(`[PRINTER SUCCESS] Dokumen berhasil dikirim ke antrean cetak ${printerName}.`);
    return { success: true, printer: printerName };
  } catch (err) {
    console.error('[PRINTER ERROR] Gagal mencetak dokumen:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  getAvailablePrinters,
  printPdfMonochrome,
};
