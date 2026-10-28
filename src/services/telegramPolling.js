import { getUpdates } from './telegramApi.js';
import { handleTelegramUpdate } from './telegramHandler.js';
import { getAllTelegramConfigs } from './channelConfig.js';

export const startTelegramPolling = () => {
  const offsets = new Map();
  const maskToken = (token) => {
    if (!token) return 'null';
    const value = String(token).trim();
    if (value.length <= 10) return '***';
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  };

  const poll = async () => {
    try {
      let configs = await getAllTelegramConfigs();
      if (configs.length === 0 && process.env.TELEGRAM_BOT_TOKEN) {
        configs = [{
          tenantId: process.env.TELEGRAM_TENANT_ID || null,
          telegram: {
            botToken: process.env.TELEGRAM_BOT_TOKEN,
            flowId: process.env.TELEGRAM_FLOW_ID || null,
            usePolling: true
          }
        }];
      }

      for (const config of configs) {
        const botToken = config.telegram?.botToken;
        if (!botToken || config.telegram?.usePolling === false) continue;

        try {
          const offset = offsets.get(botToken);
          const updates = await getUpdates(botToken, offset);
          if (Array.isArray(updates)) {
            for (const update of updates) {
              offsets.set(botToken, (update.update_id || 0) + 1);
              await handleTelegramUpdate(update, {
                tenantId: config.tenantId,
                flowId: config.telegram?.flowId || null,
                botToken
              });
            }
          }
        } catch (error) {
          console.error(
            `Erro Telegram polling (tenant=${config.tenantId || 'null'}, token=${maskToken(botToken)}):`,
            error.message || error
          );
        }
      }
    } catch (error) {
      console.error('Erro Telegram polling:', error.message || error);
    } finally {
      setTimeout(poll, 1000);
    }
  };

  poll();
};
