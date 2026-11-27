// App UI primitives. Plain words, real targets (44px), one primary action
// per view. Disabled controls stay focusable and say why. Nothing here
// starts at opacity 0.
import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import { EXPLORER_TX } from '../lib/tokens'
import type { Layer } from '../lib/types'
import { useConfig } from '../hooks/useApi'
import type { DataSource } from './hooks'
import { recordedLabel } from './fees'
import { Address } from './Address'

// ---------- buttons ----------

export type Variant = 'primary' | 'secondary' | 'ink' | 'ghost' | 'danger'
export type Size = 'sm' | 'md' | 'lg'
const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'po-btn po-btn-primary',
  secondary: 'po-btn po-btn-secondary',
  ink: 'po-btn po-btn-ink',
  ghost: 'po-btn po-btn-ghost',
  danger: 'po-btn po-btn-danger',
}
const SIZE_CLASS: Record<Size, string> = { sm: 'po-btn-sm', md: '', lg: 'po-btn-lg' }
const btnClass = (variant: Variant, size: Size | undefined, small: boolean | undefined, extra = '') =>
  [VARIANT_CLASS[variant], SIZE_CLASS[size ?? (small ? 'sm' : 'md')], extra].filter(Boolean).join(' ')

/** Neighbouring buttons always sit in a group with a real gap. */
export function ButtonRow({ children, stack, className = '' }: { children: ReactNode; stack?: boolean; className?: string }) {
  return <div className={`po-btn-row ${stack ? 'po-btn-row--stack' : ''} ${className}`}>{children}</div>
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  size,
  disabled,
  disabledReason,
  busy,
  id,
  className = '',
  small,
  type = 'button',
}: {
  size?: Size
  children: ReactNode
  onClick?: () => void
  variant?: Variant
  disabled?: boolean
  /** Shown under the button and wired as its description. */
  disabledReason?: string | null
  busy?: boolean
  id?: string
  className?: string
  small?: boolean
  type?: 'button' | 'submit'
}) {
  const reasonId = id && disabledReason ? `${id}-reason` : undefined
  const off = Boolean(disabled || busy)
  return (
    <div className={`inline-flex max-w-full flex-col items-start gap-2 ${className.includes('w-full') ? 'w-full' : ''}`}>
      <button
        id={id}
        type={type}
        onClick={off ? undefined : onClick}
        aria-disabled={off ? 'true' : undefined}
        aria-describedby={off && reasonId ? reasonId : undefined}
        className={btnClass(variant, size, small, className)}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        {children}
      </button>
      {off && disabledReason ? (
        <span id={reasonId} className="text-sm text-po-grey">
          {disabledReason}
        </span>
      ) : null}
    </div>
  )
}

export function ButtonLink({
  to,
  children,
  variant = 'secondary',
  small,
  size,
  className = '',
  ...rest
}: { variant?: Variant; size?: Size; small?: boolean; className?: string; children: ReactNode } & Omit<LinkProps, 'className'>) {
  return (
    <Link to={to} className={btnClass(variant, size, small, className)} {...rest}>
      {children}
    </Link>
  )
}

export function ExternalButtonLink({
  href,
  children,
  small,
}: {
  href: string
  children: ReactNode
  small?: boolean
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={btnClass('secondary', undefined, small)}>
      {children}
      <ExternalLink className="h-4 w-4" aria-hidden="true" />
    </a>
  )
}

// ---------- tags and status ----------

export function SourceTag({ source, asOf }: { source: DataSource; asOf?: string | null }) {
  if (source === 'loading') return null
  if (source === 'live') {
    return (
      <span className="po-tag po-tag-live" title="Fetched from the live API on this visit">
        <i className="po-live-dot" aria-hidden="true" />
        LIVE
      </span>
    )
  }
  return (
    <span className="po-tag po-tag-recorded" title={recordedLabel(asOf)}>
      RECORDED
    </span>
  )
}

export function IllustrationTag() {
  return (
    <span className="po-tag po-tag-illustration" title="Not a live result">
      ILLUSTRATION
    </span>
  )
}

const LAYER_NAME: Record<Layer, string> = {
  chain: 'Chain',
  co_signer: 'Co-signer',
  app: 'App',
  node: 'Node',
  server: 'Server',
}

export function LayerLabel({ layer }: { layer: Layer }) {
  const tone = layer === 'chain' ? 'po-chip-bad' : layer === 'co_signer' ? 'po-chip-warn' : 'po-chip-neutral'
  return (
    <span className={`po-chip ${tone}`}>
      {LAYER_NAME[layer] ?? layer}
    </span>
  )
}

