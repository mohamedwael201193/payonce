import { motion, useInView, useReducedMotion } from 'framer-motion'
import { useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { CopyButton, EASE, Rise, SvgCheck, Tag } from './bits'
import { formatStamp, verifierCommand, type Snapshot } from './data'

const PICK = ['doc', 'status_paid', 'single_transfer_to_payee', 'registry_zero']

export function docFileFor(id: number, asset: string): string {
  return `../backend/test/invoices/invoice-${String(id).padStart(3, '0')}-v2-${asset}.txt`
}

/** Section 7: four checks with self-drawing marks, and the exact command that re-runs them. */
export function Judges({ snapshot }: { snapshot: Snapshot }) {
  const ref = useRef<HTMLDivElement>(null)
  const seen = useInView(ref, { once: true, amount: 0.35 })
  const still = useReducedMotion()
  const v = snapshot.verify
  const facts = snapshot.facts
  const payTx = snapshot.recorded_steps?.steps.find((s) => s.step === 'pay')?.txHash ?? null

  const checks = useMemo(() => (v ? PICK.map((id) => v.checks.find((c) => c.id === id)).filter(Boolean) : []), [v])
  const command = facts && payTx ? verifierCommand(facts.payable_id, payTx, docFileFor(facts.payable_id, facts.asset)) : null
  if (!v || !command) return null

  return (
    <section className="po-judges po-section" id="judges" aria-label="For judges">
      <div className="po-wrap po-judges__grid" ref={ref}>
        <div>
          <Rise as="h2" text={'Check it yourself.\nNo account needed.'} className="po-h2" />
          <ul className="po-checks">
            {checks.map((c, i) => (
              <li key={c!.id}>
                <SvgCheck on={seen} delay={i * 0.35} />
                <span>{c!.label}</span>
              </li>
            ))}
          </ul>
          <p className="po-judges__note">
            <Tag kind="recorded">Recorded {formatStamp(v.checked_at)}</Tag>
            <span>Results from payable {v.payable_id}. The script is read-only: no keys, no .env, nothing sent.</span>
          </p>
          <Link to="/app/proof/judges" className="po-btn po-btn--solid">
            Open the judges page
          </Link>
        </div>
        <div className="po-cli" data-dark>
          <header>
            <span>Terminal</span>
            <CopyButton text={command} label="Copy command" />
          </header>
          <pre className="po-mono">
            <span className="po-cli__cmd">$ {command}</span>
            {'\n'}
            {v.checks.map((c, i) => (
              <motion.span
                key={c.id}
                className="po-cli__line"
                initial={{ opacity: still ? 1 : 0 }}
                animate={{ opacity: seen || still ? 1 : 0 }}
                transition={{ duration: 0.3, ease: EASE, delay: still ? 0 : 0.4 + i * 0.11 }}
              >
                {c.status === 'ok' ? 'ok    ' : 'FAIL  '}
                {c.label}
                {'\n'}
              </motion.span>
            ))}
            <span className="po-cli__sum">
              {v.passed === v.total ? `ALL CHECKS PASS (${v.passed}/${v.total})` : `${v.passed} of ${v.total} checks passed`}
            </span>
          </pre>
        </div>
      </div>
    </section>
  )
}
