import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// The landing chunk starts downloading next to the app chunk, not after it.
if (location.pathname === '/') void import('./landing/LandingPage')

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
