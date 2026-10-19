import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'

/** Uses the gateway/tray setting; never a renderer-local preference or preset. */
export function SingleModelPreference() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.api.gateway.onSingleModelModeChanged((status) => {
      revision.current++
      setEnabled(status.singleModelMode)
    })
    const requestedRevision = revision.current
    window.api.gateway.getStatus().then(status => {
      if (mounted.current && revision.current === requestedRevision) {
        setEnabled(status.singleModelMode)
      }
    }).catch(err => {
      if (mounted.current) setError(String(err))
    })
    return () => { mounted.current = false; unsubscribe() }
  }, [])

  const change = async () => {
    if (enabled === null || pending) return
    setPending(true)
    setError(null)
    const requestedRevision = revision.current
    try {
      const status = await window.api.gateway.setSingleModelMode(!enabled)
      if (mounted.current && revision.current === requestedRevision) setEnabled(status.singleModelMode)
    } catch (err) {
      if (mounted.current) setError(String(err))
    } finally {
      if (mounted.current) setPending(false)
    }
  }

  return (
    <section data-vmlx-section="general-model-loading" className="border border-border rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <span id="single-model-preference-label" className="text-sm">{t('console.oneModelLoaded')}</span>
        <button type="button" role="switch" data-vmlx-control="preferences-single-model"
          aria-labelledby="single-model-preference-label" aria-describedby="single-model-preference-help"
          aria-checked={enabled === true} aria-busy={pending || enabled === null}
          disabled={pending || enabled === null} onClick={change}
          className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border transition-colors duration-300 disabled:opacity-50 ${enabled ? 'bg-primary border-primary' : 'bg-foreground/[0.08] border-border'}`}>
          <span className={`inline-block h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-transform duration-300 ease-spring ${enabled ? 'translate-x-[17px]' : 'translate-x-[1px]'}`} />
        </button>
      </div>
      <p id="single-model-preference-help" className="text-xs text-muted-foreground">
        {enabled === null ? t('common.loading') : t(enabled ? 'api.singleModelModeOn' : 'api.singleModelModeOff')}
      </p>
      {error && <p role="alert" className="text-xs text-destructive break-words">{t('api.changeSingleModelFailed')}: {error}</p>}
    </section>
  )
}
