/**
 * ====================================================================
 * 📊 GOOGLE APPS SCRIPT: SISTEM LAPORAN KEUANGAN & WEB DASHBOARD
 * ====================================================================
 * Arsitektur 3 Sheet:
 * 1. 'Master_Product'  : Katalog referensi produk (Toko, SKU, Nama, Harga Standar, Grosir)
 * 2. 'List_Order'      : List transaksi orderan tanpa batas (Unlimited)
 * 3. 'Rekap_Keuangan'  : Rekapitulasi otomatis per tanggal & breakdown per Toko
 * 
 * Web App Dashboard:
 * - Executive Modern Grid Dashboard (Mobile & Desktop Responsive)
 * - Semua pembayaran langsung dihitung ke Omzet (tanpa pembagian tagihan COD / Transfer)
 * - Visual Charts (Chart.js): Tren Penjualan Harian & Proporsi Omzet Toko
 * - Rekapitulasi Bulan Ini (Oktober 2026) dengan 4 metrik kinerja
 * - Simple Notice Bar untuk orderan yang belum ada harganya
 * - Modal Dialog Interaktif untuk Input Harga Langsung dari Web ke Spreadsheet
 * ====================================================================
 */

function doGet(e) {
  // Jika parameter api=json diminta
  if (e && e.parameter && e.parameter.api === "json") {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var listSheet = setupListOrderSheet(ss);
    var data = listSheet.getDataRange().getValues();
    return ContentService.createTextOutput(JSON.stringify({
      status: "ok",
      totalRows: Math.max(0, data.length - 1)
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // Jika parameter action=get_data diminta
  if (e && e.parameter && e.parameter.action === "get_data") {
    return ContentService.createTextOutput(JSON.stringify(getDashboardData()))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Tampilkan Executive Web HTML Dashboard Interaktif
  return HtmlService.createHtmlOutput(getDashboardHtml())
    .setTitle("Executive Financial Dashboard - Bot Resi Multi-Toko")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no");
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({
        status: "error",
        message: "No POST body received"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Pastikan 3 Sheet utama sudah ada
    setupMasterProductSheet(ss);
    var sheetOrder = setupListOrderSheet(ss);
    var sheetRekap = setupRekapSheet(ss);

    // 1. Aksi Sinkronisasi Master Product dari CSV
    if (data.action === "sync_master_products") {
      return handleSyncMasterProducts(ss, data.products || []);
    }

    // 2. Aksi Update Harga / Status / Buat Order / Ambil Data Langsung dari Web App
    if (data.action === "update_order_price" || data.action === "update_order_status" || data.action === "update_order") {
      var updateRes = updateOrderPrice(data);
      return ContentService.createTextOutput(JSON.stringify(updateRes)).setMimeType(ContentService.MimeType.JSON);
    }

    if (data.action === "create_manual_order") {
      var createRes = createManualOrder(data);
      return ContentService.createTextOutput(JSON.stringify(createRes)).setMimeType(ContentService.MimeType.JSON);
    }

    if (data.action === "get_data") {
      var dashData = getDashboardData();
      return ContentService.createTextOutput(JSON.stringify(dashData)).setMimeType(ContentService.MimeType.JSON);
    }

    // 3. Aksi Pencatatan Batch Transaksi Orderan
    var transactions = data.transactions || [];
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: "No transactions to insert"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var batchId = data.batchId || "-";
    var batchTimestamp = data.timestamp || Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyy-MM-dd HH:mm:ss");
    var dateParts = batchTimestamp.split(" ");
    var dateStr = dateParts[0] || Utilities.formatDate(new Date(), "Asia/Jakarta", "yyyy-MM-dd");
    var timeStr = dateParts[1] || Utilities.formatDate(new Date(), "Asia/Jakarta", "HH:mm:ss");

    var rowsToInsert = [];
    var totalBatchNominal = 0;
    var unpricedItems = [];
    var storeBreakdown = {};

    for (var i = 0; i < transactions.length; i++) {
      var t = transactions[i];
      var qty = cleanNumber(t.qty) || 1;
      var unitPrice = cleanNumber(t.unitPrice);
      var totalNominal = cleanNumber(t.totalNominal) || (unitPrice * qty);
      var rawToko = String(t.toko || "").trim();
      var toko = (!rawToko || /^[:\-\s]+$/.test(rawToko)) ? "Safra" : rawToko;

      var priceSource = t.priceSource || "-";
      var priceStatus = (totalNominal > 0) ? "HARGA OK" : "⚠️ PERLU INPUT HARGA";

      if (totalNominal === 0) {
        unpricedItems.push({
          resi: t.resi,
          sku: t.sku,
          toko: toko,
          recipient: t.recipient
        });
      }

      totalBatchNominal += totalNominal;

      if (!storeBreakdown[toko]) {
        storeBreakdown[toko] = { count: 0, nominal: 0, unpriced: 0 };
      }
      storeBreakdown[toko].count++;
      storeBreakdown[toko].nominal += totalNominal;
      if (totalNominal === 0) {
        storeBreakdown[toko].unpriced++;
      }

      var orderStatus = (t.paymentStatus || t.status || "TERKIRIM").trim();
      if (!orderStatus) orderStatus = "TERKIRIM";
      var upperSt = orderStatus.toUpperCase();
      if (upperSt.indexOf("RETUR") !== -1 || upperSt.indexOf("BATAL") !== -1) {
        orderStatus = "RETUR";
      }

      rowsToInsert.push([
        batchTimestamp,
        dateStr,
        timeStr,
        batchId,
        t.resi || "-",
        toko,
        t.recipient || "-",
        t.phone ? "'" + t.phone : "-",
        t.expedition || "-",
        t.sku || "-",
        t.product || t.productName || "-",
        qty,
        unitPrice,
        totalNominal,
        "TRANSFER",
        orderStatus,
        priceSource,
        priceStatus,
        t.notes || "-"
      ]);
    }

    if (rowsToInsert.length > 0) {
      var lastRow = sheetOrder.getLastRow();
      var targetRange = sheetOrder.getRange(lastRow + 1, 1, rowsToInsert.length, rowsToInsert[0].length);
      targetRange.setValues(rowsToInsert);

      // Format kolom Harga Satuan (Kolom 13) dan Total Omzet (Kolom 14) dengan format Rupiah
      var priceRange = sheetOrder.getRange(lastRow + 1, 13, rowsToInsert.length, 2);
      priceRange.setNumberFormat('"Rp"#,##0');

      // Highlight status pesanan (Kolom 16) dan baris yang butuh input harga (Kolom 18)
      for (var r = 0; r < rowsToInsert.length; r++) {
        var statusVal = String(rowsToInsert[r][15] || "").toUpperCase();
        var cell16 = sheetOrder.getRange(lastRow + 1 + r, 16);
        if (statusVal.indexOf("RETUR") !== -1 || statusVal.indexOf("BATAL") !== -1) {
          cell16.setBackground("#FFE4E6").setFontColor("#9F1239").setFontWeight("bold");
        } else {
          cell16.setBackground("#DCFCE7").setFontColor("#166534").setFontWeight("bold");
        }

        if (rowsToInsert[r][17] === "⚠️ PERLU INPUT HARGA") {
          var alertCell = sheetOrder.getRange(lastRow + 1 + r, 18);
          alertCell.setBackground("#FEF3C7").setFontColor("#92400E").setFontWeight("bold");
        }
      }
    }

    // Update Sheet Rekap Keuangan
    recalculateRekapKeuangan(ss);

    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      batchId: batchId,
      insertedCount: rowsToInsert.length,
      totalBatchNominal: totalBatchNominal,
      unpricedCount: unpricedItems.length,
      unpricedItems: unpricedItems,
      storeBreakdown: storeBreakdown
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Update Harga & Detail Orderan dari Web Dashboard / API langsung ke Sheet 'List_Order'
 */
function updateOrderPrice(payload) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var orderSheet = setupListOrderSheet(ss);
    var values = orderSheet.getDataRange().getValues();

    var targetResi = String(payload.resi || "").trim();
    var targetRecipient = String(payload.recipient || "").trim();
    var targetRecNorm = targetRecipient.toLowerCase().replace(/[^a-z0-9]/g, "");
    var foundIndex = -1;

    // Pass 1: Cari dari transaksi PALING BARU (bawah ke atas) yang BELUM ada harga (unpriced)
    for (var i = values.length - 1; i >= 1; i--) {
      var row = values[i];
      var rResi = String(row[4] || "").trim();
      var rRecipient = String(row[6] || "").trim();
      var rowRecNorm = rRecipient.toLowerCase().replace(/[^a-z0-9]/g, "");
      var rPrice = cleanNumber(row[13]);
      var rStatusHarga = String(row[17] || "").toUpperCase();
      var isUnpriced = (rPrice === 0 || rStatusHarga.indexOf("PERLU") !== -1);

      if (isUnpriced) {
        if (targetResi && targetResi !== "-" && targetResi !== "MANUAL" && rResi.toLowerCase() === targetResi.toLowerCase()) {
          foundIndex = i + 1;
          break;
        } else if (targetRecNorm && (rowRecNorm === targetRecNorm || rowRecNorm.indexOf(targetRecNorm) !== -1 || targetRecNorm.indexOf(rowRecNorm) !== -1)) {
          foundIndex = i + 1;
          break;
        }
      }
    }

    // Pass 2: Jika tidak ada baris unpriced, cari baris paling baru yang cocok dengan nama/resi
    if (foundIndex === -1) {
      for (var i = values.length - 1; i >= 1; i--) {
        var row = values[i];
        var rResi = String(row[4] || "").trim();
        var rRecipient = String(row[6] || "").trim();
        var rowRecNorm = rRecipient.toLowerCase().replace(/[^a-z0-9]/g, "");

        if (targetResi && targetResi !== "-" && targetResi !== "MANUAL" && rResi.toLowerCase() === targetResi.toLowerCase()) {
          foundIndex = i + 1;
          break;
        } else if (targetRecNorm && (rowRecNorm === targetRecNorm || rowRecNorm.indexOf(targetRecNorm) !== -1 || targetRecNorm.indexOf(rowRecNorm) !== -1)) {
          foundIndex = i + 1;
          break;
        }
      }
    }

    if (foundIndex === -1) {
      return { status: "error", message: "Transaksi tidak ditemukan di List_Order" };
    }

    var newPrice = (payload.price !== undefined && payload.price !== null && payload.price !== "") 
      ? cleanNumber(payload.price) 
      : cleanNumber(values[foundIndex - 1][13]);

    var requestedStatus = (payload.status || payload.newStatus || "").trim();
    var currentStatus = String(values[foundIndex - 1][15] || "").trim();
    var finalStatus = requestedStatus ? requestedStatus : (currentStatus || "TERKIRIM");
    var isReturFinal = (finalStatus.toUpperCase().indexOf("RETUR") !== -1 || finalStatus.toUpperCase().indexOf("BATAL") !== -1);
    if (isReturFinal) finalStatus = "RETUR";

    var qty = (payload.newQty !== undefined || payload.qty !== undefined) 
      ? (cleanNumber(payload.newQty || payload.qty) || 1)
      : (cleanNumber(values[foundIndex - 1][11]) || 1);
    var unitPrice = (payload.unitPrice && cleanNumber(payload.unitPrice) > 0) 
      ? cleanNumber(payload.unitPrice) 
      : (qty > 0 ? Math.round(newPrice / qty) : newPrice);
    var totalNominal = newPrice;
    var rawNewToko = String(payload.toko || payload.newToko || "").trim();
    var newToko = (payload.toko !== undefined || payload.newToko !== undefined) ? ((!rawNewToko || /^[:\-\s]+$/.test(rawNewToko)) ? "Safra" : rawNewToko) : "";

    if (payload.newResi) {
      orderSheet.getRange(foundIndex, 5).setValue(payload.newResi);
    }
    if (newToko) {
      orderSheet.getRange(foundIndex, 6).setValue(newToko);
    }
    if (payload.newRecipient) {
      orderSheet.getRange(foundIndex, 7).setValue(payload.newRecipient);
    }
    if (payload.newPhone) {
      orderSheet.getRange(foundIndex, 8).setValue("'" + payload.newPhone);
    }
    if (payload.newExpedition) {
      orderSheet.getRange(foundIndex, 9).setValue(payload.newExpedition);
    }
    if (payload.newSku) {
      orderSheet.getRange(foundIndex, 10).setValue(payload.newSku);
    }
    if (payload.newProduct || payload.product) {
      orderSheet.getRange(foundIndex, 11).setValue(payload.newProduct || payload.product);
    }
    if (payload.newQty !== undefined || payload.qty !== undefined) {
      orderSheet.getRange(foundIndex, 12).setValue(qty);
    }

    orderSheet.getRange(foundIndex, 13).setValue(unitPrice).setNumberFormat('"Rp"#,##0');
    orderSheet.getRange(foundIndex, 14).setValue(totalNominal).setNumberFormat('"Rp"#,##0');

    // Kolom 15 (Metode) & Kolom 16 (Status Pesanan: Masuk Omzet atau RETUR)
    orderSheet.getRange(foundIndex, 15).setValue("TRANSFER");
    var statusCell16 = orderSheet.getRange(foundIndex, 16);
    statusCell16.setValue(finalStatus);
    if (isReturFinal) {
      statusCell16.setBackground("#FFE4E6").setFontColor("#9F1239").setFontWeight("bold");
    } else {
      statusCell16.setBackground("#DCFCE7").setFontColor("#166534").setFontWeight("bold");
    }

    var statusCell18 = orderSheet.getRange(foundIndex, 18);
    if (totalNominal > 0) {
      statusCell18.setValue("HARGA OK");
      statusCell18.setBackground("#DCFCE7").setFontColor("#166534").setFontWeight("bold");
    } else {
      statusCell18.setValue("⚠️ PERLU INPUT HARGA");
      statusCell18.setBackground("#FEF3C7").setFontColor("#92400E").setFontWeight("bold");
    }

    if (payload.notes) {
      orderSheet.getRange(foundIndex, 19).setValue(payload.notes);
    }

    // Refresh Rekap Keuangan agar selalu konsisten
    recalculateRekapKeuangan(ss);

    return {
      status: "success",
      message: "Data order (" + finalStatus + ") berhasil disimpan ke Google Sheets!",
      rowIndex: foundIndex,
      resi: payload.newResi || targetResi,
      newPrice: newPrice,
      newStatus: finalStatus,
      newToko: newToko || values[foundIndex - 1][5]
    };
  } catch (err) {
    return { status: "error", message: err.toString() };
  }
}

/**
 * Buat Order Manual baru langsung dari Web Dashboard ke Sheet 'List_Order'
 */
function createManualOrder(payload) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var orderSheet = setupListOrderSheet(ss);

    var now = new Date();
    var todayStr = Utilities.formatDate(now, "Asia/Jakarta", "yyyy-MM-dd");
    var nowTimeStr = Utilities.formatDate(now, "Asia/Jakarta", "HH:mm:ss");

    var tanggal = (payload.tanggal || todayStr).toString().trim();
    if (!tanggal || tanggal.length < 8) tanggal = todayStr;

    var jam = (payload.jam || nowTimeStr).toString().trim();
    if (jam.length === 5) jam += ":00"; // convert HH:mm to HH:mm:ss

    var batchTimestamp = tanggal + " " + jam;
    var batchId = "MANUAL-WEB-" + Utilities.formatDate(now, "Asia/Jakarta", "yyyyMMdd-HHmmss");

    var resi = String(payload.resi || "").trim();
    if (!resi || resi === "-") {
      resi = "MAN-" + Math.floor(100000 + Math.random() * 900000);
    }

    var rawToko = String(payload.toko || "").trim();
    var toko = (!rawToko || /^[:\-\s]+$/.test(rawToko)) ? "Safra" : rawToko;

    var recipient = (payload.recipient || payload.penerima || "-").trim();
    var phone = (payload.phone || payload.noHp || "-").trim();
    var expedition = (payload.expedition || payload.ekspedisi || "J&T").trim();
    var sku = (payload.sku || "-").trim();
    var product = (payload.product || payload.produk || "-").trim();
    var qty = cleanNumber(payload.qty) || 1;
    var totalNominal = cleanNumber(payload.total || payload.price || payload.totalNominal);
    var unitPrice = cleanNumber(payload.unitPrice) || (qty > 0 ? Math.round(totalNominal / qty) : totalNominal);

    var requestedStatus = (payload.status || payload.orderStatus || "TERKIRIM").trim();
    var upperSt = requestedStatus.toUpperCase();
    var isRetur = (upperSt.indexOf("RETUR") !== -1 || upperSt.indexOf("BATAL") !== -1);
    var finalStatus = isRetur ? "RETUR" : (requestedStatus || "TERKIRIM");

    var priceStatus = (totalNominal > 0) ? "HARGA OK" : "⚠️ PERLU INPUT HARGA";
    var notes = (payload.notes || payload.catatan || "Input Manual Web Dashboard").trim();

    var newRow = [
      batchTimestamp,
      tanggal,
      jam,
      batchId,
      resi,
      toko,
      recipient,
      phone ? "'" + phone : "-",
      expedition,
      sku,
      product,
      qty,
      unitPrice,
      totalNominal,
      "TRANSFER",
      finalStatus,
      "MANUAL_WEB",
      priceStatus,
      notes
    ];

    var lastRow = orderSheet.getLastRow();
    orderSheet.appendRow(newRow);
    var insertedRow = lastRow + 1;

    // Format mata uang Rupiah
    if (totalNominal > 0) {
      orderSheet.getRange(insertedRow, 13, 1, 2).setNumberFormat('"Rp"#,##0');
    }

    // Format warna status
    var statusCell16 = orderSheet.getRange(insertedRow, 16);
    if (isRetur) {
      statusCell16.setBackground("#FFE4E6").setFontColor("#9F1239").setFontWeight("bold");
    } else {
      statusCell16.setBackground("#DCFCE7").setFontColor("#166534").setFontWeight("bold");
    }

    var statusCell18 = orderSheet.getRange(insertedRow, 18);
    if (totalNominal > 0) {
      statusCell18.setBackground("#DCFCE7").setFontColor("#166534").setFontWeight("bold");
    } else {
      statusCell18.setBackground("#FEF3C7").setFontColor("#92400E").setFontWeight("bold");
    }

    // Refresh Rekap Keuangan agar selalu konsisten
    recalculateRekapKeuangan(ss);

    return {
      status: "success",
      message: "Order manual berhasil dicatat ke Google Sheets!",
      order: {
        tanggal: tanggal,
        jam: jam,
        resi: resi,
        toko: toko,
        penerima: recipient,
        phone: phone,
        ekspedisi: expedition,
        sku: sku,
        produk: product,
        qty: qty,
        unitPrice: unitPrice,
        total: totalNominal,
        statusHarga: priceStatus,
        statusPesanan: finalStatus,
        isRetur: isRetur
      }
    };
  } catch (err) {
    return { status: "error", message: err.toString() };
  }
}

/**
 * Utility untuk konversi nilai tanggal dari Google Sheet (Date Object atau String)
 * menjadi format standar ISO YYYY-MM-DD
 */
function formatAppDate(val) {
  if (!val || val === "-") return "-";
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return "-";
    return Utilities.formatDate(val, "Asia/Jakarta", "yyyy-MM-dd");
  }
  var str = String(val).trim();
  if (!str || str === "-") return "-";
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{4}-\d{2}-\d{2}\s/.test(str)) return str.split(" ")[0];

  var parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    try {
      return Utilities.formatDate(parsed, "Asia/Jakarta", "yyyy-MM-dd");
    } catch(e) {
      var y = parsed.getFullYear();
      var m = String(parsed.getMonth() + 1);
      if (m.length < 2) m = "0" + m;
      var d = String(parsed.getDate());
      if (d.length < 2) d = "0" + d;
      return y + "-" + m + "-" + d;
    }
  }
  return str;
}

/**
 * Utility untuk konversi nilai jam dari Google Sheet menjadi format HH:mm
 */
function formatAppTime(val) {
  if (!val || val === "-") return "-";
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return "-";
    return Utilities.formatDate(val, "Asia/Jakarta", "HH:mm");
  }
  var str = String(val).trim();
  if (!str || str === "-") return "-";
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(str)) return str.substring(0, 5);

  if (str.indexOf("T") !== -1 || str.indexOf("GMT") !== -1) {
    var parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
      try {
        return Utilities.formatDate(parsed, "Asia/Jakarta", "HH:mm");
      } catch(e) {}
    }
  }
  return str.length > 8 ? str.substring(0, 8) : str;
}

/**
 * Hitung Ulang Sheet 'Rekap_Keuangan' secara otomatis dari data riil 'List_Order'
 */
