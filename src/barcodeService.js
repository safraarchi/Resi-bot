const bwipjs = require('bwip-js');

/**
 * Generate 1D Barcode (Code 128) as PNG Buffer
 * @param {string} text - Tracking number or alphanumeric string
 * @returns {Promise<Buffer>}
 */
async function generateBarcode(text) {
  try {
    const png = await bwipjs.toBuffer({
      bcid: 'code128',       // Barcode type
      text: text,            // Text to encode
      scale: 3,              // 3x scaling factor
      height: 12,            // Bar height, in millimeters
      includetext: true,     // Show human-readable text
      textxalign: 'center',  // Always good to set this
      textsize: 11,
    });
    return png;
  } catch (err) {
    console.error(`Failed to generate barcode for text "${text}":`, err.message);
    return null;
  }
}

/**
 * Generate QR Code as PNG Buffer
 * @param {string} text
 * @returns {Promise<Buffer>}
 */
async function generateQRCode(text) {
  try {
    const png = await bwipjs.toBuffer({
      bcid: 'qrcode',
      text: text,
      scale: 3,
      height: 25,
      width: 25,
    });
    return png;
  } catch (err) {
    console.error(`Failed to generate QR code for "${text}":`, err.message);
    return null;
  }
}

module.exports = {
  generateBarcode,
  generateQRCode,
};
