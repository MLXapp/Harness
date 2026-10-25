/**
 * Preferences → Apps: connect Composio once (browser sign-in, or your own
 * key), then each app: connect it, and choose whether its sends and changes
 * ask first (the default), always run, or are blocked. Reads always run.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, ExternalLink } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { AppRule, AppsStatusView } from '../../../../shared/apps'
import { Reveal } from '../ui/Reveal'
import { Btn, Group, Spinner, StatusLine } from '../accounts/ui'

export function useAppsStatus(): AppsStatusView | null {
  const [status, setStatus] = useState<AppsStatusView | null>(null)
  useEffect(() => {
    const api = window.api?.apps
    if (!api) return
    let alive = true
    api.status().then(s => { if (alive) setStatus(s) }).catch(() => undefined)
    const off = api.onStatus(s => setStatus(prev => ({ ...prev, ...s, featured: s.featured ?? prev?.featured })))
    const onLocal = (e: Event) => setStatus((e as CustomEvent).detail)
    window.addEventListener('vmlx:apps-status', onLocal)
    return () => { alive = false; off(); window.removeEventListener('vmlx:apps-status', onLocal) }
  }, [])
  return status
}

const RULES: AppRule[] = ['ask', 'always', 'blocked']

export function AppsPreference() {
  const { t } = useTranslation()
  const status = useAppsStatus()
  const [rules, setRules] = useState<Record<string, AppRule>>({})
  const [keyOpen, setKeyOpen] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<Record<string, string>>({})

  useEffect(() => { window.api.apps.rules().then(setRules).catch(() => undefined) }, [])

  const connected = status?.state === 'connected'
  const waiting = status?.state === 'waiting-for-browser' || status?.state === 'connecting'

  // Pending sign-ins live in the main process (watched there until Composio
  // reports them done), so they survive closing Preferences or the app.
  const pending = (status?.featured ?? []).filter(a => a.pending && !a.connected).map(a => a.id)
  const lastCheck = useRef<Record<string, number>>({})
  const refreshStatus = () => { void window.api.apps.status().then(s => window.dispatchEvent(new CustomEvent('vmlx:apps-status', { detail: s }))).catch(() => undefined) }
  const connectApp = async (id: string) => {
    setBusy(id)
    try {
      const r = await window.api.apps.connectApp(id)
      setNote(n => ({ ...n, [id]: r.ok ? (r.connected ? t('apps.alreadyConnected') : r.opened ? t('apps.finishInBrowser') : t('apps.waitingApp')) : (r.message || t('apps.connectFailed')) }))
      refreshStatus()
    } catch (err: any) {
      setNote(n => ({ ...n, [id]: String(err?.message ?? t('apps.connectFailed')) }))
    } finally {
      setBusy(null)
    }
  }
  // Back from the browser: see whether the sign-in finished.
  const check = async (id: string, quiet = false) => {
    if (!quiet) setBusy(id)
    try {
      const r = await window.api.apps.checkApp(id)
      if (r.connected) setNote(n => ({ ...n, [id]: t('apps.nowConnected') }))
      else if (!quiet) setNote(n => ({ ...n, [id]: r.ok ? t('apps.notYet') : (r.message || t('apps.connectFailed')) }))
      refreshStatus()
    } catch { /* stays pending */ } finally {
      if (!quiet) setBusy(null)
    }
  }
  // A sign-in finished in the background: the row's note says so.
  const connectedIds = (status?.featured ?? []).filter(a => a.connected).map(a => a.id).join(',')
  const wasPending = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const id of pending) wasPending.current.add(id)
    for (const id of connectedIds.split(',').filter(Boolean)) {
      if (wasPending.current.delete(id)) setNote(n => ({ ...n, [id]: t('apps.nowConnected') }))
    }
  }, [connectedIds, pending.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  const removeApp = async (id: string) => {
    setNote(n => ({ ...n, [id]: '' }))
    window.dispatchEvent(new CustomEvent('vmlx:apps-status', { detail: await window.api.apps.removeApp(id) }))
  }
  useEffect(() => {
    if (pending.length === 0) return
    // Coming back from the browser re-checks, at most every 8 s per app (each
    // check is a call to Composio).
    const onFocus = () => {
      const now = Date.now()
      for (const id of pending) {
        if (now - (lastCheck.current[id] ?? 0) < 8000) continue
        lastCheck.current[id] = now
        void check(id, true)
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [pending.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  const setRule = async (id: string, rule: AppRule) => setRules(await window.api.apps.setRule(id, rule))

  return (
    <div className="space-y-5" data-vmlx-surface="apps-preference">
      <Group>
        <div className="space-y-3 px-4 py-4">
          <div className="flex items-start gap-3">
            <div className="mlx-apps-tile" aria-hidden>
              <span /><span /><span /><span />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14.5px] font-semibold">{t('apps.title')}</p>
              <p className="mt-0.5 text-[13px] leading-[18px] text-muted-foreground">{t('apps.subtitle')}</p>
            </div>
          </div>
          {connected ? (
            <div className="flex items-center gap-3">
              <StatusLine tone="ok">{status?.via === 'key' ? t('apps.connectedKey') : t('apps.connected')}</StatusLine>
              <span className="flex-1" />
              <Btn size="md" data-vmlx-control="apps-disconnect" onClick={() => void window.api.apps.disconnect()}>{t('apps.disconnect')}</Btn>
            </div>
          ) : waiting ? (
            <div className="flex items-center gap-3">
              <StatusLine tone="checking">{status?.state === 'waiting-for-browser' ? t('apps.waitingBrowser') : t('apps.connecting')}</StatusLine>
              <span className="flex-1" />
              <Btn size="md" onClick={() => void window.api.apps.cancel()}>{t('common.cancel')}</Btn>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Btn variant="primary" size="xl" data-vmlx-control="apps-connect" onClick={() => void window.api.apps.connect()}>
                  {t('apps.continue')}
                </Btn>
                <Btn variant="plain" size="lg" data-vmlx-control="apps-key-toggle" onClick={() => setKeyOpen(o => !o)}>{t('apps.ownKey')}</Btn>
              </div>
              {status?.state === 'error' && status.error && <StatusLine tone="error">{status.error}</StatusLine>}
              <Reveal open={keyOpen}>
                <div className="flex items-center gap-2 pt-1">
                  <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder={t('apps.keyPlaceholder')}
                    data-vmlx-control="apps-key-input" autoComplete="off" spellCheck={false}
                    className="h-8 min-w-0 flex-1 rounded-[8px] border border-input bg-background px-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring/50" />
                  <Btn size="lg" disabled={!key.trim()} data-vmlx-control="apps-key-connect"
                    onClick={() => { void window.api.apps.connectKey(key).then(() => setKey('')) }}>{t('apps.connectKey')}</Btn>
                </div>
                <p className="pt-1.5 text-[12px] leading-4 text-muted-foreground">{t('apps.keyHelp')}</p>
              </Reveal>
            </div>
          )}
        </div>
      </Group>

      <Reveal open={connected}>
        <Group title={t('apps.yourApps')} footer={`${t('apps.rulesHelp')} ${t('apps.directNote')}`}>
          {(status?.featured ?? []).map(app => {
            const rule = rules[app.id] ?? 'ask'
            return (
              <div key={app.id} className="flex min-h-[52px] flex-wrap items-center gap-3 px-4 py-2" data-vmlx-app-row={app.id}>
                <span className="flex min-w-[120px] flex-1 items-center gap-2 text-[13.5px] font-medium">
                  {app.name}
                </span>
                <div role="radiogroup" aria-label={t('apps.ruleLabel', { name: app.name })}
                  className="relative grid grid-cols-3 w-[228px] rounded-[9px] bg-[var(--seg-track)] p-[2px]">
                  <div aria-hidden className="absolute top-[2px] bottom-[2px] left-[2px] rounded-[7px] bg-[var(--seg-thumb)] shadow-[var(--elev-1)] transition-transform duration-300 ease-mlx"
                    style={{ width: 'calc((100% - 4px) / 3)', transform: `translateX(${RULES.indexOf(rule) * 100}%)` }} />
                  {RULES.map(r => (
                    <button key={r} type="button" role="radio" aria-checked={rule === r} onClick={() => void setRule(app.id, r)}
                      data-vmlx-control={`apps-rule-${app.id}-${r}`}
                      className={`relative h-6 rounded-[7px] text-[12px] font-medium transition-colors ${rule === r ? (r === 'blocked' ? 'text-destructive' : 'text-foreground') : 'text-muted-foreground hover:text-foreground'}`}>
                      {t(`apps.rule.${r}`)}
                    </button>
                  ))}
                </div>
                {app.connected ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-flex h-7 items-center gap-1.5 px-1 text-[12.5px] text-muted-foreground" data-vmlx-app-connected={app.id}>
                      <Check className="h-3.5 w-3.5 text-success" />{t('apps.connectedApp')}
                    </span>
                    <Btn size="md" variant="plain" data-vmlx-control={`apps-remove-${app.id}`} onClick={() => void removeApp(app.id)}>{t('apps.removeApp')}</Btn>
                  </span>
                ) : pending.includes(app.id) ? (
                  <Btn size="md" disabled={busy === app.id} data-vmlx-control={`apps-check-${app.id}`} onClick={() => void check(app.id)}>
                    {busy === app.id && <Spinner />}{t('apps.checkAgain')}
                  </Btn>
                ) : (
                  <Btn size="md" disabled={busy === app.id || rule === 'blocked'} data-vmlx-control={`apps-connect-${app.id}`} onClick={() => void connectApp(app.id)}>
                    {busy === app.id ? <Spinner /> : <ExternalLink className="h-3.5 w-3.5" />}{t('apps.connectApp')}
                  </Btn>
                )}
                <Reveal open={!!note[app.id]} className="basis-full">
                  <p className="text-[12px] text-muted-foreground">{note[app.id]}</p>
                </Reveal>
              </div>
            )
          })}
        </Group>
      </Reveal>

      <p className="px-1 text-[12px] leading-[17px] text-muted-foreground">
        {t('apps.privacy')}{' '}
        <a href="https://docs.composio.dev/docs/security/data-retention" target="_blank" rel="noopener noreferrer" className="text-[color:var(--link)] hover:underline">{t('apps.privacyLink')}</a>
      </p>
    </div>
  )
}
