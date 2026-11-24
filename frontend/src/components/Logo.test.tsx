// Logo — the SVG mark renders (never a raster image), with the wordmark,
// in both the dark (sky) and light (paper) variants.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Logo, LogoMark } from './Logo'

describe('Logo', () => {
  it('renders the once-loop mark as inline SVG, not an image', () => {
    const { container } = render(<LogoMark size={32} />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('img', { name: /PayOnce logo/ })).toBeInTheDocument()
  })

  it('renders the PayOnce wordmark in both variants', () => {
    const { rerender } = render(<Logo dark />)
    expect(screen.getByText('PayOnce')).toHaveClass('text-white')
    rerender(<Logo />)
    expect(screen.getByText('PayOnce')).toHaveClass('text-ink')
  })

  it('scales with the size prop', () => {
    const { container } = render(<LogoMark size={48} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('48')
    expect(svg?.getAttribute('height')).toBe('48')
  })
})
