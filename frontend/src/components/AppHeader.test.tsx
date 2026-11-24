// AppHeader — navigation: the logo always links home, the active tab is
// marked (aria-current="page" + the solid white pill), and the tab pill
// exists on mobile too (full-width row under the header), not only >=md.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppHeader } from './AppHeader'

function renderHeader(path: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AppHeader />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('AppHeader navigation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('logo links home from every page', () => {
    renderHeader('/dashboard')
    const logo = screen.getByRole('link', { name: 'PayOnce home' })
    expect(logo).toHaveAttribute('href', '/')
    expect(logo).toHaveAttribute('title', 'PayOnce — back to home')
    expect(logo.querySelector('svg')).not.toBeNull()
  })

  it('marks the active tab on desktop and mobile (two navs, same state)', () => {
    renderHeader('/judges')
    const judges = screen.getAllByRole('link', { name: 'For judges' })
    expect(judges).toHaveLength(2)
    for (const link of judges) expect(link).toHaveAttribute('aria-current', 'page')
    const home = screen.getAllByRole('link', { name: 'Home' })
    expect(home).toHaveLength(2)
    for (const link of home) expect(link).not.toHaveAttribute('aria-current', 'page')
  })

  it('marks Home active on the landing page', () => {
    renderHeader('/')
    const home = screen.getAllByRole('link', { name: 'Home' })
    for (const link of home) expect(link).toHaveAttribute('aria-current', 'page')
  })

  it('shows all three tabs', () => {
    renderHeader('/')
    expect(screen.getAllByRole('link', { name: 'Home' })).toHaveLength(2)
    expect(screen.getAllByRole('link', { name: 'Dashboard' })).toHaveLength(2)
    expect(screen.getAllByRole('link', { name: 'For judges' })).toHaveLength(2)
  })
})
