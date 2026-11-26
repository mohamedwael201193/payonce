// Dev-only harness: mounts the landing alone with a router so it can be
// developed and captured without the app shell. Not part of the build.
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import LandingPage from './LandingPage'

createRoot(document.getElementById('root') as HTMLElement).render(
  <BrowserRouter>
    <Routes>
      <Route path="*" element={<LandingPage />} />
    </Routes>
  </BrowserRouter>,
)
