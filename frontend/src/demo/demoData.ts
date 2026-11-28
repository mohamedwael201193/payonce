// /demo data: one run, six screens. The page never invents values: it shows
// whatever a DemoRun holds. Source order: (1) GET /api/demo/run, a fresh real
// run produced by the API (not shipped yet), (2) the bundled RECORDED_RUN, a
// real earlier run on registry v2. Whichever one is on screen is labelled.
import { timedFetch, API_BASE } from '../lib/api'

export interface DemoTx {
  hash: string
}
export interface DemoRefusal extends DemoTx {
  code: number
  name: string
}
export interface DemoRun {
  /** true only when the API produced this run just now */
  live: boolean
  /** One line shown under the stage: what the visitor is looking at. */
  label: string
  invoice: { amount: string; due: string | null }
  good: { account: string; ticks: string[] }
  paid: DemoTx
  impostor: { account: string; headline: string; refusal: DemoRefusal | null }
  again: DemoRefusal
}

const EXPLORER = 'https://ccdexplorer.io/testnet/transaction/'
export const txUrl = (h: string) => `${EXPLORER}${h}`

/** A real run on registry v2 <13150,0>: payable 10 was paid once, a second payment was refused on chain.
    The impostor check is the same app-layer check the Run-it page runs on a forged invoice (no transaction). */
export const RECORDED_RUN: DemoRun = {
  live: false,
  label: 'Replay of a recorded run on registry v2, 24 Nov 2026. Testnet.',
  invoice: { amount: '0.5 CCD', due: '2026-12-26' },
  good: {
    account: '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin',
    ticks: ['Invoice matches the one on chain', 'Payee fixed by the seller on chain', 'Not paid yet'],
  },
  paid: { hash: '7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197' },
  impostor: {
    account: '3kBx2h5Y8v3TfqmRZ3BmvNwKUX4ZRVJcVLRsC9cBRwLX9pYgyR',
    headline: 'This account is not the one registered. Nothing sent.',
    refusal: null,
  },
  again: {
    code: -5,
    name: 'WrongStatus',
    hash: 'a5ec5e4027523c564d81960cb0ec48b546c270ec5f43256f15cf5d34f98d6848',
  },
}

const HASH = /^[0-9a-f]{64}$/i
const isRefusal = (r: unknown): r is DemoRefusal =>
  !!r && typeof (r as DemoRefusal).code === 'number' && typeof (r as DemoRefusal).name === 'string' && HASH.test((r as DemoRefusal).hash)

/** Accepts only a complete run that is under an hour old. Anything else falls back to the recording. */
export function parseLiveRun(raw: unknown, now = Date.now()): DemoRun | null {
  const r = raw as Partial<DemoRun> & { generated_at?: string }
  if (!r || r.live !== true || typeof r.label !== 'string') return null
  const at = r.generated_at ? Date.parse(r.generated_at) : NaN
  if (!Number.isFinite(at) || now - at > 3_600_000) return null
  if (!r.invoice || !r.good || !Array.isArray(r.good.ticks) || !r.paid || !HASH.test(r.paid.hash)) return null
  if (!r.impostor || typeof r.impostor.account !== 'string' || !isRefusal(r.again)) return null
  if (r.impostor.refusal != null && !isRefusal(r.impostor.refusal)) return null
  return r as DemoRun
}

export async function loadDemoRun(signal?: AbortSignal): Promise<DemoRun> {
  try {
    const res = await timedFetch(`${API_BASE}/api/demo/run`, { signal })
    if (res.ok) {
      const live = parseLiveRun(await res.json())
      if (live) return live
    }
  } catch {
    /* no live run available: replay */
  }
  return RECORDED_RUN
}