function recalculateRekapKeuangan(ss) {
  try {
    var sheetOrder = setupListOrderSheet(ss);
    var sheetRekap = setupRekapSheet(ss);
    var values = sheetOrder.getDataRange().getValues();

    var rekapMap = {};

    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      if (!row || !row[0]) continue;
      var dateStr = formatAppDate(row[1]);
      var rawToko = String(row[5] || "").trim();
      var toko = (!rawToko || /^[:\-\s]+$/.test(rawToko)) ? "Safra" : rawToko;
      var total = cleanNumber(row[13]);
      var statusHarga = String(row[17] || "");
      var statusPesanan = String(row[15] || "TERKIRIM").toUpperCase().trim();
      var isRetur = (statusPesanan.indexOf("RETUR") !== -1 || statusPesanan.indexOf("BATAL") !== -1);

      var isUnpriced = (total === 0 || statusHarga.indexOf("PERLU") !== -1);
      var key = dateStr + "|" + toko;

      if (!rekapMap[key]) {
        rekapMap[key] = {
          dateStr: dateStr,
          toko: toko,
          count: 0,
          nominal: 0,
          unpriced: 0,
          retur: 0
        };
      }

      if (!isRetur) {
        rekapMap[key].count++;
        rekapMap[key].nominal += total;
      } else {
        rekapMap[key].retur++;
      }

      if (isUnpriced) {
        rekapMap[key].unpriced++;
      }
    }

    var lastRow = sheetRekap.getLastRow();
    if (lastRow > 1) {
      sheetRekap.getRange(2, 1, lastRow - 1, Math.max(7, sheetRekap.getLastColumn())).clearContent();
    }

    var rows = [];
    for (var k in rekapMap) {
      var item = rekapMap[k];
      var statusDesc = "Lengkap";
      if (item.retur > 0) {
        statusDesc = "⚠️ " + item.retur + " Retur" + (item.unpriced > 0 ? " | " + item.unpriced + " Butuh Harga" : "");
      } else if (item.unpriced > 0) {
        statusDesc = "⚠️ " + item.unpriced + " Belum Ada Harga";
      }

      rows.push([
        item.dateStr,
        item.toko,
        item.count,
        item.nominal,
        0,
        item.nominal,
        statusDesc
      ]);
    }

    if (rows.length > 0) {
      sheetRekap.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
      sheetRekap.getRange(2, 4, rows.length, 3).setNumberFormat('"Rp"#,##0');
    }
  } catch (err) {
    Logger.log("Error recalculateRekapKeuangan: " + err.toString());
  }
}

/**
 * Handle sync data dari master_products.csv ke Sheet 'Master_Product'
 */
function handleSyncMasterProducts(ss, products) {
  var sheet = setupMasterProductSheet(ss);
  if (products.length === 0) {
    return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "No products" })).setMimeType(ContentService.MimeType.JSON);
  }

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, Math.max(9, sheet.getLastColumn())).clearContent();
  }

  var rows = [];
  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    rows.push([
      p.toko || "-",
      p.sku || "-",
      p.nama || "-",
      p.kategori || "-",
      p.kemasan || "-",
      p.platform || "-",
      cleanNumber(p.hargaStandar),
      cleanNumber(p.hargaGrosir),
      p.keterangan || "-"
    ]);
  }

  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  var numRange = sheet.getRange(2, 7, rows.length, 2);
  numRange.setNumberFormat('"Rp"#,##0');

  return ContentService.createTextOutput(JSON.stringify({
    status: "success",
    message: "Master products synchronized successfully",
    count: rows.length
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Setup Sheet 1: Master_Product
 */
function setupMasterProductSheet(ss) {
  var sheet = ss.getSheetByName("Master_Product");
  if (!sheet) {
    sheet = ss.insertSheet("Master_Product", 0);
    var headers = [
      "Toko", "SKU", "Nama Barang", "Kategori", "Kemasan", 
      "Platform", "Harga Standar (Rp)", "Harga Grosir (Rp)", "Keterangan"
    ];
    sheet.appendRow(headers);
    var hRange = sheet.getRange(1, 1, 1, headers.length);
    hRange.setBackground("#312E81").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 130);
    sheet.setColumnWidth(2, 120);
    sheet.setColumnWidth(3, 260);
    sheet.setColumnWidth(7, 130);
    sheet.setColumnWidth(8, 130);
  }
  return sheet;
}

/**
 * Setup Sheet 2: List_Order
 */
function setupListOrderSheet(ss) {
  var sheet = ss.getSheetByName("List_Order");
  if (!sheet) {
    sheet = ss.insertSheet("List_Order", 1);
    var headers = [
      "Timestamp", "Tanggal", "Jam", "Batch ID", "No Resi", "Toko",
      "Nama Penerima", "No HP Penerima", "Ekspedisi", "SKU", "Nama Barang",
      "Qty", "Harga Satuan (Rp)", "Total Omzet (Rp)", "Metode Bayar",
      "Status Bayar", "Sumber Harga", "Status Harga", "Catatan"
    ];
    sheet.appendRow(headers);
    var hRange = sheet.getRange(1, 1, 1, headers.length);
    hRange.setBackground("#1E1B4B").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 150);
    sheet.setColumnWidth(5, 140);
    sheet.setColumnWidth(6, 120);
    sheet.setColumnWidth(7, 160);
    sheet.setColumnWidth(10, 110);
    sheet.setColumnWidth(11, 250);
    sheet.setColumnWidth(13, 120);
    sheet.setColumnWidth(14, 130);
    sheet.setColumnWidth(18, 160);
  }
  return sheet;
}

/**
 * Setup Sheet 3: Rekap_Keuangan
 */
function setupRekapSheet(ss) {
  var sheet = ss.getSheetByName("Rekap_Keuangan");
  if (!sheet) {
    sheet = ss.insertSheet("Rekap_Keuangan", 2);
    var headers = [
      "Tanggal", "Toko", "Total Paket", "Total Omzet (Rp)", 
      "Total COD (Rp)", "Total Transfer (Rp)", "Status Data"
    ];
    sheet.appendRow(headers);
    var hRange = sheet.getRange(1, 1, 1, headers.length);
    hRange.setBackground("#065F46").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 110);
    sheet.setColumnWidth(2, 130);
    sheet.setColumnWidth(3, 100);
    sheet.setColumnWidth(4, 140);
    sheet.setColumnWidth(5, 140);
    sheet.setColumnWidth(6, 140);
    sheet.setColumnWidth(7, 160);
  }
  return sheet;
}

/**
 * Pembersih format angka fleksibel (Mendukung format Indonesia '900.000', 'Rp 900.000', '900rb', '1.5jt', ribuan titik/koma)
 */
function cleanNumber(val) {
  if (typeof val === "number") return isNaN(val) ? 0 : Math.round(val);
  if (!val) return 0;
  var str = String(val).trim().toLowerCase();
  if (!str) return 0;

  if (/(\d+(?:[\.,]\d+)?)\s*(?:jt|juta)/i.test(str)) {
    var m = str.match(/(\d+(?:[\.,]\d+)?)\s*(?:jt|juta)/i);
    return Math.round(parseFloat(m[1].replace(',', '.')) * 1000000);
  }
  if (/(\d+(?:[\.,]\d+)?)\s*(?:rb|k|ribu)/i.test(str)) {
    var m = str.match(/(\d+(?:[\.,]\d+)?)\s*(?:rb|k|ribu)/i);
    return Math.round(parseFloat(m[1].replace(',', '.')) * 1000);
  }

  if (/\b\d{1,3}(?:\.\d{3})+\b/.test(str)) {
    str = str.replace(/\./g, "");
  } else if (/\b\d{1,3}(?:\,\d{3})+\b/.test(str)) {
    str = str.replace(/,/g, "");
  }

  str = str.replace(/[\.,]00\b/g, '');

  var clean = str.replace(/[^0-9]/g, '');
  var n = parseInt(clean, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Ambil data ringkasan untuk Web Dashboard (Dynamic Multi-Toko, Daily Trend, & Real-time Stream)
 */
function getDashboardData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var orderSheet = setupListOrderSheet(ss);
  var values = orderSheet.getDataRange().getValues();

  var totalOrders = 0;
  var totalTerkirimCount = 0;
  var totalReturCount = 0;
  var totalReturNominal = 0;
  var totalOmzet = 0;
  var unpricedCount = 0;

  var storeSummary = {};
  var dailySummary = {};
  var allOrders = [];
  var unpricedAlertList = [];
  var monthlyMap = {};
  var yearSet = {};

  // Dynamic Month detection (default: bulan saat ini di Indonesia)
  var now = new Date();
  var currentYearMonth = Utilities.formatDate(now, "Asia/Jakarta", "yyyy-MM"); // "2026-10"
  var todayDateStr = Utilities.formatDate(now, "Asia/Jakarta", "yyyy-MM-dd"); // "2026-10-16"
  var monthNames = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember"
  ];
  var currentMonthTitle = monthNames[now.getMonth()] + " " + now.getFullYear();
  var todayFormatted = now.getDate() + " " + monthNames[now.getMonth()] + " " + now.getFullYear();

  var todayOrders = 0;
  var todayOmzet = 0;
  var todayReturCount = 0;
  var todayTotalCount = 0;
  var todayUnpricedCount = 0;
  var todayStoreBreakdown = {};

  var monthOmzet = 0;
  var monthOrders = 0;
  var monthReturCount = 0;
  var monthStoreSummary = {};

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row || !row[0]) continue;

    var tanggal = formatAppDate(row[1]);
    var jam = formatAppTime(row[2]);
    var resi = row[4] || "-";
    var rawToko = String(row[5] || "").trim();
    var toko = (!rawToko || /^[:\-\s]+$/.test(rawToko)) ? "Safra" : rawToko;
    var penerima = row[6] || "-";
    var noHp = row[7] || "-";
    var ekspedisi = row[8] || "-";
    var sku = row[9] || "-";
    var produk = row[10] || "-";
    var qty = Number(row[11]) || 1;
    var unitPrice = cleanNumber(row[12]);
    var total = cleanNumber(row[13]);
    if (total === 0 && unitPrice > 0) {
      total = unitPrice * qty;
    } else if (total > 0 && unitPrice === 0) {
      unitPrice = Math.round(total / qty);
    }

    // Status Harga: Jika total > 0, selalu HARGA OK (jangan gunakan PERLU INPUT HARGA lagi)
    var statusHarga = (total > 0) ? "HARGA OK" : "⚠️ PERLU INPUT HARGA";

    var rawStatus = String(row[15] || "").trim();
    // Ubah MENUNGGU CAIR menjadi TERKIRIM secara otomatis di memori dan spreadsheet
    if (rawStatus.toUpperCase().indexOf("MENUNGGU") !== -1 || rawStatus.toUpperCase().indexOf("CAIR") !== -1) {
      rawStatus = "TERKIRIM";
      try {
        orderSheet.getRange(i + 1, 16).setValue("TERKIRIM").setBackground("#DCFCE7").setFontColor("#166534").setFontWeight("bold");
      } catch (_) {}
    }
    // Jika harga sudah ada (> 0) tapi status di sheet masih "PERLU", otomatis perbarui ke "HARGA OK"
    if (total > 0 && row[17] && String(row[17]).indexOf("PERLU") !== -1) {
      try {
        orderSheet.getRange(i + 1, 18).setValue("HARGA OK").setBackground("#DCFCE7").setFontColor("#166534").setFontWeight("bold");
      } catch (_) {}
    }

    var upperStatus = rawStatus.toUpperCase();
    var isRetur = (upperStatus.indexOf("RETUR") !== -1 || upperStatus.indexOf("BATAL") !== -1);
    var statusPesanan = isRetur ? "RETUR" : (rawStatus || "TERKIRIM");

    totalOrders++;
    if (isRetur) {
      totalReturCount++;
      totalReturNominal += total;
    } else {
      totalTerkirimCount++;
      totalOmzet += total;
    }

    // Monthly calculation (Bulan berjalan, misal: 2026-10)
    var isCurrentMonth = (tanggal.indexOf(currentYearMonth) === 0);
    if (!isCurrentMonth) {
      if (tanggal.indexOf("2026-10") !== -1 || tanggal.indexOf("Oct") !== -1 || tanggal.indexOf("Okt") !== -1) {
        isCurrentMonth = true;
      }
    }

    if (isCurrentMonth) {
      if (isRetur) {
        monthReturCount++;
      } else {
        monthOrders++;
        monthOmzet += total;

        if (!monthStoreSummary[toko]) {
          monthStoreSummary[toko] = { count: 0, omzet: 0 };
        }
        monthStoreSummary[toko].count++;
        monthStoreSummary[toko].omzet += total;
      }
    }

    // Today calculation (Pesanan Hari Ini)
    if (tanggal === todayDateStr) {
      todayTotalCount++;
      if (isRetur) {
        todayReturCount++;
      } else {
        todayOrders++;
        todayOmzet += total;
        if (!todayStoreBreakdown[toko]) {
          todayStoreBreakdown[toko] = 0;
        }
        todayStoreBreakdown[toko] += total;
      }
      if (total === 0 || statusHarga.indexOf("PERLU") !== -1) {
        todayUnpricedCount++;
      }
    }

    if (total === 0 || statusHarga.indexOf("PERLU") !== -1) {
      unpricedCount++;
      if (unpricedAlertList.length < 50) {
        unpricedAlertList.push({
          resi: resi,
          sku: sku,
          toko: toko,
          recipient: penerima,
          product: produk,
          qty: qty
        });
      }
    }

    // Toko aggregation
    if (!storeSummary[toko]) {
      storeSummary[toko] = { count: 0, omzet: 0, unpriced: 0, retur: 0 };
    }
    if (isRetur) {
      storeSummary[toko].retur++;
    } else {
      storeSummary[toko].count++;
      storeSummary[toko].omzet += total;
    }
    if (total === 0 || statusHarga.indexOf("PERLU") !== -1) {
      storeSummary[toko].unpriced++;
    }

    // Daily aggregation for charts (Hanya pesanan Terkirim yang masuk omzet chart)
    if (tanggal !== "-") {
      if (!dailySummary[tanggal]) {
        dailySummary[tanggal] = { omzet: 0, count: 0, returCount: 0, byStore: {} };
      }
      if (isRetur) {
        dailySummary[tanggal].returCount++;
      } else {
        dailySummary[tanggal].count++;
        dailySummary[tanggal].omzet += total;

        if (!dailySummary[tanggal].byStore[toko]) {
          dailySummary[tanggal].byStore[toko] = { count: 0, omzet: 0 };
        }
        dailySummary[tanggal].byStore[toko].count++;
        dailySummary[tanggal].byStore[toko].omzet += total;
      }
    }

    allOrders.push({
      tanggal: tanggal,
      jam: jam,
      resi: resi,
      toko: toko,
      penerima: penerima,
      phone: noHp,
      ekspedisi: ekspedisi,
      sku: sku,
      produk: produk,
      qty: qty,
      unitPrice: unitPrice,
      total: total,
      statusHarga: statusHarga,
      statusPesanan: statusPesanan,
      isRetur: isRetur
    });

    // Historical Monthly & Yearly Grouping
    if (tanggal && tanggal.length >= 7 && tanggal !== "-") {
      var ymKey = tanggal.substring(0, 7);
      var yrKey = ymKey.substring(0, 4);
      yearSet[yrKey] = true;
      if (!monthlyMap[ymKey]) {
        var ymPartsP = ymKey.split("-");
        var yNumP = ymPartsP[0];
        var mIdxP = parseInt(ymPartsP[1], 10) - 1;
        var mLabelP = (monthNames[mIdxP] || ("Bulan " + ymPartsP[1])) + " " + yNumP;
        monthlyMap[ymKey] = {
          ym: ymKey,
          label: mLabelP,
          year: yNumP,
          omzet: 0,
          count: 0,
          returCount: 0,
          aov: 0
        };
      }
      if (isRetur) {
        monthlyMap[ymKey].returCount++;
      } else {
        monthlyMap[ymKey].count++;
        monthlyMap[ymKey].omzet += total;
      }
    }
  }

  // Fallback cerdas: Jika bulan berjalan belum ada order, gunakan bulan transaksi terbaru
  if (monthOrders === 0 && allOrders.length > 0) {
    for (var bi = allOrders.length - 1; bi >= 0; bi--) {
      var candDate = allOrders[bi].tanggal;
      if (candDate && candDate.length >= 7 && candDate !== "-") {
        var ym = candDate.substring(0, 7);
        var ymParts = ym.split("-");
        if (ymParts.length === 2) {
          var yNum = ymParts[0];
          var mIdx = parseInt(ymParts[1], 10) - 1;
          currentMonthTitle = (monthNames[mIdx] || "Bulan") + " " + yNum;
          allOrders.forEach(function(ao) {
            if (ao.tanggal && ao.tanggal.indexOf(ym) === 0) {
              if (ao.isRetur) {
                monthReturCount++;
              } else {
                monthOrders++;
                monthOmzet += ao.total;
                if (!monthStoreSummary[ao.toko]) {
                  monthStoreSummary[ao.toko] = { count: 0, omzet: 0 };
                }
                monthStoreSummary[ao.toko].count++;
                monthStoreSummary[ao.toko].omzet += ao.total;
              }
            }
          });
          break;
        }
      }
    }
  }

  // Reverse so latest orders appear first (take up to 200 orders for fluid performance)
  var recentOrders = allOrders.reverse().slice(0, 200);

  // Extract all unique stores, prioritizing Fertipro & Yosa Farm
  var allStores = Object.keys(storeSummary).sort(function(a, b) {
    var aPriority = (a.toLowerCase().indexOf('fertipro') !== -1) ? 1 : (a.toLowerCase().indexOf('yosa') !== -1 ? 2 : 3);
    var bPriority = (b.toLowerCase().indexOf('fertipro') !== -1) ? 1 : (b.toLowerCase().indexOf('yosa') !== -1 ? 2 : 3);
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.localeCompare(b);
  });

  // Calculate top highlight metrics
  var aov = totalTerkirimCount > 0 ? Math.round(totalOmzet / totalTerkirimCount) : 0;
  var topStoreName = "-";
  var topStoreOmzet = 0;
  for (var s in storeSummary) {
    if (storeSummary[s].omzet > topStoreOmzet) {
      topStoreOmzet = storeSummary[s].omzet;
      topStoreName = s;
    }
  }

  var topStoreMonth = "-";
  var topStoreMonthOmzet = 0;
  for (var ms in monthStoreSummary) {
    if (monthStoreSummary[ms].omzet > topStoreMonthOmzet) {
      topStoreMonthOmzet = monthStoreSummary[ms].omzet;
      topStoreMonth = ms + " (" + (topStoreMonthOmzet >= 1000000 ? (topStoreMonthOmzet / 1000000).toFixed(1) + " Jt" : "Rp " + topStoreMonthOmzet.toLocaleString("id-ID")) + ")";
    }
  }
  if (topStoreMonth === "-" && topStoreName !== "-") {
    topStoreMonth = topStoreName + " (" + (topStoreOmzet >= 1000000 ? (topStoreOmzet / 1000000).toFixed(1) + " Jt" : "Rp " + topStoreOmzet.toLocaleString("id-ID")) + ")";
  }

  var topDayDate = "-";
  var topDayOmzet = 0;
  var topDayCount = 0;
  for (var d in dailySummary) {
    if (dailySummary[d].omzet > topDayOmzet) {
      topDayOmzet = dailySummary[d].omzet;
      topDayDate = d;
      topDayCount = dailySummary[d].count;
    }
  }

  // Convert monthlyMap to sorted array (newest month first)
  var monthlyRecap = Object.keys(monthlyMap).sort().reverse().map(function(k) {
    var item = monthlyMap[k];
    item.aov = item.count > 0 ? Math.round(item.omzet / item.count) : 0;
    item.formattedOmzet = "Rp " + Number(item.omzet).toLocaleString("id-ID");
    return item;
  });

  var availableYears = Object.keys(yearSet).sort().reverse();
  if (availableYears.length === 0) {
    availableYears = [String(now.getFullYear())];
  }

  var todayTopStore = "-";
  var topStoreTodayMax = 0;
  for (var ts in todayStoreBreakdown) {
    if (todayStoreBreakdown[ts] > topStoreTodayMax) {
      topStoreTodayMax = todayStoreBreakdown[ts];
      todayTopStore = ts;
    }
  }

  return {
    totalOrders: totalOrders,
    totalTerkirimCount: totalTerkirimCount,
    totalReturCount: totalReturCount,
    totalReturNominal: totalReturNominal,
    totalOmzet: totalOmzet,
    unpricedCount: unpricedCount,
    unpricedAlertList: unpricedAlertList,
    storeSummary: storeSummary,
    dailySummary: dailySummary,
    allStores: allStores,
    recentOrders: recentOrders,
    allOrders: allOrders.slice(),
    monthlyRecap: monthlyRecap,
    availableYears: availableYears,
    currentYearMonth: currentYearMonth,
    today: {
      dateStr: todayDateStr,
      formattedDate: todayFormatted,
      orders: todayOrders,
      omzet: todayOmzet,
      returCount: todayReturCount,
      totalCount: todayTotalCount,
      unpricedCount: todayUnpricedCount,
      aov: todayOrders > 0 ? Math.round(todayOmzet / todayOrders) : 0,
      topStore: todayTopStore
    },
    monthly: {
      monthTitle: currentMonthTitle,
      monthOmzet: monthOmzet,
      monthOrders: monthOrders,
      monthReturCount: monthReturCount,
      aovMonth: monthOrders > 0 ? Math.round(monthOmzet / monthOrders) : 0,
      topStoreMonth: topStoreMonth
    },
    analytics: {
      aov: aov,
      topStoreName: topStoreName,
      topStoreOmzet: topStoreOmzet,
      topDayDate: topDayDate,
      topDayOmzet: topDayOmzet,
      topDayCount: topDayCount
    }
  };
}

/**
 * Template HTML Web Dashboard Interaktif (Mobile-Optimized, Charts, & Direct Price Edit)
 */
