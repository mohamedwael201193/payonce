// Step 1 — Invoice (P3 §5 InvoiceSource, §7.1).
// Lab picker, drop zone, file picker, paste box, payable number field.
// The document fingerprint (SHA-256) is computed in the browser with
// WebCrypto; the file is never uploaded. The payable number is read from the
// document text when present.
import { useCallback, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, FileUp, Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { ApiError } from '../lib/types'
import { COPY } from '../lib/copy'
import { truncHash } from '../lib/format'
import { useInvoices, useConfig } from '../hooks/useApi'
import { AlertInline, PrimaryButton, SecondaryButton, StepCard } from './ui'

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Read a payable number from lab invoice text ("Payable 2", "payable #2"). */
export function extractPayableId(text: string): number | null {
  const m = /payable\s*#?\s*(\d+)/i.exec(text)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function InvoiceStep({
  onLoaded,
  onNumber,
  onFresh,
  budgetLeft,
}: {
  onLoaded: (docText: string, docSha256: string, payableId: number | null) => void
  onNumber: (id: number) => void
  onFresh: (asset: 'ccd' | 'eudemo') => void
  budgetLeft: number | null
}) {
  const invoices = useInvoices()
  const config = useConfig()
  const [paste, setPaste] = useState('')
  const [number, setNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [foundId, setFoundId] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadText = useCallback(
    async (text: string) => {
      setBusy(true)
      setError(null)
      try {
        const hash = await sha256Hex(text)
        const id = extractPayableId(text)
        setFingerprint(hash)
        setFoundId(id)
        onLoaded(text, hash, id)
      } catch {
        setError('This file could not be read as text. Lab invoices are plain text.')
      } finally {
        setBusy(false)
      }
    },
    [onLoaded],
  )

  const loadFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text()
        await loadText(text)
      } catch {
        setError('This file could not be read as text. Lab invoices are plain text.')
      }
    },
    [loadText],
  )

  const loadLab = useCallback(
    async (id: number) => {
      setBusy(true)
      setError(null)
      try {
        const text = await api.getDocument(id)
        await loadText(text)
        onNumber(id)
      } catch (e) {
        setError(
          e instanceof ApiError
            ? e.body.message
            : 'The lab invoice list is not reachable. Paste the invoice text instead.',
        )
      } finally {
        setBusy(false)
      }
    },
    [loadText, onNumber],
  )

  const items = invoices.data ?? []
  const emptyPool = !invoices.isLoading && !invoices.isError && items.length === 0
  // P3 §1: steps 1–3 fit without scrolling at 1440×900. The lab picker is the
  // primary path and stays visible; file / paste / number live behind one
  // disclosure so the idle card is ~210 px tall instead of ~560 px.
  const [showMoreWays, setShowMoreWays] = useState(false)

  return (
    <StepCard number="01" title="Pick an invoice" status={fingerprint ? 'done' : 'idle'}>
      <p className="text-[15px] text-muted">{COPY.step1Helper}</p>

      {invoices.isError ? (
        <AlertInline>The lab invoice list is not reachable. Paste the invoice text instead.</AlertInline>
      ) : null}

      {emptyPool ? (
        <div className="mt-4 rounded-md border border-line bg-paper-2 p-4">
          <p className="text-sm text-ink">
            No unpaid lab invoices are open right now. Make a fresh one (about 8 s, costs a testnet fee).
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <PrimaryButton
              onClick={() => onFresh('ccd')}
              disabled={budgetLeft !== null && budgetLeft <= 0}
              disabledReason={
                budgetLeft !== null && budgetLeft <= 0
                  ? 'The demo’s budget for new invoices is used up for this hour. Use a lab invoice.'
                  : null
              }
            >
              Make a fresh lab invoice (CCD)
            </PrimaryButton>
            <SecondaryButton
              onClick={() => onFresh('eudemo')}
              disabled={budgetLeft !== null && budgetLeft <= 0}
              disabledReason={
                budgetLeft !== null && budgetLeft <= 0
                  ? 'The demo’s budget for new invoices is used up for this hour. Use a lab invoice.'
                  : null
              }
            >
              Make a fresh lab invoice (EUDemo)
            </SecondaryButton>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <label htmlFor="lab-invoice" className="text-sm font-medium text-ink">
            {COPY.labPickerLabel}
          </label>
          <select
            id="lab-invoice"
            className="mt-1 block w-full rounded-[4px] border border-line bg-card px-3 py-2.5 text-[16px] text-ink focus-visible:outline-2 focus-visible:outline-brand-600"
            defaultValue=""
            onChange={(e) => {
              const id = Number.parseInt(e.target.value, 10)
              if (Number.isFinite(id) && id > 0) void loadLab(id)
            }}
            disabled={busy || invoices.isLoading}
          >
            <option value="" disabled>
              {invoices.isLoading ? 'Loading lab invoices…' : 'Choose a lab invoice…'}
            </option>
            {items.map((it) => (
              <option key={it.payable_id} value={it.payable_id}>
                Payable {it.payable_id} · {it.amount_display} · {it.status}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowMoreWays((v) => !v)}
          aria-expanded={showMoreWays}
          aria-controls="invoice-more-ways"
          className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          {showMoreWays ? (
            <ChevronUp className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          )}
          {showMoreWays ? 'Hide other ways to load an invoice' : 'Other ways to load an invoice (file, paste, number)'}
        </button>
      </div>

      {showMoreWays ? (
        <div id="invoice-more-ways">
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const f = e.dataTransfer.files?.[0]
              if (f) void loadFile(f)
            }}
            className="flex min-h-[88px] w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line bg-paper px-4 py-3 text-sm text-ink transition-colors hover:border-ink focus-visible:outline-2 focus-visible:outline-brand-600"
          >
            <FileUp className="h-5 w-5" aria-hidden="true" />
            Drop a file here, or choose one
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void loadFile(f)
              e.target.value = ''
            }}
          />
        </div>
        <div>
          <label htmlFor="paste-invoice" className="text-sm font-medium text-ink">
            Paste the invoice text
          </label>
          <textarea
            id="paste-invoice"
            rows={3}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="Paste the invoice text here…"
            className="mt-1 block w-full rounded-[4px] border border-line bg-card px-3 py-2.5 text-[16px] text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-brand-600"
          />
          <div className="mt-2">
            <SecondaryButton onClick={() => void loadText(paste)} disabled={!paste.trim() || busy} disabledReason={!paste.trim() ? 'Paste the invoice text first.' : null}>
              Use pasted text
            </SecondaryButton>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="payable-number" className="text-sm font-medium text-ink">
            Or type a payable number
          </label>
          <input
            id="payable-number"
            type="number"
            min={1}
            inputMode="numeric"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="e.g. 2"
            className="mt-1 block w-full rounded-[4px] border border-line bg-card px-3 py-2.5 text-[16px] text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-brand-600 sm:w-40"
          />
        </div>
        <SecondaryButton
          onClick={() => {
            const id = Number.parseInt(number, 10)
            if (Number.isFinite(id) && id > 0) onNumber(id)
          }}
          disabled={!/^\d+$/.test(number.trim())}
          disabledReason="Type a payable number from the invoice."
        >
          Use this number
        </SecondaryButton>
      </div>
        </div>
      ) : null}

      {busy ? (
        <p className="mt-4 inline-flex items-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Computing the document fingerprint in your browser…
        </p>
      ) : null}

      {fingerprint ? (
        <div className="mt-4 rounded-md border border-line bg-paper-2 p-4 text-sm" aria-live="polite">
          <p className="text-ink">
            {foundId
              ? `Found payable ${foundId} in this document. Fingerprint ${truncHash(fingerprint)}.`
              : 'This document does not show a payable number. Type it in the box, or pick a lab invoice.'}
          </p>
          <p className="mt-1 font-mono text-xs text-muted break-all">SHA-256: {fingerprint}</p>
        </div>
      ) : null}

      {config.data ? (
        <p className="mt-3 text-xs text-muted">
          Registry &lt;{config.data.registry.index},{config.data.registry.subindex}&gt; · Reservation (reserve)
          window {config.data.reservation_secs}s · Co-signer (the second approver) margin{' '}
          {config.data.co_signer_margin_secs}s
        </p>
      ) : null}

      {error ? <AlertInline>{error}</AlertInline> : null}
    </StepCard>
  )
}
