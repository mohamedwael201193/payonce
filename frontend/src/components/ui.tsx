// Shared UI primitives. Copy rules (P3 §2) and accessibility (P3 §13) live here:
// every disabled button stays focusable with aria-describedby pointing at its
// reason; every status colour comes with a word; icons always come with text.
import { useState, type ReactNode } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { truncHash } from '../lib/format'
import { LAYER_LABEL } from '../lib/copy'
import type { Layer } from '../lib/types'

export function LayerBadge({ layer }: { layer: Layer }) {
  const style: Record<Layer, string> = {
    chain: 'bg-refused-bg text-refused',
    co_signer: 'bg-unpaid-bg text-unpaid',
    app: 'bg-paper-2 text-ink',
    node: 'bg-paper-2 text-ink',
    server: 'bg-paper-2 text-ink',
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style[layer]}`}
    >
      {LAYER_LABEL[layer] ?? layer}
    </span>
  )
}

export function StatusChip({
  tone,
  children,
}: {
  tone: 'verified' | 'unpaid' | 'refused' | 'neutral'
  children: ReactNode
}) {
  const style = {
    verified: 'bg-verified-bg text-verified',
    unpaid: 'bg-unpaid-bg text-unpaid',
    refused: 'bg-refused-bg text-refused',
    neutral: 'bg-paper-2 text-ink',
  } as const
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style[tone]}`}>
      {children}
    </span>
  )
}

export function StepCard({
  number,
  title,
  status,
  children,
  summary,
}: {
  number: string
  title: string
  status?: 'idle' | 'active' | 'done' | 'blocked' | 'error'
  children: ReactNode
  summary?: ReactNode
}) {
  const chip =
    status === 'done'
      ? <StatusChip tone="verified">Done</StatusChip>
      : status === 'blocked'
        ? <StatusChip tone="refused">Blocked</StatusChip>
        : status === 'error'
          ? <StatusChip tone="refused">Error</StatusChip>
          : status === 'active'
            ? <StatusChip tone="unpaid">In progress</StatusChip>
            : null
  return (
    <section aria-labelledby={`step-${number}-title`} className="rounded-none border border-line bg-card p-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id={`step-${number}-title`} className="flex items-baseline gap-3 text-xl font-medium tracking-[-0.01em] text-ink">
          <span className="text-sm font-normal tracking-[0.02em] text-muted">{number}</span>
          {title}
        </h2>
        {chip}
      </div>
      <div className="mt-3">{children}</div>
      {summary ? <div className="mt-4 border-t border-line pt-4 text-sm">{summary}</div> : null}
    </section>
  )
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  disabledReason,
  id,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  disabledReason?: string | null
  id?: string
  className?: string
}) {
  const reasonId = id ? `${id}-reason` : undefined
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        id={id}
        type="button"
        onClick={disabled ? undefined : onClick}
        aria-disabled={disabled ? 'true' : undefined}
        aria-describedby={disabled && disabledReason && reasonId ? reasonId : undefined}
        className={`inline-flex min-h-[44px] items-center justify-center rounded-[4px] bg-brand-600 px-5 py-2.5 text-[15px] font-medium text-white transition-colors hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      >
        {children}
      </button>
      {disabled && disabledReason ? (
        <span id={reasonId} className="text-sm text-muted">
          {disabledReason}
        </span>
      ) : null}
    </span>
  )
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
  disabledReason,
  id,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  disabledReason?: string | null
  id?: string
  className?: string
}) {
  const reasonId = id ? `${id}-reason` : undefined
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        id={id}
        type="button"
        onClick={disabled ? undefined : onClick}
        aria-disabled={disabled ? 'true' : undefined}
        aria-describedby={disabled && disabledReason && reasonId ? reasonId : undefined}
        className={`inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-line bg-card px-5 py-2.5 text-[15px] font-medium text-ink transition-colors hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      >
        {children}
      </button>
      {disabled && disabledReason ? (
        <span id={reasonId} className="text-sm text-muted">
          {disabledReason}
        </span>
      ) : null}
    </span>
  )
}

export function AlertInline({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'info' }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={`mt-3 rounded-md border px-4 py-3 text-sm ${
        tone === 'error' ? 'border-refused bg-refused-bg text-refused' : 'border-line bg-paper-2 text-ink'
      }`}
    >
      {children}
    </div>
  )
}

export function HashLink({
  hash,
  explorerBase,
  label,
}: {
  hash: string
  explorerBase: string
  label?: string
}) {
  const text = label ?? truncHash(hash)
  return (
    <a
      href={`${explorerBase}${hash}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono text-sm text-brand-700 underline decoration-line underline-offset-2 hover:decoration-brand-700"
      aria-label={`Open transaction ${hash} on the explorer (new tab)`}
    >
      {text}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  )
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          setCopied(false)
        }
      }}
      className="inline-flex items-center gap-1 rounded-[4px] border border-line bg-card px-2 py-1 text-xs font-medium text-ink hover:border-ink focus-visible:outline-2 focus-visible:outline-brand-600"
      aria-label={`Copy ${label}`}
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      {copied ? 'Copied.' : `Copy ${label}`}
    </button>
  )
}
