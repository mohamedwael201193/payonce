import { useMotionValueEvent, useReducedMotion, useScroll } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { Rise, Tag } from './bits'
import { formatStamp, instanceUrl, type Snapshot, type SnapshotFacts } from './data'
import { sha256Hex } from './sha256'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** The digit the scroll tampers with when the visitor has not touched anything. */
const AUTO_IDX = 9

/** A different character in the same alphabet, deterministic so the demo is repeatable. */
export function flipChar(c: string): string {
  const i = ALPHABET.indexOf(c)
  return ALPHABET[((i < 0 ? 0 : i) + 17) % ALPHABET.length]
}

export function tamperPayee(payee: string, idx: number): string {
  if (idx < 0 || idx >= payee.length) return payee
  return payee.slice(0, idx) + flipChar(payee[idx]) + payee.slice(idx + 1)
}

/** Re-hash the invoice document with a different payee line. */
export function hashWithPayee(facts: SnapshotFacts, payee: string): string {
  const doc = (facts.document ?? '').replace(`Payee: ${facts.payee}`, `Payee: ${payee}`)
  return sha256Hex(doc)
}

type Manual = { kind: 'none' } | { kind: 'digit'; idx: number } | { kind: 'typed'; value: string }

function pseudo(i: number, salt: number) {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

export function Tamper({ snapshot }: { snapshot: Snapshot }) {
  const facts = snapshot.facts
  const sectionRef = useRef<HTMLElement>(null)
  const hashRef = useRef<HTMLDivElement>(null)
  const still = useReducedMotion()
  const [auto, setAuto] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const [manual, setManual] = useState<Manual>({ kind: 'none' })
  const [liveFacts, setLiveFacts] = useState<{ status: string; at: string } | null>(null)

  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ['start 0.85', 'end 0.3'] })
  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    setAuto(p > 0.3)
    const k = Math.min(1, Math.max(0, (p - 0.55) / 0.35))
    hashRef.current?.style.setProperty('--po-shatter', String(still ? 0 : k))
  })

  // Confirm the chain side live when the API answers.
  useEffect(() => {
    if (!facts) return
    let alive = true
    api
      .getPayable(facts.payable_id, facts.seller)
      .then((f) => {
        if (alive && f.doc_sha256 === facts.doc_sha256 && f.payee === facts.payee) {
          setLiveFacts({ status: f.status.kind, at: new Date().toISOString() })
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [facts])

  const payee = facts?.payee ?? ''
  const effective = useMemo(() => {
    if (manual.kind === 'typed') return manual.value
    if (hover !== null) return tamperPayee(payee, hover)
    if (manual.kind === 'digit') return tamperPayee(payee, manual.idx)
    if (auto) return tamperPayee(payee, AUTO_IDX)
    return payee
  }, [manual, hover, auto, payee])

  const chainHash = facts?.doc_sha256 ?? ''
  const hash = useMemo(() => (facts ? hashWithPayee(facts, effective) : ''), [facts, effective])
  const match = hash === chainHash
  const hashChars = useMemo(
    () =>
      hash.split('').map((c, i) => ({
        c,
        same: c === chainHash[i],
        dx: (pseudo(i, 1) - 0.5) * 70,
        dy: (pseudo(i, 2) - 0.5) * 46 - 8,
        dr: (pseudo(i, 3) - 0.5) * 80,
      })),
    [hash, chainHash],
  )

  if (!facts || !facts.document) return null

  const docLines = facts.document.split('\n')
  const payeeLineIdx = docLines.findIndex((l) => l.startsWith('Payee: '))
  const padded = effective.padEnd(payee.length, ' ')

  return (
    <section ref={sectionRef} className="po-tamper po-section" id="tamper" aria-label="Tamper test">
      <div className="po-wrap">
        <Rise as="h2" text={'Change one digit.\nThe hash changes with it.'} className="po-h2" />
        <p className="po-p po-tamper__lead">
          The payee account is part of the invoice document, and the document&apos;s SHA-256 is stored on chain. Hover a
          digit of the payee, or type a new one: the hash of your copy changes and the check refuses it. The record on
          chain does not move.
        </p>
        <div className="po-tamper__grid">
          <article className={`po-doc ${match ? 'is-match' : 'is-broken'}`} aria-label="Invoice document, editable copy">
            <header>
              <strong>Your copy of the invoice</strong>
              <Tag kind="recorded">Document of payable {facts.payable_id}, {formatStamp(snapshot.captured_at).slice(0, 11)}</Tag>
            </header>
            <pre className="po-doc__text" aria-label="Invoice text">
              {docLines.map((line, li) =>
                li === payeeLineIdx ? (
                  <span key={li} className="po-doc__line">
                    Payee:{' '}
                    <span className="po-doc__payee" onPointerLeave={() => setHover(null)}>
                      {padded.split('').map((ch, i) => (
                        <span
                          key={i}
                          className={`po-doc__ch${ch !== payee[i] ? ' is-changed' : ''}`}
                          onPointerEnter={(e) => {
                            if (e.pointerType === 'mouse') setHover(i)
                          }}
                        >
                          {ch}
                        </span>
                      ))}
                    </span>
                    {'\n'}
                  </span>
                ) : (
                  <span key={li} className="po-doc__line">
                    {line}
                    {li < docLines.length - 1 ? '\n' : ''}
                  </span>
                ),
              )}
            </pre>
            <div className="po-doc__hashhead">SHA-256 of this copy</div>
            <div ref={hashRef} className="po-hash po-mono" aria-label={`SHA-256 of this copy: ${hash}`}>
              {hashChars.map((h, i) => (
                <span
                  key={i}
                  className={`po-hash__c${h.same ? '' : ' is-diff'}`}
                  style={{ ['--dx' as string]: `${h.dx}px`, ['--dy' as string]: `${h.dy}px`, ['--dr' as string]: `${h.dr}deg` }}
                >
                  {h.c}
                </span>
              ))}
            </div>
            <p className={`po-verdict ${match ? 'is-ok' : 'is-bad'}`} role="status" aria-live="polite">
              {match
                ? 'Matches the hash on chain. The check passes.'
                : 'Refused. This is not the document that was registered, so nothing is paid.'}
            </p>
            <div className="po-doc__controls">
              <label>
                <span className="po-sr">Type a different payee account</span>
                <input
                  className="po-input po-mono"
                  value={effective}
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={payee.length + 4}
                  onChange={(e) => {
                    setHover(null)
                    setManual({ kind: 'typed', value: e.target.value })
                  }}
                  aria-label="Payee account in your copy"
                />
              </label>
              <button
                type="button"
                className="po-btn po-btn--solid po-btn--sm"
                onClick={() => {
                  setHover(null)
                  setManual({ kind: 'digit', idx: manual.kind === 'digit' ? (manual.idx + 7) % payee.length : AUTO_IDX })
                }}
              >
                Change one digit
              </button>
              <button
                type="button"
                className="po-btn po-btn--line po-btn--sm"
                onClick={() => {
                  setHover(null)
                  setManual({ kind: 'none' })
                  setAuto(false)
                }}
              >
                Restore
              </button>
            </div>
          </article>
          <article className="po-chain" aria-label="Record on chain">
            <header>
              <strong>On chain, testnet</strong>
              {liveFacts ? (
                <Tag kind="live">Live, {formatStamp(liveFacts.at).slice(-9)}</Tag>
              ) : (
                <Tag kind="recorded">Recorded snapshot</Tag>
              )}
            </header>
            <dl className="po-kv">
              <div>
                <dt>Payee</dt>
                <dd className="po-mono">{facts.payee}</dd>
              </div>
              <div>
                <dt>Document SHA-256</dt>
                <dd className="po-mono">{chainHash}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <span className="po-status po-status--paid">
                    {(liveFacts?.status ?? facts.status) === 'paid' ? 'Paid once' : 'Registered'}
                  </span>
                </dd>
              </div>
              {snapshot.config && (
                <div>
                  <dt>Registry contract</dt>
                  <dd>
                    <a
                      className="po-link po-mono"
                      href={instanceUrl(snapshot.config.registry.index, snapshot.config.registry.subindex)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {`<${snapshot.config.registry.index},${snapshot.config.registry.subindex}>`}
                    </a>
                  </dd>
                </div>
              )}
            </dl>
            <p className="po-chain__steady">
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Unchanged, whatever your copy says.
            </p>
          </article>
        </div>
      </div>
    </section>
  )
}
