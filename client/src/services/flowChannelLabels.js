// Mirrors the configured routes in Channels without exposing technical credentials.
export function flowChannelLabels(config = {}) {
  const result = new Map();
  const entries = Array.isArray(config.entries) ? config.entries : [];
  const represented = new Set(entries.map((entry) => entry.platform));
  const platforms = { whatsapp: 'WhatsApp', telegram: 'Telegram', web: 'Web' };
  const add = (flowId, name, platform, enabled) => {
    if (typeof flowId !== 'string' || !flowId.trim()) return;
    const label = `${typeof name === 'string' && name.trim() ? name.trim() : platforms[platform] || 'Canal'}${enabled === false ? ' (desativado)' : ''}`;
    const labels = result.get(flowId) || [];
    if (!labels.includes(label)) labels.push(label);
    result.set(flowId, labels);
  };
  for (const entry of entries) add(entry.flowId, entry.name, entry.platform, entry.enabled);
  const whatsapp = config.whatsapp || {};
  if (!represented.has('whatsapp')) {
    const senders = Array.isArray(whatsapp.senderNumbers) ? whatsapp.senderNumbers : [];
    if (senders.length) {
      for (const sender of senders) add(sender.flowId || whatsapp.flowId, sender.label || sender.displayNumber || 'Canal WhatsApp', 'whatsapp', whatsapp.enabled !== false && sender.enabled !== false);
    } else add(whatsapp.flowId, 'Canal principal (WhatsApp)', 'whatsapp', whatsapp.enabled);
  }
  if (!represented.has('telegram')) add(config.telegram?.flowId, 'Bot Telegram', 'telegram', config.telegram?.enabled);
  return result;
}
