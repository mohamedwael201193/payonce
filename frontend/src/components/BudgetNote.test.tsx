// BudgetNote — P3 §5. Shows the hourly budget from /api/health, with the
// used-up state. Mocked fetch; no network.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BudgetNote } from './BudgetNote'

const HEALTH = {
  chain: { reachable: true, checked_at: '2026-11-24T10:42:07Z' },
  node_busy: false,
  payer: { status: 'ok' },
  sponsor: { status: 'ok' },
  wallet_eudemo: { status: 'ok' },
  co_signer: { status: 'ok' },
  budget: { new_invoices_left_this_hour: 3, attack_sends_left_this_hour: 10 },
}

function renderNote(props?: { showFresh?: boolean; showAttacks?: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <BudgetNote {...props} />
    </QueryClientProvider>,
  )
}

describe('BudgetNote', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => HEALTH })),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows both budgets when available', async () => {
    renderNote()
    await waitFor(() =>
      expect(screen.getByText(/Budget this hour: 3 fresh invoices left, 10 attack sends left/)).toBeInTheDocument(),
    )
  })

  it('shows only attack sends when showFresh is false', async () => {
    renderNote({ showFresh: false })
    await waitFor(() => expect(screen.getByText(/10 attack sends left/)).toBeInTheDocument())
    expect(screen.queryByText(/fresh invoices/)).not.toBeInTheDocument()
  })

  it('says used up when the budget is 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ...HEALTH, budget: { new_invoices_left_this_hour: 0, attack_sends_left_this_hour: 0 } }),
      })),
    )
    renderNote()
    await waitFor(() => expect(screen.getByText(/fresh invoices: used up for this hour/)).toBeInTheDocument())
    expect(screen.getByText(/attack sends: used up for this hour/)).toBeInTheDocument()
  })
})
