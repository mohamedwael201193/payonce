// SSE job events — P3 §16.9. A `step` event per job step and a final `done`
// event. The server never re-sends a payment: a retry returns the existing job.
import { useEffect, useRef, useState } from 'react'
import type { JobSnapshot, JobStep } from '../lib/types'
import { timedFetch } from '../lib/api'

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

// The never-`done` failure exit (FIX-2 fix-back-2): the old hook had no
// bounded exit at all — `es.onerror` unconditionally cleared the error, and
// the snapshot poll only runs after a `done` event. If `done` never arrives
// (stream drops, server/job stalls), the pay sat on `running` forever with
// no error and no receipt. Two bounded exits now close that path, and both
// surface as `error`, which the page turns into a failed pay state
// (PAY_FAILED):
//   1. Silence watchdog — no `data:` event at all for `streamTimeoutMs`
//      after the job starts (or after the last event; a stream still
//      sending steps is a live job, not a stalled one).
//   2. Consecutive stream failures — `maxStreamErrors` `onerror` fires in
//      a row with no event between them, spread over at least
//      `minErrorWindowMs` (see below). A single transient `onerror` is
//      still ignored: EventSource reconnects on its own, and one dropped
//      connection is not a failed pay.
//
// The watchdog bound is 180 s, NOT 60 s (fix-back-3 MF-1: 60 s false-failed
// a legitimately quiet live job). The server's longest silent window is one
// `waitFinalized` poll — 120 s with NO `data:` event during the wait
// (`backend/src/send.mjs:69-84`, via `api/src/chain-v2.mjs:166`) — inside a
// step span that emits only a single `running` event first (CCD
// `wait_finality`, EUDemo `wait_finality`/`reserve`/`confirm`). The EUDemo
// `reserve`/`confirm` spans can additionally spend up to ~24 s in the
// bounded duplicate-nonce send retry (6 attempts, 4 s apart,
// `api/src/chain-v2.mjs:183-195`) before the 120 s wait even starts, so the
// worst legit silence is ~144 s; 180 s covers it with ~36 s of margin. The
// server's 5 s heartbeat is an SSE `: ping` COMMENT (`api/src/server.mjs:570`)
// — comments never fire `onmessage`, so it does NOT re-arm this watchdog;
// only `data:` step events do. The 90 s `awaitStableNonce` leg does NOT
// apply to pay jobs: it runs only when the sender is the owner account
// (`isContended`, `api/src/chain-v2.mjs:221`), and every job send is from
// sellerB, never the owner — the bound rests on the 120 s finality legs
// only. No periodic server `data:` progress event is emitted on purpose:
// one would re-arm this watchdog forever and silently reintroduce the
// unbounded never-`done` hang FIX-2 closed; the 180 s bound keeps the exit
// bounded — a genuinely stalled job still fails, just not a live one.
const STREAM_TIMEOUT_MS = 180_000
const MAX_STREAM_ERRORS = 3
// Minimum wall-clock span over which the consecutive `onerror` failures
// must arrive before the pay fails (fix-back-3 O1). Three `onerror` fires
// can arrive within seconds of a brief total outage (a Render restart, a
// network flap) while the job underneath is healthy and the next reconnect
// would succeed — failing the pay on count alone false-fails it. With the
// window, a dead stream keeps erroring past 10 s and still fails; a brief
// outage that recovers inside the window stays silent, and the 180 s
// silence watchdog above remains the backstop either way.
const MIN_ERROR_WINDOW_MS = 10_000
export const STREAM_QUIET_ERROR =
  'The payment stream went quiet before the payment finished — we cannot confirm the status yet.'

export function useJobEvents(
  jobId: string | null,
  opts?: { streamTimeoutMs?: number; maxStreamErrors?: number; minErrorWindowMs?: number },
) {
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!jobId) {
      setJob(null)
      setError(null)
      return
    }
    const streamTimeoutMs = opts?.streamTimeoutMs ?? STREAM_TIMEOUT_MS
    const maxStreamErrors = opts?.maxStreamErrors ?? MAX_STREAM_ERRORS
    const errorWindowMs = opts?.minErrorWindowMs ?? MIN_ERROR_WINDOW_MS
    const es = new EventSource(`${API_BASE}/api/jobs/${jobId}/events`)
    esRef.current = es
    let done = false
    let failures = 0
    let firstFailureAt = 0
    let timer: number | undefined
    const armWatchdog = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (done) return
        es.close()
        setError(STREAM_QUIET_ERROR)
      }, streamTimeoutMs)
    }
    const disarm = () => window.clearTimeout(timer)
    armWatchdog()
    es.onmessage = (ev) => {
      // Any event proves the stream is alive: reset the failure count and
      // restart the silence watchdog from this event.
      failures = 0
      firstFailureAt = 0
      armWatchdog()
      try {
        const data = JSON.parse(ev.data) as
          | { type: 'step'; step: JobStep }
          | { type: 'done'; outcome: 'paid' | 'refused' | 'failed'; receipt_url: string }
          | JobSnapshot
        if ((data as { type?: string }).type === 'done') {
          done = true
          disarm()
          // Final state comes from a fresh snapshot poll. It goes through
          // timedFetch (15 s, like every other fetch in the app): the old
          // bare fetch() had no timeout, so a hung/erroring API at the
          // `done` moment left the job stuck on `running` forever with no
          // error and no receipt. A poll failure surfaces as `error`, which
          // the page turns into a failed pay state (PAY_FAILED).
          void timedFetch(`${API_BASE}/api/jobs/${jobId}`)
            .then((r) => {
              if (!r.ok) throw new Error(`Snapshot poll failed: ${r.status}`)
              return r.json()
            })
            .then((snap) => setJob(snap as JobSnapshot))
            .catch(() => setError('The test node stayed busy, so we cannot confirm the status yet.'))
          es.close()
          return
        }
        if ((data as { type?: string }).type === 'step') {
          const step = (data as { type: 'step'; step: JobStep }).step
          setJob((prev) => {
            if (!prev) return prev
            const steps = prev.steps.map((s) => (s.step === step.step ? { ...s, ...step } : s))
            if (!steps.some((s) => s.step === step.step)) steps.push(step)
            return { ...prev, steps }
          })
          return
        }
        setJob(data as JobSnapshot)
      } catch {
        // Ignore a malformed event; the snapshot poll below still runs.
      }
    }
    es.onerror = () => {
      // EventSource reconnects on its own, so one failure is transient and
      // stays silent. Only `maxStreamErrors` failures in a row — no event
      // between them — spread over at least `errorWindowMs` mean the stream
      // is dead, and the pay must fail instead of spinning on `running`
      // forever. The window matters: without it, three failures arriving
      // within seconds of a brief outage would fail a healthy job whose
      // next reconnect would have succeeded.
      failures += 1
      if (failures === 1) firstFailureAt = Date.now()
      if (failures >= maxStreamErrors && Date.now() - firstFailureAt >= errorWindowMs) {
        disarm()
        es.close()
        setError(STREAM_QUIET_ERROR)
      }
    }
    return () => {
      disarm()
      es.close()
      esRef.current = null
    }
  }, [jobId])

  return { job, error }
}
