import { runOutsideChatLocks } from './chatLocks.js';

/**
 * Retomada pontual do delayNode.
 *
 * O delay grava `delayUntil` no chat e para. Quem continua o fluxo e o watcher
 * de runtime, que confere a cada 30s: bom para timeout de menu, ruim para um
 * delay de 3s. Aqui cada delay ganha tambem um timer em memoria para o segundo
 * exato. O watcher segue como rede de seguranca: timer perdido num restart e
 * pego no tick seguinte.
 *
 * Os dois caminhos chamam a mesma rotina, registrada pelo watcher, que trava o
 * chat e confere se o delay ainda esta pendente. O fluxo nunca continua duas vezes.
 */

// Delay maior que isso fica so com o watcher: alguns segundos a mais nao
// importam, e nao vale segurar um timer por horas.
export const MAX_TIMER_DELAY_MS = 15 * 60 * 1000;

// delayUntil e gravado antes de o timer nascer; a margem garante que, quando o
// timer dispara, o delay ja esta vencido para a rotina do watcher.
const MARGEM_MS = 250;

const timers = new Map();
let handler = null;

export const setDelayResumeHandler = (fn) => {
  handler = typeof fn === 'function' ? fn : null;
};

export const scheduleDelayResume = (chatId, delayMs) => {
  const ms = Number(delayMs);
  if (!chatId || !handler || !Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMER_DELAY_MS) return false;

  clearTimeout(timers.get(chatId));

  // O delay costuma ser agendado de dentro do lock do chat (processamento do
  // webhook). Sem sair desse contexto, o callback herdaria o lock e rodaria sem
  // esperar por ele.
  const timer = runOutsideChatLocks(() => setTimeout(async () => {
    if (timers.get(chatId) === timer) timers.delete(chatId);
    try {
      await handler(chatId);
    } catch (error) {
      console.warn('[DELAY_RESUME] Falha ao retomar delay; o watcher tenta de novo', {
        chatId,
        error: error?.message || error
      });
    }
  }, ms + MARGEM_MS));

  timer.unref?.();
  timers.set(chatId, timer);
  return true;
};
