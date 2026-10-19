const { PDFDocument, rgb, degrees, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const config = require('./config');
const { generateBarcode } = require('./barcodeService');
const { parsePrice } = require('./productCatalogService');

// Dimensions in Points (72 points = 1 inch)
// A4 = 210 x 297 mm
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

// A6 = 105 x 148.5 mm (Half of A5, quarter of A4)
const A6_WIDTH = 297.64;
const A6_HEIGHT = 420.94;

/**
 * Word wrap helper for PDF-lib
 */
function wrapText(text, maxWidth, font, fontSize) {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (testWidth <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

/**
 * Parse plain text shipping instructions to extract structured fields.
 */
function parseShippingText(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  let recipient = '';
  let address = '';
  let phone = '';
  let toko = '';
  let sip = config.DEFAULT_SIP || 'SAFRA';
  let senderPhone = config.DEFAULT_HP || '0856-9733-7041';
  let keterangan = '';
  let explicitNominal = 0;
  let explicitMetode = '';
  let explicitStatus = '';

  let readingAddress = false;
  let readingKeterangan = false;
  let addressAccumulator = [];
  let keteranganAccumulator = [];

  for (const line of lines) {
    // Ignore the /manual command header line
    if (line.toLowerCase().startsWith('/manual')) {
      continue;
    }

    const namaMatch = line.match(/^(?:nama|kepada|penerima)\s*[:=]?\s*(.+)$/i);
    if (namaMatch) {
      recipient = namaMatch[1].trim();
      readingAddress = false;
      readingKeterangan = false;
      continue;
    }

    const alamatMatch = line.match(/^(?:d\/a|alamat)\s*[:=]?\s*(.+)$/i);
    if (alamatMatch) {
      addressAccumulator.push(alamatMatch[1].trim());
      readingAddress = true;
      readingKeterangan = false;
      continue;
    }

    const hpMatch = line.match(/^(?:no\s*hp|no\.?\s*hp|hp|telp|wa)\s*[:=]?\s*([0-9\+\-\s]{8,25})$/i);
    if (hpMatch) {
      phone = hpMatch[1].trim();
      readingAddress = false;
      readingKeterangan = false;
      continue;
    }

    const nominalMatch = line.match(/^(?:nominal|harga|total|nilai)\s*[:=]?\s*(.+)$/i);
    if (nominalMatch) {
      explicitNominal = parsePrice(nominalMatch[1]);
      readingAddress = false;
      readingKeterangan = false;
      continue;
    }

    const statusMatch = line.match(/^(?:status|status\s*bayar|metode|metode\s*bayar|bayar)\s*[:=]?\s*(.+)$/i);
    if (statusMatch) {
      const rawVal = statusMatch[1].trim();
      explicitStatus = rawVal;
      const mStr = rawVal.toUpperCase();
      explicitMetode = mStr.includes('COD') ? 'COD' : (mStr.includes('TF') || mStr.includes('TRANSFER') || mStr.includes('LUNAS') ? 'TRANSFER' : rawVal);
      readingAddress = false;
      readingKeterangan = false;
      continue;
    }

    const tokoMatch = line.match(/^(?:toko|store|shop)\s*[:=]?\s*(.*)$/i);
    if (tokoMatch) {
      const rawToko = tokoMatch[1].trim();
      // Jika toko kosong, ":", "-", atau hanya simbol titik dua, default ke 'Safra'
      if (!rawToko || /^[:\-\s]+$/.test(rawToko)) {
        toko = 'Safra';
      } else {
        toko = rawToko;
      }
      readingAddress = false;
      readingKeterangan = false;
      continue;
    }

    const sipMatch = line.match(/^(?:sip|pengirim)\s*[:=]?\s*(.+)$/i);
    if (sipMatch) {
      sip = sipMatch[1].trim();
      readingAddress = false;
      readingKeterangan = false;
      continue;
    }

    const hpPengirimMatch = line.match(/^(?:hp\s*pengirim|hp\s*toko)\s*[:=]?\s*([0-9\+\-\s]{8,25})$/i);
    if (hpPengirimMatch) {
      senderPhone = hpPengirimMatch[1].trim();
      readingAddress = false;
      readingKeterangan = false;
      continue;
    }

    const ketMatch = line.match(/^(?:keterangan|ket|catatan|note|barang|produk)\s*[:=]?\s*(.*)$/i);
    if (ketMatch) {
      if (ketMatch[1].trim()) {
        keteranganAccumulator.push(ketMatch[1].trim());
      }
      readingAddress = false;
      readingKeterangan = true;
      continue;
    }

    if (readingAddress) {
      addressAccumulator.push(line);
      continue;
    }

    if (readingKeterangan) {
      keteranganAccumulator.push(line);
      continue;
    }

    if (!recipient) {
      recipient = line;
    } else if (addressAccumulator.length === 0) {
      addressAccumulator.push(line);
    } else {
      keteranganAccumulator.push(line);
    }
  }

  address = addressAccumulator.join(', ');
  keterangan = keteranganAccumulator.join('\n').trim();

  // Smart financial extraction from combined text if not explicit
  let finalNominal = explicitNominal;
  let finalMethod = explicitMetode;
  const combinedText = `${rawText}\n${keterangan}`;

  if (!finalMethod) {
    if (/\bcod\b/i.test(combinedText)) {
      finalMethod = 'COD';
    } else if (/\b(?:sudah\s*tf|transfer|lunas|tf)\b/i.test(combinedText)) {
      finalMethod = 'TRANSFER';
    } else {
      finalMethod = 'NON-COD';
    }
  }

  if (finalNominal === 0) {
    const codAmountMatch = combinedText.match(/(?:cod|tf|transfer|lunas)\s*[:=]?\s*(?:rp\.?\s*)?([0-9\.\,]+(?:\s*(?:rb|k|ribu|jt|juta))?)/i) ||
                           combinedText.match(/(?:rp\.?\s*)?([0-9\.\,]+(?:\s*(?:rb|k|ribu|jt|juta))?)\s*(?:[\(\[\{]?\s*(?:cod|tf|transfer|lunas)\s*[\)\]\}]?)/i);
    if (codAmountMatch) {
      const numStr = codAmountMatch[1].toLowerCase();
      if (/(\d+(?:[\.,]\d+)?)\s*(?:jt|juta)/i.test(numStr)) {
        const m = numStr.match(/(\d+(?:[\.,]\d+)?)\s*(?:jt|juta)/i);
        finalNominal = Math.round(parseFloat(m[1].replace(',', '.')) * 1000000);
      } else if (/(\d+(?:[\.,]\d+)?)\s*(?:rb|k|ribu)/i.test(numStr)) {
        const m = numStr.match(/(\d+(?:[\.,]\d+)?)\s*(?:rb|k|ribu)/i);
        finalNominal = Math.round(parseFloat(m[1].replace(',', '.')) * 1000);
      } else {
        const clean = numStr.replace(/[^0-9]/g, '');
        finalNominal = parseInt(clean, 10) || 0;
      }
    }
  }

  const finalStatus = explicitStatus || 'TERKIRIM';
  const cleanToko = (toko || '').trim();
  const finalToko = (!cleanToko || /^[:\-\s]+$/.test(cleanToko)) ? 'Safra' : cleanToko;

  return {
    recipient: recipient || '-',
    address: address || '-',
    phone: phone || '-',
    toko: finalToko,
    sip: sip || config.DEFAULT_SIP || 'SAFRA',
    senderPhone: senderPhone || config.DEFAULT_HP || '0856-9733-7041',
    keterangan: keterangan || '',
    nominal: finalNominal,
    paymentMethod: finalMethod,
    paymentStatus: finalStatus,
    explicitStatus: explicitStatus || '',
    rawText,
  };
}

/**
 * Generate photo-matched label (Rounded Box: Nama, D/A, No HP, SIP, HP, and Items below)
 */
async function createManualLabelFromPhotoFormat(data) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([A6_WIDTH, A6_HEIGHT]);

  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);

  const boxMarginX = 14;
  const boxW = A6_WIDTH - (boxMarginX * 2);
  const boxH = 230;
  const boxTop = A6_HEIGHT - 16;
  const boxBottom = boxTop - boxH;
  const r = 20;

  const svgPath = `M ${r} 0 L ${boxW - r} 0 Q ${boxW} 0 ${boxW} ${r} L ${boxW} ${boxH - r} Q ${boxW} ${boxH} ${boxW - r} ${boxH} L ${r} ${boxH} Q 0 ${boxH} 0 ${boxH - r} L 0 ${r} Q 0 0 ${r} 0 Z`;

  page.drawSvgPath(svgPath, {
    x: boxMarginX,
    y: boxTop,
    borderWidth: 2,
    borderColor: rgb(0, 0, 0),
  });

  // Dynamic scaling based on total content length
  const availableContentWidth = boxW - 85;

  let fontSize = 12.5;
  let lineSpacing = 18;

  let nameLines = wrapText(data.recipient, availableContentWidth, fontBold, fontSize);
  let addrLines = wrapText(data.address, availableContentWidth, fontBold, fontSize);
  let totalInsideLines = nameLines.length + addrLines.length + 3; // + No HP, SIP, HP

  // If text is long, dynamically scale down font and line spacing so NOTHING is truncated or overflows
  if (totalInsideLines > 8) {
    fontSize = 10.5;
    lineSpacing = 14.5;
    nameLines = wrapText(data.recipient, availableContentWidth, fontBold, fontSize);
    addrLines = wrapText(data.address, availableContentWidth, fontBold, fontSize);
    totalInsideLines = nameLines.length + addrLines.length + 3;
  }
  if (totalInsideLines > 11) {
    fontSize = 9.5;
    lineSpacing = 12.5;
    nameLines = wrapText(data.recipient, availableContentWidth, fontBold, fontSize);
    addrLines = wrapText(data.address, availableContentWidth, fontBold, fontSize);
  }

  let textY = boxTop - 26;
  const labelX = boxMarginX + 14;
  const colonX = boxMarginX + 66;
  const valueX = boxMarginX + 76;

  // Nama
  page.drawText('Nama', { x: labelX, y: textY, size: fontSize, font: fontBold });
  page.drawText(':', { x: colonX, y: textY, size: fontSize, font: fontBold });
  for (let i = 0; i < nameLines.length; i++) {
    page.drawText(nameLines[i], { x: valueX, y: textY, size: fontSize, font: fontBold });
    textY -= lineSpacing;
  }

  // D/A (Alamat Lengkap)
  page.drawText('D/A', { x: labelX, y: textY, size: fontSize, font: fontBold });
  page.drawText(':', { x: colonX, y: textY, size: fontSize, font: fontBold });
  for (let i = 0; i < addrLines.length; i++) {
    page.drawText(addrLines[i], { x: valueX, y: textY, size: fontSize, font: fontBold });
    textY -= lineSpacing;
  }

  // No HP
  page.drawText('No HP', { x: labelX, y: textY, size: fontSize, font: fontBold });
  page.drawText(':', { x: colonX, y: textY, size: fontSize, font: fontBold });
  page.drawText(data.phone, { x: valueX, y: textY, size: fontSize, font: fontBold });
  textY -= lineSpacing;

  // SIP
  page.drawText('SIP', { x: labelX, y: textY, size: fontSize, font: fontBold });
  page.drawText(':', { x: colonX, y: textY, size: fontSize, font: fontBold });
  page.drawText(data.sip, { x: valueX, y: textY, size: fontSize, font: fontBold });
  textY -= lineSpacing;

  // HP
  page.drawText('HP', { x: labelX, y: textY, size: fontSize, font: fontBold });
  page.drawText(':', { x: colonX, y: textY, size: fontSize, font: fontBold });
  page.drawText(data.senderPhone, { x: valueX, y: textY, size: fontSize, font: fontBold });

  // Keterangan di bawah kotak (Barang / Status Pembayaran)
  if (data.keterangan && data.keterangan.trim().length > 0) {
    let itemFontSize = 12;
    let itemLineSpacing = 17;
    const maxItemsW = boxW - 40;

    const rawLines = data.keterangan.split('\n').map(l => l.trim()).filter(Boolean);
    let allItemLines = [];
    let statusLine = '';

    for (const rawLine of rawLines) {
      // Saring agar Toko, Harga, dan Status TIDAK PERNAH dicetak ke label PDF fisik
      if (/^(?:toko|store|shop)\s*[:=]?/i.test(rawLine)) continue;
      if (/^(?:harga|nominal|total|nilai)\s*[:=]?/i.test(rawLine)) continue;
      if (/^(?:status|status\s*bayar|metode|metode\s*bayar|bayar)\s*[:=]?/i.test(rawLine)) continue;
      if (/^(?:sudah\s*tf|tf|cod|lunas|transfer)$/i.test(rawLine.trim())) continue;

      const split = rawLine.split(',').map(s => s.trim()).filter(Boolean);
      for (const s of split) {
        if (/^(?:toko|store|shop|harga|nominal|total|nilai|status|metode|bayar)\s*[:=]?/i.test(s)) continue;
        if (/^(?:sudah\s*tf|tf|cod|lunas|transfer)$/i.test(s)) continue;
        const wrapped = wrapText(s, maxItemsW, fontRegular, itemFontSize);
        allItemLines.push(...wrapped);
      }
    }

    if (allItemLines.length > 5) {
      itemFontSize = 10;
      itemLineSpacing = 13.5;
    }
    if (allItemLines.length > 8) {
      itemFontSize = 8.5;
      itemLineSpacing = 11.5;
    }

    let belowY = boxBottom - 24;
    const itemX = boxMarginX + 30;

    for (const itemLine of allItemLines) {
      if (belowY > 28) {
        page.drawText(itemLine, { x: itemX, y: belowY, size: itemFontSize, font: fontRegular });
        belowY -= itemLineSpacing;
      }
    }
  }

  return await doc.save();
}

/**
 * Universal label generator from text
 */
async function createLabelFromText(rawText) {
  const data = parseShippingText(rawText);
  return await createManualLabelFromPhotoFormat(data);
}

/**
 * Convert PNG/JPG image buffer into a single-page PDF
 */
async function convertImageToPdf(imageBuffer) {
  const doc = await PDFDocument.create();
  let img;
  try {
    img = await doc.embedPng(imageBuffer);
  } catch (_) {
    img = await doc.embedJpg(imageBuffer);
  }
  const page = doc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  return await doc.save();
}

/**
 * Detect tight bounding box of content in a PDF page to discard empty white borders
 */
async function detectContentBounds(pdfBytes, pageIndex = 0) {
  try {
    const parser = new PDFParse(new Uint8Array(pdfBytes));
    await parser.load();
    const page = await parser.doc.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    const pageView = page.getViewport({ scale: 1.0 });

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const w = item.width || 0;
      const h = item.height || 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    }

    if (minX === Infinity) {
      return { cropX: 0, cropY: 0, cropW: pageView.width, cropH: pageView.height, pageW: pageView.width, pageH: pageView.height };
    }

    // Always protect top logos & headers: receipts place logos/headers at top edge
    const cropTop = (pageView.height - maxY < 120) ? pageView.height : Math.min(pageView.height, maxY + 15);
    const cropBottom = Math.max(0, minY - 15);
    const cropLeft = (minX < 50) ? 0 : Math.max(0, minX - 15);
    const cropRight = (pageView.width - maxX < 50) ? pageView.width : Math.min(pageView.width, maxX + 15);

    const cropX = cropLeft;
    const cropY = cropBottom;
    const cropW = cropRight - cropLeft;
    const cropH = cropTop - cropBottom;

    // If content already spans >92% of both dimensions, it's already a full label (no crop needed)
    const isFull = (cropW / pageView.width > 0.92) && (cropH / pageView.height > 0.92);

    return {
      cropX: isFull ? 0 : cropX,
      cropY: isFull ? 0 : cropY,
      cropW: isFull ? pageView.width : cropW,
      cropH: isFull ? pageView.height : cropH,
      pageW: pageView.width,
      pageH: pageView.height,
    };
  } catch (err) {
    // Fallback: return full page if parsing text fails
    return null;
  }
}

