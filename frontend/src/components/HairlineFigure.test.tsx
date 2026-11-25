// HairlineFigure — a figure that fails to load must show a fallback box
// that says so, never a blank bordered box + caption.
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HairlineFigure } from './HairlineFigure'

describe('HairlineFigure load failure (FIX-7e)', () => {
  it('shows the fallback when the loaded document has no figure root (404 / error page)', () => {
    render(<HairlineFigure name="payable" caption="Payable figure" />)
    const iframe = screen.getByTitle('Hairline figure: payable')
    expect(screen.queryByRole('alert')).toBeNull()
    // jsdom never loads the iframe: its document is empty, so the load
    // check finds no #hl-figure — exactly the 404/error-page case.
    fireEvent.load(iframe)
    expect(screen.getByRole('alert')).toHaveTextContent('Figure did not load.')
    expect(screen.queryByTitle('Hairline figure: payable')).toBeNull()
    expect(screen.getByText('Payable figure')).toBeInTheDocument()
  })

  it('shows the fallback on an iframe error event', () => {
    render(<HairlineFigure name="seal" caption="Seal figure" />)
    fireEvent.error(screen.getByTitle('Hairline figure: seal'))
    expect(screen.getByRole('alert')).toHaveTextContent('The hairline diagram (seal) could not be loaded.')
  })

  it('keeps the iframe when the loaded document carries the figure root', () => {
    const { container } = render(<HairlineFigure name="receipt" caption="Receipt figure" />)
    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    // jsdom never loads the iframe (its contentDocument has no body), so
    // stand in a real document carrying the figure root for the load check.
    const fakeDoc = document.implementation.createHTMLDocument()
    fakeDoc.body.insertAdjacentHTML('beforeend', '<div id="hl-figure"></div>')
    Object.defineProperty(iframe, 'contentDocument', { value: fakeDoc, configurable: true })
    fireEvent.load(iframe)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTitle('Hairline figure: receipt')).toBeInTheDocument()
  })
})
