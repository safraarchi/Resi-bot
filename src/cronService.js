const cron = require('node-cron');
const config = require('./config');

/**
 * Initialize cron schedule for automated batch processing
 * @param {Function} onTrigger - Callback executed when schedule triggers
 */
function initScheduler(onTrigger) {
  const scheduleExpr = (config.CRON_SCHEDULE || '').trim().toLowerCase();

  if (!scheduleExpr || ['disabled', 'false', 'none', 'off', '0'].includes(scheduleExpr)) {
    console.log('[CRON] Jadwal otomatis DINONAKTIFKAN (Pencetakan murni manual via perintah /cetak).');
    return null;
  }

  if (!cron.validate(config.CRON_SCHEDULE)) {
    console.warn(`[CRON WARNING] Format jadwal cron tidak valid: "${config.CRON_SCHEDULE}". Jadwal otomatis tidak diaktifkan.`);
    return null;
  }

  const validExpr = config.CRON_SCHEDULE;
  console.log(`[CRON] Scheduler aktif dengan jadwal: "${validExpr}"`);

  const task = cron.schedule(validExpr, async () => {
    console.log(`[CRON] Pemicu jadwal tercapai (${new Date().toLocaleTimeString('id-ID')}). Menjalankan penggabungan otomatis...`);
    try {
      if (typeof onTrigger === 'function') {
        await onTrigger();
      }
    } catch (err) {
      console.error('[CRON ERROR] Gagal menjalankan tugas terjadwal:', err);
    }
  }, {
    timezone: 'Asia/Jakarta'
  });

  return task;
}

module.exports = {
  initScheduler,
};
