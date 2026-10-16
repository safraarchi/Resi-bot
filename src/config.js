const path = require('path');
require('dotenv').config();

const ROOT_DIR = path.resolve(__dirname, '..');

// Helper to parse comma-separated IDs into an array of clean string IDs
function parseIdList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
}

const adminIds = parseIdList(process.env.ADMIN_CHAT_ID);
const allowedGroupIds = parseIdList(process.env.ALLOWED_GROUP_ID);

function isAdmin(userId) {
  if (!userId) return false;
  return adminIds.includes(String(userId));
}

function isAllowedChat(chatId) {
  if (!chatId) return false;
  const strId = String(chatId);
  return allowedGroupIds.includes(strId) || adminIds.includes(strId);
}

function isSecurityActive() {
  return adminIds.length > 0 || allowedGroupIds.length > 0;
}

function getPrimaryTargetChatId() {
  if (allowedGroupIds.length > 0) return allowedGroupIds[0];
  if (adminIds.length > 0) return adminIds[0];
  return null;
}

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID || '',
  ALLOWED_GROUP_ID: process.env.ALLOWED_GROUP_ID || '',
  
  // Parsed ID lists & helper methods
  adminIds,
  allowedGroupIds,
  isAdmin,
  isAllowedChat,
  isSecurityActive,
  getPrimaryTargetChatId,

  // Cron schedule for automatic batch merge ('disabled' for manual only)
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || 'disabled',
  
  // Auto-send merged file back to the group/chat where resi were sent?
  AUTO_SEND_MERGED_PDF: process.env.AUTO_SEND_MERGED_PDF !== 'false',

  // Target printer name for direct monochrome printing
  PRINTER_NAME: process.env.PRINTER_NAME || 'EPSON L3250 Series',

  // Google Sheet Webhook Integration
  GOOGLE_SHEET_WEBHOOK_URL: process.env.GOOGLE_SHEET_WEBHOOK_URL || '',

  // Default Sender Info
  DEFAULT_SIP: process.env.DEFAULT_SIP || 'SAFRA',
  DEFAULT_HP: process.env.DEFAULT_HP || '0856-9733-7041',

  // Directory paths
  PATHS: {
    ROOT: ROOT_DIR,
    STORAGE: path.join(ROOT_DIR, 'storage'),
    QUEUE: path.join(ROOT_DIR, 'storage', 'queue'),
    OUTPUT: path.join(ROOT_DIR, 'storage', 'output'),
    ARCHIVE: path.join(ROOT_DIR, 'storage', 'archive'),
    PENDING_FINANCE: path.join(ROOT_DIR, 'storage', 'pending_finance.json'),
  }
};
