import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

// Seed history so cold deep-links into /t/:id don't trap the back button.
// Stack becomes ['/', '/t/:id'] → back returns to feed instead of leaving the site.
// Runs only at fresh page load (main.tsx); SPA in-app nav never re-enters this.
if (window.location.pathname.startsWith('/t/')) {
  const target = window.location.pathname + window.location.search + window.location.hash
  window.history.replaceState({}, '', '/')
  window.history.pushState({}, '', target)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
