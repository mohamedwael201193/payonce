// One step of the /app/sell timeline in the dashboard design: a numbered node on a rail, content in a white card.
import type { ReactNode } from 'react'
import type { StepState } from '../wallet/WalletUI'

export function SellStep({ n, title, state, children }: { n: number; title: string; state: StepState; children?: ReactNode }) {
  return (
    <li className={`ds-step is-${state}`} aria-current={state === 'active' ? 'step' : undefined} data-state={state}>
      <span className="ds-step__node" aria-hidden>{state === 'done' ? '✓' : state === 'failed' ? '×' : n}</span>
      <div className="ds-step__card">
        <h2 className="ds-step__h">{title}<span className="sr-only"> ({state === 'done' ? 'done' : state === 'active' ? 'current' : state === 'failed' ? 'failed' : 'waiting'})</span></h2>
        {state !== 'todo' && children ? <div className="ds-step__body">{children}</div> : null}
      </div>
    </li>
  )
}
