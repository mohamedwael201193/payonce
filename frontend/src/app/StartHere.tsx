// StartHere: three steps, ticked from what actually happened in this
// browser (a check that came back, a payment that finished, a receipt that
// was opened). One primary action: the first step that is not done. It
// hides itself when all three are done, or when dismissed.
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Check } from 'lucide-react'
import type { InvoiceItem } from '../lib/types'
import { itemKey, payPath, receiptPath } from './keys'
import { useFlag } from './hooks'
import { ButtonLink, Card } from './ui'

export function StartHere({ items }: { items: InvoiceItem[] }) {
  const [verified] = useFlag('step.verified')
  const [paid] = useFlag('step.paid')
  const [receipt] = useFlag('step.receipt')
  const [dismissed, setDismissed] = useFlag('start.hidden')

  const firstOpen = items.find((i) => i.status !== 'paid')
  const latestPaid = [...items].filter((i) => i.status === 'paid').sort((a, b) => b.payable_id - a.payable_id)[0]
  const payTo = firstOpen ? payPath(itemKey(firstOpen)) : '/app/pay'

  const steps = [
    {
      done: verified === '1',
      title: 'Check an invoice',
      text: 'Read it against the chain. Nothing is paid.',
      cta: 'Check an invoice',
      to: payTo,
    },
    {
      done: paid === '1',
      title: 'Pay a test invoice',
      text: 'One payment on testnet, no wallet needed.',
      cta: 'Pay a test invoice',
      to: payTo,
    },
    {
      done: receipt === '1',
      title: 'Open a receipt',
      text: 'See the payment re-read from the chain.',
      cta: 'Open a receipt',
      to: latestPaid ? receiptPath(itemKey(latestPaid)) : '/app/invoices',
    },
  ]
  const doneCount = steps.filter((s) => s.done).length
  if (dismissed === '1' || doneCount === steps.length) return null
  const current = steps.findIndex((s) => !s.done)

  return (
    <Card aria-labelledby="start-title" data-testid="start-here">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="start-title" className="text-xl font-medium text-po-ink">
            Start here
          </h2>
          <p className="mt-1 text-po-grey">
            {doneCount} of {steps.length} done.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed('1')}
          className="min-h-[44px] rounded-[10px] px-3 text-sm font-medium text-po-grey underline decoration-po-line-strong hover:text-po-ink"
        >
          Hide this
        </button>
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-po-sunken" aria-hidden="true">
        <motion.div
          className="h-full origin-left rounded-full bg-po-accent"
          initial={false}
          animate={{ scaleX: doneCount / steps.length }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        />
      </div>
      <ol className="mt-5 grid gap-4 md:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex flex-col gap-3 rounded-[10px] bg-po-sunken/60 p-4">
            <div className="flex items-center gap-3">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                  s.done ? 'bg-po-ok-bg text-po-ok' : 'bg-po-surface text-po-ink ring-1 ring-po-line-strong'
                }`}
              >
                {s.done ? <Check className="h-4 w-4" aria-label="Done" /> : i + 1}
              </span>
              <h3 className="font-medium text-po-ink">{s.title}</h3>
            </div>
            <p className="text-[15px] text-po-grey">{s.text}</p>
            {s.done ? null : i === current ? (
              <ButtonLink to={s.to} variant="primary" className="mt-auto self-start">
                {s.cta}
              </ButtonLink>
            ) : (
              <Link
                to={s.to}
                className="mt-auto inline-flex min-h-[44px] items-center font-medium text-po-accent-ink underline decoration-po-line-strong"
              >
                {s.cta}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Card>
  )
}
