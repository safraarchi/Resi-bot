const fs = require('fs');
const path = require('path');
const vm = require('vm');

const codeGsPath = path.join(__dirname, '..', 'google_apps_script', 'Code.gs');
let code = fs.readFileSync(codeGsPath, 'utf8');

console.log('Original Code.gs length:', code.length);

// 1. Add HTML widget before '<!-- DYNAMIC STORE PERFORMANCE GRID -->'
const storeGridMarker = "'    <!-- DYNAMIC STORE PERFORMANCE GRID -->\\n' +";
if (!code.includes(storeGridMarker)) {
  console.error("Could not find storeGridMarker in Code.gs");
  process.exit(1);
}

const topProductsHtml = [
  "'    <!-- TOP SELLING PRODUCTS WIDGET -->\\n' +",
  "'    <section class=\"glass-card p-4 sm:p-5 rounded-2xl sm:rounded-3xl border border-slate-800 shadow-xl space-y-3.5\">\\n' +",
  "'      <div class=\"flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-800/80\">\\n' +",
  "'        <div class=\"flex items-center space-x-2.5\">\\n' +",
  "'          <div class=\"w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center text-sm shadow-sm\">\\n' +",
  "'            <i class=\"fa-solid fa-trophy\"></i>\\n' +",
  "'          </div>\\n' +",
  "'          <div>\\n' +",
  "'            <h3 class=\"text-sm sm:text-base font-bold text-white tracking-tight flex items-center\">\\n' +",
  "'              Produk Terlaris & Kontribusi Omzet\\n' +",
  "'              <span class=\"ml-2 text-[10px] font-bold text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20\">BEST SELLERS</span>\\n' +",
  "'            </h3>\\n' +",
  "'            <p class=\"text-[11px] text-slate-400\">Peringkat produk terlaris berdasarkan volume paket dan total omzet bersih pada periode terpilih</p>\\n' +",
  "'          </div>\\n' +",
  "'        </div>\\n' +",
  "'        <div class=\"text-[11px] text-slate-400 flex items-center gap-1.5 self-start sm:self-auto\">\\n' +",
  "'          <span class=\"text-slate-400\" id=\"top-products-count-badge\">Memuat produk...</span>\\n' +",
  "'        </div>\\n' +",
  "'      </div>\\n' +",
  "'\\n' +",
  "'      <div class=\"grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-3.5\" id=\"top-products-grid\">\\n' +",
  "'      </div>\\n' +",
  "'    </section>\\n' +",
  "'\\n' +"
].join('\n') + '\n';

code = code.replace(storeGridMarker, topProductsHtml + storeGridMarker);
console.log('Added HTML widget before store grid.');

// 2. Add renderTopProducts function in client script
const renderStoreCardsMarker = "'    // Render dynamic store cards grid\\n' +";
if (!code.includes(renderStoreCardsMarker)) {
  console.error("Could not find renderStoreCardsMarker in Code.gs");
  process.exit(1);
}

