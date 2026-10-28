// Sentry do painel. Desligado sem VITE_SENTRY_DSN; com DSN, o SDK vem num
// chunk separado depois do primeiro render, para nao pesar no carregamento.
// So erro: sem replay de sessao (grava a tela, e a tela tem conversa de
// cliente) e sem tracing.

const DSN = String(import.meta.env.VITE_SENTRY_DSN || '').trim()
const PHONE_LIKE = /\+?\d{10,15}/g

let sentry = null
let usuario = null
const pendentes = []

const scrub = (event) => {
  if (event?.request) {
    delete event.request.data
    delete event.request.cookies
    delete event.request.headers
  }
  if (event?.user) event.user = event.user.id ? { id: event.user.id } : undefined
  for (const value of event?.exception?.values || []) {
    if (typeof value.value === 'string') value.value = value.value.replace(PHONE_LIKE, '***')
  }
  return event
}

export const initErrorTracking = () => {
  if (!DSN || sentry) return
  import('./sentryBrowser').then((mod) => {
    mod.init({
      dsn: DSN,
      environment: import.meta.env.MODE,
      release: import.meta.env.VITE_RELEASE || undefined,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      // Cliques e console podem ter texto de conversa.
      maxBreadcrumbs: 20,
      beforeBreadcrumb: (crumb) => (crumb.category === 'console' || crumb.category?.startsWith('ui.') ? null : crumb),
      beforeSend: scrub
    })
    sentry = mod
    setErrorTrackingUser(usuario)
    while (pendentes.length) {
      const [error, info] = pendentes.shift()
      reportReactError(error, info)
    }
  }).catch(() => { /* sem monitoramento, o painel segue */ })
}

// So id, tenant e papel: nome, e-mail e login ficam fora.
export const setErrorTrackingUser = (user) => {
  usuario = user || null
  if (!sentry) return
  sentry.setUser(user?.id ? { id: user.id } : null)
  sentry.setTag('tenantId', user?.tenantId || null)
  sentry.setTag('role', user?.role || null)
}

// Para os onUncaughtError/onCaughtError do createRoot: erros que o React
// segura nao chegam ao window.onerror.
export const reportReactError = (error, info) => {
  if (!DSN) return
  if (!sentry) {
    if (pendentes.length < 10) pendentes.push([error, info])
    return
  }
  sentry.withScope((scope) => {
    if (info?.componentStack) scope.setContext('react', { componentStack: info.componentStack })
    sentry.captureException(error)
  })
}
