import { useMemo } from 'react'
import { RECORDED_REFUSALS } from '../lib/recorded'
import { Rise } from './bits'
import { instanceUrl, shortHash, txUrl, type Snapshot } from './data'

interface Item {
  key: string
  kind: 'paid' | 'refused' | 'registered'
  label: string
  hash: string
}

export function proofItems(s: Snapshot): { a: Item[]; b: Item[] } {
  const pays: Item[] = []
  for (const r of s.receipts) {
    for (const t of r.txs) {
      pays.push({ key: `p-${t.tx_hash}`, kind: 'paid', label: `Payable ${r.payable_id}, ${t.label.toLowerCase()}`, hash: t.tx_hash })
    }
  }
  const refused: Item[] = RECORDED_REFUSALS.map((r) => ({
    key: `r-${r.txHash}`,
    kind: 'refused',
    label: `Refused ${r.code} ${r.name}`,
    hash: r.txHash,
  }))
  const reg = s.recorded_steps?.steps.find((x) => x.step === 'register' && x.txHash)
  const registered: Item[] = reg?.txHash
    ? [{ key: `g-${reg.txHash}`, kind: 'registered', label: `Payable ${s.recorded_steps?.payable_id}, registered`, hash: reg.txHash }]
    : []
  const half = Math.ceil(pays.length / 2)
  return { a: [...pays.slice(0, half), ...registered], b: [...refused, ...pays.slice(half)] }
}

function Chip({ it, hidden }: { it: Item; hidden?: boolean }) {
  return (
    <li>
      <a
        href={txUrl(it.hash)}
        target="_blank"
        rel="noreferrer"
        className={`po-hashchip po-hashchip--${it.kind}`}
        tabIndex={hidden ? -1 : undefined}
      >
        <span>{it.label}</span>
        <b className="po-mono">{shortHash(it.hash)}</b>
      </a>
    </li>
  )
}

function Marquee({ items, reverse, label }: { items: Item[]; reverse?: boolean; label: string }) {
  return (
    <div className={`po-marq${reverse ? ' is-rev' : ''}`} role="group" aria-label={label}>
      <ul className="po-marq__track">
        {items.map((it) => (
          <Chip key={it.key} it={it} />
        ))}
        {items.map((it) => (
          <li key={`d-${it.key}`} aria-hidden className="po-marq__dup">
            <a href={txUrl(it.hash)} target="_blank" rel="noreferrer" tabIndex={-1} className={`po-hashchip po-hashchip--${it.kind}`}>
              <span>{it.label}</span>
              <b className="po-mono">{shortHash(it.hash)}</b>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Section 6: proof wall. Two opposing marquees of real transaction hashes, linked to the explorer. */
export function Proof({ snapshot }: { snapshot: Snapshot }) {
  const { a, b } = useMemo(() => proofItems(snapshot), [snapshot])
  const reg = snapshot.config?.registry
  return (
    <section className="po-proof po-section" id="proof" aria-label="Proof">
      <div className="po-wrap">
        <Rise as="h2" text={'Every claim has\na transaction.'} className="po-h2" />
        <p className="po-p po-proof__lead">
          Each chip below is a real testnet transaction. Open one on the explorer and read it yourself.
        </p>
      </div>
      <div className="po-proof__marq">
        <Marquee items={a} label="Payments and registrations on testnet" />
        <Marquee items={b} reverse label="Refused attempts and payments on testnet" />
      </div>
      <div className="po-wrap po-proof__foot">
        <ul className="po-proof__stack">
          <li>Registry contract{reg ? ' ' : ''}{reg && (
            <a className="po-link po-mono" href={instanceUrl(reg.index, reg.subindex)} target="_blank" rel="noreferrer">
              {`<${reg.index},${reg.subindex}>`}
            </a>
          )} on Concordium testnet</li>
          <li>CIS-8004 agent registry for the seller agent</li>
          <li>
            Read-only verifier script{' '}
            <span className="po-mono">{snapshot.config?.verifier.file ?? 'verify-payable-v2.mjs'}</span>
          </li>
          <li>React, Vite and TypeScript front end</li>
        </ul>
      </div>
    </section>
  )
}
