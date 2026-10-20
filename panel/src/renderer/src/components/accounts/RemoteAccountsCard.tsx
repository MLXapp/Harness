/**
 * New Chat → Remote: one friendly card instead of URL/model/key fields.
 * Accounts and custom endpoints become providers, so their models appear in
 * the chat model picker (legacy remote sessions stay listed and importable
 * from Preferences → Accounts → Other services).
 */
import { useTranslation } from '../../i18n'
import { FEATURED_ACCOUNTS } from '../../../../shared/curated'
import { AccountGlyph } from './AccountGlyph'
import { openConnectAccount } from './events'
import { Btn } from './ui'
import '../../styles/accounts.css'

export function RemoteAccountsCard() {
  const { t } = useTranslation()
  return (
    <div data-vmlx-surface="remote-accounts" className="rounded-[12px] border border-border bg-card px-6 py-8 text-center mlx-view-in">
      <div className="flex justify-center -space-x-1.5" aria-hidden>
        {FEATURED_ACCOUNTS.map(account => (
          <span key={account.id} className="rounded-[9px] ring-2 ring-card">
            <AccountGlyph providerId={account.catalogId} size={32} />
          </span>
        ))}
      </div>
      <h3 className="mt-4 text-[17px] font-semibold leading-[22px]">{t('accounts.remote.title')}</h3>
      <p className="mx-auto mt-1 max-w-[420px] text-[13px] leading-[18px] text-muted-foreground">{t('accounts.remote.body')}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Btn size="lg" variant="primary" onClick={() => openConnectAccount('list')}>{t('accounts.remote.connect')}</Btn>
        <Btn size="lg" onClick={() => openConnectAccount('custom')}>{t('accounts.customEndpoint')}</Btn>
      </div>
    </div>
  )
}
