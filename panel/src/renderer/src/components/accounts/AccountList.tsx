/**
 * The five accounts as large rows (setup step 2 and the "Connect an account"
 * sheet). The button cross-fades from Connect to "✓ Connected".
 */
import { useId } from 'react'
import { Check } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { FEATURED_ACCOUNTS, type FeaturedAccountId } from '../../../../shared/curated'
import { AccountGlyph } from './AccountGlyph'
import { Sheet, SheetFooter, SheetHeader } from './Sheet'
import { Btn } from './ui'

export function AccountRowsLarge({ connected, onConnect }: {
  connected: ReadonlySet<string>
  onConnect: (account: FeaturedAccountId) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="overflow-hidden rounded-[12px] border border-border bg-card divide-y divide-border/70">
      {FEATURED_ACCOUNTS.map(account => {
        const isOn = connected.has(account.catalogId)
        return (
          <div key={account.id} className="flex h-16 items-center gap-3 px-4" data-account={account.id}>
            <AccountGlyph providerId={account.catalogId} size={32} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold leading-5">{account.name}</p>
              <p className="truncate text-[13px] leading-[18px] text-muted-foreground" title={account.tagline}>{account.tagline}</p>
            </div>
            <div className="mlx-xfade shrink-0 justify-items-end">
              <div data-active={!isOn ? 'true' : 'false'} aria-hidden={isOn}>
                <Btn size="lg" tabIndex={isOn ? -1 : 0} onClick={() => onConnect(account.id)}>{t('accounts.connect.connect')}</Btn>
              </div>
              <div data-active={isOn ? 'true' : 'false'} aria-hidden={!isOn}>
                <button
                  type="button"
                  tabIndex={isOn ? 0 : -1}
                  onClick={() => onConnect(account.id)}
                  title={t('accounts.replaceKey')}
                  className="inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2 text-[13px] font-medium text-success transition-colors hover:bg-foreground/[0.05]"
                >
                  <Check className="h-4 w-4" strokeWidth={2.5} aria-hidden />
                  {t('accounts.connected')}
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function AccountsListSheet({ open, connected, onClose, onClosed, onConnect, onCustom }: {
  open: boolean
  connected: ReadonlySet<string>
  onClose: () => void
  onClosed?: () => void
  onConnect: (account: FeaturedAccountId) => void
  onCustom: () => void
}) {
  const { t } = useTranslation()
  const titleId = useId()
  return (
    <Sheet open={open} onClose={onClose} onClosed={onClosed} labelledBy={titleId} width={520}>
      <SheetHeader id={titleId} title={t('accounts.list.title')} subtitle={t('accounts.list.subtitle')} />
      <div className="overflow-y-auto px-6 pb-6">
        <AccountRowsLarge connected={connected} onConnect={onConnect} />
        <button
          type="button"
          onClick={onCustom}
          className="mt-3 h-7 rounded-[7px] px-1 text-[13px] font-medium text-[color:var(--link)] transition-colors hover:underline"
        >
          {t('accounts.otherOrCustom')}
        </button>
      </div>
      <SheetFooter>
        <Btn size="lg" variant="primary" data-default onClick={onClose}>{t('accounts.done')}</Btn>
      </SheetFooter>
    </Sheet>
  )
}
