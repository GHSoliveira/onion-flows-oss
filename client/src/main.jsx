import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { AuthProvider } from './context/AuthContext'
import { BrandingProvider } from './context/BrandingContext'
import { DialogProvider } from './context/DialogContext'
import App from './App'
import './index.css'
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals'
import { initErrorTracking, reportReactError } from './services/errorTracking'

// Depois de um deploy, a aba que ja estava aberta pede pedacos da versao
// anterior, que nao existem mais (404) e a tela quebra. Recarrega uma vez para
// pegar a versao nova; o intervalo minimo evita ficar recarregando em loop se
// o problema for outro (sem internet, por exemplo).
const RECARGA_KEY = 'onion:recarga-versao'
const recarregarParaVersaoNova = () => {
  try {
    const ultima = Number(sessionStorage.getItem(RECARGA_KEY) || 0)
    if (Date.now() - ultima < 30000) return false
    sessionStorage.setItem(RECARGA_KEY, String(Date.now()))
  } catch {
    // Sem sessionStorage nao da para garantir que nao entra em loop.
    return false
  }
  window.location.reload()
  return true
}
const ehPedacoAusente = (motivo) => /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i
  .test(String(motivo?.message || motivo || ''))

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    if (recarregarParaVersaoNova()) event.preventDefault()
  })
  window.addEventListener('unhandledrejection', (event) => {
    if (ehPedacoAusente(event.reason)) recarregarParaVersaoNova()
  })
}

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const reportWebVital = (metric) => {
  try {
    if (Math.random() > 0.1) return
    const token = localStorage.getItem('token')
    const payload = {
      ...metric,
      page: window.location.pathname
    }

    fetch(`${API_BASE}/api/metrics/web-vitals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(payload)
    }).catch(() => {})
  } catch (e) {
    // ignore
  }
}

onCLS(reportWebVital)
onFCP(reportWebVital)
onINP(reportWebVital)
onLCP(reportWebVital)
onTTFB(reportWebVital)

// Erro que o React segura nao chega ao window.onerror: repassa ao Sentry e
// mantem o log no console que o React faria sem estas opcoes.
const root = ReactDOM.createRoot(document.getElementById('root'), {
  // Pedaco da versao anterior que sumiu cai aqui pelo lazy(): recarrega.
  onUncaughtError: (error, info) => { if (ehPedacoAusente(error) && recarregarParaVersaoNova()) return; console.error(error); reportReactError(error, info) },
  onCaughtError: (error, info) => { console.error(error); reportReactError(error, info) }
})
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <BrandingProvider>
          <DialogProvider>
            <Toaster position='top-right' />
            <App />
          </DialogProvider>
        </BrandingProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
)

initErrorTracking()
