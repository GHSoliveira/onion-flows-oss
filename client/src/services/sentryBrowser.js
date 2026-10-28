// So o que o painel usa, com import nomeado: assim o empacotador deixa de fora
// replay, feedback e tracing, que um import('@sentry/react') inteiro puxaria.
export { init, withScope, captureException, setUser, setTag } from '@sentry/react'
