import fs from 'node:fs';

// Sentry do backend. Desligado sem SENTRY_DSN: nem carrega o pacote, que pesa
// na VPS de 1 GB. Com DSN, manda so erro (sem tracing, sem breadcrumbs) e
// limpa o que pode ter dado de cliente antes de sair do servidor: corpo da
// requisicao, cookies, cabecalhos e query (a verificacao da Meta manda token
// na query). O que fica e a pilha, a rota e tags como fila e tenant.

let sentry = null;

const PHONE_LIKE = /\+?\d{10,15}/g;
const SENSITIVE_QUERY = /((?:token|verify_token|access_token|key|secret|password|senha|code)=)[^&]*/gi;

export const scrubEvent = (event) => {
  if (event?.request) {
    delete event.request.data;
    delete event.request.cookies;
    const userAgent = event.request.headers?.['user-agent'];
    event.request.headers = userAgent ? { 'user-agent': userAgent } : {};
    if (typeof event.request.query_string === 'string') {
      event.request.query_string = event.request.query_string.replace(SENSITIVE_QUERY, '$1***');
    } else {
      delete event.request.query_string;
    }
    if (typeof event.request.url === 'string') event.request.url = event.request.url.replace(SENSITIVE_QUERY, '$1***');
  }
  if (event?.user) event.user = event.user.id ? { id: event.user.id } : undefined;
  delete event?.extra?.body;
  // Mensagem de erro as vezes carrega o telefone do cliente (wa_id).
  for (const value of event?.exception?.values || []) {
    if (typeof value.value === 'string') value.value = value.value.replace(PHONE_LIKE, '***');
  }
  if (typeof event?.message === 'string') event.message = event.message.replace(PHONE_LIKE, '***');
  return event;
};

const readRelease = () => {
  try { return fs.readFileSync(new URL('../../REVISION', import.meta.url), 'utf8').trim() || undefined; } catch { return undefined; }
};

// @sentry/core em vez de @sentry/node: o SDK de Node traz OpenTelemetry e
// custava ~72 MB de RSS medidos; o core fica em ~23 MB e faz o que usamos
// (erro com pilha, tags, envio por fetch).
const fetchTransport = (core, options) => core.createTransport(options, async (request) => {
  const response = await fetch(options.url, { method: 'POST', body: request.body, headers: options.headers });
  return {
    statusCode: response.status,
    headers: {
      'x-sentry-rate-limits': response.headers.get('x-sentry-rate-limits'),
      'retry-after': response.headers.get('retry-after')
    }
  };
});

let crashHandlerInstalled = false;
const installCrashHandler = () => {
  if (crashHandlerInstalled) return;
  crashHandlerInstalled = true;
  // Mesmo comportamento do Node sem listener (loga e sai com 1, o systemd
  // reinicia), mas antes manda o erro. Promise rejeitada sem catch vira
  // uncaughtException no Node 22, entao passa por aqui tambem.
  process.on('uncaughtException', async (error) => {
    console.error('[FATAL]', error);
    captureError(error, { tags: { fatal: true } });
    await flushErrorTracking(2000);
    process.exit(1);
  });
};

export const initErrorTracking = async () => {
  const dsn = String(process.env.SENTRY_DSN || '').trim();
  if (!dsn || sentry) return Boolean(sentry);
  try {
    const core = await import('@sentry/core');
    const client = new core.ServerRuntimeClient({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      release: readRelease(),
      platform: 'node',
      runtime: { name: 'node', version: process.version },
      serverName: process.env.SENTRY_SERVER_NAME || 'onion-flows-api',
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      stackParser: core.createStackParser(core.nodeStackLineParser()),
      transport: (options) => fetchTransport(core, options),
      integrations: [core.inboundFiltersIntegration(), core.linkedErrorsIntegration(), core.dedupeIntegration()],
      beforeSend: scrubEvent
    });
    core.setCurrentClient(client);
    client.init();
    sentry = core;
    installCrashHandler();
    console.log('[SENTRY] ativo');
    return true;
  } catch (error) {
    sentry = null;
    console.warn('[SENTRY] nao iniciou:', error?.message || error);
    return false;
  }
};

export const captureError = (error, { tags = {}, extra = {} } = {}) => {
  if (!sentry) return;
  try {
    sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(tags)) if (value != null) scope.setTag(key, String(value));
      for (const [key, value] of Object.entries(extra)) if (value != null) scope.setExtra(key, value);
      sentry.captureException(error);
    });
  } catch { /* monitoramento nunca derruba o atendimento */ }
};

export const flushErrorTracking = async (timeoutMs = 2000) => {
  if (!sentry) return;
  try { await sentry.flush(timeoutMs); } catch { /* idem */ }
};
