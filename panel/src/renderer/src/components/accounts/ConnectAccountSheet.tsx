/**
 * Connect DeepSeek / Claude / OpenAI / Gemini / WaveSpeed AI in two steps:
 * get a key on the service's site, paste it here. The key is checked live
 * (one cheap request), and Connect saves the account with its featured
 * models shown in the chat picker; anything else the service lists is kept
 * but hidden ("Choose models…").
 */
import { useEffect, useId, useState } from 'react'
import { ArrowUpRight, ClipboardPaste, Eye, EyeOff, Lock } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { featuredAccount, type FeaturedAccountId } from '../../../../shared/curated'
import { accountDraft } from '../../../../shared/accountSetup'
import { cleanPastedKey } from '../../../../shared/providers/apiKey'
import type { ProviderView } from '../../../../shared/providers/types'
import { Reveal } from '../ui/Reveal'
import { AccountGlyph } from './AccountGlyph'
import { KeyStatus } from './KeyStatus'
import { Sheet, SheetFooter, SheetHeader } from './Sheet'
import { Btn, Spinner } from './ui'
import { useKeyCheck } from './useKeyCheck'

function StepNumber({ n, done }: { n: number; done?: boolean }) {
  return (
    <span
      className={`mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold leading-none transition-colors duration-200 ${
        done ? 'bg-success text-success-foreground' : 'bg-foreground/[0.08] text-foreground'
      }`}
      aria-hidden
    >
      {n}
    </span>
  )
}

export function ConnectAccountSheet({ account: accountId, open, existing, onClose, onClosed, onConnected }: {
  account: FeaturedAccountId
  open: boolean
  /** The saved provider when the account is already connected (Replace key…). */
  existing?: ProviderView
  onClose: () => void
  onClosed?: () => void
  onConnected?: (provider: ProviderView) => void
}) {
  const { t } = useTranslation()
  const account = featuredAccount(accountId)!
  const titleId = useId()
  const fieldId = useId()
  const [draft, setDraft] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // A fresh sheet every time it opens.
  useEffect(() => {
    if (!open) return
    setDraft('')
    setRevealed(false)
    setSaving(false)
    setSaveError(null)
  }, [open, accountId])

  const key = cleanPastedKey(draft)
  const { state, retry } = useKeyCheck({ providerId: account.catalogId, apiKey: key }, open && key.length > 0)
  const verdict = state.phase === 'done' ? state.result : null
  // A key that works on an account without credit can still be connected.
  const usable = !!verdict && (verdict.ok || verdict.reason === 'no-credit')

  const paste = async () => {
    try {
      const text = await window.api.clipboard.readText()
      if (text) setDraft(cleanPastedKey(text))
    } catch {
      // Nothing to paste.
    }
    document.getElementById(fieldId)?.focus()
  }

  const connect = async () => {
    if (!usable || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const discovered = verdict?.ok ? verdict.discovered : []
      const result = await window.api.providers.save(accountDraft(account, discovered, existing), key)
      if (!result.ok) {
        setSaveError(result.error)
        setSaving(false)
        return
      }
      onConnected?.(result.provider)
      onClose()
    } catch (error) {
      setSaveError(String(error))
      setSaving(false)
    }
  }

  const keyDone = state.phase === 'done' && usable

  return (
    <Sheet open={open} onClose={onClose} onClosed={onClosed} labelledBy={titleId}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void connect()
        }}
        className="flex min-h-0 flex-col"
      >
        <SheetHeader
          id={titleId}
          icon={<AccountGlyph providerId={account.catalogId} size={32} />}
          title={existing ? t('accounts.connect.titleReplace', { name: account.name }) : t('accounts.connect.title', { name: account.name })}
          subtitle={account.company !== account.name ? account.company : account.tagline}
        />

        <div className="space-y-5 overflow-y-auto px-6 pb-6">
          {/* 1. Get a key */}
          <div className="flex gap-3">
            <StepNumber n={1} />
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="text-[13px] font-semibold leading-[18px]">{t('accounts.connect.step1')}</p>
                <p className="text-[12px] leading-4 text-muted-foreground">{t('accounts.connect.step1Hint', { site: account.keySiteName })}</p>
              </div>
              <a
                href={account.keyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-7 items-center gap-1 rounded-[7px] bg-foreground/[0.06] px-3 text-[13px] font-medium ring-1 ring-inset ring-border transition-colors duration-200 hover:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                {t('accounts.connect.openSite', { site: account.keySiteName })}
                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              </a>
            </div>
          </div>

          {/* 2. Paste your key */}
          <div className="flex gap-3">
            <StepNumber n={2} done={keyDone} />
            <div className="min-w-0 flex-1">
              <label htmlFor={fieldId} className="block text-[13px] font-semibold leading-[18px]">{t('accounts.connect.step2')}</label>
              <div className="mt-2 flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <input
                    id={fieldId}
                    data-autofocus
                    type={revealed ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    value={draft}
                    placeholder={account.keyPrefix ? `${account.keyPrefix}…` : t('accounts.connect.keyPlaceholder')}
                    onChange={(event) => setDraft(event.target.value)}
                    onPaste={(event) => {
                      const text = event.clipboardData.getData('text')
                      if (!text) return
                      event.preventDefault()
                      setDraft(cleanPastedKey(text))
                    }}
                    className="h-8 w-full rounded-[8px] border border-input bg-background pl-2.5 pr-9 font-mono text-[13px] leading-[18px] transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/25"
                  />
                  <button
                    type="button"
                    onClick={() => setRevealed(v => !v)}
                    aria-label={revealed ? t('providers.keyHide') : t('providers.keyShow')}
                    title={revealed ? t('providers.keyHide') : t('providers.keyShow')}
                    aria-pressed={revealed}
                    className="absolute right-0.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {revealed ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                  </button>
                </div>
                <Btn size="lg" onClick={() => void paste()}>
                  <ClipboardPaste className="h-3.5 w-3.5" aria-hidden />
                  {t('accounts.connect.paste')}
                </Btn>
              </div>
              <KeyStatus state={state} site={account.keySiteName} service={account.name} onRetry={retry} />
            </div>
          </div>

          <Reveal open={!!saveError}>
            <p role="alert" className="text-[13px] leading-[18px] text-destructive break-words">{saveError}</p>
          </Reveal>
        </div>

        <SheetFooter
          note={(
            <span className="flex items-start gap-1.5">
              <Lock className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('accounts.connect.privacy', { service: account.name })}
            </span>
          )}
        >
          <Btn size="lg" onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn size="lg" variant="primary" type="submit" data-default disabled={!usable || saving}>
            {saving && <Spinner />}
            {existing ? t('accounts.connect.saveKey') : t('accounts.connect.connect')}
          </Btn>
        </SheetFooter>
      </form>
    </Sheet>
  )
}
