const config = require('./config');

/**
 * Global authentication middleware to verify chat / user authorization
 */
function authMiddleware(ctx, next) {
  // Always permit /id command so users/admins can identify their Telegram ID
  const text = ctx.message?.text || '';
  if (text.startsWith('/id')) {
    return next();
  }

  // If no security ID is configured yet in .env, permit traffic but log a warning
  if (!config.isSecurityActive()) {
    return next();
  }

  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;

  // Check if chat or sender is authorized
  const isChatAllowed = config.isAllowedChat(chatId);
  const isSenderAdmin = config.isAdmin(userId);

  if (isChatAllowed || isSenderAdmin) {
    return next();
  }

  // Silent Drop: Ignore unauthorized user / chat to avoid exposing bot existence/data
  const senderName = ctx.from?.username ? `@${ctx.from.username}` : (userId || 'Unknown');
  console.warn(`[SECURITY BLOCKED] Akses tidak sah dicegah: User ${senderName} (Chat ID: ${chatId})`);
  return; // Stop chain, no response sent to untrusted caller
}

/**
 * Middleware restricting sensitive commands (e.g. /reset) strictly to Admins
 */
function adminOnly(ctx, next) {
  // If security is not configured, allow
  if (!config.isSecurityActive()) {
    return next();
  }

  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (config.isAdmin(userId) || config.isAdmin(chatId)) {
    return next();
  }

  return ctx.reply('⛔ *Akses Ditolak:* Perintah ini hanya dapat dijalankan oleh Admin terdaftar.', {
    parse_mode: 'Markdown',
  });
}

module.exports = {
  authMiddleware,
  adminOnly,
};
