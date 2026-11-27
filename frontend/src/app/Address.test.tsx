import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Address, midTruncate } from './Address'

const FULL = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB'

describe('midTruncate', () => {
  it('keeps the first 6 and last 6 characters', () => {
    expect(midTruncate(FULL)).toBe('42jaZZ…zmRjNB')
  })
  it('shows short values whole and an empty value as a dash', () => {
    expect(midTruncate('abc')).toBe('abc')
    expect(midTruncate('')).toBe('-')
  })
})

describe('Address', () => {
  it('renders one line of text with the full value in the tooltip and for screen readers', () => {
    render(<Address value={FULL} kind="account" label="payee" />)
    const code = screen.getByTitle(FULL)
    expect(code.tagName).toBe('CODE')
    expect(code.textContent).toContain('42jaZZ…zmRjNB')
    expect(screen.getByText(FULL, { selector: '.sr-only' })).toBeInTheDocument()
  })

  it('has a copy button that copies the full value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<Address value={FULL} label="payee" />)
    await userEvent.click(screen.getByRole('button', { name: 'Copy payee' }))
    expect(writeText).toHaveBeenCalledWith(FULL)
  })

  it('links accounts and transactions to the testnet explorer, but not plain hashes', () => {
    const { rerender } = render(<Address value={FULL} kind="account" label="payee" />)
    expect(screen.getByRole('link', { name: /explorer/i })).toHaveAttribute('href', expect.stringContaining(FULL))
    rerender(<Address value={FULL} kind="hash" label="invoice hash" />)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('expands to the whole value only when asked', async () => {
    render(<Address value={FULL} label="payee" expandable />)
    const more = screen.getByRole('button', { name: 'Show all' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(more)
    expect(screen.getByTitle(FULL).textContent).toBe(FULL)
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
  })
})
