const fs = require('fs');
const path = require('path');
const vm = require('vm');

const codeGs = fs.readFileSync(path.join(__dirname, 'google_apps_script', 'Code.gs'), 'utf8');

// Mock Google Apps Script environment
const sandbox = {
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => null,
      insertSheet: (name) => {
        const rangeMock = {
          setValues: () => rangeMock,
          setBackground: () => rangeMock,
          setFontColor: () => rangeMock,
          setFontWeight: () => rangeMock,
          setHorizontalAlignment: () => rangeMock,
          setNumberFormat: () => rangeMock,
          setValue: () => rangeMock
        };
        return {
          getRange: () => rangeMock,
          appendRow: () => {},
          getLastRow: () => 0,
          setFrozenRows: () => {},
          setColumnWidth: () => {},
          getDataRange: () => ({
            getValues: () => [
              ["Batch Timestamp", "Tanggal", "Jam", "Batch ID", "No Resi", "Nama Toko", "Penerima", "No HP", "Ekspedisi", "SKU", "Nama Produk", "Qty", "Harga Satuan", "Total Omzet", "Metode", "Status Pesanan", "Sumber", "Status Validasi", "Catatan"],
              ["2026-10-15 10:00:00", "2026-10-15", "10:00:00", "BATCH-1", "JP12345", "Fertipro", "Pak Budi", "08123456", "J&T", "FP-01", "Paket 1 Hektar Fertipro", 1, 395000, 395000, "TRANSFER", "TERKIRIM", "CATALOG", "HARGA OK", ""],
              ["2026-10-15 11:00:00", "2026-10-15", "11:00:00", "BATCH-2", "JP67890", "Yosa Farm", "Pak Joko", "08567890", "J&T", "YS-01", "Bio Humat", 1, 150000, 150000, "TRANSFER", "RETUR", "CATALOG", "HARGA OK", ""],
              ["2026-09-20 14:00:00", "2026-09-20", "14:00:00", "BATCH-3", "JP99999", "Fertipro", "Pak Slamet", "08777777", "J&T", "FP-01", "Paket 1 Hektar Fertipro", 1, 395000, 395000, "TRANSFER", "TERKIRIM", "CATALOG", "HARGA OK", ""],
              ["2026-10-16 09:00:00", "2026-10-16", "09:00:00", "BATCH-TODAY", "JP88888", "Fertipro", "Pak Amir", "08199999", "J&T", "FP-01", "Paket 1 Hektar Fertipro", 1, 395000, 395000, "TRANSFER", "TERKIRIM", "CATALOG", "HARGA OK", ""]
            ]
          })
        };
      }
    })
  },
  Utilities: {
    formatDate: (d, tz, fmt) => {
      if (fmt === "yyyy-MM") return "2026-10";
      if (fmt === "yyyy-MM-dd") return "2026-10-16";
      if (fmt === "yyyy-MM-dd HH:mm:ss") return "2026-10-16 11:00:00";
      if (fmt === "HH:mm:ss") return "11:00:00";
      if (fmt === "yyyyMMdd-HHmmss") return "20261016-110000";
      return "2026-10-16";
    }
  },
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput: (s) => ({ setMimeType: () => s })
  },
  HtmlService: {
    XFrameOptionsMode: { ALLOWALL: "ALLOWALL" },
    createHtmlOutput: (html) => ({
      setTitle: () => ({
        setXFrameOptionsMode: () => ({
          addMetaTag: () => html
        })
      })
    })
  },
  console: console
};

vm.createContext(sandbox);
vm.runInContext(codeGs, sandbox);

console.log('Testing getDashboardData()...');
const dashData = sandbox.getDashboardData();
console.log('Total Orders:', dashData.totalOrders);
console.log('Total Omzet:', dashData.totalOmzet);
console.log('Monthly Recap count:', dashData.monthlyRecap ? dashData.monthlyRecap.length : 0);
console.log('Available Years:', dashData.availableYears);
console.log('Monthly Recap items:', JSON.stringify(dashData.monthlyRecap, null, 2));

if (!dashData.today) throw new Error('dashData.today is missing');
if (dashData.today.orders !== 1) throw new Error(`Expected today orders = 1, got ${dashData.today.orders}`);
if (dashData.today.omzet !== 395000) throw new Error(`Expected today omzet = 395000, got ${dashData.today.omzet}`);
console.log('✅ Today Data verified:', JSON.stringify(dashData.today));

console.log('\nTesting getDashboardHtml()...');
const htmlOutput = sandbox.getDashboardHtml();
console.log('Generated HTML output length:', htmlOutput.length);

if (!htmlOutput.includes('Orderan & Omzet Hari Ini')) throw new Error('Hero card title missing from HTML');
if (!htmlOutput.includes('id="today-omzet-val"')) throw new Error('Hero card omzet element missing from HTML');
if (!htmlOutput.includes('renderTodayCard')) throw new Error('renderTodayCard function missing from client script');
console.log('✅ Today Hero Card HTML & Client script verified in output!');

// Extract the client-side <script> from generated HTML to test client JS syntax
const scriptMatch = htmlOutput.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  const clientJs = scriptMatch[1];
  console.log('Client JS length:', clientJs.length);
  try {
    const clientVm = {
      window: { location: { href: 'http://localhost' } },
      document: {
        getElementById: () => ({
          style: {},
          classList: { add: () => {}, remove: () => {} },
          appendChild: () => {},
          value: '',
          textContent: '',
          innerHTML: ''
        }),
        createElement: () => ({
          style: {},
          classList: { add: () => {}, remove: () => {} },
          appendChild: () => {},
          onclick: null
        }),
        addEventListener: () => {}
      },
      Chart: function() { return { destroy: () => {} }; },
      alert: () => {},
      confirm: () => true,
      setTimeout: () => {},
      console: console
    };
    vm.createContext(clientVm);
    vm.runInContext(clientJs, clientVm);
    console.log('✅ Client JS parsed and executed with 0 errors!');
  } catch (err) {
    console.error('❌ Error executing client JS:', err);
    process.exit(1);
  }
} else {
  console.error('❌ Could not find <script> tag in HTML output');
  process.exit(1);
}

console.log('\nTesting createManualOrder()...');
const createRes = sandbox.createManualOrder({
  tanggal: "2026-10-16",
  jam: "11:15",
  toko: "Fertipro",
  recipient: "H. Abdullah",
  phone: "08123456789",
  product: "Paket 1 Hektar Fertipro",
  qty: 2,
  price: 790000,
  status: "TERKIRIM"
});
console.log('createManualOrder result:', JSON.stringify(createRes, null, 2));

console.log('\n🎉 ALL GAS & CLIENT DASHBOARD TESTS PASSED SUCCESSFULLY!');
