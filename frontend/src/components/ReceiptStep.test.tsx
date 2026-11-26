// ReceiptStep — B-5 (round-5 fix-back) regression tests, extended in
// round 6. The copied verifier command must verify the receipt's ACTUAL
// rail: an EUDemo receipt's Transfer leg run through the v1 CLI's default
// CCD rail fails CCD-03 (exit 1) on a valid payment, so the command
// threads --rail, and for EUDemo (CLI rail plt) the reservation and
// confirm txs from the receipt's own tx list. A CCD receipt keeps the
// plain --rail ccd command with no reserve/confirm flags. Round 6: the
// rail is derived from the RECEIPT, never from the parent's loaded
// payable — pay EUDemo 11, pick CCD 10, copy → --rail plt still — and
// the command carries the repo-relative script path (H-3). A
// Transfer-only EUDemo receipt discloses that the copied command fails
// PLT-13 (no --reserve-tx to give it), and a receipt for another payable
// renders as stale with no copy button at all. Both tests click the real
// Copy button and read what reaches the clipboard.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildVerifierCommand, ReceiptCard, ReceiptStep } from './ReceiptStep'
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

// Round-6: the live receipt 2001 shape — Transfer only, no Reservation
// or Confirm leg, so the copied command has no --reserve-tx and the
// verifier fails PLT-13 closed.
const TRANSFER_ONLY_RECEIPT: Receipt = {
  payable_id: 2001,
  amount_display: '2.00 EUDemo',
  payee: 'PAYEE-PLACEHOLDER',
  payer_label: 'Demo payer account (lab)',
  txs: [{ label: 'Transfer', tx_hash: TRANSFER, explorer_url: 'https://example.invalid/tx' }],
  verifier: { passed: 12, total: 15, checked_at: '2026-11-26T03:05:21.942Z' },
  payment_tx_source: 'chain',
}

const CMD = 'node backend/src/verifier/verify-payable.mjs'

function renderCard(receipt: Receipt, asset?: 'ccd' | 'eudemo') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReceiptCard receipt={receipt} explorerBase="https://ccdexplorer.io/testnet/transaction/" asset={asset} />
    </QueryClientProvider>,
  )
}

function renderStep(receipt: Receipt, forPayableId?: number, forSeller?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReceiptStep
        receipt={receipt}
        explorerBase="https://ccdexplorer.io/testnet/transaction/"
        forPayableId={forPayableId}
        forSeller={forSeller}
      />
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
    const expected = `${CMD} 11 ${TRANSFER} --rail plt --reserve-tx ${RESERVE} --confirm-tx ${CONFIRM}`
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
    const expected = `${CMD} 10 ${PAY} --rail ccd`
    expect(buildVerifierCommand(CCD_RECEIPT, 'ccd')).toBe(expected)
    renderCard(CCD_RECEIPT, 'ccd')
    await user.click(screen.getByRole('button', { name: 'Copy verifier command' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected))
    expect(writeText.mock.calls[0][0]).not.toContain('--reserve-tx')
    expect(writeText.mock.calls[0][0]).not.toContain('--confirm-tx')
  })

  it('no asset threaded → the receipt’s own tx labels still pick the right rail (Transfer ⇒ plt)', () => {
    expect(buildVerifierCommand(EUDEMO_RECEIPT)).toBe(
      `${CMD} 11 ${TRANSFER} --rail plt --reserve-tx ${RESERVE} --confirm-tx ${CONFIRM}`,
    )
    expect(buildVerifierCommand(CCD_RECEIPT)).toBe(`${CMD} 10 ${PAY} --rail ccd`)
  })

  // Round-6 B-5: the stale case. Pay EUDemo 11, pick CCD 10 — the
  // parent's loaded asset is now 'ccd', but the copied command must
  // still verify the RECEIPT's rail (plt), and the reverse direction
  // (CCD receipt under EUDemo facts) must still copy --rail ccd.
  it('stale parent asset → the receipt’s own rail wins (EUDemo receipt under CCD facts → --rail plt)', async () => {
    const user = userEvent.setup()
    stubClipboard()
    const expected = `${CMD} 11 ${TRANSFER} --rail plt --reserve-tx ${RESERVE} --confirm-tx ${CONFIRM}`
    expect(buildVerifierCommand(EUDEMO_RECEIPT, 'ccd')).toBe(expected)
    renderCard(EUDEMO_RECEIPT, 'ccd')
    await user.click(screen.getByRole('button', { name: 'Copy verifier command' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected))
  })

  it('stale parent asset, reverse → CCD receipt under EUDemo facts → --rail ccd', () => {
    expect(buildVerifierCommand(CCD_RECEIPT, 'eudemo')).toBe(`${CMD} 10 ${PAY} --rail ccd`)
  })

  // Round-6 B-5 latent instance: a Transfer-only EUDemo receipt copies
  // --rail plt with no --reserve-tx, so the verifier fails PLT-13 — the
  // card must disclose that next to the copy button, never silently.
  it('Transfer-only EUDemo receipt → no --reserve-tx and a PLT-13 disclosure next to the copy button', async () => {
    const user = userEvent.setup()
    stubClipboard()
    const expected = `${CMD} 2001 ${TRANSFER} --rail plt`
    expect(buildVerifierCommand(TRANSFER_ONLY_RECEIPT, 'eudemo')).toBe(expected)
    renderCard(TRANSFER_ONLY_RECEIPT, 'eudemo')
    expect(screen.getByText(/fails the verifier’s reservation check \(PLT-13\)/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy verifier command' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected))
    expect(writeText.mock.calls[0][0]).not.toContain('--reserve-tx')
  })

  it('full-leg EUDemo receipt → no PLT-13 disclosure', () => {
    renderCard(EUDEMO_RECEIPT, 'eudemo')
    expect(screen.queryByText(/PLT-13/)).not.toBeInTheDocument()
  })

  // Round-6 B-5 gate: a receipt for another payable renders as stale
  // with no copy button, never as the current receipt.
  it('receipt for another payable → stale notice, no copy button', () => {
    renderStep(EUDEMO_RECEIPT, 10)
    expect(screen.getByText(/This receipt is for payable 11 — you picked payable 10/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy verifier command' })).not.toBeInTheDocument()
  })

  it('receipt for the loaded payable → the card renders with its copy button', () => {
    renderStep(EUDEMO_RECEIPT, 11)
    expect(screen.queryByText(/This receipt is for payable/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy verifier command' })).toBeInTheDocument()
  })
})
