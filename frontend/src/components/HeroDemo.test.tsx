// HeroDemo — the SMALL demo glimpse in the hero card (fix-back-6 B6).
// Asserts: the card is a glimpse only — stat chips + a 3-row invoice
// table + a link to the real dashboard. No walkthrough, no checks, no pay
// button, no progress bar, no receipt box, no cursor, no auto-play; the
// label is "Demo" (never "Simulation"); the demo makes ZERO network calls
// (no fetch, no pay POST) and shows no real-looking transaction hash.
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeroDemo } from './HeroDemo'
import { demoStatChips, demoTableRows } from '../lib/heroDemo'
import type { InvoiceItem, Stats } from '../lib/types'

// Same live shape as HeroOverview.test.tsx: 13 payables, 8 paid, 5
// unpaid, 18 refused. Dues are relative to Date.now() (MF-H1 pattern):
// payable 5 is past due (−1 d, Overdue pill, first in the table),
// payable 1004 is the soonest-due unpaid (+1 d), 1/2/3 sit at +7 d.
