/**
 * Mounted once in App: answers `vmlx:connect-account` from anywhere by
 * opening the Connect sheet for that account, the Custom endpoint sheet or
 * the list of all five. A sheet opened from the list stacks above it.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderView } from '../../../../shared/providers/types'
import { featuredAccount, type FeaturedAccountId } from '../../../../shared/curated'
import { connectedAccountIds } from '../../../../shared/accountSetup'
import { useProviders } from '../settings/useProviders'
import { AccountsListSheet } from './AccountList'
import { ConnectAccountSheet } from './ConnectAccountSheet'
import { CustomEndpointSheet } from './CustomEndpointSheet'
import { CONNECT_ACCOUNT_EVENT, type ConnectAccountTarget } from './events'

export function AccountSheetsHost() {
  const { providers, reload } = useProviders()
  const [listOpen, setListOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  // Kept after closing so the sheet can animate out with its content.
  const [account, setAccount] = useState<FeaturedAccountId | null>(null)
  const [accountOpen, setAccountOpen] = useState(false)
  // The saved row as it was when the sheet opened (its title must not flip while it closes).
  const [existing, setExisting] = useState<ProviderView | undefined>()
  const providersRef = useRef(providers)
  providersRef.current = providers

  const openAccount = (id: FeaturedAccountId) => {
    const catalogId = featuredAccount(id)?.catalogId
    setExisting(providersRef.current.find(p => p.id === catalogId && p.configured))
    setAccount(id)
    setAccountOpen(true)
  }
  const openRef = useRef(openAccount)
  openRef.current = openAccount

  useEffect(() => {
    const onEvent = (event: Event) => {
      const target = (event as CustomEvent<{ account?: ConnectAccountTarget }>).detail?.account
      if (target === 'list') setListOpen(true)
      else if (target === 'custom') setCustomOpen(true)
      else if (target && featuredAccount(target)) openRef.current(featuredAccount(target)!.id)
    }
    window.addEventListener(CONNECT_ACCOUNT_EVENT, onEvent)
    return () => window.removeEventListener(CONNECT_ACCOUNT_EVENT, onEvent)
  }, [])

  const connected = useMemo(() => connectedAccountIds(providers), [providers])

  return (
    <>
      <AccountsListSheet
        open={listOpen}
        connected={connected}
        onClose={() => setListOpen(false)}
        onConnect={openAccount}
        onCustom={() => setCustomOpen(true)}
      />
      {account && (
        <ConnectAccountSheet
          account={account}
          open={accountOpen}
          existing={existing}
          onClose={() => setAccountOpen(false)}
          onConnected={() => void reload()}
        />
      )}
      <CustomEndpointSheet
        open={customOpen}
        providers={providers}
        onClose={() => setCustomOpen(false)}
        onSaved={() => void reload()}
      />
    </>
  )
}
