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
//   1. Silence watchdog — no event at all for `streamTimeoutMs` after the
//      job starts (or after the last event; a stream still sending steps
//      is a live job, not a stalled one).
//   2. Consecutive stream failures — `maxStreamErrors` `onerror` fires in
//      a row with no event between them. A single transient `onerror` is
//      still ignored: EventSource reconnects on its own, and one dropped
//      connection is not a failed pay.
const STREAM_TIMEOUT_MS = 60_000
const MAX_STREAM_ERRORS = 3
export const STREAM_QUIET_ERROR =
  'The payment stream went quiet before the payment finished — we cannot confirm the status yet.'

export function useJobEvents(
  jobId: string | null,
  opts?: { streamTimeoutMs?: number; maxStreamErrors?: number },
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
    const es = new EventSource(`${API_BASE}/api/jobs/${jobId}/events`)
    esRef.current = es
    let done = false
    let failures = 0
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
      // between them — mean the stream is dead, and the pay must fail
      // instead of spinning on `running` forever.
      failures += 1
      if (failures >= maxStreamErrors) {
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