/**
 * Tightly crop a single page into a standalone clean PDF document
 */
async function cropPageToCleanDoc(srcBytes, pageIndex = 0) {
  const bounds = await detectContentBounds(srcBytes, pageIndex);
  const srcDoc = await PDFDocument.load(srcBytes);
  const srcPage = srcDoc.getPage(pageIndex);
  const { width: pageW, height: pageH } = srcPage.getSize();

  if (!bounds || (bounds.cropW === pageW && bounds.cropH === pageH && bounds.cropX === 0 && bounds.cropY === 0)) {
    // Already full page or no crop needed
    const singleDoc = await PDFDocument.create();
    const [embedded] = await singleDoc.embedPdf(srcDoc, [pageIndex]);
    const singlePage = singleDoc.addPage([pageW, pageH]);
    singlePage.drawPage(embedded, { x: 0, y: 0, width: pageW, height: pageH });
    return {
      pdfBytes: await singleDoc.save(),
      width: pageW,
      height: pageH,
    };
  }

  // Create clean intermediate doc sized exactly to the cropped label
  const cleanDoc = await PDFDocument.create();
  const cleanPage = cleanDoc.addPage([bounds.cropW, bounds.cropH]);

  const [embedded] = await cleanDoc.embedPdf(srcDoc, [pageIndex]);
  cleanPage.drawPage(embedded, {
    x: -bounds.cropX,
    y: -bounds.cropY,
    width: bounds.pageW,
    height: bounds.pageH,
  });

  return {
    pdfBytes: await cleanDoc.save(),
    width: bounds.cropW,
    height: bounds.cropH,
  };
}

