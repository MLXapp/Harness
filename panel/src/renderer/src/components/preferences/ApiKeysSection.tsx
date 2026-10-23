import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'

/** Brave Search key (web_search tool) and Hugging Face token (gated downloads). */
export function ApiKeysSection() {
  const { t } = useTranslation()
  const [braveKey, setBraveKey] = useState('')
  const [hfToken, setHfToken] = useState('')
  const [saved, setSaved] = useState(false)
  const [hfSaved, setHfSaved] = useState(false)
  const [hasSavedBraveKey, setHasSavedBraveKey] = useState(false)
  const [hasSavedHfToken, setHasSavedHfToken] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [showHfKey, setShowHfKey] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    window.api.settings.has('braveApiKey').then((exists) => {
      if (mountedRef.current) setHasSavedBraveKey(exists)
    })
    window.api.settings.has('hf_api_key').then((exists) => {
      if (mountedRef.current) setHasSavedHfToken(exists)
    })
    return () => { mountedRef.current = false }
  }, [])

  const handleSave = async () => {
    const trimmed = braveKey.trim()
    if (trimmed) {
      await window.api.settings.set('braveApiKey', trimmed)
    } else {
      await window.api.settings.delete('braveApiKey')
    }
    setHasSavedBraveKey(!!trimmed)
    setSaved(true)
    setTimeout(() => { if (mountedRef.current) setSaved(false) }, 2000)
  }

  const handleHfSave = async () => {
    const trimmed = hfToken.trim()
    if (trimmed) {
      await window.api.settings.set('hf_api_key', trimmed)
    } else {
      await window.api.settings.delete('hf_api_key')
    }
    setHasSavedHfToken(!!trimmed)
    setHfSaved(true)
    setTimeout(() => { if (mountedRef.current) setHfSaved(false) }, 2000)
  }

  return (
    <div className="mlx-group p-5">
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">{t('app.about.braveKey')}</label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-2">
            {t('app.about.braveRequired')}{' '}
            <a
              href="https://brave.com/search/api/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {t('app.about.getFreeKey')}
            </a>
          </p>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={braveKey}
                onChange={e => { setBraveKey(e.target.value); setSaved(false) }}
                placeholder={hasSavedBraveKey ? t('app.about.savedKeyPlaceholder') : 'BSA...'}
                className="w-full px-3 py-2 bg-background border border-input rounded text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring pr-10"
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                title={showKey ? t('app.about.hide') : t('app.about.show')}
              >
                {showKey ? t('app.about.hide') : t('app.about.show')}
              </button>
            </div>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
            >
              {saved ? t('app.about.saved') : t('common.save')}
            </button>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-border">
          <label className="text-sm font-medium">{t('app.about.hfToken')}</label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-2">
            {t('app.about.hfRequired')}{' '}
            <a
              href="https://huggingface.co/settings/tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {t('app.about.getToken')}
            </a>
          </p>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type={showHfKey ? 'text' : 'password'}
                value={hfToken}
                onChange={e => { setHfToken(e.target.value); setHfSaved(false) }}
                placeholder={hasSavedHfToken ? t('app.about.savedTokenPlaceholder') : 'hf_...'}
                className="w-full px-3 py-2 bg-background border border-input rounded text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring pr-10"
              />
              <button
                onClick={() => setShowHfKey(!showHfKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                title={showHfKey ? t('app.about.hide') : t('app.about.show')}
              >
                {showHfKey ? t('app.about.hide') : t('app.about.show')}
              </button>
            </div>
            <button
              onClick={handleHfSave}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
            >
              {hfSaved ? t('app.about.saved') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