const renderTopProductsJs = [
  "'    // Render Top Selling Products Widget\\n' +",
  "'    function renderTopProducts(products, totalPeriodOmzet) {\\n' +",
  "'      var container = document.getElementById(\"top-products-grid\");\\n' +",
  "'      var badgeCount = document.getElementById(\"top-products-count-badge\");\\n' +",
  "'      if (!container) return;\\n' +",
  "'      container.innerHTML = \"\";\\n' +",
  "'\\n' +",
  "'      if (!products || products.length === 0) {\\n' +",
  "'        container.innerHTML = \"<div class=\\'col-span-full p-6 text-center text-slate-500 text-xs bg-slate-900/40 rounded-2xl border border-slate-800/80\\'>\" +\\n' +",
  "'          \"<i class=\\'fa-solid fa-box-open text-2xl text-slate-600 mb-2 block\\'></i>\" +\\n' +",
  "'          \"Belum ada data penjualan produk untuk periode ini.\" +\\n' +",
  "'        \"</div>\";\\n' +",
  "'        if (badgeCount) badgeCount.textContent = \"0 Produk\";\\n' +",
  "'        return;\\n' +",
  "'      }\\n' +",
  "'\\n' +",
  "'      if (badgeCount) badgeCount.textContent = \"Menampilkan Top \" + products.length + \" Produk\";\\n' +",
  "'\\n' +",
  "'      products.forEach(function(item, idx) {\\n' +",
  "'        var rank = idx + 1;\\n' +",
  "'        var rankBadgeColor = \"\";\\n' +",
  "'        var rankIcon = \"\";\\n' +",
  "'        var cardBorder = \"border-slate-800\";\\n' +",
  "'\\n' +",
  "'        if (rank === 1) {\\n' +",
  "'          rankBadgeColor = \"bg-amber-500/20 text-amber-300 border-amber-500/40\";\\n' +",
  "'          rankIcon = \"<i class=\\'fa-solid fa-crown text-amber-400 mr-1\\'></i>\";\\n' +",
  "'          cardBorder = \"border-amber-500/30 bg-gradient-to-br from-amber-950/20 to-slate-900/60\";\\n' +",
  "'        } else if (rank === 2) {\\n' +",
  "'          rankBadgeColor = \"bg-slate-400/20 text-slate-200 border-slate-400/40\";\\n' +",
  "'          rankIcon = \"<i class=\\'fa-solid fa-medal text-slate-300 mr-1\\'></i>\";\\n' +",
  "'        } else if (rank === 3) {\\n' +",
  "'          rankBadgeColor = \"bg-orange-700/20 text-orange-300 border-orange-600/40\";\\n' +",
  "'          rankIcon = \"<i class=\\'fa-solid fa-award text-orange-400 mr-1\\'></i>\";\\n' +",
  "'        } else {\\n' +",
  "'          rankBadgeColor = \"bg-indigo-500/15 text-indigo-300 border-indigo-500/25\";\\n' +",
  "'          rankIcon = \"<span class=\\'font-mono font-bold mr-1\\'>#\" + rank + \"</span>\";\\n' +",
  "'        }\\n' +",
  "'\\n' +",
  "'        var isFertipro = item.toko.toLowerCase().indexOf(\"fertipro\") !== -1;\\n' +",
  "'        var isYosa = item.toko.toLowerCase().indexOf(\"yosa\") !== -1;\\n' +",
  "'        var storeBadgeColor = isFertipro ? \"bg-emerald-500/15 text-emerald-300 border-emerald-500/30\" :\\n' +",
  "'                              (isYosa ? \"bg-amber-500/15 text-amber-300 border-amber-500/30\" : \"bg-indigo-500/15 text-indigo-300 border-indigo-500/30\");\\n' +",
  "'\\n' +",
  "'        var pct = (totalPeriodOmzet > 0) ? Math.min(100, Math.round((item.omzet / totalPeriodOmzet) * 100)) : 0;\\n' +",
  "'\\n' +",
  "'        var card = document.createElement(\"div\");\\n' +",
  "'        card.className = \"btn-touch glass-card glass-card-hover p-3.5 rounded-2xl cursor-pointer transition relative group border \" + cardBorder;\\n' +",
  "'        card.title = \"Klik untuk menyaring riwayat transaksi produk ini\";\\n' +",
  "'        card.onclick = function() {\\n' +",
  "'          var searchInput = document.getElementById(\"order-search\");\\n' +",
  "'          if (searchInput) {\\n' +",
  "'            searchInput.value = item.name;\\n' +",
  "'            applyFilters();\\n' +",
  "'            var tableEl = document.getElementById(\"orders-table-body\");\\n' +",
  "'            if (tableEl) tableEl.scrollIntoView({ behavior: \"smooth\" });\\n' +",
  "'            showToast(\"🔍 Memfilter transaksi untuk: \" + item.name);\\n' +",
  "'          }\\n' +",
  "'        };\\n' +",
  "'\\n' +",
  "'        card.innerHTML = \\n' +",
  "'          \"<div class=\\'flex items-start justify-between gap-2 mb-2\\'>\" +\\n' +",
  "'            \"<div class=\\'flex items-center space-x-2 min-w-0\\'>\" +\\n' +",
  "'              \"<span class=\\'text-[10px] px-2 py-0.5 rounded-lg font-black border flex items-center \" + rankBadgeColor + \"\\'>\" +\\n' +",
  "'                rankIcon + \" Juara \" + rank +\\n' +",
  "'              \"</span>\" +\\n' +",
  "'              \"<span class=\\'text-[10px] px-2 py-0.5 rounded-md font-medium border \" + storeBadgeColor + \" truncate\\'>\" +\\n' +",
  "'                item.toko +\\n' +",
  "'              \"</span>\" +\\n' +",
  "'            \"</div>\" +\\n' +",
  "'            \"<span class=\\'text-xs font-black text-indigo-300 whitespace-nowrap\\'>\" + formatRupiah(item.omzet) + \"</span>\" +\\n' +",
  "'          \"</div>\" +\\n' +",
  "'          \"<div class=\\'font-bold text-slate-100 text-xs sm:text-sm line-clamp-1 group-hover:text-indigo-300 transition\\' title=\\'\" + item.name.replace(/\\'/g, \"\") + \"\\'>\" +\\n' +",
  "'            item.name +\\n' +",
  "'          \"</div>\" +\\n' +",
  "'          \"<div class=\\'flex items-center justify-between text-[11px] text-slate-400 mt-2\\'>\" +\\n' +",
  "'            \"<span><i class=\\'fa-solid fa-box-open text-indigo-400 mr-1\\'></i><b>\" + item.qty + \"</b> paket (\" + item.count + \" order)</span>\" +\\n' +",
  "'            \"<span class=\\'text-[10px] text-slate-500 font-mono\\'>SKU: \" + item.sku + \"</span>\" +\\n' +",
  "'          \"</div>\" +\\n' +",
  "'          \"<div class=\\'w-full bg-slate-800/80 rounded-full h-1.5 overflow-hidden mt-2.5 border border-slate-700/50\\'>\" +\\n' +",
  "'            \"<div class=\\'bg-gradient-to-r from-amber-500 to-indigo-500 h-1.5 rounded-full transition-all duration-500\\' style=\\'width: \" + Math.max(5, pct) + \"%\\'></div>\" +\\n' +",
  "'          \"</div>\" +\\n' +",
  "'          \"<div class=\\'flex justify-between items-center text-[10px] text-slate-500 mt-1\\'>\" +\\n' +",
  "'            \"<span>Porsi Omzet Periode</span>\" +\\n' +",
  "'            \"<span class=\\'font-bold text-indigo-400\\'>\" + pct + \"%</span>\" +\\n' +",
  "'          \"</div>\";\\n' +",
  "'\\n' +",
  "'        container.appendChild(card);\\n' +",
  "'      });\\n' +",
  "'    }\\n' +",
  "'\\n' +"
].join('\n') + '\n';