/**
 * Merge an array of PDF files (and/or buffers) into an A4 Grid (2x2 = 4 labels per page)
 * Includes Smart Auto-Crop and Adaptive Rotation based on aspect ratio!
 * @param {Array<string|Buffer>} inputPdfs - Array of file paths or raw buffers
 * @param {string} outputPath - Path to save the final compiled A4 PDF
 * @returns {Promise<{ totalLabels: number, totalPages: number, outputPath: string }>}
 */
async function mergeLabelsToA4(inputPdfs, outputPath) {
  if (!inputPdfs || inputPdfs.length === 0) {
    throw new Error('Tidak ada file resi untuk digabungkan.');
  }

  // Pre-process all pages: auto-crop white spaces to produce clean standalone label buffers
  const cleanLabels = []; // Stores { pdfBytes, width, height }
  for (const item of inputPdfs) {
    try {
      let pdfBytes;
      if (typeof item === 'string') {
        pdfBytes = fs.readFileSync(item);
      } else if (Buffer.isBuffer(item) || item instanceof Uint8Array) {
        pdfBytes = item;
      } else {
        continue;
      }

      const tempDoc = await PDFDocument.load(pdfBytes);
      const pageCount = tempDoc.getPageCount();

      for (let i = 0; i < pageCount; i++) {
        const srcPage = tempDoc.getPage(i);
        const { width: pW, height: pH } = srcPage.getSize();

        // Native manual text labels generated by bot are already standard A6 with exact outer borders
        const isStandardA6 = Math.abs(pW - A6_WIDTH) < 2 && Math.abs(pH - A6_HEIGHT) < 2;

        if (isStandardA6) {
          const singleDoc = await PDFDocument.create();
          const [embedded] = await singleDoc.embedPdf(tempDoc, [i]);
          const singlePage = singleDoc.addPage([pW, pH]);
          singlePage.drawPage(embedded, { x: 0, y: 0, width: pW, height: pH });
          cleanLabels.push({
            pdfBytes: await singleDoc.save(),
            width: pW,
            height: pH,
          });
        } else {
          // External PDF (Shopee, bosCOD, J&T, etc.): Smart crop empty borders while protecting 100% of top logos & headers!
          const cropped = await cropPageToCleanDoc(pdfBytes, i);
          cleanLabels.push(cropped);
        }
      }
    } catch (err) {
      console.error(`Gagal memproses file resi "${item}":`, err.message);
    }
  }

  if (cleanLabels.length === 0) {
    throw new Error('Semua file resi yang diinput tidak valid atau kosong.');
  }

  const finalDoc = await PDFDocument.create();

  // Grid Layout settings (2 columns x 2 rows = 4 per page)
  const marginX = 8;
  const marginY = 8;
  const colWidth = (A4_WIDTH - (marginX * 2)) / 2;    // ~289.64 pt
  const rowHeight = (A4_HEIGHT - (marginY * 2)) / 2;  // ~412.94 pt

  const getQuadrantRect = (index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = marginX + (col * colWidth);
    const y = row === 0 ? marginY + rowHeight : marginY;
    return { x, y, width: colWidth, height: rowHeight };
  };

  let currentPage = null;

  for (let i = 0; i < cleanLabels.length; i++) {
    const slotIndex = i % 4;

    // Create a new A4 page every 4 labels
    if (slotIndex === 0) {
      currentPage = finalDoc.addPage([A4_WIDTH, A4_HEIGHT]);

      const centerX = A4_WIDTH / 2;
      const centerY = A4_HEIGHT / 2;

      // Vertical dashed cut guideline
      currentPage.drawLine({
        start: { x: centerX, y: marginY },
        end: { x: centerX, y: A4_HEIGHT - marginY },
        thickness: 0.75,
        color: rgb(0.7, 0.7, 0.7),
        dashArray: [4, 4],
      });

      // Horizontal dashed cut guideline
      currentPage.drawLine({
        start: { x: marginX, y: centerY },
        end: { x: A4_WIDTH - marginX, y: centerY },
        thickness: 0.75,
        color: rgb(0.7, 0.7, 0.7),
        dashArray: [4, 4],
      });
    }

    const { pdfBytes, width: labelW, height: labelH } = cleanLabels[i];
    const singleDoc = await PDFDocument.load(pdfBytes);
    const [embeddedPage] = await finalDoc.embedPdf(singleDoc, [0]);

    const cell = getQuadrantRect(slotIndex);
    const padding = 6;
    const maxDrawW = cell.width - (padding * 2);
    const maxDrawH = cell.height - (padding * 2);

    // ADAPTIVE ORIENTATION:
    // If the cropped label is dominantly landscape (width > height * 1.05):
    // Rotate 90° counter-clockwise so its longer dimension fills the vertical height of the slot!
    // If it's dominantly portrait or square: keep upright!
    const isLandscape = labelW > (labelH * 1.05);

    if (isLandscape) {
      // Rotate 90° counter-clockwise (degrees(90))
      // Width becomes effective height, Height becomes effective width
      const scale = Math.min(maxDrawW / labelH, maxDrawH / labelW);
      const drawW = labelW * scale;
      const drawH = labelH * scale;
      const effW = drawH;
      const effH = drawW;

      const drawX = cell.x + padding + (maxDrawW - effW) / 2;
      const drawY = cell.y + padding + (maxDrawH - effH) / 2;

      currentPage.drawPage(embeddedPage, {
        x: drawX + effW,
        y: drawY,
        width: drawW,
        height: drawH,
        rotate: degrees(90),
      });
    } else {
      // Normal upright portrait
      const scale = Math.min(maxDrawW / labelW, maxDrawH / labelH);
      const drawW = labelW * scale;
      const drawH = labelH * scale;

      const drawX = cell.x + padding + (maxDrawW - drawW) / 2;
      const drawY = cell.y + padding + (maxDrawH - drawH) / 2;

      currentPage.drawPage(embeddedPage, {
        x: drawX,
        y: drawY,
        width: drawW,
        height: drawH,
        rotate: degrees(0),
      });
    }
  }

  // Ensure output directory exists
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const mergedPdfBytes = await finalDoc.save();
  fs.writeFileSync(outputPath, mergedPdfBytes);

  return {
    totalLabels: cleanLabels.length,
    totalPages: finalDoc.getPageCount(),
    outputPath,
  };
}

module.exports = {
  createLabelFromText,
  createManualLabelFromPhotoFormat,
  convertImageToPdf,
  parseShippingText,
  detectContentBounds,
  cropPageToCleanDoc,
  mergeLabelsToA4,
  A4_WIDTH,
  A4_HEIGHT,
  A6_WIDTH,
  A6_HEIGHT,
};
