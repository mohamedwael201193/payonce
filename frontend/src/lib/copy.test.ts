// Copy deck — P3 §2 rule 3: no banned claim may appear in any user-visible
// string. Scans every COPY value (including function outputs) for every
// banned word, case-insensitively. The JudgesPage honesty table deliberately
// NAMES the banned words to explain them — that page is documentation, not
// copy, so it is out of scope of this test.
import { describe, expect, it } from 'vitest'
import { BANNED_WORDS, COPY, GLOSSARY, buildStatusString, buildStatusText, coSignerRunsAsSentence, refusedCaption, reservationDefinition } from './copy'

function allCopyStrings(): string[] {
  const out: string[] = []
  for (const v of Object.values(COPY)) {
    if (typeof v === 'string') out.push(v)
    else if (typeof v === 'function') {
      // Call each formatter with representative args.
      const fn = v as (...args: never[]) => string
      try {
        out.push(fn('PLACEHOLDER' as never))
      } catch {
        /* fall through to the argless call below */
      }
      try {
        out.push(fn(0 as never, 0 as never, '' as never))
      } catch {
        /* some formatters need different arity; covered below */
      }
    }
  }
  // Formatter outputs with realistic args (covers every function in COPY).
  out.push(COPY.step2VerdictReady('PAYEE-PLACEHOLDER'))
  out.push(COPY.paidCcd('0.5 CCD'))
  out.push(COPY.paidEudemo('0.01'))
  out.push(COPY.verifierLine(12, 12, '10:42:07'))
  out.push(COPY.chainRefused(-5, 'WrongStatus', 'Already paid.', '4.928645'))
  out.push(COPY.chainRefused(-5, 'WrongStatus', 'Already paid.', null))
  out.push(COPY.coSignerRefused('Wrong payee.'))
  out.push(COPY.appRefused('Not on the vendor list.'))
  // Glossary definitions are user-visible strings too (Judges page).
  for (const [term, def] of GLOSSARY) {
    out.push(term)
    out.push(def)
  }
  return out
}

describe('BANNED_WORDS (P3 §2 rule 3)', () => {
  it('no COPY string contains a banned word', () => {
    const strings = allCopyStrings()
    expect(strings.length).toBeGreaterThan(10)
    for (const s of strings) {
      for (const b of BANNED_WORDS) {
        expect(
          s.toLowerCase(),
          `banned word "${b.word}" (${b.reason}) found in: ${s}`,
        ).not.toContain(b.word.toLowerCase())
      }
    }
  })
  it('hero line is the P3 §0/§10 line', () => {
    expect(COPY.heroH1).toContain('paid exactly once')
    expect(COPY.heroH1).toContain('only to the account the supplier put there')
  })
  it('step-2 verdict names the payee from the chain', () => {
    expect(COPY.step2VerdictReady('PAYEE-PLACEHOLDER')).toContain('PAYEE-PLACEHOLDER')
  })
  it('receipt footer disclaims legal status', () => {
    expect(COPY.receiptFooter).toContain('not a legal invoice')
  })
  it('co-signer sentence is a plain sentence, not a raw config fragment', () => {
    expect(coSignerRunsAsSentence()).toBe('Decision gate inside the API service — no separate co-signer service runs.')
    expect(coSignerRunsAsSentence()).not.toContain('(no service)')
  })
  it('refusedCaption states the live chain total and its basis', () => {
    expect(refusedCaption(21)).toBe('Recorded run, 24 Nov 2026 · 21 refused on chain since deploy')
    expect(refusedCaption(undefined)).toBe('Recorded run, 24 Nov 2026')
  })
})

describe('reservation + build status (fix-back-6 B4/B5)', () => {
  it('the glossary Reservation length is the live 3600 s, never the v1-era 300 s', () => {
    const def = GLOSSARY.find(([term]) => term === 'Reservation')?.[1] ?? ''
    expect(def).toContain('3600 s')
    expect(def).not.toContain('300 s')
  })
  it('reservationDefinition reads the live config value and never states a number while loading', () => {
    expect(reservationDefinition(3600)).toBe('the payable is reserved for one payer for 3600 s (60 minutes)')
    expect(reservationDefinition(300)).toBe('the payable is reserved for one payer for 300 s (5 minutes)')
    expect(reservationDefinition(undefined)).not.toMatch(/\d+ s/)
  })
  it('build status never says "Not yet" before the config has answered', () => {
    expect(buildStatusText(true, false, undefined)).toBe('Loading…')
    expect(buildStatusText(false, true, undefined)).toContain('Could not load')
    expect(buildStatusText(false, false, true)).toBe('Yes')
    expect(buildStatusText(false, false, false)).toBe('Not yet (planned)')
    expect(buildStatusString(true, false, undefined)).toBe('Loading…')
    expect(buildStatusString(false, false, 'payer (the reserving payer)')).toBe('payer (the reserving payer)')
    expect(buildStatusString(false, false, undefined)).toContain('Could not load')
  })
})
