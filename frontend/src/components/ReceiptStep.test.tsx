// ReceiptStep — B-5 (round-5 fix-back) regression tests. The copied
// verifier command must verify the receipt's ACTUAL rail: an EUDemo
// receipt's Transfer leg run through the v1 CLI's default CCD rail
// fails CCD-02/CCD-03 (exit 1) on a valid payment, so the command
// threads --rail, and for EUDemo (CLI rail plt) the reservation and
// confirm txs from the receipt's own tx list. A CCD receipt keeps the
// plain --rail ccd command with no reserve/confirm flags. Both tests
// click the real Copy button and read what reaches the clipboard.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildVerifierCommand, ReceiptCard } from './ReceiptStep'
import type { Receipt } from '../lib/types'

const RESERVE = '11'.repeat(32)
const TRANSFER = '22'.repeat(32)
const CONFIRM = '33'.repeat(32)
const PAY = '44'.repeat(32)

const EUDEMO_RECEIPT: Receipt = {
  payable_id: 11,
  amount_display: '0.01 EUDemo',
  payee: 'PAYEE-PLACEHOLDER',
  payer_label: 'Demo payer account (lab)',
  txs: [
    { label: 'Reservation', tx_hash: RESERVE, explorer_url: 'https://example.invalid/tx' },
    { label: 'Transfer', tx_hash: TRANSFER, explorer_url: 'https://example.invalid/tx' },
    { label: 'Confirm', tx_hash: CONFIRM, explorer_url: 'https://example.invalid/tx' },
  ],
  verifier: null,
  payment_tx_source: 'chain',
}

const CCD_RECEIPT: Receipt = {
  payable_id: 10,
  amount_display: '0.5 CCD',
  payee: 'PAYEE-PLACEHOLDER',
  payer_label: 'Demo payer account (lab)',
  txs: [{ label: 'Payment', tx_hash: PAY, explorer_url: 'https://example.invalid/tx' }],
  verifier: null,
  payment_tx_source: 'server_store',
}

function renderCard(receipt: Receipt, asset?: 'ccd' | 'eudemo') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReceiptCard receipt={receipt} explorerBase="https://ccdexplorer.io/testnet/transaction/" asset={asset} />
    </QueryClientProvider>,
  )
}

describe('ReceiptStep copied verifier command (B-5)', () => {
  const writeText = vi.fn(async (_text: string): Promise<void> => {})
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    writeText.mockClear()
  })

  // userEvent.setup() installs its own navigator.clipboard stub — the
  // mock must be installed AFTER setup, or the click writes to
  // user-event's clipboard instead of this mock.
  function stubClipboard() {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  }

  it('EUDemo receipt → the copied command carries --rail plt plus the reserve and confirm txs', async () => {
    const user = userEvent.setup()
    stubClipboard()
    const expected = `node verify-payable.mjs 11 ${TRANSFER} --rail plt --reserve-tx ${RESERVE} --confirm-tx ${CONFIRM}`
    expect(buildVerifierCommand(EUDEMO_RECEIPT, 'eudemo')).toBe(expected)
    renderCard(EUDEMO_RECEIPT, 'eudemo')
    await user.click(screen.getByRole('button', { name: 'Copy verifier command' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected))
    // The positional tx is the Transfer leg, never a bare default-rail run.
    expect(writeText.mock.calls[0][0]).not.toContain('--rail ccd')
  })

  it('CCD receipt → the copied command stays --rail ccd with no reserve/confirm flags', async () => {
    const user = userEvent.setup()
    stubClipboard()
    const expected = `node verify-payable.mjs 10 ${PAY} --rail ccd`
    expect(buildVerifierCommand(CCD_RECEIPT, 'ccd')).toBe(expected)
    renderCard(CCD_RECEIPT, 'ccd')
    await user.click(screen.getByRole('button', { name: 'Copy verifier command' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected))
    expect(writeText.mock.calls[0][0]).not.toContain('--reserve-tx')
    expect(writeText.mock.calls[0][0]).not.toContain('--confirm-tx')
  })

  it('no asset threaded → the receipt’s own tx labels still pick the right rail (Transfer ⇒ plt)', () => {
    expect(buildVerifierCommand(EUDEMO_RECEIPT)).toBe(
      `node verify-payable.mjs 11 ${TRANSFER} --rail plt --reserve-tx ${RESERVE} --confirm-tx ${CONFIRM}`,
    )
    expect(buildVerifierCommand(CCD_RECEIPT)).toBe(`node verify-payable.mjs 10 ${PAY} --rail ccd`)
  })
})
