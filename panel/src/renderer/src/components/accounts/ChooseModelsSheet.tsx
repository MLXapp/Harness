/** "Choose models…": which of an account's models the chat picker offers. */
import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from '../../i18n'
import { sortModelsForChooser, withShownModels } from '../../../../shared/accountSetup'
import { featuredAccount } from '../../../../shared/curated'
import type { ProviderView } from '../../../../shared/providers/types'
import { Reveal } from '../ui/Reveal'
import { AccountGlyph } from './AccountGlyph'
import { ModelChecklist } from './ModelChecklist'
import { Sheet, SheetFooter, SheetHeader } from './Sheet'
import { Btn, Spinner, countKey } from './ui'

export function ChooseModelsSheet({ provider, open, onClose, onClosed }: {
  provider: ProviderView
  open: boolean
  onClose: () => void
  onClosed?: () => void
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const models = useMemo(() => sortModelsForChooser(provider.models), [provider.models])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setChecked(new Set(provider.models.filter(m => !m.hidden).map(m => m.id)))
    setSaving(false)
    setError(null)
  }, [open, provider.models])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const result = await window.api.providers.save({
        id: provider.id,
        kind: provider.kind,
        displayName: provider.displayName,
        api: provider.api,
        baseURL: provider.baseURL,
        models: withShownModels(provider.models, checked),
      })
      if (!result.ok) {
        setError(result.error)
        setSaving(false)
        return
      }
      onClose()
    } catch (err) {
      setError(String(err))
      setSaving(false)
    }
  }

  const name = featuredAccount(provider.id)?.name ?? provider.displayName
  return (
    <Sheet open={open} onClose={onClose} onClosed={onClosed} labelledBy={titleId} width={480}>
      <form onSubmit={(event) => { event.preventDefault(); void save() }} className="flex min-h-0 flex-col">
        <SheetHeader
          id={titleId}
          icon={<AccountGlyph providerId={provider.id} name={provider.displayName} size={32} />}
          title={t('accounts.models.title', { name })}
          subtitle={t('accounts.models.subtitle')}
        />
        <div className="space-y-3 overflow-y-auto px-6 pb-6">
          {models.length === 0
            ? <p className="text-[13px] text-muted-foreground">{t('accounts.models.empty')}</p>
            : (
              <ModelChecklist
                models={models}
                checked={checked}
                onToggle={(id) => setChecked(prev => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })}
                onSetAll={(ids, on) => setChecked(prev => {
                  const next = new Set(prev)
                  for (const id of ids) on ? next.add(id) : next.delete(id)
                  return next
                })}
                maxHeight={320}
              />
            )}
          <Reveal open={!!error}>
            <p role="alert" className="text-[13px] text-destructive break-words">{error}</p>
          </Reveal>
        </div>
        <SheetFooter note={t(countKey('accounts.models.shownCount', checked.size), { count: checked.size })}>
          <Btn size="lg" onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn size="lg" variant="primary" type="submit" data-default disabled={saving}>
            {saving && <Spinner />}
            {t('common.save')}
          </Btn>
        </SheetFooter>
      </form>
    </Sheet>
  )
}
