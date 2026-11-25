// SSE job events — P3 §16.9. A `step` event per job step and a final `done`
// event. The server never re-sends a payment: a retry returns the existing job.
import { useEffect, useRef, useState } from 'react'
import type { JobSnapshot, JobStep } from '../lib/types'
import { timedFetch } from '../lib/api'

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

export function useJobEvents(jobId: string | null) {
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!jobId) {
      setJob(null)
      setError(null)
      return
    }
    const es = new EventSource(`${API_BASE}/api/jobs/${jobId}/events`)
    esRef.current = es
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as
          | { type: 'step'; step: JobStep }
          | { type: 'done'; outcome: 'paid' | 'refused' | 'failed'; receipt_url: string }
          | JobSnapshot
        if ((data as { type?: string }).type === 'done') {
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
      // EventSource reconnects on its own. Only surface an error if the job
      // is still running after the stream ends without a done event.
      setError(null)
    }
    return () => {
      es.close()
      esRef.current = null
    }
  }, [jobId])

  return { job, error }
}