code = code.replace(renderStoreCardsMarker, renderTopProductsJs + renderStoreCardsMarker);
console.log('Added renderTopProducts function in client script.');

// 3. Compute topProducts and call renderTopProducts in applyActivePeriodData
const targetCall = [
  "'      renderStoreCards(periodStoreSummary);\\n' +",
  "'      renderTrendChart(periodDailySummary);\\n' +",
  "'      renderDistChart(periodStoreSummary);\\n' +",
  "'      renderOrdersTable(currentActiveOrders);\\n' +"
].join('\n');

const replacementCall = [
  "'      // Compute Top Selling Products for active period\\n' +",
  "'      var productMap = {};\\n' +",
  "'      currentActiveOrders.forEach(function(o) {\\n' +",
  "'        if (o.statusPesanan === \"RETUR\" || o.isRetur) return;\\n' +",
  "'        var pName = (o.produk || o.product || \"\").trim();\\n' +",
  "'        if (!pName || pName === \"-\" || pName.toLowerCase() === \"undefined\") {\\n' +",
  "'          pName = (o.sku && o.sku !== \"-\") ? (\"Produk \" + o.sku) : \"Paket Umum\";\\n' +",
  "'        }\\n' +",
  "'        if (!productMap[pName]) {\\n' +",
  "'          productMap[pName] = {\\n' +",
  "'            name: pName,\\n' +",
  "'            sku: o.sku || \"-\",\\n' +",
  "'            toko: o.toko || \"Safra\",\\n' +",
  "'            qty: 0,\\n' +",
  "'            omzet: 0,\\n' +",
  "'            count: 0\\n' +",
  "'          };\\n' +",
  "'        }\\n' +",
  "'        productMap[pName].qty += (Number(o.qty) || 1);\\n' +",
  "'        productMap[pName].omzet += (Number(o.total) || 0);\\n' +",
  "'        productMap[pName].count++;\\n' +",
  "'      });\\n' +",
  "'\\n' +",
  "'      var topProducts = Object.keys(productMap).map(function(k) {\\n' +",
  "'        return productMap[k];\\n' +",
  "'      }).sort(function(a, b) {\\n' +",
  "'        if (b.omzet !== a.omzet) return b.omzet - a.omzet;\\n' +",
  "'        return b.qty - a.qty;\\n' +",
  "'      }).slice(0, 6);\\n' +",
  "'\\n' +",
  "'      renderTopProducts(topProducts, periodOmzet);\\n' +",
  "'      renderStoreCards(periodStoreSummary);\\n' +",
  "'      renderTrendChart(periodDailySummary);\\n' +",
  "'      renderDistChart(periodStoreSummary);\\n' +",
  "'      renderOrdersTable(currentActiveOrders);\\n' +"
].join('\n');

if (!code.includes(targetCall)) {
  console.error("Could not find targetCall in applyActivePeriodData");
  process.exit(1);
}

code = code.replace(targetCall, replacementCall);
console.log('Updated applyActivePeriodData with topProducts computation.');

// 4. Verify syntax
try {
  vm.createScript(code);
  console.log('✅ Syntax verification PASSED! No parse errors in Code.gs');
  fs.writeFileSync(codeGsPath, code, 'utf8');
  console.log('Successfully wrote updated Code.gs! New length:', code.length);
} catch (err) {
  console.error('❌ Syntax error in updated code:', err);
  process.exit(1);
}