export function StatusPill({ tone, children }: { tone: 'ok' | 'bad' | 'warn' | 'neutral'; children: ReactNode }) {
  const cls = { ok: 'po-chip-ok', bad: 'po-chip-bad', warn: 'po-chip-warn', neutral: 'po-chip-neutral' }[tone]
  return <span className={`po-chip ${cls}`}>{children}</span>
}

// ---------- layout atoms ----------

export function PageHeader({
  title,
  lead,
  actions,
}: {
  title: string
  lead?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <h1 className="text-[32px] leading-[1.08] font-semibold tracking-[-0.03em] text-po-ink sm:text-[44px]">{title}</h1>
        {lead ? <p className="mt-3 max-w-[60ch] text-[17px] text-po-grey">{lead}</p> : null}
      </div>
      {actions ? <div className="po-btn-row">{actions}</div> : null}
    </header>
  )
}

export function Card({
  children,
  className = '',
  as: Tag = 'section',
  ...rest
}: {
  children: ReactNode
  className?: string
  as?: ElementType
  [k: string]: unknown
}) {
  return (
    <Tag className={`po-card p-5 sm:p-6 ${className}`} {...rest}>
      {children}
    </Tag>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`po-skel ${className}`} />
}

export function Notice({
  tone = 'info',
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'error'
  children: ReactNode
  action?: ReactNode
}) {
  const cls = {
    info: 'border-po-line bg-po-surface text-po-ink',
    warn: 'border-po-warn bg-po-warn-bg text-po-warn',
    error: 'border-po-bad bg-po-bad-bg text-po-bad',
  }[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex flex-wrap items-center justify-between gap-3 rounded-[10px] border px-4 py-3 text-[15px] ${cls}`}
    >
      <div className="min-w-0">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="po-card flex flex-col items-start gap-3 p-6">
      <h2 className="text-lg font-medium text-po-ink">{title}</h2>
      {children ? <p className="max-w-[56ch] text-po-grey">{children}</p> : null}
      {action}
    </div>
  )
}

// ---------- hashes and explorer links ----------

export function useExplorerBase(): string {
  const config = useConfig()
  return config.data?.explorer.tx ?? EXPLORER_TX
}

export function ExplorerTx({ hash, base, label }: { hash: string; base?: string; label?: string }) {
  const fallback = useExplorerBase()
  const b = base ?? fallback
  if (!label) return <Address value={hash} kind="tx" label="transaction hash" explorerBase={b} />
  return (
    <a
      href={b + hash}
      target="_blank"
      rel="noreferrer"
      aria-label={"Open transaction " + hash + " on the testnet explorer (new tab)"}
      className="inline-flex min-h-[44px] items-center gap-1.5 py-1 font-mono text-[13px] text-po-accent-ink underline decoration-po-line-strong"
    >
      {label}
      <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </a>
  )
}

export function CopyButton({ value, label, small = true }: { value: string; label: string; small?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 2000)
        } catch {
          setCopied(false)
        }
      }}
      className={btnClass('secondary', undefined, small)}
    >
      {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      {copied ? 'Copied' : `Copy ${label}`}
    </button>
  )
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-sm font-medium text-po-grey">{label}</dt>
      <dd className="min-w-0 text-[15px] text-po-ink">{children}</dd>
    </div>
  )
}

// ---------- confirm sheet ----------

/** Review-before-pay sheet: role=dialog, aria-modal, focus lands on the
    confirm control, Tab stays inside, Escape and the scrim cancel. On
    narrow screens it is a bottom sheet. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  initialFocusId,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  initialFocusId: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    returnTo.current = document.activeElement as HTMLElement | null
    const raf = requestAnimationFrame(() => {
      const target = document.getElementById(initialFocusId) ?? ref.current?.querySelector<HTMLElement>('button')
      target?.focus()
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !ref.current) return
      const focusable = Array.from(
        ref.current.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, summary, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true')
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey, true)
      returnTo.current?.focus?.()
    }
  }, [open, onClose, initialFocusId])

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6">
          <motion.div
            key="scrim"
            className="absolute inset-0 bg-[rgba(24,25,20,0.5)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            data-testid="sheet-scrim"
          />
          <motion.div
            key="sheet"
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="relative max-h-[92dvh] w-full max-w-[560px] overflow-y-auto rounded-t-[24px] bg-po-surface p-6 shadow-[var(--po-shadow-2)] sm:rounded-[24px] sm:p-8"
            style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            {children}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  )
}
