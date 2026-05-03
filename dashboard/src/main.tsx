import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

// Seed history so cold deep-links into item detail paths don't trap the back
// button. Stack becomes ['/', '/<deep>'] → back returns to feed.
// Runs only at fresh page load (main.tsx); SPA in-app nav never re-enters here.
{
  const p = window.location.pathname
  const isDeepLink = p.startsWith('/t/') || p.startsWith('/g/') || p.startsWith('/ph/')
  if (isDeepLink) {
    const target = window.location.pathname + window.location.search + window.location.hash
    window.history.replaceState({}, '', '/')
    window.history.pushState({}, '', target)
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
