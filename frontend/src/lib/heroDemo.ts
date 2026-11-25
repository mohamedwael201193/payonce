// Hero demo — the SMALL demo glimpse inside the hero card.
// Fix-back-6 B6 (user order 2026-11-25 03:40, Altura frames): the hero
// gets ONLY a small demo dashboard, a glimpse — the old looping
// walkthrough (9 checks, pay button, progress bar, receipt box, virtual
// cursor auto-playing a 24 s loop) filled the whole right column and ~2
// viewport heights. It is deleted: no timeline, no cursor, no auto-play.
// What remains is the glimpse itself — the live stat chips and the 3-row
// invoice table — labelled "Demo" in the UI, with the footer disclosing
// that the numbers are live from the test registry.
// HONESTY: the stat chips and the invoice table are LIVE data (same
// unified snapshot as the hero card and the dashboard). The card shows no
// checks, no payment and no receipt — nothing canned that could be
// mistaken for a real flow. The demo makes ZERO network calls: no fetch,
// no pay POST, no chain call — it only renders the props it is given.
// Label rule (user order 2026-11-24 21:49): the word is "Demo" — never
// "Simulation" / "Simulated" anywhere in the demo UI or this module's
// user-facing strings.
import type { InvoiceItem, Stats } from './types'

/** The 4 stat chips mirror the real dashboard's 4 stat cards, from the
// same live inputs (stats + the live invoice list). One source, like the
// dashboard cards: Total/Paid/Unpaid are counted from the LIST itself (the
// stats total can be a different snapshot), and Refused is null until
// /api/stats answers — never a 0 placeholder (bug 4). */
export function demoStatChips(items: InvoiceItem[], stats: Stats | undefined): Array<{ label: string; value: number | null }> {
  const paid = items.filter((i) => i.status === 'paid').length
  return [
    { label: 'Total', value: items.length },
    { label: 'Paid', value: paid },
    { label: 'Unpaid', value: items.length - paid },
    { label: 'Refused', value: stats?.refused_on_chain_since_deploy ?? null },
  ]
}

/** The demo table mirrors the real "Live Invoices" table: the 3
// soonest-due unpaid payables, soonest first. */
export function demoTableRows(items: InvoiceItem[]): InvoiceItem[] {
  return [...items.filter((i) => i.status !== 'paid')].sort((a, b) => a.due.localeCompare(b.due)).slice(0, 3)
}
