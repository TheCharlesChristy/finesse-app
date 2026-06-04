import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.jsx'

registerSW({
  onRegisteredSW(swUrl, registration) {
    if (!registration) return
    setInterval(() => {
      if (!navigator.onLine || registration.installing) return
      fetch(swUrl, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } })
        .then(r => { if (r?.status === 200) registration.update() })
        .catch(() => {})
    }, 60 * 60 * 1000)
  },
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
