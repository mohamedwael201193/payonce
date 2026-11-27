// Address / Hash: one reusable way to show a long on-chain value.
// One line, monospace, ink colour, middle-truncated (first 6 ... last 6). The
// full value is in the tooltip, in the accessible text, behind a copy button
// and, when asked for, behind an explorer link. "Show all" expands it to the
// whole value, wrapped with overflow-wrap:anywhere (only when expanded).
import { useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { EXPLORER_INSTANCE, EXPLORER_TX } from '../lib/tokens'

/** First 6 ... last 6. Short values are shown whole. */
export function midTruncate(value: string, head = 6, tail = 6): string {
  if (!value) return '-'
  if (value.length <= head + tail + 1) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

export type AddressKind = 'account' | 'tx' | 'instance' | 'hash'

export function explorerHref(kind: AddressKind, value: string, base?: string): string | null {
  if (kind === 'tx') return `${base ?? EXPLORER_TX}${value}`
  if (kind === 'instance') return `${base ?? EXPLORER_INSTANCE}${value}`
  if (kind === 'account') return `https://ccdexplorer.io/testnet/account/${value}`
  return null
}

export function Address({
  value,
  label = 'value',
  kind = 'hash',
  explorer,
  explorerBase,
  copy = true,
  expandable = false,
  className = '',
}: {
  value: string
  /** Names the value for the copy button and screen readers: "payee", "document hash". */
  label?: string
  kind?: AddressKind
  /** Show an explorer link. Defaults to true for accounts and transactions. */
  explorer?: boolean
  explorerBase?: string
  copy?: boolean
  /** Offer a "Show all" toggle that wraps the whole value. */
  expandable?: boolean
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const href = explorerHref(kind, value, explorerBase)
  const showLink = (explorer ?? (kind === 'account' || kind === 'tx')) && href !== null
  const truncated = midTruncate(value)
  const canExpand = expandable && truncated !== value

  return (
    <span className={`po-addr ${open ? 'is-open' : ''} ${className}`} data-testid="address">
      <code className="po-addr__text" title={value}>
        {open || truncated === value ? (
          value
        ) : (
          <>
            <span className="sr-only">{value}</span>
            <span aria-hidden="true">{truncated}</span>
          </>
        )}
      </code>
      <span className="po-addr__tools">
        {copy ? (
          <button
            type="button"
            className="po-addr__btn"
            aria-label={`Copy ${label}`}
            title={copied ? 'Copied' : `Copy ${label}`}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1800)
              } catch {
                setCopied(false)
              }
            }}
          >
            {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          </button>
        ) : null}
        {showLink ? (
          <a
            className="po-addr__btn"
            href={href as string}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${label} on the testnet explorer (new tab)`}
            title="Open on the testnet explorer"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
        ) : null}
        {canExpand ? (
          <button type="button" className="po-addr__more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Show less' : 'Show all'}
          </button>
        ) : null}
      </span>
    </span>
  )
}

export const Hash = (props: Omit<Parameters<typeof Address>[0], 'kind'> & { kind?: AddressKind }) => (
  <Address kind="hash" {...props} />
)
