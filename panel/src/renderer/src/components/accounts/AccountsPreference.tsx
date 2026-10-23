/**
 * Preferences → Accounts: the five accounts people connect, the model
 * servers on this Mac, and (folded away) every other service or custom
 * endpoint. Keys are write-only: nothing here reads one back.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { FEATURED_ACCOUNTS, MEDIA_ACCOUNTS, type FeaturedAccount } from '../../../../shared/curated'
import { LOCAL_SERVERS } from '../../../../shared/providers/catalog'
import { otherProviders } from '../../../../shared/accountSetup'
import { shownModels } from '../../../../shared/providers/pickerGroups'
import type { ProviderView } from '../../../../shared/providers/types'
import { Reveal } from '../ui/Reveal'
import { ProviderEditor, type CatalogEntry } from '../settings/ProviderEditor'
import { useProviders } from '../settings/useProviders'
import { AccountGlyph } from './AccountGlyph'
import { ChooseModelsSheet } from './ChooseModelsSheet'
import { openConnectAccount, openOnboarding } from './events'
import { Btn, Group, MoreMenu, Spinner, countKey } from './ui'
import '../../styles/accounts.css'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Inline "Remove …?" under a row; opens and closes by height. */
function RemoveConfirm({ open, name, onCancel, onConfirm }: { open: boolean; name: string; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation()
  return (
    <Reveal open={open}>
      <div className="flex items-center gap-3 bg-destructive/[0.06] px-4 py-3">
        <p className="min-w-0 flex-1 text-[13px] leading-[18px]">{t('accounts.removeConfirm', { name })}</p>
        <Btn size="md" onClick={onCancel}>{t('common.cancel')}</Btn>
        <Btn size="md" variant="destructive" onClick={onConfirm}>{t('accounts.remove')}</Btn>
      </div>
    </Reveal>
  )
}

export function AccountsPreference({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation()
  const { providers, localServers, probing, probe, reload, error } = useProviders({ probe: true })
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [choosing, setChoosing] = useState<ProviderView | null>(null)
  const [choosingOpen, setChoosingOpen] = useState(false)
  const [othersOpen, setOthersOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [candidates, setCandidates] = useState<Array<{ sessionId: string; remoteUrl: string; remoteModel: string }>>([])
  const [rowError, setRowError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.api.providers.catalog().then(list => { if (alive) setCatalog(list) }).catch(() => undefined)
    window.api.providers.remoteSessionCandidates().then(list => { if (alive) setCandidates(list) }).catch(() => undefined)
    return () => { alive = false }
  }, [])

  const others = useMemo(() => otherProviders(providers), [providers])
  const takenIds = useMemo(() => new Set(providers.map(p => p.id)), [providers])
  const importable = candidates.filter(c => {
    const base = c.remoteUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1'
    return !providers.some(p => p.baseURL === base && p.models.some(m => m.id === c.remoteModel))
  })

  // Keep "Other services" open when there is something in it to see.
  useEffect(() => {
    if (others.length > 0 || importable.length > 0) setOthersOpen(true)
  }, [others.length, importable.length])

  const remove = async (id: string) => {
    setRowError(null)
    const result = await window.api.providers.delete(id)
    if (!result.ok) setRowError(result.error)
    setConfirmRemove(null)
    if (editing === id) setEditing(null)
    void reload()
  }

  const chooseModels = (provider: ProviderView) => {
    setChoosing(provider)
    setChoosingOpen(true)
  }

  const importSession = async (sessionId: string) => {
    setRowError(null)
    const result = await window.api.providers.importRemoteSession(sessionId)
    if (!result.ok) setRowError(result.error)
    void reload()
  }

  const providerRowMenu = (provider: ProviderView, featured: boolean) => [
    ...(featured ? [{ label: t('accounts.replaceKey'), onSelect: () => openConnectAccount([...FEATURED_ACCOUNTS, ...MEDIA_ACCOUNTS].find(a => a.catalogId === provider.id)!.id) }] : []),
    { label: t('accounts.chooseModels'), onSelect: () => chooseModels(provider) },
    ...(!featured ? [{ label: t('accounts.edit'), onSelect: () => { setAdding(false); setEditing(provider.id) } }] : []),
    'separator' as const,
    { label: t('accounts.removeEllipsis'), destructive: true, onSelect: () => setConfirmRemove(provider.id) },
  ]

  const accountRow = (account: FeaturedAccount) => {
          const provider = providers.find(p => p.id === account.catalogId)
          const connected = !!provider?.configured
          const shown = provider ? shownModels(provider.models).length : 0
          return (
            <div key={account.id} data-account={account.id}>
              <div className="flex h-[52px] items-center gap-3 px-4">
                <AccountGlyph providerId={account.catalogId} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold leading-[18px]">{account.name}</p>
                  <div className="mlx-xfade">
                    <p data-active={connected ? 'true' : 'false'} className="truncate text-[12px] leading-4 text-muted-foreground">
                      <span className="mr-1 inline-block h-1.5 w-1.5 -translate-y-px rounded-full bg-success align-middle" aria-hidden />
                      {t(countKey('accounts.connectedModels', shown), { count: shown })}
                    </p>
                    <p data-active={connected ? 'false' : 'true'} className="truncate text-[12px] leading-4 text-muted-foreground">{account.tagline}</p>
                  </div>
                </div>
                <div className="mlx-xfade shrink-0 justify-items-end">
                  <div data-active={connected ? 'false' : 'true'} aria-hidden={connected}>
                    <Btn size="md" tabIndex={connected ? -1 : 0} onClick={() => openConnectAccount(account.id)}>{t('accounts.connect.connect')}</Btn>
                  </div>
                  <div data-active={connected ? 'true' : 'false'} aria-hidden={!connected}>
                    {provider && <MoreMenu label={t('accounts.more', { name: account.name })} items={providerRowMenu(provider, true)} />}
                  </div>
                </div>
              </div>
              {provider && (
                <RemoveConfirm
                  open={confirmRemove === provider.id}
                  name={account.name}
                  onCancel={() => setConfirmRemove(null)}
                  onConfirm={() => void remove(provider.id)}
                />
              )}
            </div>
          )
  }

  return (
    <section data-vmlx-section="accounts" className="space-y-6">
      <div className="space-y-1">
        {/* Inside Preferences the sheet already titles the section. */}
        {!embedded && <h2 className="text-[20px] font-bold leading-6">{t('accounts.title')}</h2>}
        <p className="text-[13px] leading-[18px] text-muted-foreground">{t('accounts.subtitle')}</p>
      </div>

      {/* The five */}
      <Group>
        {FEATURED_ACCOUNTS.map(account => accountRow(account))}
      </Group>

      {/* Media accounts (Atlas Cloud; WaveSpeed AI is above and serves media too) */}
      <Group title={t('accounts.media')} footer={t('accounts.mediaHint')}>
        {MEDIA_ACCOUNTS.filter(a => !FEATURED_ACCOUNTS.includes(a)).map(account => accountRow(account))}
      </Group>

      {/* On this Mac */}
      <Group
        title={t('accounts.onThisMac')}
        action={(
          <Btn size="md" variant="plain" onClick={() => void probe()} disabled={probing}>
            {probing ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
            {t('common.refresh')}
          </Btn>
        )}
        footer={t('accounts.onThisMacHint')}
      >
        {LOCAL_SERVERS.map(server => {
          const found = localServers.find(s => s.id === server.id)
          return (
            <div key={server.id} className="flex h-[52px] items-center gap-3 px-4">
              <AccountGlyph providerId={server.id} name={server.displayName} size={28} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold leading-[18px]">{server.displayName}</p>
                <p className="truncate text-[12px] leading-4 text-muted-foreground">{hostOf(server.baseURL)}</p>
              </div>
              <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                <span className={`h-2 w-2 rounded-full transition-colors duration-200 ${found ? 'bg-success' : 'bg-muted-foreground/40'}`} aria-hidden />
                {found ? t(countKey('accounts.runningModels', found.models.length), { count: found.models.length }) : t('accounts.notRunning')}
              </span>
            </div>
          )
        })}
      </Group>

      {/* Other services */}
      <section className="space-y-2">
        <button
          type="button"
          onClick={() => setOthersOpen(v => !v)}
          aria-expanded={othersOpen}
          className="flex h-7 items-center gap-1.5 rounded-[7px] px-1 text-[15px] font-semibold leading-5 transition-colors hover:text-foreground"
        >
          <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ease-mlx ${othersOpen ? 'rotate-90' : ''}`} aria-hidden />
          {t('accounts.otherServices')}
          {others.length > 0 && <span className="text-[13px] font-normal text-muted-foreground">{others.length}</span>}
        </button>
        <Reveal open={othersOpen}>
          <div className="space-y-3 pt-1">
            <p className="px-1 text-[12px] leading-4 text-muted-foreground">{t('accounts.otherServicesHint')}</p>
            {others.length > 0 && (
              <Group>
                {others.map(provider => (
                  <div key={provider.id}>
                    <div className="flex h-[52px] items-center gap-3 px-4">
                      <AccountGlyph providerId={provider.id} name={provider.displayName} size={28} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold leading-[18px]">{provider.displayName}</p>
                        <p className="truncate text-[12px] leading-4 text-muted-foreground">
                          {provider.needsKey && !provider.configured
                            ? t('accounts.needsKey')
                            : t(countKey('accounts.hostModels', shownModels(provider.models).length), { host: hostOf(provider.baseURL), count: shownModels(provider.models).length })}
                        </p>
                      </div>
                      <MoreMenu label={t('accounts.more', { name: provider.displayName })} items={providerRowMenu(provider, false)} />
                    </div>
                    <RemoveConfirm
                      open={confirmRemove === provider.id}
                      name={provider.displayName}
                      onCancel={() => setConfirmRemove(null)}
                      onConfirm={() => void remove(provider.id)}
                    />
                    <Reveal open={editing === provider.id}>
                      <div className="border-t border-border/70 p-4">
                        <ProviderEditor
                          existing={provider}
                          catalog={catalog}
                          takenIds={takenIds}
                          onSaved={() => { setEditing(null); void reload() }}
                          onCancel={() => setEditing(null)}
                        />
                      </div>
                    </Reveal>
                  </div>
                ))}
              </Group>
            )}

            <Reveal open={adding}>
              <ProviderEditor
                key={adding ? 'adding' : 'idle'}
                catalog={catalog.filter(c => ![...FEATURED_ACCOUNTS, ...MEDIA_ACCOUNTS].some(a => a.catalogId === c.id))}
                takenIds={takenIds}
                onSaved={() => { setAdding(false); void reload() }}
                onCancel={() => setAdding(false)}
              />
            </Reveal>

            <div className="flex flex-wrap items-center gap-2">
              <Btn size="lg" onClick={() => { setEditing(null); setAdding(true) }} disabled={adding}>{t('accounts.addOther')}</Btn>
              <Btn size="lg" onClick={() => openConnectAccount('custom')}>{t('accounts.customEndpoint')}</Btn>
            </div>

            <Reveal open={importable.length > 0}>
              <Group title={t('providers.importTitle')} footer={t('providers.importHint')}>
                {importable.map(c => (
                  <div key={c.sessionId} className="flex h-[52px] items-center gap-3 px-4">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[13px] leading-[18px]">{c.remoteModel}</p>
                      <p className="truncate text-[12px] leading-4 text-muted-foreground">{hostOf(c.remoteUrl)}</p>
                    </div>
                    <Btn size="md" onClick={() => void importSession(c.sessionId)}>{t('providers.importButton')}</Btn>
                  </div>
                ))}
              </Group>
            </Reveal>
          </div>
        </Reveal>
      </section>

      <Reveal open={!!rowError || !!error}>
        <p role="alert" className="text-[13px] text-destructive break-words">{rowError ?? error}</p>
      </Reveal>

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <p className="min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">{t('accounts.setupAgainHint')}</p>
        <Btn size="lg" onClick={openOnboarding}>{t('accounts.setupAgain')}</Btn>
      </div>

      {choosing && (
        <ChooseModelsSheet
          provider={choosing}
          open={choosingOpen}
          onClose={() => setChoosingOpen(false)}
          onClosed={() => { setChoosing(null); void reload() }}
        />
      )}
    </section>
  )
}
