import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { walletErrorText, isMobile } from './types'

vi.mock('./browser', () => ({
  browserWalletPresent: async () => false,
  resumeBrowserWallet: async () => null,
  watchBrowserWallet: async () => () => {},
  connectBrowserWallet: async () => { throw new Error('not found') },
}))

describe('wallet helpers', () => {
  it('turns wallet errors into plain words', () => {
    expect(walletErrorText(new Error('Site is not whitelisted'))).toMatch(/allowlist/)
    expect(walletErrorText(new Error('User rejected the request'))).toMatch(/cancelled/)
    expect(walletErrorText(new Error('Wallet is locked'))).toMatch(/locked/)
    expect(walletErrorText(new Error('insufficient funds'))).toMatch(/test CCD/)
    expect(walletErrorText('')).toMatch(/did not complete/)
  })
  it('detects a phone from the user agent', () => {
    expect(typeof isMobile()).toBe('boolean')
  })
  it('builds the CryptoX testnet deep link per platform', async () => {
    const { cryptoxDeepLink } = await import('./types')
    const ua = vi.spyOn(navigator, 'userAgent', 'get')
    ua.mockReturnValue('Mozilla/5.0 (Linux; Android 14)')
    expect(cryptoxDeepLink('wc:abc@2?x=1')).toBe('cryptox-wc-testnet://wc?uri=wc%3Aabc%402%3Fx%3D1&go_back=true')
    ua.mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')
    expect(cryptoxDeepLink('wc:abc')).toBe('cryptoxtestnet://wc?uri=wc%3Aabc')
    ua.mockRestore()
  })
})

describe('ConnectWallet', () => {
  it('offers Concordium Wallet (browser) first on a computer and explains a missing extension', async () => {
    const { WalletProvider } = await import('./WalletContext')
    const { ConnectWallet } = await import('./WalletUI')
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <WalletProvider><ConnectWallet purpose="pay" /></WalletProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Connect your wallet')).toBeTruthy()
    const buttons = screen.getAllByRole('button')
    expect(buttons[0].textContent).toMatch(/Concordium Wallet \(browser\)/)
    expect(screen.getByText(/Install Concordium Wallet/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Phone wallet/ })).toBeTruthy()
  })
})