function getDashboardHtml() {
  var data = getDashboardData();
  var jsonPayload = JSON.stringify(data);

  return '<!DOCTYPE html>\n' +
'<html lang="id" class="overflow-x-hidden w-full max-w-full">\n' +
'<head>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">\n' +
'  <title>Executive Financial Dashboard - Bot Resi</title>\n' +
'  <script src="https://cdn.tailwindcss.com"></script>\n' +
'  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>\n' +
'  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">\n' +
'  <style>\n' +
'    *, *::before, *::after { box-sizing: border-box; }\n' +
'    html {\n' +
'      overflow-x: hidden;\n' +
'      width: 100%;\n' +
'      max-width: 100vw;\n' +
'      overscroll-behavior-x: none;\n' +
'      -webkit-text-size-adjust: 100%;\n' +
'    }\n' +
'    body {\n' +
'      overflow-x: hidden;\n' +
'      width: 100%;\n' +
'      max-width: 100vw;\n' +
'      margin: 0;\n' +
'      padding: 0;\n' +
'      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;\n' +
'      background-color: #0B1120;\n' +
'      color: #F8FAFC;\n' +
'    }\n' +
'    .glass-card { background: rgba(17, 24, 39, 0.78); backdrop-filter: blur(14px); border: 1px solid rgba(255, 255, 255, 0.08); }\n' +
'    .glass-card-hover:hover { background: rgba(30, 41, 59, 0.9); border-color: rgba(99, 102, 241, 0.4); transform: translateY(-2px); }\n' +
'    .custom-scrollbar::-webkit-scrollbar { width: 5px; height: 5px; }\n' +
'    .custom-scrollbar::-webkit-scrollbar-track { background: #0F172A; }\n' +
'    .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }\n' +
'    .btn-touch { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }\n' +
'  </style>\n' +
'</head>\n' +
'<body class="p-2.5 sm:p-5 lg:p-7 min-h-screen w-full max-w-full overflow-x-hidden">\n' +
'  <div class="w-full max-w-7xl mx-auto space-y-4 sm:space-y-5 overflow-x-hidden">\n' +
'\n' +
'    <!-- HEADER BAR -->\n' +
'    <header class="glass-card p-3.5 sm:p-5 rounded-2xl sm:rounded-3xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xl w-full max-w-full">\n' +
'      <div class="flex items-center space-x-3 min-w-0">\n' +
'        <div class="w-10 h-10 sm:w-13 sm:h-13 rounded-2xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-white text-lg sm:text-xl shadow-lg shadow-indigo-500/25 flex-shrink-0">\n' +
'          <i class="fa-solid fa-chart-pie"></i>\n' +
'        </div>\n' +
'        <div class="min-w-0">\n' +
'          <div class="flex items-center space-x-2">\n' +
'            <h1 class="text-base sm:text-2xl font-black tracking-tight text-white truncate">Financial Dashboard</h1>\n' +
'            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex-shrink-0">PRO</span>\n' +
'          </div>\n' +
'          <p class="text-[11px] sm:text-xs text-slate-400 mt-0.5 truncate">Rekapitulasi Omzet Multi-Toko • Real-Time Stream</p>\n' +
'        </div>\n' +
'      </div>\n' +
'      <div class="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">\n' +
'        <button onclick="openNewOrderModal()" class="btn-touch px-3 py-1.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 active:scale-95 text-white rounded-xl text-xs font-bold transition flex items-center shadow-lg shadow-indigo-600/25 cursor-pointer flex-1 sm:flex-initial justify-center">\n' +
'          <i class="fa-solid fa-circle-plus mr-1.5"></i> + Order Manual\n' +
'        </button>\n' +
'        <span class="inline-flex items-center px-2 py-1 rounded-full text-[10px] sm:text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex-shrink-0">\n' +
'          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-ping"></span> Live Sync\n' +
'        </span>\n' +
'        <button onclick="refreshDashboardLive()" id="btn-refresh" class="btn-touch px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 active:scale-95 text-slate-200 rounded-xl text-xs font-medium border border-slate-700 transition flex items-center shadow-sm cursor-pointer flex-shrink-0">\n' +
'          <i class="fa-solid fa-rotate mr-1.5" id="btn-refresh-icon"></i> Refresh\n' +
'        </button>\n' +
'      </div>\n' +
'    </header>\n' +
'\n' +
'    <!-- SIMPLE NOTICE BAR (TIDAK BERLEBIHAN) -->\n' +
'    <div id="unpriced-banner" style="' + (data.unpricedCount > 0 ? '' : 'display: none;') + '" class="glass-card px-3.5 sm:px-4 py-3 rounded-2xl flex flex-wrap items-center justify-between gap-2 border-amber-500/30 bg-amber-950/20 text-amber-200 shadow-md transition w-full max-w-full">\n' +
'      <div class="flex items-center space-x-2.5 min-w-0 flex-1">\n' +
'        <span class="w-7 h-7 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center text-xs flex-shrink-0">\n' +
'          <i class="fa-solid fa-circle-info"></i>\n' +
'        </span>\n' +
'        <span class="text-xs sm:text-sm font-medium truncate">\n' +
'          Terdapat <b id="unpriced-count-text" class="text-amber-300 font-bold">' + data.unpricedCount + ' pesanan</b> yang belum terdata harganya.\n' +
'        </span>\n' +
'      </div>\n' +
'      <div class="flex items-center gap-2 flex-shrink-0">\n' +
'        <button type="button" onclick="filterUnpricedOnly()" class="btn-touch px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 active:scale-95 text-amber-300 text-xs font-semibold border border-amber-500/30 transition flex items-center shadow-xs cursor-pointer">\n' +
'          <i class="fa-solid fa-pen-to-square mr-1.5"></i> Input Harga\n' +
'        </button>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <!-- HERO CARD: ORDERAN & OMZET HARI INI (WARNA BERBEDA & EYE-CATCHING) -->\n' +
'    <div class="relative overflow-hidden rounded-2xl sm:rounded-3xl border-2 border-amber-500/50 bg-gradient-to-br from-amber-950/40 via-slate-900/95 to-amber-950/20 p-3.5 sm:p-5 shadow-2xl shadow-amber-500/10 w-full max-w-full">\n' +
'      <div class="absolute -right-8 -top-8 w-44 h-44 bg-amber-500/10 rounded-full blur-3xl pointer-events-none"></div>\n' +
'      <div class="absolute -left-8 -bottom-8 w-44 h-44 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>\n' +
'\n' +
'      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-3 mb-3 border-b border-amber-500/20 min-w-0">\n' +
'        <div class="flex items-center space-x-2.5 sm:space-x-3 min-w-0">\n' +
'          <span class="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/40 flex items-center justify-center text-xs sm:text-sm shadow-inner shadow-amber-500/30 flex-shrink-0">\n' +
'            <i class="fa-solid fa-bolt-lightning animate-pulse"></i>\n' +
'          </span>\n' +
'          <div class="min-w-0">\n' +
'            <div class="flex items-center space-x-2">\n' +
'              <h2 class="text-xs sm:text-base font-black text-white tracking-tight truncate">Orderan & Omzet Hari Ini</h2>\n' +
'              <span class="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] sm:text-[10px] font-black bg-amber-500/20 text-amber-300 border border-amber-500/40 tracking-wider flex-shrink-0">\n' +
'                <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping mr-1"></span> LIVE\n' +
'              </span>\n' +
'            </div>\n' +
'            <p class="text-[10px] sm:text-[11px] text-amber-200/80 mt-0.5 truncate" id="today-date-text">Hari ini, ' + (data.today ? data.today.formattedDate : "16 Oktober 2026") + '</p>\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="text-[11px] sm:text-xs font-bold px-2.5 py-1 rounded-xl bg-slate-900/90 border border-amber-500/30 text-amber-300 flex items-center self-start sm:self-auto shadow-xs flex-shrink-0" id="today-badge-status">\n' +
'          <i class="fa-solid fa-box-open mr-1.5 text-amber-400"></i> <span id="today-badge-text">' + (data.today ? data.today.orders : 0) + ' Terkirim' + (data.today && data.today.returCount > 0 ? ' • ' + data.today.returCount + ' Retur' : '') + '</span>\n' +
'        </div>\n' +
'      </div>\n' +
'\n' +
'      <div class="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 text-left w-full max-w-full">\n' +
'        <div class="bg-slate-900/90 p-2.5 sm:p-4 rounded-xl sm:rounded-2xl border border-amber-500/40 shadow-sm relative overflow-hidden group min-w-0">\n' +
'          <div class="text-[10px] sm:text-xs font-bold text-amber-400 uppercase tracking-wider flex items-center justify-between">\n' +
'            <span class="truncate">Omzet Hari Ini</span>\n' +
'            <div class="w-5 h-5 sm:w-6 sm:h-6 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center text-[10px] sm:text-xs flex-shrink-0"><i class="fa-solid fa-rupiah-sign"></i></div>\n' +
'          </div>\n' +
'          <div class="text-sm sm:text-2xl font-black text-amber-300 tracking-tight mt-1 truncate" id="today-omzet-val">Rp ' + Number(data.today ? data.today.omzet : 0).toLocaleString("id-ID") + '</div>\n' +
'          <div class="text-[10px] sm:text-xs text-slate-400 mt-1 truncate" id="today-omzet-sub">\n' +
'            <i class="fa-solid fa-circle-check text-emerald-400 mr-1"></i> Masuk omzet terkirim\n' +
'          </div>\n' +
'        </div>\n' +
'\n' +
'        <div class="bg-slate-900/90 p-2.5 sm:p-4 rounded-xl sm:rounded-2xl border border-amber-500/40 shadow-sm relative overflow-hidden group min-w-0">\n' +
'          <div class="text-[10px] sm:text-xs font-bold text-amber-400 uppercase tracking-wider flex items-center justify-between">\n' +
'            <span class="truncate">Orderan Terkirim</span>\n' +
'            <div class="w-5 h-5 sm:w-6 sm:h-6 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center text-[10px] sm:text-xs flex-shrink-0"><i class="fa-solid fa-truck-ramp-box"></i></div>\n' +
'          </div>\n' +
'          <div class="text-sm sm:text-2xl font-black text-white tracking-tight mt-1 truncate" id="today-orders-val">' + (data.today ? data.today.orders : 0) + ' <span class="text-xs font-semibold text-slate-400">paket</span></div>\n' +
'          <div class="text-[10px] sm:text-xs text-slate-400 mt-1 truncate" id="today-orders-sub">\n' +
'            ' + (data.today && data.today.returCount > 0 ? '<span class="text-rose-400 font-semibold">' + data.today.returCount + ' retur hari ini</span>' : '<span class="text-emerald-400"><i class="fa-solid fa-check mr-1"></i> Siap kirim hari ini</span>') + '\n' +
'          </div>\n' +
'        </div>\n' +
'\n' +
'        <div class="bg-slate-900/90 p-2.5 sm:p-4 rounded-xl sm:rounded-2xl border border-amber-500/40 shadow-sm relative overflow-hidden group min-w-0">\n' +
'          <div class="text-[10px] sm:text-xs font-bold text-amber-400 uppercase tracking-wider flex items-center justify-between">\n' +
'            <span class="truncate">Rata-Rata Paket</span>\n' +
'            <div class="w-5 h-5 sm:w-6 sm:h-6 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-[10px] sm:text-xs flex-shrink-0"><i class="fa-solid fa-chart-line"></i></div>\n' +
'          </div>\n' +
'          <div class="text-xs sm:text-xl font-black text-emerald-400 tracking-tight mt-1 truncate" id="today-aov-val">Rp ' + Number(data.today ? data.today.aov : 0).toLocaleString("id-ID") + '</div>\n' +
'          <div class="text-[10px] sm:text-xs text-slate-400 mt-1 truncate">Average Order Value</div>\n' +
'        </div>\n' +
'\n' +
'        <div class="bg-slate-900/90 p-2.5 sm:p-4 rounded-xl sm:rounded-2xl border border-amber-500/40 shadow-sm relative overflow-hidden group min-w-0">\n' +
'          <div class="text-[10px] sm:text-xs font-bold text-amber-400 uppercase tracking-wider flex items-center justify-between">\n' +
'            <span class="truncate">Toko Terbanyak</span>\n' +
'            <div class="w-5 h-5 sm:w-6 sm:h-6 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center text-[10px] sm:text-xs flex-shrink-0"><i class="fa-solid fa-store"></i></div>\n' +
'          </div>\n' +
'          <div class="text-xs sm:text-sm font-bold text-amber-200 tracking-tight mt-1 truncate" id="today-top-store-val" title="' + (data.today ? data.today.topStore : "-") + '">' + (data.today ? data.today.topStore : "-") + '</div>\n' +
'          <div class="text-[10px] sm:text-xs text-slate-400 mt-1 truncate" id="today-unpriced-sub">\n' +
'            ' + (data.today && data.today.unpricedCount > 0 ? '<span class="text-amber-400 font-semibold">' + data.today.unpricedCount + ' butuh harga</span>' : '<span class="text-slate-400">Semua harga lengkap</span>') + '\n' +
'          </div>\n' +
'        </div>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <!-- PERIOD & STATISTIC SELECTOR BAR -->\n' +
'    <div class="glass-card p-3.5 sm:p-4 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-lg border border-slate-700/60 bg-gradient-to-r from-slate-900/90 via-slate-900/80 to-indigo-950/40 w-full max-w-full">\n' +
'      <div class="flex items-center space-x-3 min-w-0">\n' +
'        <div class="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-sm sm:text-base flex-shrink-0">\n' +
'          <i class="fa-solid fa-calendar-days"></i>\n' +
'        </div>\n' +
'        <div class="min-w-0">\n' +
'          <div class="flex items-center space-x-2">\n' +
'            <h2 class="text-xs sm:text-base font-bold text-white tracking-tight truncate">Filter Periode Statistik</h2>\n' +
'            <span id="period-badge-label" class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex-shrink-0">Memuat...</span>\n' +
'          </div>\n' +
'          <p class="text-[10px] sm:text-[11px] text-slate-400 mt-0.5 truncate">Pilih rentang bulan / tahun untuk memfilter omzet & grafik</p>\n' +
'        </div>\n' +
'      </div>\n' +
'\n' +
'      <div class="flex flex-wrap sm:flex-nowrap items-center gap-2 w-full md:w-auto">\n' +
'        <div class="relative w-full sm:w-auto flex-1 sm:flex-initial min-w-0">\n' +
'          <select id="period-filter-select" onchange="onPeriodChange(this.value)" class="w-full sm:w-auto bg-slate-900 border border-indigo-500/40 text-indigo-200 text-xs rounded-xl px-3 py-2 font-semibold focus:ring-2 focus:ring-indigo-500 focus:outline-none cursor-pointer truncate">\n' +
'            <option value="CURRENT_MONTH" selected>📅 Bulan Ini</option>\n' +
'            <option value="LAST_MONTH">📅 Bulan Lalu</option>\n' +
'            <option value="ALL">🌟 Total Semua (All-Time)</option>\n' +
'          </select>\n' +
'        </div>\n' +
'        <button type="button" onclick="toggleMonthlyTable()" id="btn-toggle-monthly" class="btn-touch w-full sm:w-auto px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 active:scale-95 text-slate-200 text-xs font-semibold border border-slate-700 transition flex items-center justify-center shadow-xs cursor-pointer flex-shrink-0">\n' +
'          <i class="fa-solid fa-table-list mr-1.5 text-indigo-400"></i> <span id="btn-toggle-monthly-text">Rekap Tiap Bulan</span>\n' +
'        </button>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <!-- MONTHLY BREAKDOWN TABLE (REKAPITULASI PER BULAN) -->\n' +
'    <div id="monthly-recap-section" style="display: none;" class="glass-card p-3.5 sm:p-5 rounded-2xl sm:rounded-3xl border border-indigo-500/30 bg-slate-900/80 shadow-xl space-y-3 w-full max-w-full overflow-hidden">\n' +
'      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-3 min-w-0">\n' +
'        <div class="flex items-center space-x-2.5 min-w-0">\n' +
'          <span class="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-sm flex-shrink-0">\n' +
'            <i class="fa-solid fa-chart-column"></i>\n' +
'          </span>\n' +
'          <div class="min-w-0">\n' +
'            <h3 class="text-xs sm:text-base font-bold text-white tracking-tight truncate">Rekapitulasi Omzet Tiap Bulan</h3>\n' +
'            <p class="text-[10px] sm:text-[11px] text-slate-400 truncate">Pilih baris bulan di bawah untuk langsung menyaring dashboard</p>\n' +
'          </div>\n' +
'        </div>\n' +
'        <button type="button" onclick="toggleMonthlyTable()" class="text-xs text-slate-400 hover:text-white px-2.5 py-1 rounded-lg bg-slate-800 cursor-pointer self-end sm:self-auto flex-shrink-0">\n' +
'          <i class="fa-solid fa-xmark mr-1"></i> Tutup\n' +
'        </button>\n' +
'      </div>\n' +
'\n' +
'      <div class="w-full max-w-full overflow-x-auto custom-scrollbar">\n' +
'        <table class="w-full text-left text-xs min-w-[550px] sm:min-w-full">\n' +
'          <thead class="bg-slate-950/80 text-slate-400 font-semibold uppercase tracking-wider text-[10px] sm:text-[11px] border-b border-slate-800">\n' +
'            <tr>\n' +
'              <th class="px-3.5 py-2.5">Bulan & Tahun</th>\n' +
'              <th class="px-3.5 py-2.5 text-right">Total Omzet Bersih</th>\n' +
'              <th class="px-3.5 py-2.5 text-center">Paket Terkirim</th>\n' +
'              <th class="px-3.5 py-2.5 text-center">Retur</th>\n' +
'              <th class="px-3.5 py-2.5 text-right">Rata-Rata Order (AOV)</th>\n' +
'              <th class="px-3.5 py-2.5 text-center">Aksi Filter</th>\n' +
'            </tr>\n' +
'          </thead>\n' +
'          <tbody id="monthly-recap-tbody" class="divide-y divide-slate-800/80 font-normal">\n' +
'          </tbody>\n' +
'        </table>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <!-- REKAPITULASI SUMMARY CARD (DYNAMIC PERIOD) -->\n' +
'    <div class="glass-card p-4 sm:p-5 rounded-2xl sm:rounded-3xl border border-indigo-500/20 bg-gradient-to-r from-indigo-950/30 via-slate-900/60 to-slate-900/40 shadow-lg">\n' +
'      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 mb-3 border-b border-slate-800/80">\n' +
'        <div class="flex items-center space-x-2.5">\n' +
'          <span class="w-8 h-8 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-sm">\n' +
'            <i class="fa-solid fa-calendar-check"></i>\n' +
'          </span>\n' +
'          <div>\n' +
'            <h2 class="text-sm sm:text-base font-bold text-white tracking-tight" id="period-summary-title">Rekapitulasi Periode: ' + (data.monthly ? data.monthly.monthTitle : "Oktober 2026") + '</h2>\n' +
'            <span class="text-[11px] text-slate-400" id="period-summary-desc">Total akumulasi omzet penjualan pada periode terpilih</span>\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="text-xs text-indigo-300 font-semibold bg-indigo-500/10 px-3 py-1 rounded-full border border-indigo-500/20 self-start sm:self-auto" id="month-badge-orders">\n' +
'          <i class="fa-solid fa-box-archive mr-1"></i> ' + (data.monthly ? data.monthly.monthOrders : 0) + ' Terkirim' + (data.monthly && data.monthly.monthReturCount > 0 ? ' • ' + data.monthly.monthReturCount + ' Retur' : '') + '\n' +
'        </div>\n' +
'      </div>\n' +
'\n' +
'      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-left">\n' +
'        <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-800/80">\n' +
'          <div class="text-[10px] sm:text-xs font-semibold text-slate-400 uppercase" id="period-omzet-label">Omzet Periode Ini</div>\n' +
'          <div class="text-base sm:text-xl font-black text-white mt-1" id="month-omzet-val">Rp ' + Number(data.monthly ? data.monthly.monthOmzet : 0).toLocaleString("id-ID") + '</div>\n' +
'        </div>\n' +
'        <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-800/80">\n' +
'          <div class="text-[10px] sm:text-xs font-semibold text-slate-400 uppercase" id="period-orders-label">Paket Periode Ini</div>\n' +
'          <div class="text-base sm:text-xl font-black text-indigo-400 mt-1" id="month-orders-val">' + (data.monthly ? data.monthly.monthOrders : 0) + ' <span class="text-xs font-normal text-slate-400">terkirim</span></div>\n' +
'        </div>\n' +
'        <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-800/80">\n' +
'          <div class="text-[10px] sm:text-xs font-semibold text-slate-400 uppercase">Rata-Rata Order</div>\n' +
'          <div class="text-base sm:text-xl font-black text-emerald-400 mt-1" id="month-aov-val">Rp ' + Number(data.monthly ? data.monthly.aovMonth : 0).toLocaleString("id-ID") + '</div>\n' +
'        </div>\n' +
'        <div class="bg-slate-900/60 p-3 rounded-xl border border-slate-800/80">\n' +
'          <div class="text-[10px] sm:text-xs font-semibold text-slate-400 uppercase">Toko Terbesar</div>\n' +
'          <div class="text-xs sm:text-sm font-bold text-indigo-300 mt-1 truncate" id="month-top-store-val" title="' + (data.monthly ? data.monthly.topStoreMonth : "-") + '">' + (data.monthly ? data.monthly.topStoreMonth : "-") + '</div>\n' +
'        </div>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <!-- KPI METRIC CARDS (ALL DIRECT TO OMZET) -->\n' +
'    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">\n' +
'      <div class="glass-card p-4 sm:p-5 rounded-2xl relative overflow-hidden group">\n' +
'        <div class="flex items-center justify-between text-slate-400 text-[10px] sm:text-xs font-semibold uppercase tracking-wider mb-1.5">\n' +
'          <span>Total Omzet Bersih</span>\n' +
'          <div class="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-xs"><i class="fa-solid fa-sack-dollar"></i></div>\n' +
'        </div>\n' +
'        <div class="text-lg sm:text-2xl font-black text-white tracking-tight" id="kpi-omzet">Rp ' + Number(data.totalOmzet).toLocaleString("id-ID") + '</div>\n' +
'        <div class="text-[10px] sm:text-xs text-slate-400 mt-1.5 truncate" id="kpi-omzet-sub">\n' +
'          <i class="fa-solid fa-circle-check text-emerald-400 mr-1"></i> ' + (data.totalReturCount > 0 ? data.totalReturCount + " paket retur dieksklusi" : "Semua pembayaran masuk omzet") + '\n' +
'        </div>\n' +
'      </div>\n' +
'\n' +
'      <div class="glass-card p-4 sm:p-5 rounded-2xl relative overflow-hidden group">\n' +
'        <div class="flex items-center justify-between text-slate-400 text-[10px] sm:text-xs font-semibold uppercase tracking-wider mb-1.5">\n' +
'          <span>Total Paket</span>\n' +
'          <div class="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center text-xs"><i class="fa-solid fa-box"></i></div>\n' +
'        </div>\n' +
'        <div class="text-lg sm:text-2xl font-black text-blue-400 tracking-tight" id="kpi-orders">' + data.totalTerkirimCount + ' Terkirim</div>\n' +
'        <div class="text-[10px] sm:text-xs text-slate-400 mt-1.5 truncate" id="kpi-orders-sub">\n' +
'          <i class="fa-solid fa-truck-fast text-blue-400 mr-1"></i> ' + (data.totalReturCount > 0 ? data.totalReturCount + " paket retur" : "Volume sukses") + '\n' +
'        </div>\n' +
'      </div>\n' +
'\n' +
'      <div class="glass-card p-4 sm:p-5 rounded-2xl relative overflow-hidden group">\n' +
'        <div class="flex items-center justify-between text-slate-400 text-[10px] sm:text-xs font-semibold uppercase tracking-wider mb-1.5">\n' +
'          <span>Rata-Rata per Paket</span>\n' +
'          <div class="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs"><i class="fa-solid fa-receipt"></i></div>\n' +
'        </div>\n' +
'        <div class="text-lg sm:text-2xl font-black text-emerald-400 tracking-tight" id="kpi-aov">Rp ' + Number(data.analytics.aov).toLocaleString("id-ID") + '</div>\n' +
'        <div class="text-[10px] sm:text-xs text-emerald-400/80 mt-1.5 truncate">\n' +
'          <i class="fa-solid fa-chart-simple mr-1"></i> Average Order Value (AOV)\n' +
'        </div>\n' +
'      </div>\n' +
'\n' +
'      <div class="glass-card p-4 sm:p-5 rounded-2xl relative overflow-hidden group">\n' +
'        <div class="flex items-center justify-between text-slate-400 text-[10px] sm:text-xs font-semibold uppercase tracking-wider mb-1.5">\n' +
'          <span>Validitas Harga</span>\n' +
'          <div class="w-7 h-7 sm:w-8 sm:h-8 rounded-lg ' + (data.unpricedCount > 0 ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400') + ' flex items-center justify-center text-xs">\n' +
'            <i class="fa-solid ' + (data.unpricedCount > 0 ? 'fa-tags' : 'fa-check-double') + '"></i>\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="text-lg sm:text-2xl font-black ' + (data.unpricedCount > 0 ? 'text-amber-400' : 'text-slate-100') + ' tracking-tight" id="kpi-unpriced">' + (data.unpricedCount > 0 ? (data.unpricedCount + ' Butuh Input') : 'Semua Lengkap') + '</div>\n' +
'        <div class="text-[10px] sm:text-xs ' + (data.unpricedCount > 0 ? 'text-amber-400' : 'text-slate-400') + ' mt-1.5 truncate">\n' +
'          ' + (data.unpricedCount > 0 ? 'Klik untuk input harga langsung' : 'Seluruh transaksi terdata aman') + '\n' +
'        </div>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <!-- VISUAL CHARTS & DIAGRAMS (CHART.JS) -->\n' +
'    <section class="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-5">\n' +
'      <!-- Chart 1: Tren Harian (Line/Area Chart - 7 cols) -->\n' +
'      <div class="lg:col-span-7 glass-card p-4 sm:p-5 rounded-2xl sm:rounded-3xl border border-slate-800 shadow-xl flex flex-col justify-between">\n' +
'        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 mb-3">\n' +
'          <div>\n' +
'            <h3 class="text-sm sm:text-base font-bold text-white flex items-center">\n' +
'              <i class="fa-solid fa-chart-line text-indigo-400 mr-2"></i>\n' +
'              <span id="trend-chart-title">Grafik Tren Penjualan Harian</span>\n' +
'            </h3>\n' +
'            <p class="text-[11px] text-slate-400">Pertumbuhan omzet dan volume paket dari tanggal ke tanggal</p>\n' +
'          </div>\n' +
'          <div class="flex items-center space-x-1.5 bg-slate-900/80 p-1 rounded-xl border border-slate-800 self-start sm:self-auto">\n' +
'            <button type="button" onclick="setTrendMetric(\'omzet\')" id="metric-btn-omzet" class="btn-touch px-2.5 py-1 text-xs font-semibold rounded-lg bg-indigo-600 text-white transition shadow-sm cursor-pointer">Omzet</button>\n' +
'            <button type="button" onclick="setTrendMetric(\'count\')" id="metric-btn-count" class="btn-touch px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-400 hover:text-white transition cursor-pointer">Paket</button>\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="relative w-full h-56 sm:h-64">\n' +
'          <canvas id="trendChart"></canvas>\n' +
'        </div>\n' +
'      </div>\n' +
'\n' +
'      <!-- Chart 2: Proporsi Toko (Doughnut Chart - 5 cols) -->\n' +
'      <div class="lg:col-span-5 glass-card p-4 sm:p-5 rounded-2xl sm:rounded-3xl border border-slate-800 shadow-xl flex flex-col justify-between">\n' +
'        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 mb-3">\n' +
'          <div>\n' +
'            <h3 class="text-sm sm:text-base font-bold text-white flex items-center">\n' +
'              <i class="fa-solid fa-chart-pie text-violet-400 mr-2"></i>\n' +
'              <span id="dist-chart-title">Pembagian Kinerja Toko</span>\n' +
'            </h3>\n' +
'            <p class="text-[11px] text-slate-400">Kontribusi penjualan per cabang toko</p>\n' +
'          </div>\n' +
'          <div class="flex items-center space-x-1.5 bg-slate-900/80 p-1 rounded-xl border border-slate-800 self-start sm:self-auto">\n' +
'            <button type="button" onclick="setDistMode(\'omzet\')" id="dist-btn-omzet" class="btn-touch px-2.5 py-1 text-xs font-semibold rounded-lg bg-indigo-600 text-white transition shadow-sm cursor-pointer">Omzet</button>\n' +
'            <button type="button" onclick="setDistMode(\'count\')" id="dist-btn-count" class="btn-touch px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-400 hover:text-white transition cursor-pointer">Paket</button>\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="relative w-full h-56 sm:h-64 flex items-center justify-center">\n' +
'          <canvas id="distChart"></canvas>\n' +
'        </div>\n' +
'      </div>\n' +
'    </section>\n' +
'\n' +
'    <!-- TOP SELLING PRODUCTS WIDGET -->\n' +
'    <section class="glass-card p-4 sm:p-5 rounded-2xl sm:rounded-3xl border border-slate-800 shadow-xl space-y-3.5">\n' +
'      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-800/80">\n' +
'        <div class="flex items-center space-x-2.5">\n' +
'          <div class="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center text-sm shadow-sm">\n' +
'            <i class="fa-solid fa-trophy"></i>\n' +
'          </div>\n' +
'          <div>\n' +
'            <h3 class="text-sm sm:text-base font-bold text-white tracking-tight flex items-center">\n' +
'              Produk Terlaris & Kontribusi Omzet\n' +
'              <span class="ml-2 text-[10px] font-bold text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">BEST SELLERS</span>\n' +
'            </h3>\n' +
'            <p class="text-[11px] text-slate-400">Peringkat produk terlaris berdasarkan volume paket dan total omzet bersih pada periode terpilih</p>\n' +
'          </div>\n' +
'        </div>\n' +
'        <div class="text-[11px] text-slate-400 flex items-center gap-1.5 self-start sm:self-auto">\n' +
'          <span class="text-slate-400" id="top-products-count-badge">Memuat produk...</span>\n' +
'        </div>\n' +
'      </div>\n' +
'\n' +
'      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-3.5" id="top-products-grid">\n' +
'      </div>\n' +
'    </section>\n' +
'\n' +
'    <!-- DYNAMIC STORE PERFORMANCE GRID -->\n' +
'    <section class="space-y-3">\n' +
'      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 px-1">\n' +
'        <div>\n' +
'          <h2 class="text-sm sm:text-base font-bold text-white flex items-center">\n' +
'            <i class="fa-solid fa-store text-indigo-400 mr-2"></i> Kinerja Omzet per Toko\n' +
'          </h2>\n' +
'          <p class="text-[11px] text-slate-400">Klik kartu toko untuk memfilter tabel transaksi</p>\n' +
'        </div>\n' +
'        <div id="active-store-indicator" class="text-[11px] text-indigo-300 font-medium bg-indigo-500/10 px-2.5 py-0.5 rounded-full border border-indigo-500/20 self-start sm:self-auto">\n' +
'          Semua Toko Ditampilkan\n' +
'        </div>\n' +
'      </div>\n' +
'      \n' +
'      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4" id="store-cards-grid">\n' +
'      </div>\n' +
'    </section>\n' +
'\n' +
'    <!-- FILTER & SEARCH CONTROL BAR -->\n' +
'    <div class="glass-card p-3 sm:p-4 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-2.5 sm:gap-3 shadow-md w-full max-w-full overflow-hidden">\n' +
'      <!-- Store Dropdown -->\n' +
'      <div class="flex items-center space-x-2 flex-shrink-0 w-full sm:w-auto">\n' +
'        <label for="store-filter" class="text-[11px] sm:text-xs font-semibold text-slate-400 uppercase tracking-wider flex-shrink-0">\n' +
'          <i class="fa-solid fa-filter text-indigo-400 mr-1"></i> Toko:\n' +
'        </label>\n' +
'        <select id="store-filter" onchange="onSelectStore(this.value)" class="w-full sm:w-auto bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-xl px-2.5 py-1.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-medium cursor-pointer truncate">\n' +
'        </select>\n' +
'      </div>\n' +
'\n' +
'      <!-- Search Box -->\n' +
'      <div class="relative flex-1 w-full max-w-full md:max-w-md min-w-0">\n' +
'        <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>\n' +
'        <input type="text" id="order-search" oninput="applyFilters()" placeholder="Cari Resi, Nama Pembeli, SKU, atau Produk..." class="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-xl pl-8 pr-8 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none placeholder:text-slate-500">\n' +
'        <button type="button" onclick="clearSearch()" class="btn-touch absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs cursor-pointer">\n' +
'          <i class="fa-solid fa-xmark"></i>\n' +
'        </button>\n' +
'      </div>\n' +
'\n' +
'      <!-- Filter Status Pills -->\n' +
'      <div class="flex items-center space-x-1.5 overflow-x-auto pb-1 md:pb-0 w-full md:w-auto min-w-0 max-w-full custom-scrollbar flex-nowrap flex-shrink-0">\n' +
'        <button type="button" onclick="setStatusFilter(\'ALL\')" id="tab-all" class="btn-touch filter-tab px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white transition cursor-pointer whitespace-nowrap flex-shrink-0">Semua</button>\n' +
'        <button type="button" onclick="setStatusFilter(\'TERKIRIM\')" id="tab-terkirim" class="btn-touch filter-tab px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-emerald-300 hover:bg-slate-700 transition flex items-center cursor-pointer whitespace-nowrap flex-shrink-0">\n' +
'          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5"></span> Terkirim\n' +
'        </button>\n' +
'        <button type="button" onclick="setStatusFilter(\'RETUR\')" id="tab-retur" class="btn-touch filter-tab px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-rose-300 hover:bg-slate-700 transition flex items-center cursor-pointer whitespace-nowrap flex-shrink-0">\n' +
'          <span class="w-1.5 h-1.5 rounded-full bg-rose-400 mr-1.5"></span> Retur\n' +
'        </button>\n' +
'        <button type="button" onclick="setStatusFilter(\'UNPRICED\')" id="tab-unpriced" class="btn-touch filter-tab px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 text-amber-300 hover:bg-slate-700 transition flex items-center cursor-pointer whitespace-nowrap flex-shrink-0">\n' +
'          <span class="w-1.5 h-1.5 rounded-full bg-amber-400 mr-1.5"></span> Butuh Harga\n' +
'        </button>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <!-- ORDER TRANSACTIONS STREAM TABLE -->\n' +
'    <section class="glass-card rounded-2xl sm:rounded-3xl overflow-hidden shadow-xl border border-slate-800 w-full max-w-full">\n' +
'      <div class="px-3.5 sm:px-4 py-3 sm:py-3.5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-slate-900/60 min-w-0">\n' +
'        <div class="flex items-center space-x-2 min-w-0">\n' +
'          <div class="w-2 h-2 rounded-full bg-indigo-500 flex-shrink-0"></div>\n' +
'          <h3 class="text-xs sm:text-sm font-bold text-white tracking-tight truncate">Daftar Transaksi Real-Time</h3>\n' +
'          <span class="text-[11px] text-slate-400 flex-shrink-0" id="order-count-badge">(' + data.totalOrders + ' Transaksi)</span>\n' +
'        </div>\n' +
'        <div class="text-[11px] text-slate-400 flex items-center gap-1.5 flex-shrink-0">\n' +
'          <i class="fa-solid fa-table-list text-indigo-400"></i> Sheet: <code class="bg-slate-800 px-1.5 py-0.5 rounded text-indigo-300 font-mono text-[10px]">List_Order</code>\n' +
'        </div>\n' +
'      </div>\n' +
'\n' +
'      <div class="w-full max-w-full overflow-x-auto custom-scrollbar max-h-[550px]">\n' +
'        <table class="w-full text-left text-xs min-w-[620px] sm:min-w-full">\n' +
'          <thead class="bg-slate-900/90 sticky top-0 text-slate-400 font-semibold uppercase tracking-wider text-[10px] sm:text-[11px] border-b border-slate-800 backdrop-blur-md z-10">\n' +
'            <tr>\n' +
'              <th class="px-3.5 py-3">Waktu</th>\n' +
'              <th class="px-3.5 py-3">No Resi & Ekspedisi</th>\n' +
'              <th class="px-3.5 py-3">Toko</th>\n' +
'              <th class="px-3.5 py-3">Penerima & HP</th>\n' +
'              <th class="px-3.5 py-3">Produk / SKU</th>\n' +
'              <th class="px-3.5 py-3 text-center">Qty</th>\n' +
'              <th class="px-3.5 py-3 text-right">Total Omzet (Rp)</th>\n' +
'              <th class="px-3.5 py-3 text-center">Status / Aksi</th>\n' +
'            </tr>\n' +
'          </thead>\n' +
'          <tbody id="orders-table-body" class="divide-y divide-slate-800/80 font-normal">\n' +
'          </tbody>\n' +
'        </table>\n' +
'      </div>\n' +
'\n' +
'      <div id="orders-empty-state" class="hidden p-10 text-center">\n' +
'        <div class="w-10 h-10 rounded-full bg-slate-800 text-slate-500 mx-auto flex items-center justify-center text-lg mb-2">\n' +
'          <i class="fa-solid fa-inbox"></i>\n' +
'        </div>\n' +
'        <h4 class="text-xs font-bold text-slate-300">Tidak ada transaksi yang cocok</h4>\n' +
'        <p class="text-[11px] text-slate-500 mt-1">Coba sesuaikan kata kunci pencarian atau filter toko Anda.</p>\n' +
'      </div>\n' +
'    </section>\n' +
'\n' +
'    <!-- FOOTER INFO -->\n' +
'    <footer class="text-center text-[11px] text-slate-500 py-3">\n' +
'      Bot Resi & Financial Engine • Arsitektur 3 Sheet (Master_Product, List_Order, Rekap_Keuangan)\n' +
'    </footer>\n' +
'\n' +
'  </div>\n' +
'\n' +
'  <!-- MODAL INPUT / UPDATE HARGA DIRECT DARI WEB DASHBOARD -->\n' +
'  <div id="price-modal" style="display: none;" class="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">\n' +
'    <div class="glass-card w-full max-w-md p-5 sm:p-6 rounded-3xl border border-slate-700 shadow-2xl relative space-y-4">\n' +
'      <div class="flex items-center justify-between pb-3 border-b border-slate-800">\n' +
'        <div class="flex items-center space-x-2">\n' +
'          <span class="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center text-sm">\n' +
'            <i class="fa-solid fa-pen-to-square"></i>\n' +
'          </span>\n' +
'          <h3 class="text-base font-bold text-white">Input Nominal Omzet</h3>\n' +
'        </div>\n' +
'        <button type="button" onclick="closePriceModal()" class="btn-touch text-slate-400 hover:text-white text-base p-1.5 cursor-pointer">\n' +
'          <i class="fa-solid fa-xmark"></i>\n' +
'        </button>\n' +
'      </div>\n' +
'\n' +
'      <div class="space-y-3 text-xs">\n' +
'        <div class="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1.5">\n' +
'          <div class="text-slate-400">No. Resi: <b id="modal-resi-text" class="text-slate-200 font-mono"></b></div>\n' +
'          <div class="text-slate-400">Penerima: <b id="modal-recipient-text" class="text-slate-200"></b></div>\n' +
'          <div class="text-slate-400">Produk: <span id="modal-product-text" class="text-slate-300"></span></div>\n' +
'        </div>\n' +
'\n' +
'        <div>\n' +
'          <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Nominal Harga Total (Rp):</label>\n' +
'          <div class="relative">\n' +
'            <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-xs">Rp</span>\n' +
'            <input type="text" inputmode="numeric" id="modal-price-input" placeholder="Contoh: 900.000 atau 900000" class="w-full bg-slate-900 border border-slate-700 text-white text-sm rounded-xl pl-10 pr-3 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-bold">\n' +
'          </div>\n' +
'          <span class="text-[10px] text-slate-400 mt-1 block">Bisa ketik angka bebas (contoh: 900000, 900.000, atau 900rb). Otomatis masuk langsung ke total omzet.</span>\n' +
'        </div>\n' +
'\n' +
'        <div>\n' +
'          <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Pilih Toko:</label>\n' +
'          <select id="modal-store-select" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-medium cursor-pointer">\n' +
'            <option value="Fertipro">🌾 Fertipro</option>\n' +
'            <option value="Yosa Farm">🌿 Yosa Farm</option>\n' +
'            <option value="Interfarm">📦 Interfarm</option>\n' +
'            <option value="Utamigro">🌱 Utamigro</option>\n' +
'            <option value="Safra">👤 Safra</option>\n' +
'            <option value="Alwiwin Store">🏪 Alwiwin Store</option>\n' +
'          </select>\n' +
'        </div>\n' +
'\n' +
'        <div>\n' +
'          <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Status Pesanan:</label>\n' +
'          <select id="modal-status-select" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-medium cursor-pointer">\n' +
'            <option value="TERKIRIM">✅ TERKIRIM (Masuk Omzet)</option>\n' +
'            <option value="RETUR">🔄 RETUR (Barang Batal / Bukan Omzet)</option>\n' +
'          </select>\n' +
'        </div>\n' +
'      </div>\n' +
'\n' +
'      <div class="flex items-center justify-end space-x-2 pt-2 border-t border-slate-800">\n' +
'        <button type="button" onclick="closePriceModal()" class="btn-touch px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 transition cursor-pointer">\n' +
'          Batal\n' +
'        </button>\n' +
'        <button type="button" id="modal-save-btn" onclick="submitPriceModal()" class="btn-touch px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition flex items-center shadow-lg shadow-indigo-600/30 cursor-pointer">\n' +
'          <i class="fa-solid fa-cloud-arrow-up mr-1.5"></i> Simpan ke Spreadsheet\n' +
'        </button>\n' +
'      </div>\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'  <!-- MODAL INPUT ORDER MANUAL DARI WEB DASHBOARD -->\n' +
'  <div id="new-order-modal" style="display: none;" class="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md overflow-y-auto">\n' +
'    <div class="glass-card w-full max-w-lg p-5 sm:p-6 rounded-3xl border border-indigo-500/40 shadow-2xl relative space-y-4 my-8">\n' +
'      <div class="flex items-center justify-between pb-3 border-b border-slate-800">\n' +
'        <div class="flex items-center space-x-2.5">\n' +
'          <span class="w-8 h-8 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-sm">\n' +
'            <i class="fa-solid fa-circle-plus"></i>\n' +
'          </span>\n' +
'          <div>\n' +
'            <h3 class="text-base font-bold text-white">Input Order Manual</h3>\n' +
'            <p class="text-[11px] text-slate-400">Catat pesanan susulan langsung ke Google Sheets</p>\n' +
'          </div>\n' +
'        </div>\n' +
'        <button type="button" onclick="closeNewOrderModal()" class="btn-touch text-slate-400 hover:text-white text-base p-1.5 cursor-pointer">\n' +
'          <i class="fa-solid fa-xmark"></i>\n' +
'        </button>\n' +
'      </div>\n' +
'\n' +
'      <div class="space-y-3 text-xs">\n' +
'        <div class="grid grid-cols-2 gap-3">\n' +
'          <div>\n' +
'            <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Tanggal Transaksi:</label>\n' +
'            <input type="date" id="new-order-date" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-medium">\n' +
'          </div>\n' +
'          <div>\n' +
'            <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Jam (WIB):</label>\n' +
'            <input type="time" id="new-order-time" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-medium">\n' +
'          </div>\n' +
'        </div>\n' +
'\n' +
'        <div class="grid grid-cols-2 gap-3">\n' +
'          <div>\n' +
'            <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Cabang Toko:</label>\n' +
'            <select id="new-order-store" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-medium cursor-pointer">\n' +
'              <option value="Fertipro">🌾 Fertipro</option>\n' +
'              <option value="Yosa Farm">🌿 Yosa Farm</option>\n' +
'              <option value="Interfarm">📦 Interfarm</option>\n' +
'              <option value="Utamigro">🌱 Utamigro</option>\n' +
'              <option value="Safra">👤 Safra</option>\n' +
'              <option value="Alwiwin Store">🏪 Alwiwin Store</option>\n' +
'            </select>\n' +
'          </div>\n' +
'          <div>\n' +
'            <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Ekspedisi:</label>\n' +
'            <input type="text" id="new-order-expedition" placeholder="J&T / JNE / SiCepat / dll" value="J&T" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-medium">\n' +
'          </div>\n' +
'        </div>\n' +
'\n' +
'        <div class="grid grid-cols-2 gap-3">\n' +
'          <div>\n' +
'            <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Nama Penerima: <span class="text-rose-400">*</span></label>\n' +
'            <input type="text" id="new-order-recipient" placeholder="Contoh: Pak Budi" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-medium">\n' +
'          </div>\n' +
'          <div>\n' +
'            <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">No. WhatsApp / HP:</label>\n' +
'            <input type="tel" id="new-order-phone" placeholder="08xxxxxxxxxx" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-medium">\n' +
'          </div>\n' +
'        </div>\n' +
'\n' +
'        <div>\n' +
'          <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">No. Resi (Opsional):</label>\n' +
'          <input type="text" id="new-order-resi" placeholder="Kosongkan jika otomatis di-generate" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-mono">\n' +
'        </div>\n' +
'\n' +
'        <div class="grid grid-cols-3 gap-3">\n' +
'          <div class="col-span-2">\n' +
'            <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Nama Produk:</label>\n' +
'            <input type="text" id="new-order-product" placeholder="Contoh: Fertipro 1 Hektar" value="Fertipro 1 Hektar" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-medium">\n' +
'          </div>\n' +
'          <div>\n' +
'            <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Qty:</label>\n' +
'            <input type="number" id="new-order-qty" value="1" min="1" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-bold text-center">\n' +
'          </div>\n' +
'        </div>\n' +
'\n' +
'        <div class="grid grid-cols-2 gap-3">\n' +
'          <div>\n' +
'            <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Total Omzet / Harga (Rp): <span class="text-rose-400">*</span></label>\n' +
'            <div class="relative">\n' +
'              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-xs">Rp</span>\n' +
'              <input type="text" inputmode="numeric" id="new-order-total" placeholder="Contoh: 395.000 atau 395000" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl pl-9 pr-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-bold">\n' +
'            </div>\n' +
'          </div>\n' +
'          <div>\n' +
'            <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Status Awal:</label>\n' +
'            <select id="new-order-status" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-medium cursor-pointer">\n' +
'              <option value="TERKIRIM">✅ TERKIRIM (Masuk Omzet)</option>\n' +
'              <option value="RETUR">🔄 RETUR (Barang Retur)</option>\n' +
'            </select>\n' +
'          </div>\n' +
'        </div>\n' +
'\n' +
'        <div>\n' +
'          <label class="block text-[11px] font-semibold text-slate-300 uppercase tracking-wider mb-1">Catatan Tambahan:</label>\n' +
'          <input type="text" id="new-order-notes" placeholder="Contoh: Pesanan manual via WhatsApp" class="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:outline-none font-medium">\n' +
'        </div>\n' +
'      </div>\n' +
'\n' +
'      <div class="flex items-center justify-end space-x-2 pt-3 border-t border-slate-800">\n' +
'        <button type="button" onclick="closeNewOrderModal()" class="btn-touch px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 transition cursor-pointer">\n' +
'          Batal\n' +
'        </button>\n' +
'        <button type="button" id="btn-submit-new-order" onclick="submitNewOrderModal()" class="btn-touch px-4 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white transition flex items-center shadow-lg shadow-indigo-600/30 cursor-pointer">\n' +
'          <i class="fa-solid fa-cloud-arrow-up mr-1.5"></i> Simpan Order Baru\n' +
'        </button>\n' +
'      </div>\n' +
'    </div>\n' +
'  </div>\n' +
'\n' +
'  <!-- TOAST NOTIFICATION -->\n' +
'  <div id="toast" style="display: none;" class="fixed bottom-5 right-5 z-[10000] px-4 py-2.5 rounded-2xl bg-emerald-600 text-white text-xs font-semibold shadow-2xl flex items-center space-x-2 transition">\n' +
'    <i class="fa-solid fa-circle-check"></i>\n' +
'    <span id="toast-msg">Harga berhasil diperbarui!</span>\n' +
'  </div>\n' +
'\n' +
'  <!-- CLIENT-SIDE LOGIC -->\n' +
'  <script>\n' +
'    var rawData = ' + jsonPayload + ';\n' +
'    var currentPeriodFilter = "CURRENT_MONTH";\n' +
'    var currentActiveOrders = [];\n' +
'    var currentActiveStoreSummary = {};\n' +
'    var currentActiveDaily = {};\n' +
'    var currentStoreFilter = "ALL";\n' +
'    var currentStatusFilter = "ALL";\n' +
'    var currentTrendMetric = "omzet";\n' +
'    var currentDistMetric = "omzet";\n' +
'    var trendChartInstance = null;\n' +
'    var distChartInstance = null;\n' +
'    var currentModalTarget = null;\n' +
'\n' +
'    function formatRupiah(num) {\n' +
'      return "Rp " + Number(num || 0).toLocaleString("id-ID");\n' +
'    }\n' +
'\n' +
'    function parseClientPrice(val) {\n' +
'      if (typeof val === "number") return isNaN(val) ? 0 : Math.round(val);\n' +
'      if (!val) return 0;\n' +
'      var str = String(val).trim().toLowerCase();\n' +
'      if (!str) return 0;\n' +
'      if (/(\\d+(?:[\\.,]\\d+)?)\\s*(?:jt|juta)/i.test(str)) {\n' +
'        var m = str.match(/(\\d+(?:[\\.,]\\d+)?)\\s*(?:jt|juta)/i);\n' +
'        return Math.round(parseFloat(m[1].replace(",", ".")) * 1000000);\n' +
'      }\n' +
'      if (/(\\d+(?:[\\.,]\\d+)?)\\s*(?:rb|k|ribu)/i.test(str)) {\n' +
'        var m = str.match(/(\\d+(?:[\\.,]\\d+)?)\\s*(?:rb|k|ribu)/i);\n' +
'        return Math.round(parseFloat(m[1].replace(",", ".")) * 1000);\n' +
'      }\n' +
'      if (/\\b\\d{1,3}(?:\\.\\d{3})+\\b/.test(str)) {\n' +
'        str = str.replace(/\\./g, "");\n' +
'      } else if (/\\b\\d{1,3}(?:\\,\\d{3})+\\b/.test(str)) {\n' +
'        str = str.replace(/,/g, "");\n' +
'      }\n' +
'      str = str.replace(/[\\.,]00\\b/g, "");\n' +
'      var clean = str.replace(/[^0-9]/g, "");\n' +
'      var n = parseInt(clean, 10);\n' +
'      return isNaN(n) ? 0 : n;\n' +
'    }\n' +
'\n' +
'    function showToast(msg) {\n' +
'      var t = document.getElementById("toast");\n' +
'      document.getElementById("toast-msg").textContent = msg;\n' +
'      t.style.display = "flex";\n' +
'      setTimeout(function() { t.style.display = "none"; }, 3500);\n' +
'    }\n' +
'\n' +
'    // Dynamic store filter options\n' +
'    function initStoreSelect() {\n' +
'      var sel = document.getElementById("store-filter");\n' +
'      if (!sel) return;\n' +
'      sel.innerHTML = "";\n' +
'      var optAll = document.createElement("option");\n' +
'      optAll.value = "ALL";\n' +
'      optAll.textContent = "🌟 Semua Toko";\n' +
'      sel.appendChild(optAll);\n' +
'\n' +
'      (rawData.allStores || []).forEach(function(s) {\n' +
'        var opt = document.createElement("option");\n' +
'        opt.value = s;\n' +
'        var count = (rawData.storeSummary && rawData.storeSummary[s] && rawData.storeSummary[s].count) || 0;\n' +
'        var icon = (s.toLowerCase().indexOf("fertipro") !== -1) ? "🌾 " : (s.toLowerCase().indexOf("yosa") !== -1 ? "🌿 " : "🏪 ");\n' +
'        opt.textContent = icon + s + " (" + count + ")";\n' +
'        sel.appendChild(opt);\n' +
'      });\n' +
'      sel.value = currentStoreFilter;\n' +
'    }\n' +
'\n' +
'    // Dynamic period filter options\n' +
'    function initPeriodSelector() {\n' +
'      var sel = document.getElementById("period-filter-select");\n' +
'      if (!sel) return;\n' +
'      sel.innerHTML = "";\n' +
'\n' +
'      var curMonthTitle = (rawData.monthly && rawData.monthly.monthTitle) ? rawData.monthly.monthTitle : "Berjalan";\n' +
'      var optCur = document.createElement("option");\n' +
'      optCur.value = "CURRENT_MONTH";\n' +
'      optCur.textContent = "📅 Bulan Ini (" + curMonthTitle + ")";\n' +
'      sel.appendChild(optCur);\n' +
'\n' +
'      var optLast = document.createElement("option");\n' +
'      optLast.value = "LAST_MONTH";\n' +
'      optLast.textContent = "📅 Bulan Lalu";\n' +
'      sel.appendChild(optLast);\n' +
'\n' +
'      var optAll = document.createElement("option");\n' +
'      optAll.value = "ALL";\n' +
'      optAll.textContent = "🌟 Total Semua (All-Time)";\n' +
'      sel.appendChild(optAll);\n' +
'\n' +
'      if (rawData.monthlyRecap && rawData.monthlyRecap.length > 0) {\n' +
'        var optGroupMonths = document.createElement("optgroup");\n' +
'        optGroupMonths.label = "--- PILIH BULAN TERTENTU ---";\n' +
'        rawData.monthlyRecap.forEach(function(m) {\n' +
'          var optM = document.createElement("option");\n' +
'          optM.value = "MONTH:" + m.ym;\n' +
'          optM.textContent = "🗓️ " + m.label + " (" + m.formattedOmzet + ")";\n' +
'          optGroupMonths.appendChild(optM);\n' +
'        });\n' +
'        sel.appendChild(optGroupMonths);\n' +
'      }\n' +
'\n' +
'      if (rawData.availableYears && rawData.availableYears.length > 0) {\n' +
'        var optGroupYears = document.createElement("optgroup");\n' +
'        optGroupYears.label = "--- PILIH TAHUN ---";\n' +
'        rawData.availableYears.forEach(function(y) {\n' +
'          var optY = document.createElement("option");\n' +
'          optY.value = "YEAR:" + y;\n' +
'          optY.textContent = "📅 Tahun " + y;\n' +
'          optGroupYears.appendChild(optY);\n' +
'        });\n' +
'        sel.appendChild(optGroupYears);\n' +
'      }\n' +
'\n' +
'      sel.value = currentPeriodFilter;\n' +
'    }\n' +
'\n' +
'    function renderTodayCard() {\n' +
'      if (!rawData) return;\n' +
'      var todayObj = rawData.today || {};\n' +
'      var todayDateStr = todayObj.dateStr || "";\n' +
'      var todayFormatted = todayObj.formattedDate || "";\n' +
'      var all = (rawData.allOrders && rawData.allOrders.length > 0) ? rawData.allOrders : (rawData.recentOrders || []);\n' +
'\n' +
'      var tOrders = 0;\n' +
'      var tOmzet = 0;\n' +
'      var tRetur = 0;\n' +
'      var tUnpriced = 0;\n' +
'      var storeMap = {};\n' +
'\n' +
'      all.forEach(function(o) {\n' +
'        if (!o.tanggal) return;\n' +
'        if (todayDateStr && o.tanggal !== todayDateStr) return;\n' +
'        if (currentStoreFilter !== "ALL" && o.toko !== currentStoreFilter) return;\n' +
'\n' +
'        var isRet = (o.statusPesanan === "RETUR" || o.isRetur);\n' +
'        var isUnpriced = (o.total === 0 || (o.statusHarga && o.statusHarga.indexOf("PERLU") !== -1));\n' +
'\n' +
'        if (isUnpriced) tUnpriced++;\n' +
'        if (isRet) {\n' +
'          tRetur++;\n' +
'        } else {\n' +
'          tOrders++;\n' +
'          tOmzet += (Number(o.total) || 0);\n' +
'          var tk = o.toko || "Safra";\n' +
'          storeMap[tk] = (storeMap[tk] || 0) + (Number(o.total) || 0);\n' +
'        }\n' +
'      });\n' +
'\n' +
'      var tAov = tOrders > 0 ? Math.round(tOmzet / tOrders) : 0;\n' +
'      var tTopStore = "-";\n' +
'      var maxStoreOmzet = 0;\n' +
'      for (var s in storeMap) {\n' +
'        if (storeMap[s] > maxStoreOmzet) {\n' +
'          maxStoreOmzet = storeMap[s];\n' +
'          tTopStore = s;\n' +
'        }\n' +
'      }\n' +
'      if (tTopStore === "-" && currentStoreFilter !== "ALL") {\n' +
'        tTopStore = currentStoreFilter;\n' +
'      }\n' +
'\n' +
'      var dateEl = document.getElementById("today-date-text");\n' +
'      if (dateEl && todayFormatted) {\n' +
'        dateEl.textContent = "Hari ini, " + todayFormatted + (currentStoreFilter !== "ALL" ? " • Toko: " + currentStoreFilter : "");\n' +
'      }\n' +
'      var omzetEl = document.getElementById("today-omzet-val");\n' +
'      if (omzetEl) omzetEl.textContent = formatRupiah(tOmzet);\n' +
'      var ordersEl = document.getElementById("today-orders-val");\n' +
'      if (ordersEl) ordersEl.innerHTML = tOrders + " <span class=\'text-xs font-semibold text-slate-400\'>paket</span>";\n' +
'      var ordersSub = document.getElementById("today-orders-sub");\n' +
'      if (ordersSub) {\n' +
'        if (tRetur > 0) {\n' +
'          ordersSub.innerHTML = "<span class=\'text-rose-400 font-semibold\'>" + tRetur + " retur hari ini</span>";\n' +
'        } else {\n' +
'          ordersSub.innerHTML = "<span class=\'text-emerald-400\'><i class=\'fa-solid fa-check mr-1\'></i> Siap kirim hari ini</span>";\n' +
'        }\n' +
'      }\n' +
'      var aovEl = document.getElementById("today-aov-val");\n' +
'      if (aovEl) aovEl.textContent = formatRupiah(tAov);\n' +
'      var topStoreEl = document.getElementById("today-top-store-val");\n' +
'      if (topStoreEl) {\n' +
'        topStoreEl.textContent = tTopStore;\n' +
'        topStoreEl.title = tTopStore;\n' +
'      }\n' +
'      var unpricedSub = document.getElementById("today-unpriced-sub");\n' +
'      if (unpricedSub) {\n' +
'        if (tUnpriced > 0) {\n' +
'          unpricedSub.innerHTML = "<span class=\'text-amber-400 font-semibold\'>" + tUnpriced + " butuh harga</span>";\n' +
'        } else {\n' +
'          unpricedSub.innerHTML = "<span class=\'text-slate-400\'>Semua harga lengkap</span>";\n' +
'        }\n' +
'      }\n' +
'      var badgeText = document.getElementById("today-badge-text");\n' +
'      if (badgeText) {\n' +
'        badgeText.textContent = tOrders + " Terkirim" + (tRetur > 0 ? " • " + tRetur + " Retur" : "");\n' +
'      }\n' +
'    }\n' +
'\n' +
'    function toggleMonthlyTable() {\n' +
'      var sec = document.getElementById("monthly-recap-section");\n' +
'      var btnText = document.getElementById("btn-toggle-monthly-text");\n' +
'      if (!sec) return;\n' +
'      if (sec.style.display === "none") {\n' +
'        sec.style.display = "block";\n' +
'        if (btnText) btnText.textContent = "Tutup Rekap Tiap Bulan";\n' +
'        renderMonthlyRecapTable();\n' +
'        sec.scrollIntoView({ behavior: "smooth" });\n' +
'      } else {\n' +
'        sec.style.display = "none";\n' +
'        if (btnText) btnText.textContent = "Lihat Rekap Tiap Bulan";\n' +
'      }\n' +
'    }\n' +
'\n' +
'    function renderMonthlyRecapTable() {\n' +
'      var tbody = document.getElementById("monthly-recap-tbody");\n' +
'      if (!tbody) return;\n' +
'      tbody.innerHTML = "";\n' +
'      var list = rawData.monthlyRecap || [];\n' +
'      if (list.length === 0) {\n' +
'        tbody.innerHTML = "<tr><td colspan=\'6\' class=\'px-3.5 py-4 text-center text-slate-500\'>Belum ada riwayat transaksi bulanan.</td></tr>";\n' +
'        return;\n' +
'      }\n' +
'      list.forEach(function(item) {\n' +
'        var tr = document.createElement("tr");\n' +
'        var isSelMonth = (currentPeriodFilter === ("MONTH:" + item.ym));\n' +
'        tr.className = "hover:bg-slate-800/60 transition cursor-pointer " + (isSelMonth ? "bg-indigo-950/40 border-l-4 border-indigo-500" : "");\n' +
'        tr.onclick = function() {\n' +
'          onPeriodChange("MONTH:" + item.ym);\n' +
'          var el = document.getElementById("period-summary-title");\n' +
'          if (el) el.scrollIntoView({ behavior: "smooth" });\n' +
'        };\n' +
'        tr.innerHTML = \n' +
'          "<td class=\'px-3.5 py-2.5 font-bold text-slate-200\'>" + item.label + (isSelMonth ? " <span class=\'text-[10px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded font-bold\'>DIPILIH</span>" : "") + "</td>" +\n' +
'          "<td class=\'px-3.5 py-2.5 text-right font-black text-indigo-300\'>" + item.formattedOmzet + "</td>" +\n' +
'          "<td class=\'px-3.5 py-2.5 text-center font-bold text-emerald-400\'>" + item.count + " paket</td>" +\n' +
'          "<td class=\'px-3.5 py-2.5 text-center font-bold " + (item.returCount > 0 ? "text-rose-400" : "text-slate-500") + "\'>" + item.returCount + "</td>" +\n' +
'          "<td class=\'px-3.5 py-2.5 text-right font-bold text-emerald-300\'>" + formatRupiah(item.aov) + "</td>" +\n' +
'          "<td class=\'px-3.5 py-2.5 text-center\'>" +\n' +
'            "<button type=\'button\' class=\'btn-touch px-2.5 py-1 text-[10px] font-bold rounded-lg " + (isSelMonth ? "bg-indigo-600 text-white" : "bg-indigo-600/25 text-indigo-300 hover:bg-indigo-600 hover:text-white") + " transition cursor-pointer\'>" +\n' +
'              "<i class=\'fa-solid fa-filter mr-1\'></i> " + (isSelMonth ? "Sedang Aktif" : "Pilih Bulan") +\n' +
'            "</button>" +\n' +
'          "</td>";\n' +
'        tbody.appendChild(tr);\n' +
'      });\n' +
'    }\n' +
'\n' +
'    function onPeriodChange(periodVal) {\n' +
'      currentPeriodFilter = periodVal;\n' +
'      var sel = document.getElementById("period-filter-select");\n' +
'      if (sel) sel.value = periodVal;\n' +
'      applyActivePeriodData();\n' +
'      renderMonthlyRecapTable();\n' +
'    }\n' +
'\n' +
'    function getFilteredOrdersForPeriod() {\n' +
'      var all = (rawData.allOrders && rawData.allOrders.length > 0) ? rawData.allOrders : (rawData.recentOrders || []);\n' +
'      if (currentPeriodFilter === "ALL") {\n' +
'        return { orders: all, title: "Total Semua (All-Time)" };\n' +
'      }\n' +
'      if (currentPeriodFilter === "CURRENT_MONTH") {\n' +
'        var targetYM = rawData.currentYearMonth || "2026-10";\n' +
'        var title = (rawData.monthly && rawData.monthly.monthTitle) ? rawData.monthly.monthTitle : "Bulan Ini";\n' +
'        var filtered = all.filter(function(o) {\n' +
'          return o.tanggal && (o.tanggal.indexOf(targetYM) === 0 || o.tanggal.indexOf("2026-10") !== -1);\n' +
'        });\n' +
'        return { orders: filtered, title: "Bulan Ini (" + title + ")" };\n' +
'      }\n' +
'      if (currentPeriodFilter === "LAST_MONTH") {\n' +
'        var nowD = new Date();\n' +
'        nowD.setDate(1);\n' +
'        nowD.setMonth(nowD.getMonth() - 1);\n' +
'        var prevY = nowD.getFullYear();\n' +
'        var prevM = (nowD.getMonth() + 1);\n' +
'        var prevYM = prevY + "-" + (prevM < 10 ? "0" + prevM : prevM);\n' +
'        var monNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];\n' +
'        var titleLast = (monNames[nowD.getMonth()] || "Bulan Lalu") + " " + prevY;\n' +
'        var filteredLast = all.filter(function(o) {\n' +
'          return o.tanggal && (o.tanggal.indexOf(prevYM) === 0 || o.tanggal.indexOf("2026-09") !== -1);\n' +
'        });\n' +
'        return { orders: filteredLast, title: "Bulan Lalu (" + titleLast + ")" };\n' +
'      }\n' +
'      if (currentPeriodFilter.indexOf("MONTH:") === 0) {\n' +
'        var ymTarget = currentPeriodFilter.substring(6);\n' +
'        var mFound = (rawData.monthlyRecap || []).find(function(m) { return m.ym === ymTarget; });\n' +
'        var mLabel = mFound ? mFound.label : ("Bulan " + ymTarget);\n' +
'        var filteredM = all.filter(function(o) {\n' +
'          return o.tanggal && o.tanggal.indexOf(ymTarget) === 0;\n' +
'        });\n' +
'        return { orders: filteredM, title: mLabel };\n' +
'      }\n' +
'      if (currentPeriodFilter.indexOf("YEAR:") === 0) {\n' +
'        var yrTarget = currentPeriodFilter.substring(5);\n' +
'        var filteredYr = all.filter(function(o) {\n' +
'          return o.tanggal && o.tanggal.indexOf(yrTarget) === 0;\n' +
'        });\n' +
'        return { orders: filteredYr, title: "Tahun " + yrTarget };\n' +
'      }\n' +
'      return { orders: all, title: "Semua Transaksi" };\n' +
'    }\n' +
'\n' +
'    function applyActivePeriodData() {\n' +
'      var periodObj = getFilteredOrdersForPeriod();\n' +
'      currentActiveOrders = periodObj.orders;\n' +
'      var activeTitle = periodObj.title;\n' +
'\n' +
'      var periodOmzet = 0;\n' +
'      var periodOrdersCount = 0;\n' +
'      var periodReturCount = 0;\n' +
'      var periodStoreSummary = {};\n' +
'      var periodDailySummary = {};\n' +
'      var periodUnpricedCount = 0;\n' +
'\n' +
'      (rawData.allStores || []).forEach(function(s) {\n' +
'        periodStoreSummary[s] = { count: 0, omzet: 0, unpriced: 0, retur: 0 };\n' +
'      });\n' +
'\n' +
'      currentActiveOrders.forEach(function(o) {\n' +
'        var isRet = (o.statusPesanan === "RETUR" || o.isRetur);\n' +
'        var isUnpriced = (o.total === 0 || o.statusHarga.indexOf("PERLU") !== -1);\n' +
'        if (isUnpriced) periodUnpricedCount++;\n' +
'\n' +
'        if (!periodStoreSummary[o.toko]) {\n' +
'          periodStoreSummary[o.toko] = { count: 0, omzet: 0, unpriced: 0, retur: 0 };\n' +
'        }\n' +
'        if (isUnpriced) periodStoreSummary[o.toko].unpriced++;\n' +
'\n' +
'        if (isRet) {\n' +
'          periodReturCount++;\n' +
'          periodStoreSummary[o.toko].retur++;\n' +
'        } else {\n' +
'          periodOrdersCount++;\n' +
'          periodOmzet += (o.total || 0);\n' +
'          periodStoreSummary[o.toko].count++;\n' +
'          periodStoreSummary[o.toko].omzet += (o.total || 0);\n' +
'\n' +
'          if (o.tanggal && o.tanggal !== "-") {\n' +
'            if (!periodDailySummary[o.tanggal]) {\n' +
'              periodDailySummary[o.tanggal] = { omzet: 0, count: 0, returCount: 0 };\n' +
'            }\n' +
'            periodDailySummary[o.tanggal].count++;\n' +
'            periodDailySummary[o.tanggal].omzet += (o.total || 0);\n' +
'          }\n' +
'        }\n' +
'      });\n' +
'\n' +
'      currentActiveStoreSummary = periodStoreSummary;\n' +
'      currentActiveDaily = periodDailySummary;\n' +
'\n' +
'      var periodAov = periodOrdersCount > 0 ? Math.round(periodOmzet / periodOrdersCount) : 0;\n' +
'      var topStoreName = "-";\n' +
'      var topStoreNominal = 0;\n' +
'      for (var s in periodStoreSummary) {\n' +
'        if (periodStoreSummary[s].omzet > topStoreNominal) {\n' +
'          topStoreNominal = periodStoreSummary[s].omzet;\n' +
'          topStoreName = s + " (" + (topStoreNominal >= 1000000 ? (topStoreNominal / 1000000).toFixed(1) + " Jt" : formatRupiah(topStoreNominal)) + ")";\n' +
'        }\n' +
'      }\n' +
'\n' +
'      // Update Dynamic Period Card\n' +
'      var pTitle = document.getElementById("period-summary-title");\n' +
'      if (pTitle) pTitle.textContent = "Rekapitulasi Periode: " + activeTitle;\n' +
'      var pBadge = document.getElementById("period-badge-label");\n' +
'      if (pBadge) pBadge.textContent = activeTitle;\n' +
'      var mOmzet = document.getElementById("month-omzet-val");\n' +
'      if (mOmzet) mOmzet.textContent = formatRupiah(periodOmzet);\n' +
'      var mOrders = document.getElementById("month-orders-val");\n' +
'      if (mOrders) mOrders.innerHTML = periodOrdersCount + " <span class=\'text-xs font-normal text-slate-400\'>terkirim</span>";\n' +
'      var mAov = document.getElementById("month-aov-val");\n' +
'      if (mAov) mAov.textContent = formatRupiah(periodAov);\n' +
'      var mTopStore = document.getElementById("month-top-store-val");\n' +
'      if (mTopStore) { mTopStore.textContent = topStoreName; mTopStore.title = topStoreName; }\n' +
'      var mBadge = document.getElementById("month-badge-orders");\n' +
'      if (mBadge) mBadge.innerHTML = "<i class=\'fa-solid fa-box-archive mr-1\'></i> " + periodOrdersCount + " Terkirim" + (periodReturCount > 0 ? " • " + periodReturCount + " Retur" : "");\n' +
'\n' +
'      // Update KPI Cards\n' +
'      var kpiOmzet = document.getElementById("kpi-omzet");\n' +
'      if (kpiOmzet) kpiOmzet.textContent = formatRupiah(periodOmzet);\n' +
'      var kpiOmzetSub = document.getElementById("kpi-omzet-sub");\n' +
'      if (kpiOmzetSub) kpiOmzetSub.innerHTML = "<i class=\'fa-solid fa-circle-check text-emerald-400 mr-1\'></i> " + (periodReturCount > 0 ? periodReturCount + " paket retur dieksklusi" : "Semua pembayaran masuk omzet");\n' +
'      var kpiOrders = document.getElementById("kpi-orders");\n' +
'      if (kpiOrders) kpiOrders.textContent = periodOrdersCount + " Terkirim";\n' +
'      var kpiOrdersSub = document.getElementById("kpi-orders-sub");\n' +
'      if (kpiOrdersSub) kpiOrdersSub.innerHTML = "<i class=\'fa-solid fa-truck-fast text-blue-400 mr-1\'></i> " + (periodReturCount > 0 ? periodReturCount + " paket retur" : "Volume sukses");\n' +
'      var kpiAov = document.getElementById("kpi-aov");\n' +
'      if (kpiAov) kpiAov.textContent = formatRupiah(periodAov);\n' +
'\n' +
'      var kpiUnpriced = document.getElementById("kpi-unpriced");\n' +
'      if (kpiUnpriced) kpiUnpriced.textContent = periodUnpricedCount > 0 ? (periodUnpricedCount + " Butuh Input") : "Semua Lengkap";\n' +
'      var unpricedBanner = document.getElementById("unpriced-banner");\n' +
'      if (unpricedBanner) {\n' +
'        unpricedBanner.style.display = (periodUnpricedCount > 0) ? "flex" : "none";\n' +
'        var cText = document.getElementById("unpriced-count-text");\n' +
'        if (cText) cText.textContent = periodUnpricedCount + " pesanan";\n' +
'      }\n' +
'\n' +
'      // Compute Top Selling Products for active period\n' +
'      var productMap = {};\n' +
'      currentActiveOrders.forEach(function(o) {\n' +
'        if (o.statusPesanan === "RETUR" || o.isRetur) return;\n' +
'        var pName = (o.produk || o.product || "").trim();\n' +
'        if (!pName || pName === "-" || pName.toLowerCase() === "undefined") {\n' +
'          pName = (o.sku && o.sku !== "-") ? ("Produk " + o.sku) : "Paket Umum";\n' +
'        }\n' +
'        if (!productMap[pName]) {\n' +
'          productMap[pName] = {\n' +
'            name: pName,\n' +
'            sku: o.sku || "-",\n' +
'            toko: o.toko || "Safra",\n' +
'            qty: 0,\n' +
'            omzet: 0,\n' +
'            count: 0\n' +
'          };\n' +
'        }\n' +
'        productMap[pName].qty += (Number(o.qty) || 1);\n' +
'        productMap[pName].omzet += (Number(o.total) || 0);\n' +
'        productMap[pName].count++;\n' +
'      });\n' +
'\n' +
'      var topProducts = Object.keys(productMap).map(function(k) {\n' +
'        return productMap[k];\n' +
'      }).sort(function(a, b) {\n' +
'        if (b.omzet !== a.omzet) return b.omzet - a.omzet;\n' +
'        return b.qty - a.qty;\n' +
'      }).slice(0, 6);\n' +
'\n' +
'      renderTopProducts(topProducts, periodOmzet);\n' +
'      renderStoreCards(periodStoreSummary);\n' +
'      renderTrendChart(periodDailySummary);\n' +
'      renderDistChart(periodStoreSummary);\n' +
'      renderOrdersTable(currentActiveOrders);\n' +
'      renderTodayCard();\n' +
'    }\n' +
'\n' +
'    // Live Refresh without iframe reload white blank screen\n' +
'    function refreshDashboardLive() {\n' +
'      var icon = document.getElementById("btn-refresh-icon");\n' +
'      var btn = document.getElementById("btn-refresh");\n' +
'      if (icon) icon.classList.add("fa-spin");\n' +
'      if (btn) btn.disabled = true;\n' +
'      showToast("⏳ Memperbarui data langsung dari Google Sheets...");\n' +
'\n' +
'      function onRefreshSuccess(freshData) {\n' +
'        if (icon) icon.classList.remove("fa-spin");\n' +
'        if (btn) btn.disabled = false;\n' +
'        if (!freshData || freshData.status === "error") {\n' +
'          alert("Gagal memuat data: " + (freshData ? freshData.message : "Tidak ada data"));\n' +
'          return;\n' +
'        }\n' +
'        rawData = freshData;\n' +
'        initStoreSelect();\n' +
'        initPeriodSelector();\n' +
'        renderMonthlyRecapTable();\n' +
'        applyActivePeriodData();\n' +
'        showToast("✅ Data dashboard berhasil disinkronkan!");\n' +
'      }\n' +
'\n' +
'      function onRefreshError(err) {\n' +
'        if (icon) icon.classList.remove("fa-spin");\n' +
'        if (btn) btn.disabled = false;\n' +
'        alert("Gagal refresh data: " + (err.message || err));\n' +
'      }\n' +
'\n' +
'      if (typeof google !== "undefined" && google.script && google.script.run) {\n' +
'        google.script.run\n' +
'          .withSuccessHandler(onRefreshSuccess)\n' +
'          .withFailureHandler(onRefreshError)\n' +
'          .getDashboardData();\n' +
'      } else {\n' +
'        fetch(window.location.href, {\n' +
'          method: "POST",\n' +
'          headers: { "Content-Type": "application/json" },\n' +
'          body: JSON.stringify({ action: "get_data" })\n' +
'        })\n' +
'        .then(function(r) { return r.json(); })\n' +
'        .then(onRefreshSuccess)\n' +
'        .catch(onRefreshError);\n' +
'      }\n' +
'    }\n' +
'\n' +
'    // Modal Input Order Manual Functions\n' +
'    function openNewOrderModal() {\n' +
'      var now = new Date();\n' +
'      var yr = now.getFullYear();\n' +
'      var mo = String(now.getMonth() + 1).padStart(2, "0");\n' +
'      var dy = String(now.getDate()).padStart(2, "0");\n' +
'      var hr = String(now.getHours()).padStart(2, "0");\n' +
'      var mn = String(now.getMinutes()).padStart(2, "0");\n' +
'\n' +
'      var dateInput = document.getElementById("new-order-date");\n' +
'      if (dateInput) dateInput.value = yr + "-" + mo + "-" + dy;\n' +
'      var timeInput = document.getElementById("new-order-time");\n' +
'      if (timeInput) timeInput.value = hr + ":" + mn;\n' +
'\n' +
'      var recInput = document.getElementById("new-order-recipient");\n' +
'      if (recInput) recInput.value = "";\n' +
'      var phoneInput = document.getElementById("new-order-phone");\n' +
'      if (phoneInput) phoneInput.value = "";\n' +
'      var resiInput = document.getElementById("new-order-resi");\n' +
'      if (resiInput) resiInput.value = "";\n' +
'      var priceInput = document.getElementById("new-order-total");\n' +
'      if (priceInput) priceInput.value = "";\n' +
'      var notesInput = document.getElementById("new-order-notes");\n' +
'      if (notesInput) notesInput.value = "Input Manual Web Dashboard";\n' +
'\n' +
'      var m = document.getElementById("new-order-modal");\n' +
'      if (m) m.style.display = "flex";\n' +
'      setTimeout(function() {\n' +
'        if (recInput) recInput.focus();\n' +
'      }, 100);\n' +
'    }\n' +
'\n' +
'    function closeNewOrderModal() {\n' +
'      var m = document.getElementById("new-order-modal");\n' +
'      if (m) m.style.display = "none";\n' +
'    }\n' +
'\n' +
'    function submitNewOrderModal() {\n' +
'      var dateVal = (document.getElementById("new-order-date").value || "").trim();\n' +
'      var timeVal = (document.getElementById("new-order-time").value || "").trim();\n' +
'      var storeVal = document.getElementById("new-order-store").value;\n' +
'      var expeditionVal = (document.getElementById("new-order-expedition").value || "J&T").trim();\n' +
'      var recipientVal = (document.getElementById("new-order-recipient").value || "").trim();\n' +
'      var phoneVal = (document.getElementById("new-order-phone").value || "").trim();\n' +
'      var resiVal = (document.getElementById("new-order-resi").value || "").trim();\n' +
'      var productVal = (document.getElementById("new-order-product").value || "-").trim();\n' +
'      var qtyVal = parseInt(document.getElementById("new-order-qty").value, 10) || 1;\n' +
'      var totalVal = parseClientPrice(document.getElementById("new-order-total").value);\n' +
'      var statusVal = document.getElementById("new-order-status").value;\n' +
'      var notesVal = (document.getElementById("new-order-notes").value || "").trim();\n' +
'\n' +
'      if (!recipientVal) {\n' +
'        alert("Silakan isi nama penerima / pembeli!");\n' +
'        document.getElementById("new-order-recipient").focus();\n' +
'        return;\n' +
'      }\n' +
'      if (isNaN(totalVal) || totalVal < 0) {\n' +
'        alert("Silakan isi nominal total harga yang valid (contoh: 395000)!");\n' +
'        document.getElementById("new-order-total").focus();\n' +
'        return;\n' +
'      }\n' +
'\n' +
'      var btn = document.getElementById("btn-submit-new-order");\n' +
'      btn.disabled = true;\n' +
'      btn.innerHTML = "<i class=\'fa-solid fa-spinner animate-spin mr-1.5\'></i> Menyimpan...";\n' +
'\n' +
'      var payload = {\n' +
'        action: "create_manual_order",\n' +
'        tanggal: dateVal,\n' +
'        jam: timeVal,\n' +
'        toko: storeVal,\n' +
'        expedition: expeditionVal,\n' +
'        recipient: recipientVal,\n' +
'        phone: phoneVal,\n' +
'        resi: resiVal,\n' +
'        product: productVal,\n' +
'        qty: qtyVal,\n' +
'        total: totalVal,\n' +
'        status: statusVal,\n' +
'        notes: notesVal\n' +
'      };\n' +
'\n' +
'      function handleCreateSuccess(res) {\n' +
'        btn.disabled = false;\n' +
'        btn.innerHTML = "<i class=\'fa-solid fa-cloud-arrow-up mr-1.5\'></i> Simpan Order Baru";\n' +
'        closeNewOrderModal();\n' +
'        showToast("✅ Order manual berhasil dicatat ke Google Sheets!");\n' +
'\n' +
'        var newOrderObj = (res && res.order) ? res.order : {\n' +
'          tanggal: dateVal,\n' +
'          jam: timeVal,\n' +
'          resi: resiVal || ("MAN-" + Math.floor(100000 + Math.random() * 900000)),\n' +
'          toko: storeVal,\n' +
'          penerima: recipientVal,\n' +
'          phone: phoneVal,\n' +
'          ekspedisi: expeditionVal,\n' +
'          sku: "-",\n' +
'          produk: productVal,\n' +
'          qty: qtyVal,\n' +
'          unitPrice: Math.round(totalVal / qtyVal),\n' +
'          total: totalVal,\n' +
'          statusHarga: (totalVal > 0) ? "HARGA OK" : "⚠️ PERLU INPUT HARGA",\n' +
'          statusPesanan: statusVal,\n' +
'          isRetur: (statusVal === "RETUR")\n' +
'        };\n' +
'\n' +
'        if (!rawData.allOrders) rawData.allOrders = [];\n' +
'        rawData.allOrders.unshift(newOrderObj);\n' +
'        if (!rawData.recentOrders) rawData.recentOrders = [];\n' +
'        rawData.recentOrders.unshift(newOrderObj);\n' +
'\n' +
'        if (rawData.allStores && rawData.allStores.indexOf(storeVal) === -1) {\n' +
'          rawData.allStores.push(storeVal);\n' +
'          initStoreSelect();\n' +
'        }\n' +
'\n' +
'        applyActivePeriodData();\n' +
'      }\n' +
'\n' +
'      if (typeof google !== "undefined" && google.script && google.script.run) {\n' +
'        google.script.run\n' +
'          .withSuccessHandler(handleCreateSuccess)\n' +
'          .withFailureHandler(function(err) {\n' +
'            btn.disabled = false;\n' +
'            btn.innerHTML = "<i class=\'fa-solid fa-cloud-arrow-up mr-1.5\'></i> Simpan Order Baru";\n' +
'            alert("Gagal simpan order: " + (err.message || err));\n' +
'          })\n' +
'          .createManualOrder(payload);\n' +
'      } else {\n' +
'        fetch(window.location.href, {\n' +
'          method: "POST",\n' +
'          headers: { "Content-Type": "application/json" },\n' +
'          body: JSON.stringify(payload)\n' +
'        })\n' +
'        .then(function(r) { return r.json(); })\n' +
'        .then(handleCreateSuccess)\n' +
'        .catch(function(err) {\n' +
'          btn.disabled = false;\n' +
'          btn.innerHTML = "<i class=\'fa-solid fa-cloud-arrow-up mr-1.5\'></i> Simpan Order Baru";\n' +
'          alert("Gagal koneksi: " + (err.message || err));\n' +
'        });\n' +
'      }\n' +
'    }\n' +
'\n' +
'    function filterUnpricedOnly() {\n' +
'      setStatusFilter("UNPRICED");\n' +
'      var tableEl = document.getElementById("orders-table-body");\n' +
'      if (tableEl) tableEl.scrollIntoView({ behavior: "smooth" });\n' +
'\n' +
'      var firstUnpriced = (currentActiveOrders || rawData.allOrders || rawData.recentOrders || []).find(function(o) {\n' +
'        return o.total === 0 || o.statusHarga.indexOf("PERLU") !== -1;\n' +
'      });\n' +
'      if (firstUnpriced) {\n' +
'        setTimeout(function() {\n' +
'          openPriceModal(firstUnpriced.resi, firstUnpriced.penerima, firstUnpriced.toko, firstUnpriced.produk, firstUnpriced.qty, firstUnpriced.total, firstUnpriced.statusPesanan);\n' +
'        }, 200);\n' +
'      }\n' +
'    }\n' +
'\n' +
'    // Render Top Selling Products Widget\n' +
'    function renderTopProducts(products, totalPeriodOmzet) {\n' +
'      var container = document.getElementById("top-products-grid");\n' +
'      var badgeCount = document.getElementById("top-products-count-badge");\n' +
'      if (!container) return;\n' +
'      container.innerHTML = "";\n' +
'\n' +
'      if (!products || products.length === 0) {\n' +
'        container.innerHTML = "<div class=\'col-span-full p-6 text-center text-slate-500 text-xs bg-slate-900/40 rounded-2xl border border-slate-800/80\'>" +\n' +
'          "<i class=\'fa-solid fa-box-open text-2xl text-slate-600 mb-2 block\'></i>" +\n' +
'          "Belum ada data penjualan produk untuk periode ini." +\n' +
'        "</div>";\n' +
'        if (badgeCount) badgeCount.textContent = "0 Produk";\n' +
'        return;\n' +
'      }\n' +
'\n' +
'      if (badgeCount) badgeCount.textContent = "Menampilkan Top " + products.length + " Produk";\n' +
'\n' +
'      products.forEach(function(item, idx) {\n' +
'        var rank = idx + 1;\n' +
'        var rankBadgeColor = "";\n' +
'        var rankIcon = "";\n' +
'        var cardBorder = "border-slate-800";\n' +
'\n' +
'        if (rank === 1) {\n' +
'          rankBadgeColor = "bg-amber-500/20 text-amber-300 border-amber-500/40";\n' +
'          rankIcon = "<i class=\'fa-solid fa-crown text-amber-400 mr-1\'></i>";\n' +
'          cardBorder = "border-amber-500/30 bg-gradient-to-br from-amber-950/20 to-slate-900/60";\n' +
'        } else if (rank === 2) {\n' +
'          rankBadgeColor = "bg-slate-400/20 text-slate-200 border-slate-400/40";\n' +
'          rankIcon = "<i class=\'fa-solid fa-medal text-slate-300 mr-1\'></i>";\n' +
'        } else if (rank === 3) {\n' +
'          rankBadgeColor = "bg-orange-700/20 text-orange-300 border-orange-600/40";\n' +
'          rankIcon = "<i class=\'fa-solid fa-award text-orange-400 mr-1\'></i>";\n' +
'        } else {\n' +
'          rankBadgeColor = "bg-indigo-500/15 text-indigo-300 border-indigo-500/25";\n' +
'          rankIcon = "<span class=\'font-mono font-bold mr-1\'>#" + rank + "</span>";\n' +
'        }\n' +
'\n' +
'        var isFertipro = item.toko.toLowerCase().indexOf("fertipro") !== -1;\n' +
'        var isYosa = item.toko.toLowerCase().indexOf("yosa") !== -1;\n' +
'        var storeBadgeColor = isFertipro ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" :\n' +
'                              (isYosa ? "bg-amber-500/15 text-amber-300 border-amber-500/30" : "bg-indigo-500/15 text-indigo-300 border-indigo-500/30");\n' +
'\n' +
'        var pct = (totalPeriodOmzet > 0) ? Math.min(100, Math.round((item.omzet / totalPeriodOmzet) * 100)) : 0;\n' +
'\n' +
'        var card = document.createElement("div");\n' +
'        card.className = "btn-touch glass-card glass-card-hover p-3.5 rounded-2xl cursor-pointer transition relative group border " + cardBorder;\n' +
'        card.title = "Klik untuk menyaring riwayat transaksi produk ini";\n' +
'        card.onclick = function() {\n' +
'          var searchInput = document.getElementById("order-search");\n' +
'          if (searchInput) {\n' +
'            searchInput.value = item.name;\n' +
'            applyFilters();\n' +
'            var tableEl = document.getElementById("orders-table-body");\n' +
'            if (tableEl) tableEl.scrollIntoView({ behavior: "smooth" });\n' +
'            showToast("🔍 Memfilter transaksi untuk: " + item.name);\n' +
'          }\n' +
'        };\n' +
'\n' +
'        card.innerHTML = \n' +
'          "<div class=\'flex items-start justify-between gap-2 mb-2\'>" +\n' +
'            "<div class=\'flex items-center space-x-2 min-w-0\'>" +\n' +
'              "<span class=\'text-[10px] px-2 py-0.5 rounded-lg font-black border flex items-center " + rankBadgeColor + "\'>" +\n' +
'                rankIcon + " Juara " + rank +\n' +
'              "</span>" +\n' +
'              "<span class=\'text-[10px] px-2 py-0.5 rounded-md font-medium border " + storeBadgeColor + " truncate\'>" +\n' +
'                item.toko +\n' +
'              "</span>" +\n' +
'            "</div>" +\n' +
'            "<span class=\'text-xs font-black text-indigo-300 whitespace-nowrap\'>" + formatRupiah(item.omzet) + "</span>" +\n' +
'          "</div>" +\n' +
'          "<div class=\'font-bold text-slate-100 text-xs sm:text-sm line-clamp-1 group-hover:text-indigo-300 transition\' title=\'" + item.name.replace(/\'/g, "") + "\'>" +\n' +
'            item.name +\n' +
'          "</div>" +\n' +
'          "<div class=\'flex items-center justify-between text-[11px] text-slate-400 mt-2\'>" +\n' +
'            "<span><i class=\'fa-solid fa-box-open text-indigo-400 mr-1\'></i><b>" + item.qty + "</b> paket (" + item.count + " order)</span>" +\n' +
'            "<span class=\'text-[10px] text-slate-500 font-mono\'>SKU: " + item.sku + "</span>" +\n' +
'          "</div>" +\n' +
'          "<div class=\'w-full bg-slate-800/80 rounded-full h-1.5 overflow-hidden mt-2.5 border border-slate-700/50\'>" +\n' +
'            "<div class=\'bg-gradient-to-r from-amber-500 to-indigo-500 h-1.5 rounded-full transition-all duration-500\' style=\'width: " + Math.max(5, pct) + "%\'></div>" +\n' +
'          "</div>" +\n' +
'          "<div class=\'flex justify-between items-center text-[10px] text-slate-500 mt-1\'>" +\n' +
'            "<span>Porsi Omzet Periode</span>" +\n' +
'            "<span class=\'font-bold text-indigo-400\'>" + pct + "%</span>" +\n' +
'          "</div>";\n' +
'\n' +
'        container.appendChild(card);\n' +
'      });\n' +
'    }\n' +
'\n' +
'    // Render dynamic store cards grid\n' +
'    function renderStoreCards(customSummary) {\n' +
'      if (customSummary) currentActiveStoreSummary = customSummary;\n' +
'      var summaryToUse = currentActiveStoreSummary || rawData.storeSummary || {};\n' +
'      var container = document.getElementById("store-cards-grid");\n' +
'      if (!container) return;\n' +
'      container.innerHTML = "";\n' +
'\n' +
'      (rawData.allStores || []).forEach(function(s) {\n' +
'        var d = summaryToUse[s] || { count: 0, omzet: 0, unpriced: 0, retur: 0 };\n' +
'        var isFertipro = s.toLowerCase().indexOf("fertipro") !== -1;\n' +
'        var isYosa = s.toLowerCase().indexOf("yosa") !== -1;\n' +
'        var isSelected = currentStoreFilter.toLowerCase() === s.toLowerCase();\n' +
'\n' +
'        var card = document.createElement("div");\n' +
'        card.className = "btn-touch glass-card glass-card-hover p-3.5 sm:p-4 rounded-2xl cursor-pointer transition relative group select-none " +\n' +
'                         (isSelected ? "ring-2 ring-indigo-500 bg-slate-800/90" : "");\n' +
'        card.onclick = function() {\n' +
'          if (currentStoreFilter.toLowerCase() === s.toLowerCase()) {\n' +
'            onSelectStore("ALL");\n' +
'          } else {\n' +
'            onSelectStore(s);\n' +
'          }\n' +
'        };\n' +
'\n' +
'        var badgeColor = isFertipro ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" :\n' +
'                         (isYosa ? "bg-amber-500/20 text-amber-300 border-amber-500/30" :\n' +
'                         "bg-indigo-500/20 text-indigo-300 border-indigo-500/30");\n' +
'\n' +
'        var icon = isFertipro ? "fa-seedling text-emerald-400" : (isYosa ? "fa-leaf text-amber-400" : "fa-shop text-indigo-400");\n' +
'        var aovVal = d.count > 0 ? Math.round(d.omzet / d.count) : 0;\n' +
'\n' +
'        card.innerHTML = \n' +
'          "<div class=\'flex items-center justify-between mb-2\'>" +\n' +
'            "<div class=\'flex items-center space-x-2\'>" +\n' +
'              "<div class=\'w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center text-xs border border-slate-700\'>" +\n' +
'                "<i class=\'fa-solid " + icon + "\'></i>" +\n' +
'              "</div>" +\n' +
'              "<div>" +\n' +
'                "<h4 class=\'font-bold text-slate-100 text-xs sm:text-sm\'>" + s + "</h4>" +\n' +
'                "<span class=\'text-[10px] text-slate-400\'>" + d.count + " paket</span>" +\n' +
'              "</div>" +\n' +
'            "</div>" +\n' +
'            "<span class=\'text-[10px] px-2 py-0.5 rounded-full font-bold border " + badgeColor + "\'>" +\n' +
'              (isSelected ? "AKTIF" : "FILTER") +\n' +
'            "</span>" +\n' +
'          "</div>" +\n' +
'          "<div class=\'text-base sm:text-lg font-black text-white mt-2\'>" + formatRupiah(d.omzet) + "</div>" +\n' +
'          "<div class=\'flex items-center justify-between text-[10px] text-slate-400 mt-2 pt-2 border-t border-slate-800/80\'>" +\n' +
'            "<span>Rata-rata: " + formatRupiah(aovVal) + "</span>" +\n' +
'            (d.unpriced > 0 ? "<span class=\'text-amber-400 font-bold\'>⚠️ " + d.unpriced + " butuh harga</span>" : "<span class=\'text-emerald-400\'>✓ Lengkap</span>") +\n' +
'          "</div>";\n' +
'\n' +
'        container.appendChild(card);\n' +
'      });\n' +
'    }\n' +
'\n' +
'    function onSelectStore(storeName) {\n' +
'      currentStoreFilter = storeName;\n' +
'      var sel = document.getElementById("store-filter");\n' +
'      if (sel) sel.value = storeName;\n' +
'      var ind = document.getElementById("active-store-indicator");\n' +
'      if (ind) {\n' +
'        if (storeName === "ALL") {\n' +
'          ind.textContent = "Semua Toko Ditampilkan";\n' +
'          ind.className = "text-[11px] text-indigo-300 font-medium bg-indigo-500/10 px-2.5 py-0.5 rounded-full border border-indigo-500/20 self-start sm:self-auto";\n' +
'        } else {\n' +
'          ind.textContent = "Filter Aktif: " + storeName;\n' +
'          ind.className = "text-[11px] text-emerald-300 font-bold bg-emerald-500/20 px-2.5 py-0.5 rounded-full border border-emerald-500/30 self-start sm:self-auto";\n' +
'        }\n' +
'      }\n' +
'      renderStoreCards();\n' +
'      renderTodayCard();\n' +
'      applyFilters();\n' +
'    }\n' +
'\n' +
'    function setStatusFilter(filter) {\n' +
'      currentStatusFilter = filter;\n' +
'      var btnA = document.getElementById("tab-all");\n' +
'      var btnT = document.getElementById("tab-terkirim");\n' +
'      var btnR = document.getElementById("tab-retur");\n' +
'      var btnU = document.getElementById("tab-unpriced");\n' +
'\n' +
'      if (btnA) btnA.className = "btn-touch filter-tab px-3 py-1.5 rounded-lg text-xs font-semibold " + (filter === "ALL" ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700") + " transition cursor-pointer";\n' +
'      if (btnT) btnT.className = "btn-touch filter-tab px-3 py-1.5 rounded-lg text-xs font-semibold " + (filter === "TERKIRIM" ? "bg-emerald-600 text-white" : "bg-slate-800 text-emerald-300 hover:bg-slate-700") + " transition flex items-center cursor-pointer";\n' +
'      if (btnR) btnR.className = "btn-touch filter-tab px-3 py-1.5 rounded-lg text-xs font-semibold " + (filter === "RETUR" ? "bg-rose-600 text-white" : "bg-slate-800 text-rose-300 hover:bg-slate-700") + " transition flex items-center cursor-pointer";\n' +
'      if (btnU) btnU.className = "btn-touch filter-tab px-3 py-1.5 rounded-lg text-xs font-semibold " + (filter === "UNPRICED" ? "bg-amber-600 text-white" : "bg-slate-800 text-amber-300 hover:bg-slate-700") + " transition flex items-center cursor-pointer";\n' +
'\n' +
'      applyFilters();\n' +
'    }\n' +
'\n' +
'    // --- VISUAL CHARTS (TREND & STORE DISTRIBUTION) --- \n' +
'    function renderTrendChart(customDaily) {\n' +
'      if (customDaily) currentActiveDaily = customDaily;\n' +
'      var dailyToUse = currentActiveDaily || rawData.dailySummary || {};\n' +
'      var ctx = document.getElementById("trendChart");\n' +
'      if (!ctx) return;\n' +
'\n' +
'      if (trendChartInstance) {\n' +
'        trendChartInstance.destroy();\n' +
'      }\n' +
'\n' +
'      var dates = Object.keys(dailyToUse).sort();\n' +
'      var labels = [];\n' +
'      var values = [];\n' +
'\n' +
'      dates.forEach(function(d) {\n' +
'        var dayData = dailyToUse[d] || {};\n' +
'        var cleanDate = d;\n' +
'        var p = d.split("-");\n' +
'        if (p.length === 3) {\n' +
'          var monNames = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agt", "Sep", "Okt", "Nov", "Des"];\n' +
'          var mIdx = parseInt(p[1], 10) - 1;\n' +
'          cleanDate = p[2] + " " + (monNames[mIdx] || p[1]);\n' +
'        } else if (cleanDate.length > 15) {\n' +
'          var parts = cleanDate.split(" ");\n' +
'          if (parts.length >= 3) cleanDate = parts[1] + " " + parts[2];\n' +
'        }\n' +
'        labels.push(cleanDate);\n' +
'        values.push(currentTrendMetric === "omzet" ? (dayData.omzet || 0) : (dayData.count || 0));\n' +
'      });\n' +
'\n' +
'      trendChartInstance = new Chart(ctx, {\n' +
'        type: "line",\n' +
'        data: {\n' +
'          labels: labels,\n' +
'          datasets: [{\n' +
'            label: currentTrendMetric === "omzet" ? "Omzet Penjualan (Rp)" : "Volume Paket",\n' +
'            data: values,\n' +
'            borderColor: "#6366F1",\n' +
'            backgroundColor: "rgba(99, 102, 241, 0.12)",\n' +
'            fill: true,\n' +
'            tension: 0.35,\n' +
'            borderWidth: 2.5,\n' +
'            pointBackgroundColor: "#818CF8",\n' +
'            pointRadius: 4,\n' +
'            pointHoverRadius: 6\n' +
'          }]\n' +
'        },\n' +
'        options: {\n' +
'          responsive: true,\n' +
'          maintainAspectRatio: false,\n' +
'          plugins: {\n' +
'            legend: { display: false },\n' +
'            tooltip: {\n' +
'              backgroundColor: "#1E293B",\n' +
'              titleColor: "#F8FAFC",\n' +
'              bodyColor: "#E2E8F0",\n' +
'              borderColor: "#475569",\n' +
'              borderWidth: 1,\n' +
'              padding: 10,\n' +
'              callbacks: {\n' +
'                label: function(c) {\n' +
'                  return currentTrendMetric === "omzet" ? " " + formatRupiah(c.raw) : " " + c.raw + " Paket";\n' +
'                }\n' +
'              }\n' +
'            }\n' +
'          },\n' +
'          scales: {\n' +
'            x: {\n' +
'              grid: { color: "rgba(255, 255, 255, 0.04)" },\n' +
'              ticks: { color: "#94A3B8", font: { size: 10 } }\n' +
'            },\n' +
'            y: {\n' +
'              grid: { color: "rgba(255, 255, 255, 0.05)" },\n' +
'              ticks: {\n' +
'                color: "#94A3B8",\n' +
'                font: { size: 10 },\n' +
'                callback: function(v) {\n' +
'                  if (currentTrendMetric === "omzet") {\n' +
'                    if (v >= 1000000) return (v / 1000000).toFixed(1) + " Jt";\n' +
'                    if (v >= 1000) return (v / 1000).toFixed(0) + " Rb";\n' +
'                    return v;\n' +
'                  }\n' +
'                  return v;\n' +
'                }\n' +
'              }\n' +
'            }\n' +
'          }\n' +
'        }\n' +
'      });\n' +
'    }\n' +
'\n' +
'    function renderDistChart(customSummary) {\n' +
'      var summaryToUse = customSummary || currentActiveStoreSummary || rawData.storeSummary || {};\n' +
'      var ctx = document.getElementById("distChart");\n' +
'      if (!ctx) return;\n' +
'\n' +
'      if (distChartInstance) {\n' +
'        distChartInstance.destroy();\n' +
'      }\n' +
'\n' +
'      var chartLabels = [];\n' +
'      var chartData = [];\n' +
'      var chartColors = [];\n' +
'      var palette = ["#10B981", "#F59E0B", "#6366F1", "#06B6D4", "#A855F7", "#EC4899", "#3B82F6"];\n' +
'      var stores = rawData.allStores || [];\n' +
'\n' +
'      stores.forEach(function(s, idx) {\n' +
'        var sd = summaryToUse[s] || { omzet: 0, count: 0 };\n' +
'        var val = currentDistMetric === "omzet" ? (sd.omzet || 0) : (sd.count || 0);\n' +
'        if (val > 0) {\n' +
'          chartLabels.push(s);\n' +
'          chartData.push(val);\n' +
'          chartColors.push(palette[idx % palette.length]);\n' +
'        }\n' +
'      });\n' +
'\n' +
'      distChartInstance = new Chart(ctx, {\n' +
'        type: "doughnut",\n' +
'        data: {\n' +
'          labels: chartLabels,\n' +
'          datasets: [{\n' +
'            data: chartData,\n' +
'            backgroundColor: chartColors,\n' +
'            borderColor: "#0B1120",\n' +
'            borderWidth: 2,\n' +
'            hoverOffset: 5\n' +
'          }]\n' +
'        },\n' +
'        options: {\n' +
'          responsive: true,\n' +
'          maintainAspectRatio: false,\n' +
'          plugins: {\n' +
'            legend: {\n' +
'              position: "bottom",\n' +
'              labels: { color: "#CBD5E1", font: { size: 10 }, padding: 10 }\n' +
'            },\n' +
'            tooltip: {\n' +
'              backgroundColor: "#1E293B",\n' +
'              titleColor: "#F8FAFC",\n' +
'              bodyColor: "#E2E8F0",\n' +
'              borderColor: "#475569",\n' +
'              borderWidth: 1,\n' +
'              padding: 8,\n' +
'              callbacks: {\n' +
'                label: function(c) {\n' +
'                  var sum = c.dataset.data.reduce(function(a, b) { return a + b; }, 0);\n' +
'                  var val = c.raw;\n' +
'                  var pct = sum > 0 ? Math.round((val / sum) * 100) : 0;\n' +
'                  var valStr = currentDistMetric === "omzet" ? formatRupiah(val) : (val + " Paket");\n' +
'                  return " " + c.label + ": " + valStr + " (" + pct + "%)";\n' +
'                }\n' +
'              }\n' +
'            }\n' +
'          },\n' +
'          cutout: "66%"\n' +
'        }\n' +
'      });\n' +
'    }\n' +
'\n' +
'    function setTrendMetric(metric) {\n' +
'      currentTrendMetric = metric;\n' +
'      var btnO = document.getElementById("metric-btn-omzet");\n' +
'      var btnC = document.getElementById("metric-btn-count");\n' +
'      if (metric === "omzet") {\n' +
'        btnO.className = "btn-touch px-2.5 py-1 text-xs font-semibold rounded-lg bg-indigo-600 text-white transition shadow-sm cursor-pointer";\n' +
'        btnC.className = "btn-touch px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-400 hover:text-white transition cursor-pointer";\n' +
'      } else {\n' +
'        btnC.className = "btn-touch px-2.5 py-1 text-xs font-semibold rounded-lg bg-indigo-600 text-white transition shadow-sm cursor-pointer";\n' +
'        btnO.className = "btn-touch px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-400 hover:text-white transition cursor-pointer";\n' +
'      }\n' +
'      renderTrendChart();\n' +
'    }\n' +
'\n' +
'    function setDistMode(metric) {\n' +
'      currentDistMetric = metric;\n' +
'      var btnO = document.getElementById("dist-btn-omzet");\n' +
'      var btnC = document.getElementById("dist-btn-count");\n' +
'      if (metric === "omzet") {\n' +
'        btnO.className = "btn-touch px-2.5 py-1 text-xs font-semibold rounded-lg bg-indigo-600 text-white transition shadow-sm cursor-pointer";\n' +
'        btnC.className = "btn-touch px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-400 hover:text-white transition cursor-pointer";\n' +
'      } else {\n' +
'        btnC.className = "btn-touch px-2.5 py-1 text-xs font-semibold rounded-lg bg-indigo-600 text-white transition shadow-sm cursor-pointer";\n' +
'        btnO.className = "btn-touch px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-400 hover:text-white transition cursor-pointer";\n' +
'      }\n' +
'      renderDistChart();\n' +
'    }\n' +
'\n' +
'    // --- MODAL INPUT / UPDATE HARGA & STATUS --- \n' +
'    function openPriceModal(resi, recipient, toko, product, qty, currentPrice, currentStatus) {\n' +
'      currentModalTarget = { resi: resi, recipient: recipient, toko: toko, product: product, qty: qty, price: currentPrice, status: currentStatus };\n' +
'      document.getElementById("modal-resi-text").textContent = resi && resi !== "-" ? resi : "(Manual / Barcode)";\n' +
'      document.getElementById("modal-recipient-text").textContent = recipient || "-";\n' +
'      document.getElementById("modal-product-text").textContent = product || "-";\n' +
'      document.getElementById("modal-price-input").value = (currentPrice && currentPrice > 0) ? currentPrice : "";\n' +
'      if (toko) {\n' +
'        document.getElementById("modal-store-select").value = toko;\n' +
'      }\n' +
'      var statusSel = document.getElementById("modal-status-select");\n' +
'      if (statusSel) {\n' +
'        var curSt = currentStatus || "TERKIRIM";\n' +
'        var isRet = (curSt === "RETUR");\n' +
'        var opts = \'<option value="TERKIRIM"\' + (!isRet && curSt === "TERKIRIM" ? \' selected\' : \'\') + \'>✅ TERKIRIM (Masuk Omzet)</option>\';\n' +
'        if (!isRet && curSt !== "TERKIRIM") {\n' +
'          opts += \'<option value="\' + curSt.replace(/"/g, \'&quot;\') + \'" selected>📝 \' + curSt + \' (Masuk Omzet)</option>\';\n' +
'        }\n' +
'        opts += \'<option value="RETUR"\' + (isRet ? \' selected\' : \'\') + \'>🔄 RETUR (Batal / Bukan Omzet)</option>\';\n' +
'        statusSel.innerHTML = opts;\n' +
'      }\n' +
'      var m = document.getElementById("price-modal");\n' +
'      m.style.display = "flex";\n' +
'      setTimeout(function() {\n' +
'        var inp = document.getElementById("modal-price-input");\n' +
'        if (inp) inp.focus();\n' +
'      }, 100);\n' +
'    }\n' +
'\n' +
'    function closePriceModal() {\n' +
'      var m = document.getElementById("price-modal");\n' +
'      m.style.display = "none";\n' +
'      currentModalTarget = null;\n' +
'    }\n' +
'\n' +
'    // Close modal on background click\n' +
'    document.addEventListener("DOMContentLoaded", function() {\n' +
'      var modalBackdrop = document.getElementById("price-modal");\n' +
'      if (modalBackdrop) {\n' +
'        modalBackdrop.onclick = function(e) {\n' +
'          if (e.target === this) closePriceModal();\n' +
'        };\n' +
'      }\n' +
'      var newOrderBackdrop = document.getElementById("new-order-modal");\n' +
'      if (newOrderBackdrop) {\n' +
'        newOrderBackdrop.onclick = function(e) {\n' +
'          if (e.target === this) closeNewOrderModal();\n' +
'        };\n' +
'      }\n' +
'    });\n' +
'\n' +
'    function submitPriceModal() {\n' +
'      if (!currentModalTarget) return;\n' +
'      var priceInput = document.getElementById("modal-price-input");\n' +
'      var priceVal = parseClientPrice(priceInput.value);\n' +
'      if (isNaN(priceVal) || priceVal < 0) {\n' +
'        alert("Silakan masukkan nominal harga/omzet yang valid (contoh: 395000)!");\n' +
'        priceInput.focus();\n' +
'        return;\n' +
'      }\n' +
'      var selectedStore = document.getElementById("modal-store-select").value;\n' +
'      var statusSel = document.getElementById("modal-status-select");\n' +
'      var selectedStatus = statusSel ? statusSel.value : "TERKIRIM";\n' +
'\n' +
'      var saveBtn = document.getElementById("modal-save-btn");\n' +
'      saveBtn.disabled = true;\n' +
'      saveBtn.innerHTML = "<i class=\'fa-solid fa-spinner animate-spin mr-1.5\'></i> Menyimpan...";\n' +
'\n' +
'      var payload = {\n' +
'        action: "update_order",\n' +
'        resi: currentModalTarget.resi,\n' +
'        recipient: currentModalTarget.recipient,\n' +
'        price: priceVal,\n' +
'        toko: selectedStore,\n' +
'        status: selectedStatus\n' +
'      };\n' +
'\n' +
'      function handleSuccess(res) {\n' +
'        saveBtn.disabled = false;\n' +
'        saveBtn.innerHTML = "<i class=\'fa-solid fa-cloud-arrow-up mr-1.5\'></i> Simpan ke Spreadsheet";\n' +
'        closePriceModal();\n' +
'        showToast("✅ Berhasil menyimpan order (" + selectedStatus + ") ke Google Sheets!");\n' +
'\n' +
'        var targetNorm = (payload.recipient || "").toLowerCase().replace(/[^a-z0-9]/g, "");\n' +
'        var orderList = (rawData.allOrders && rawData.allOrders.length > 0) ? rawData.allOrders : (rawData.recentOrders || []);\n' +
'        orderList.forEach(function(o) {\n' +
'          var oNorm = (o.penerima || "").toLowerCase().replace(/[^a-z0-9]/g, "");\n' +
'          var isMatch = (payload.resi && payload.resi !== "-" && o.resi === payload.resi) ||\n' +
'                        (targetNorm && (oNorm === targetNorm || oNorm.indexOf(targetNorm) !== -1 || targetNorm.indexOf(oNorm) !== -1));\n' +
'          if (isMatch) {\n' +
'            o.total = priceVal;\n' +
'            o.unitPrice = Math.round(priceVal / (o.qty || 1));\n' +
'            o.toko = selectedStore;\n' +
'            o.statusPesanan = selectedStatus;\n' +
'            o.isRetur = (selectedStatus === "RETUR");\n' +
'            o.statusHarga = (priceVal > 0) ? "HARGA OK" : "⚠️ PERLU INPUT HARGA";\n' +
'          }\n' +
'        });\n' +
'\n' +
'        applyActivePeriodData();\n' +
'      }\n' +
'\n' +
'      if (typeof google !== "undefined" && google.script && google.script.run) {\n' +
'        google.script.run\n' +
'          .withSuccessHandler(handleSuccess)\n' +
'          .withFailureHandler(function(err) {\n' +
'            saveBtn.disabled = false;\n' +
'            saveBtn.innerHTML = "<i class=\'fa-solid fa-cloud-arrow-up mr-1.5\'></i> Simpan ke Spreadsheet";\n' +
'            alert("Gagal: " + (err.message || err));\n' +
'          })\n' +
'          .updateOrderPrice(payload);\n' +
'      } else {\n' +
'        fetch(window.location.href, {\n' +
'          method: "POST",\n' +
'          headers: { "Content-Type": "application/json" },\n' +
'          body: JSON.stringify(payload)\n' +
'        })\n' +
'        .then(function(r) { return r.json(); })\n' +
'        .then(handleSuccess)\n' +
'        .catch(function(err) {\n' +
'          saveBtn.disabled = false;\n' +
'          saveBtn.innerHTML = "<i class=\'fa-solid fa-cloud-arrow-up mr-1.5\'></i> Simpan ke Spreadsheet";\n' +
'          alert("Gagal koneksi: " + (err.message || err));\n' +
'        });\n' +
'      }\n' +
'    }\n' +
'\n' +
'    // --- QUICK 1-CLICK TOGGLE STATUS ANTARA TERKIRIM DAN RETUR --- \n' +
'    function quickToggleStatus(event, resi, recipient, currentStatus, currentPrice, toko) {\n' +
'      if (event) event.stopPropagation();\n' +
'      var isCurRetur = (currentStatus === "RETUR");\n' +
'      var targetStatus = isCurRetur ? "TERKIRIM" : "RETUR";\n' +
'      var confirmMsg = isCurRetur\n' +
'        ? "✅ Kembalikan status order ini menjadi TERKIRIM?\\n(Nominal omzet otomatis dihitung kembali ke omzet)"\n' +
'        : "⚠️ Ubah status order ini (" + currentStatus + ") menjadi RETUR?\\n(Nominal omzet otomatis dikeluarkan/tidak dihitung ke omzet)";\n' +
'\n' +
'      if (!confirm(confirmMsg)) return;\n' +
'\n' +
'      var payload = {\n' +
'        action: "update_order",\n' +
'        resi: resi,\n' +
'        recipient: recipient,\n' +
'        status: targetStatus,\n' +
'        price: currentPrice,\n' +
'        toko: toko\n' +
'      };\n' +
'\n' +
'      showToast("⏳ Mengubah status ke " + targetStatus + "...");\n' +
'\n' +
'      function handleQuickSuccess(res) {\n' +
'        showToast("✅ Status berhasil diubah menjadi " + targetStatus + "!");\n' +
'\n' +
'        var targetNorm = (payload.recipient || "").toLowerCase().replace(/[^a-z0-9]/g, "");\n' +
'        var orderList = (rawData.allOrders && rawData.allOrders.length > 0) ? rawData.allOrders : (rawData.recentOrders || []);\n' +
'        orderList.forEach(function(o) {\n' +
'          var oNorm = (o.penerima || "").toLowerCase().replace(/[^a-z0-9]/g, "");\n' +
'          var isMatch = (payload.resi && payload.resi !== "-" && o.resi === payload.resi) ||\n' +
'                        (targetNorm && (oNorm === targetNorm || oNorm.indexOf(targetNorm) !== -1 || targetNorm.indexOf(oNorm) !== -1));\n' +
'          if (isMatch) {\n' +
'            o.statusPesanan = targetStatus;\n' +
'            o.isRetur = (targetStatus === "RETUR");\n' +
'          }\n' +
'        });\n' +
'\n' +
'        applyActivePeriodData();\n' +
'      }\n' +
'\n' +
'      if (typeof google !== "undefined" && google.script && google.script.run) {\n' +
'        google.script.run\n' +
'          .withSuccessHandler(handleQuickSuccess)\n' +
'          .withFailureHandler(function(err) {\n' +
'            alert("Gagal ubah status: " + (err.message || err));\n' +
'          })\n' +
'          .updateOrderPrice(payload);\n' +
'      } else {\n' +
'        fetch(window.location.href, {\n' +
'          method: "POST",\n' +
'          headers: { "Content-Type": "application/json" },\n' +
'          body: JSON.stringify(payload)\n' +
'        })\n' +
'        .then(function(r) { return r.json(); })\n' +
'        .then(handleQuickSuccess)\n' +
'        .catch(function(err) {\n' +
'          alert("Gagal koneksi: " + (err.message || err));\n' +
'        });\n' +
'      }\n' +
'    }\n' +
'\n' +
'    // Render orders stream table based on active filters\n' +
'    function renderOrdersTable(customList) {\n' +
'      if (customList) currentActiveOrders = customList;\n' +
'      var tbody = document.getElementById("orders-table-body");\n' +
'      var emptyState = document.getElementById("orders-empty-state");\n' +
'      var searchInput = (document.getElementById("order-search").value || "").toLowerCase().trim();\n' +
'      if (!tbody) return;\n' +
'      tbody.innerHTML = "";\n' +
'\n' +
'      var orders = (currentActiveOrders && currentActiveOrders.length > 0)\n' +
'        ? currentActiveOrders\n' +
'        : ((rawData.allOrders && rawData.allOrders.length > 0) ? rawData.allOrders : (rawData.recentOrders || []));\n' +
'      var matchCount = 0;\n' +
'\n' +
'      orders.forEach(function(o) {\n' +
'        // Store filter\n' +
'        if (currentStoreFilter !== "ALL" && o.toko.toLowerCase() !== currentStoreFilter.toLowerCase()) {\n' +
'          return;\n' +
'        }\n' +
'\n' +
'        // Status filter\n' +
'        var isUnpriced = (o.total === 0 || o.statusHarga.indexOf("PERLU") !== -1);\n' +
'        if (currentStatusFilter === "UNPRICED" && !isUnpriced) return;\n' +
'        if (currentStatusFilter === "TERKIRIM" && o.statusPesanan === "RETUR") return;\n' +
'        if (currentStatusFilter === "RETUR" && o.statusPesanan !== "RETUR") return;\n' +
'\n' +
'        // Search filter\n' +
'        if (searchInput) {\n' +
'          var combined = (o.resi + " " + o.penerima + " " + o.sku + " " + o.produk + " " + o.toko + " " + o.phone + " " + o.statusPesanan).toLowerCase();\n' +
'          if (combined.indexOf(searchInput) === -1) return;\n' +
'        }\n' +
'\n' +
'        matchCount++;\n' +
'        var tr = document.createElement("tr");\n' +
'        if (isUnpriced) {\n' +
'          tr.className = "bg-amber-950/25 hover:bg-amber-900/40 border-l-4 border-amber-500 transition cursor-pointer";\n' +
'          tr.title = "Klik baris ini untuk input harga / status";\n' +
'          tr.onclick = function() {\n' +
'            openPriceModal(o.resi, o.penerima, o.toko, o.produk, o.qty, o.total, o.statusPesanan);\n' +
'          };\n' +
'        } else if (o.statusPesanan === "RETUR") {\n' +
'          tr.className = "bg-rose-950/20 hover:bg-rose-900/30 border-l-4 border-rose-500/80 transition cursor-pointer";\n' +
'          tr.title = "Status: RETUR (Klik baris ini untuk edit harga / status)";\n' +
'          tr.onclick = function() {\n' +
'            openPriceModal(o.resi, o.penerima, o.toko, o.produk, o.qty, o.total, o.statusPesanan);\n' +
'          };\n' +
'        } else {\n' +
'          tr.className = "hover:bg-slate-800/60 transition cursor-pointer";\n' +
'          tr.title = "Klik baris ini untuk edit harga / status";\n' +
'          tr.onclick = function() {\n' +
'            openPriceModal(o.resi, o.penerima, o.toko, o.produk, o.qty, o.total, o.statusPesanan);\n' +
'          };\n' +
'        }\n' +
'\n' +
'        var tokoTagColor = (o.toko.toLowerCase().indexOf("fertipro") !== -1) ? "bg-emerald-500/20 text-emerald-300" :\n' +
'                           ((o.toko.toLowerCase().indexOf("yosa") !== -1) ? "bg-amber-500/20 text-amber-300" : "bg-indigo-500/20 text-indigo-300");\n' +
'\n' +
'        var cleanDateDisplay = o.tanggal;\n' +
'        var dateParts = (o.tanggal || "").split("-");\n' +
'        if (dateParts.length === 3) {\n' +
'          var monNames = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agt", "Sep", "Okt", "Nov", "Des"];\n' +
'          var mIdx = parseInt(dateParts[1], 10) - 1;\n' +
'          cleanDateDisplay = dateParts[2] + " " + (monNames[mIdx] || dateParts[1]) + " " + dateParts[0];\n' +
'        }\n' +
'\n' +
'        var tdTime = "<td class=\'px-3.5 py-2.5 whitespace-nowrap text-slate-400 text-[10px] sm:text-[11px]\'>" +\n' +
'          "<div class=\'font-medium text-slate-300\'>" + cleanDateDisplay + "</div>" +\n' +
'          "<div class=\'text-[10px] text-slate-500 font-mono\'>" + (o.jam && o.jam !== "-" ? o.jam + " WIB" : "-") + "</div>" +\n' +
'        "</td>";\n' +
'\n' +
'        var tdResi = "<td class=\'px-3.5 py-2.5 font-mono font-bold text-slate-200 text-[11px]\'>" +\n' +
'          "<div>" + (o.resi && o.resi !== "-" ? o.resi : "(Manual / Barcode)") + "</div>" +\n' +
'          "<div class=\'text-[10px] text-slate-500 font-sans font-normal\'>" + (o.ekspedisi || "-") + "</div>" +\n' +
'        "</td>";\n' +
'\n' +
'        var tdToko = "<td class=\'px-3.5 py-2.5 whitespace-nowrap\'>" +\n' +
'          "<span class=\'px-2 py-0.5 rounded text-[10px] font-bold " + tokoTagColor + "\'>" + o.toko + "</span>" +\n' +
'        "</td>";\n' +
'\n' +
'        var tdPenerima = "<td class=\'px-3.5 py-2.5\'>" +\n' +
'          "<div class=\'font-medium text-slate-200\'>" + o.penerima + "</div>" +\n' +
'          "<div class=\'text-[10px] text-slate-500 font-mono\'>" + o.phone + "</div>" +\n' +
'        "</td>";\n' +
'\n' +
'        var tdProduk = "<td class=\'px-3.5 py-2.5 max-w-[200px]\'>" +\n' +
'          "<div class=\'truncate text-slate-300 font-medium\' title=\'" + (o.produk || "").replace(/\'/g, "") + "\'>" + o.produk + "</div>" +\n' +
'          "<div class=\'text-[10px] font-mono text-slate-500\'>SKU: " + o.sku + "</div>" +\n' +
'        "</td>";\n' +
'\n' +
'        var tdQty = "<td class=\'px-3.5 py-2.5 text-center font-bold text-slate-200\'>" + o.qty + "</td>";\n' +
'\n' +
'        var tdTotal = "";\n' +
'        if (o.statusPesanan === "RETUR") {\n' +
'          tdTotal = "<td class=\'px-3.5 py-2.5 text-right font-bold text-slate-400 whitespace-nowrap\'>" +\n' +
'            "<span class=\'line-through text-slate-500 text-[11px] mr-1\'>" + formatRupiah(o.total) + "</span>" +\n' +
'            "<span class=\'text-rose-400 font-extrabold text-[10px] bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20\'>RETUR</span>" +\n' +
'          "</td>";\n' +
'        } else {\n' +
'          tdTotal = "<td class=\'px-3.5 py-2.5 text-right font-bold text-white whitespace-nowrap\'>" +\n' +
'            (isUnpriced ? "<span class=\'text-amber-400 font-mono\'>Rp 0</span>" : formatRupiah(o.total)) +\n' +
'          "</td>";\n' +
'        }\n' +
'\n' +
'        tr.innerHTML = tdTime + tdResi + tdToko + tdPenerima + tdProduk + tdQty + tdTotal;\n' +
'\n' +
'        var tdAction = document.createElement("td");\n' +
'        tdAction.className = "px-3.5 py-2.5 text-center whitespace-nowrap";\n' +
'\n' +
'        if (isUnpriced) {\n' +
'          var btn = document.createElement("button");\n' +
'          btn.type = "button";\n' +
'          btn.className = "btn-touch px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 active:scale-95 text-slate-950 font-bold text-[10px] sm:text-xs transition shadow-sm inline-flex items-center cursor-pointer";\n' +
'          btn.innerHTML = "<i class=\'fa-solid fa-pen-to-square mr-1\'></i> Input Harga";\n' +
'          btn.onclick = (function(orderItem) {\n' +
'            return function(e) {\n' +
'              e.stopPropagation();\n' +
'              openPriceModal(orderItem.resi, orderItem.penerima, orderItem.toko, orderItem.produk, orderItem.qty, orderItem.total, orderItem.statusPesanan);\n' +
'            };\n' +
'          })(o);\n' +
'          tdAction.appendChild(btn);\n' +
'        } else if (o.statusPesanan === "RETUR") {\n' +
'          var returBtn = document.createElement("button");\n' +
'          returBtn.type = "button";\n' +
'          returBtn.className = "btn-touch px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 font-bold text-[10px] sm:text-xs border border-rose-500/30 transition shadow-xs inline-flex items-center cursor-pointer";\n' +
'          returBtn.title = "Status: RETUR (Klik untuk ubah kembali ke Terkirim)";\n' +
'          returBtn.innerHTML = "<i class=\'fa-solid fa-rotate-left mr-1\'></i> RETUR <i class=\'fa-solid fa-arrows-rotate ml-1.5 text-[9px] opacity-70\'></i>";\n' +
'          returBtn.onclick = (function(orderItem) {\n' +
'            return function(e) {\n' +
'              e.stopPropagation();\n' +
'              quickToggleStatus(e, orderItem.resi, orderItem.penerima, orderItem.statusPesanan, orderItem.total, orderItem.toko);\n' +
'            };\n' +
'          })(o);\n' +
'          tdAction.appendChild(returBtn);\n' +
'        } else {\n' +
'          var terkirimBtn = document.createElement("button");\n' +
'          terkirimBtn.type = "button";\n' +
'          terkirimBtn.className = "btn-touch px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 font-bold text-[10px] sm:text-xs border border-emerald-500/30 transition shadow-xs inline-flex items-center cursor-pointer";\n' +
'          var statusLabel = o.statusPesanan || "TERKIRIM";\n' +
'          terkirimBtn.title = "Status: " + statusLabel + " (Masuk Omzet. Klik untuk ubah menjadi Retur)";\n' +
'          terkirimBtn.innerHTML = "<i class=\'fa-solid fa-circle-check text-[10px] mr-1\'></i> " + statusLabel + " <i class=\'fa-solid fa-arrows-rotate ml-1.5 text-[9px] opacity-70\'></i>";\n' +
'          terkirimBtn.onclick = (function(orderItem) {\n' +
'            return function(e) {\n' +
'              e.stopPropagation();\n' +
'              quickToggleStatus(e, orderItem.resi, orderItem.penerima, orderItem.statusPesanan, orderItem.total, orderItem.toko);\n' +
'            };\n' +
'          })(o);\n' +
'          tdAction.appendChild(terkirimBtn);\n' +
'        }\n' +
'        tr.appendChild(tdAction);\n' +
'        tbody.appendChild(tr);\n' +
'      });\n' +
'\n' +
'      document.getElementById("order-count-badge").textContent = "(" + matchCount + " Order)";\n' +
'      if (matchCount === 0) {\n' +
'        emptyState.classList.remove("hidden");\n' +
'      } else {\n' +
'        emptyState.classList.add("hidden");\n' +
'      }\n' +
'    }\n' +
'\n' +
'    function clearSearch() {\n' +
'      document.getElementById("order-search").value = "";\n' +
'      applyFilters();\n' +
'    }\n' +
'\n' +
'    function applyFilters() {\n' +
'      renderOrdersTable();\n' +
'    }\n' +
'\n' +
'    // Inisialisasi awal\n' +
'    initStoreSelect();\n' +
'    initPeriodSelector();\n' +
'    renderMonthlyRecapTable();\n' +
'    renderTodayCard();\n' +
'    applyActivePeriodData();\n' +
'  </script>\n' +
'</body>\n' +
'</html>';
}
