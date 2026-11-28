// Small JSON client for the wallet endpoints (same API base as the rest of the app).
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

export class WalletApiError extends Error {
  code: string
  status: number
  extra: Record<string, unknown>
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export async function walletApi<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init?.signal,
    })
  } catch {
    throw new WalletApiError(0, 'network', 'The PayOnce API did not answer. Check your connection and try again.')
  }
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = (json.error ?? json) as { code?: string; message?: string }
    throw new WalletApiError(res.status, String(err.code ?? `http_${res.status}`), String(err.message ?? `The API answered ${res.status}.`), json)
  }
  return json as T
}

/** Poll the API until the transaction is finalized (or the timeout passes). */
export async function waitForTx(hash: string, timeoutMs = 120_000): Promise<{ status: string; reject: { code: number; name: string; message?: string } | null; explorer_url?: string }> {
  const until = Date.now() + timeoutMs
  let last: { status: string; reject: null } = { status: 'unknown', reject: null }
  while (Date.now() < until) {
    try {
      const s = await walletApi<{ status: string; reject: { code: number; name: string } | null; explorer_url?: string }>(`/api/tx/${hash}/status`)
      if (s.status === 'finalized') return s
      last = { status: s.status, reject: null }
    } catch (e) {
      if (!(e instanceof WalletApiError) || (e.status !== 404 && e.status !== 503 && e.status !== 0)) throw e
    }
    await new Promise((r) => setTimeout(r, 2500))
  }
  return last
}
