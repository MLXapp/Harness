/**
 * First-run setup, shown once after the engine is installed (and again from
 * Preferences → Accounts → Run setup again):
 *   1 Welcome · 2 Connect your accounts · 3 Your Mac · 4 Done
 * One card over the dimmed app; steps cross-fade with a 16px slide, the card
 * keeps its size, and everything that grows (previews, progress) animates.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, Laptop, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import {
  featuredAccount,
  fitFor,
  localPicksFor,
  reachableFeaturedModels,
  FEATURED_ACCOUNTS,
  type LocalPick,
} from '../../../../shared/curated'
import {
  chooseStartModel,
  connectedAccountIds,
  formatPrice,
  nextStep,
  previousStep,
  ONBOARDING_STEPS,
  type OnboardingStep,
  type StartChoice,
} from '../../../../shared/accountSetup'
import { hardwareParts, type HardwareInfo } from '../../../../shared/hardware'
import { Reveal } from '../ui/Reveal'
import { AccountGlyph } from '../accounts/AccountGlyph'
import { AccountRowsLarge } from '../accounts/AccountList'
import { openConnectAccount } from '../accounts/events'
import { AppIconTile, Badge, Btn, Spinner } from '../accounts/ui'
import { useProviders } from '../settings/useProviders'
import { usePickDownloads, type PickState } from './usePickDownloads'
import '../../styles/accounts.css'

type Direction = 'forward' | 'back'
type Phase = `enter-${Direction}` | 'shown' | `exit-${Direction}`
interface Layer { step: OnboardingStep; phase: Phase; key: number }

const BADGE_KEYS = { Best: 'onboarding.badge.best', 'Best value': 'onboarding.badge.value', Fast: 'onboarding.badge.fast' } as const
const PURPOSE_KEYS = { chat: 'onboarding.mac.chat', code: 'onboarding.mac.code', image: 'onboarding.mac.images' } as const

export function Onboarding({ open, onFinish, onStart }: {
  open: boolean
  /** Skip or close: setup is done (the caller stores it). */
  onFinish: () => void
  /** Start a chat with the chosen model, then finish. */
  onStart: (choice: StartChoice) => void
}) {
  const { t } = useTranslation()
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const [layers, setLayers] = useState<Layer[]>([{ step: 'welcome', phase: 'shown', key: 0 }])
  const seq = useRef(0)
  const current = layers[layers.length - 1].step
  const { providers } = useProviders({})
  const connected = useMemo(() => connectedAccountIds(providers), [providers])
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const picks = useMemo(() => (hardware ? localPicksFor(hardware.memoryGB) : []), [hardware])
  const downloads = usePickDownloads(picks)

  // Open / close with a fade and a small scale; start at Welcome each time.
  useEffect(() => {
    if (open) {
      setMounted(true)
      setLayers([{ step: 'welcome', phase: 'shown', key: ++seq.current }])
      document.documentElement.setAttribute('data-mlx-onboarding', '')
      let second = 0
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setShown(true)) })
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
    }
    setShown(false)
    document.documentElement.removeAttribute('data-mlx-onboarding')
    const timer = window.setTimeout(() => setMounted(false), 260)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    let alive = true
    const api = window.api?.app
    const fallback = async (): Promise<HardwareInfo> => ({ chip: 'Apple silicon', memoryGB: (await api?.getTotalMemoryGB?.().catch(() => 16)) ?? 16 })
    ;(api?.getHardware ? api.getHardware().catch(fallback) : fallback()).then(hw => { if (alive) setHardware(hw) })
    return () => { alive = false }
  }, [open])

  const go = useCallback((next: OnboardingStep, direction: Direction) => {
    setLayers(prev => {
      const top = prev[prev.length - 1]
      if (top.step === next) return prev
      return [{ ...top, phase: `exit-${direction}` }, { step: next, phase: `enter-${direction}`, key: ++seq.current }]
    })
  }, [])

  // Entering layer: paint off-position, then slide in; drop the exiting one after.
  useEffect(() => {
    const entering = layers.find(l => l.phase.startsWith('enter'))
    if (!entering) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setLayers(prev => prev.map(l => (l.key === entering.key ? { ...l, phase: 'shown' } : l))))
    })
    const timer = window.setTimeout(() => setLayers(prev => prev.filter(l => !l.phase.startsWith('exit'))), 260)
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); window.clearTimeout(timer) }
  }, [layers])

  // Return = Continue; Esc does nothing here (Skip is explicit), unless a sheet is on top.
  const startChoice = useMemo(() => {
    const downloaded = picks
      .filter(p => p.purpose !== 'image')
      .map(pick => ({ pick, state: downloads.states[pick.repo] }))
      .filter((d): d is { pick: LocalPick; state: PickState & { path: string } } => d.state?.phase === 'done' && !!d.state.path)
      .map(d => ({ pick: d.pick, path: d.state.path }))
    return chooseStartModel(providers, downloaded)
  }, [picks, downloads.states, providers])

  const primary = () => {
    if (current === 'done') onStart(startChoice)
    else go(nextStep(current), 'forward')
  }

  if (!mounted) return null
  const state = shown && open ? 'open' : 'closed'
  const stepIndex = ONBOARDING_STEPS.indexOf(current)

  const renderStep = (step: OnboardingStep): ReactNode => {
    switch (step) {
      case 'welcome':
        return <WelcomeStep onStart={() => go('accounts', 'forward')} onSkip={onFinish} />
      case 'accounts':
        return <AccountsStep connected={connected} />
      case 'mac':
        return <MacStep hardware={hardware} picks={picks} downloads={downloads} />
      case 'done':
        return <DoneStep connected={connected} picks={picks} states={downloads.states} choice={startChoice} />
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-6" data-vmlx-surface="onboarding">
      <div className="mlx-sheet-backdrop absolute inset-0 bg-background/60 backdrop-blur-md" data-state={state} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('onboarding.label')}
        data-state={state}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && current !== 'welcome' && (event.target as HTMLElement).tagName !== 'BUTTON' && (event.target as HTMLElement).tagName !== 'INPUT') {
            event.preventDefault()
            primary()
          }
        }}
        className="mlx-sheet relative flex h-[560px] max-h-full w-full max-w-[600px] flex-col overflow-hidden rounded-[14px] border border-border bg-card text-card-foreground shadow-[0_32px_80px_-32px_var(--shadow-deep),0_1px_3px_var(--lg-depth)]"
      >
        {/* Skip, top right, on every step but the last */}
        <div className={`absolute right-3 top-3 z-10 transition-opacity duration-200 ${current === 'done' || current === 'welcome' ? 'pointer-events-none opacity-0' : 'opacity-100'}`}>
          <Btn size="md" variant="plain" className="text-muted-foreground" onClick={onFinish} tabIndex={current === 'done' || current === 'welcome' ? -1 : 0}>
            {t('onboarding.skip')}
          </Btn>
        </div>

        <div className="mlx-stage min-h-0 flex-1">
          {layers.map(layer => (
            <div key={layer.key} className="mlx-step" data-phase={layer.phase} aria-hidden={layer.phase.startsWith('exit')}>
              {renderStep(layer.step)}
            </div>
          ))}
        </div>

        {/* Footer: Back · dots · Continue */}
        <div className="flex h-16 shrink-0 items-center gap-3 border-t border-border/70 px-6">
          <div className="flex w-[160px] justify-start">
            <div className={`transition-opacity duration-200 ${stepIndex > 0 ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
              <Btn size="lg" variant="plain" onClick={() => go(previousStep(current), 'back')} tabIndex={stepIndex > 0 ? 0 : -1}>
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                {t('common.back')}
              </Btn>
            </div>
          </div>
          <div className="flex flex-1 items-center justify-center gap-1.5" aria-label={t('onboarding.stepOf', { n: stepIndex + 1, total: ONBOARDING_STEPS.length })}>
            {ONBOARDING_STEPS.map((step, i) => <span key={step} className="mlx-dot" data-active={i === stepIndex ? 'true' : 'false'} />)}
          </div>
          <div className="flex w-[160px] justify-end">
            <div className={`mlx-xfade justify-items-end transition-opacity duration-200 ${current === 'welcome' ? 'pointer-events-none opacity-0' : 'opacity-100'}`}>
              <div data-active={current !== 'done' ? 'true' : 'false'}>
                <Btn size="xl" variant="primary" onClick={primary} tabIndex={current === 'done' || current === 'welcome' ? -1 : 0}>{t('onboarding.continue')}</Btn>
              </div>
              <div data-active={current === 'done' ? 'true' : 'false'}>
                <Btn size="xl" variant="primary" data-default onClick={primary} tabIndex={current === 'done' ? 0 : -1}>{t('onboarding.startChat')}</Btn>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Steps ──────────────────────────────────────────────────────────────────

function StepFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-8 pb-4 pt-8 pr-24">
        <h2 className="text-[22px] font-bold leading-7">{title}</h2>
        {subtitle && <p className="mt-1 text-[13px] leading-[18px] text-muted-foreground">{subtitle}</p>}
      </div>
      {/* Content that scrolls under the footer fades out instead of being cut. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-8 pb-6"
        style={{ maskImage: 'linear-gradient(to bottom, black calc(100% - 28px), transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 28px), transparent)' }}
      >
        {children}
      </div>
    </div>
  )
}

function WelcomeStep({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col items-center justify-center px-12 text-center">
      <AppIconTile size={88} />
      <h1 className="mt-6 text-[28px] font-bold leading-[34px] tracking-[-0.01em]">{t('onboarding.welcome.title')}</h1>
      <p className="mt-2 max-w-[400px] text-[15px] leading-[22px] text-muted-foreground">{t('onboarding.welcome.body')}</p>
      <Btn size="xl" variant="primary" className="mt-8 min-w-[180px]" data-default onClick={onStart}>{t('onboarding.welcome.start')}</Btn>
      <button type="button" onClick={onSkip} className="mt-3 h-7 rounded-[7px] px-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
        {t('onboarding.welcome.skip')}
      </button>
    </div>
  )
}

function AccountsStep({ connected }: { connected: ReadonlySet<string> }) {
  const { t } = useTranslation()
  const reachable = reachableFeaturedModels(connected)
  const preview = useRef<HTMLDivElement>(null)
  const before = useRef(reachable.length)
  // When the first account connects, glide the new "Best models" list into view
  // (after it has opened), so it is not hidden below the fold.
  useEffect(() => {
    const grew = before.current === 0 && reachable.length > 0
    before.current = reachable.length
    if (!grew) return
    const timer = window.setTimeout(() => {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      preview.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' })
    }, 420)
    return () => window.clearTimeout(timer)
  }, [reachable.length])
  return (
    <StepFrame title={t('onboarding.accounts.title')} subtitle={t('onboarding.accounts.subtitle')}>
      <AccountRowsLarge connected={connected} onConnect={openConnectAccount} />
      <button
        type="button"
        onClick={() => openConnectAccount('custom')}
        className="mt-2 h-7 rounded-[7px] px-1 text-[13px] font-medium text-[color:var(--link)] transition-colors hover:underline"
      >
        {t('accounts.otherOrCustom')}
      </button>
      <Reveal open={reachable.length > 0}>
        <div ref={preview} className="pt-4">
          <h3 className="mb-2 text-[15px] font-semibold leading-5">{t('onboarding.accounts.best')}</h3>
          <div className="overflow-hidden rounded-[12px] border border-border divide-y divide-border/70">
            {reachable.map(({ model, via }) => (
              <div key={model.key} className="flex h-11 items-center gap-2.5 px-3 mlx-view-in">
                <AccountGlyph providerId={via === 'wavespeed' ? 'wavespeed' : featuredAccount(model.account)!.catalogId} size={20} />
                <span className="truncate text-[13px] font-semibold">{model.name}</span>
                {model.badge && <Badge>{t(BADGE_KEYS[model.badge])}</Badge>}
                <span className="flex-1" />
                {model.price && (
                  <span className="shrink-0 text-[12px] text-muted-foreground mlx-num" title={model.price.note}>
                    {t('onboarding.accounts.price', formatPrice(model.price))}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </StepFrame>
  )
}

function MacStep({ hardware, picks, downloads }: {
  hardware: HardwareInfo | null
  picks: LocalPick[]
  downloads: ReturnType<typeof usePickDownloads>
}) {
  const { t } = useTranslation()
  const groups = (['chat', 'code', 'image'] as const)
    .map(purpose => ({ purpose, picks: picks.filter(p => p.purpose === purpose) }))
    .filter(g => g.picks.length > 0)
  return (
    <StepFrame title={t('onboarding.mac.title')}>
      <div className="flex min-h-[56px] items-center gap-3 rounded-[12px] bg-foreground/[0.04] px-4 py-3">
        <Laptop className="h-7 w-7 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden />
        <div className="mlx-xfade min-w-0 flex-1">
          <p data-active={hardware ? 'false' : 'true'} className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Spinner /> {t('onboarding.mac.reading')}
          </p>
          <p data-active={hardware ? 'true' : 'false'} className="text-[15px] font-semibold leading-5">
            {hardware ? hardwareParts(hardware, t).join(' · ') : ''}
          </p>
        </div>
      </div>

      <h3 className="mb-2 mt-5 text-[15px] font-semibold leading-5">{t('onboarding.mac.recommended')}</h3>
      {hardware && groups.length === 0 && <p className="text-[13px] text-muted-foreground">{t('onboarding.mac.none')}</p>}
      <div className="space-y-4">
        {groups.map(group => (
          <div key={group.purpose} className="mlx-view-in">
            <p className="mb-1.5 px-1 text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{t(PURPOSE_KEYS[group.purpose])}</p>
            <div className="overflow-hidden rounded-[12px] border border-border divide-y divide-border/70">
              {group.picks.map(pick => (
                <PickRow
                  key={pick.repo}
                  pick={pick}
                  memoryGB={hardware?.memoryGB ?? 0}
                  freeGB={hardware?.freeDiskGB}
                  state={downloads.states[pick.repo] ?? { phase: 'idle' }}
                  onDownload={() => void downloads.start(pick)}
                  onCancel={() => void downloads.cancel(pick)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 px-1 text-[12px] leading-4 text-muted-foreground">{t('onboarding.mac.background')}</p>
    </StepFrame>
  )
}

function PickRow({ pick, memoryGB, freeGB, state, onDownload, onCancel }: {
  pick: LocalPick
  memoryGB: number
  freeGB?: number
  state: PickState
  onDownload: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const fit = fitFor(pick, memoryGB)
  const busy = state.phase === 'queued' || state.phase === 'downloading'
  const done = state.phase === 'done'
  const noRoom = freeGB !== undefined && pick.sizeGB > freeGB && !done && !busy
  const percent = Math.max(0, Math.min(100, state.percent ?? 0))
  return (
    <div className="px-3">
      <div className="flex min-h-[52px] items-center gap-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold leading-[18px]">{pick.name}</span>
            <Badge tone={fit === 'good' ? 'ok' : 'warn'}>{fit === 'good' ? t('onboarding.mac.runsWell') : t('onboarding.mac.tight')}</Badge>
          </div>
          <p className="truncate text-[12px] leading-4 text-muted-foreground">{pick.blurb}</p>
        </div>
        <span className="shrink-0 text-[12px] text-muted-foreground mlx-num">{t('onboarding.mac.size', { gb: pick.sizeGB })}</span>
        <div className="mlx-xfade w-[118px] shrink-0 justify-items-end">
          <div data-active={!busy && !done ? 'true' : 'false'}>
            <Btn size="md" onClick={onDownload} disabled={noRoom} tabIndex={!busy && !done ? 0 : -1} title={noRoom ? t('onboarding.mac.noRoom', { gb: pick.sizeGB }) : undefined}>
              {state.phase === 'error' ? t('onboarding.mac.retry') : t('onboarding.mac.download')}
            </Btn>
          </div>
          <div data-active={busy ? 'true' : 'false'} className="flex items-center gap-1">
            <span className="text-[12px] text-muted-foreground mlx-num">
              {state.phase === 'queued' && !state.percent ? t('onboarding.mac.waiting') : `${Math.round(percent)}%`}
            </span>
            <button
              type="button"
              onClick={onCancel}
              tabIndex={busy ? 0 : -1}
              aria-label={t('onboarding.mac.cancel', { name: pick.name })}
              title={t('common.cancel')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <div data-active={done ? 'true' : 'false'} className="flex h-7 items-center gap-1 text-[13px] font-medium text-success">
            <Check className="h-4 w-4" strokeWidth={2.5} aria-hidden />
            {t('onboarding.mac.downloaded')}
          </div>
        </div>
      </div>
      <Reveal open={busy}>
        <div className="pb-3">
          <div className="mlx-progress" data-indeterminate={state.phase === 'queued' && !state.percent ? 'true' : 'false'}>
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
      </Reveal>
      <Reveal open={state.phase === 'error'}>
        <p className="pb-2 text-[12px] leading-4 text-destructive break-words">{state.error || t('onboarding.mac.failed')}</p>
      </Reveal>
    </div>
  )
}

function DoneStep({ connected, picks, states, choice }: {
  connected: ReadonlySet<string>
  picks: LocalPick[]
  states: Record<string, PickState>
  choice: StartChoice
}) {
  const { t } = useTranslation()
  const accounts = FEATURED_ACCOUNTS.filter(a => connected.has(a.catalogId))
  const fetched = picks.filter(p => states[p.repo] && states[p.repo].phase !== 'idle' && states[p.repo].phase !== 'error')
  return (
    <div className="flex h-full flex-col px-8 pt-10">
      <div className="flex items-center gap-4">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
          <Check className="h-6 w-6" strokeWidth={2.5} aria-hidden />
        </span>
        <h1 className="text-[28px] font-bold leading-[34px]">{t('onboarding.done.title')}</h1>
      </div>
      <div className="mt-6 min-h-0 flex-1 space-y-5 overflow-y-auto pb-6">
        <div>
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{t('onboarding.done.accounts')}</p>
          {accounts.length === 0
            ? <p className="text-[13px] text-muted-foreground">{t('onboarding.done.noAccounts')}</p>
            : (
              <div className="flex flex-wrap gap-2">
                {accounts.map(a => (
                  <span key={a.id} className="inline-flex h-8 items-center gap-2 rounded-full bg-foreground/[0.05] pl-1.5 pr-3 text-[13px] font-medium">
                    <AccountGlyph providerId={a.catalogId} size={22} />
                    {a.name}
                  </span>
                ))}
              </div>
            )}
        </div>
        <div>
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{t('onboarding.done.downloads')}</p>
          {fetched.length === 0
            ? <p className="text-[13px] text-muted-foreground">{t('onboarding.done.noDownloads')}</p>
            : (
              <div className="space-y-2">
                {fetched.map(pick => {
                  const s = states[pick.repo]
                  const done = s.phase === 'done'
                  return (
                    <div key={pick.repo} className="flex h-7 items-center gap-3">
                      <AccountGlyph local size={18} />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{pick.name}</span>
                      <div className="w-[120px]">
                        <div className="mlx-xfade justify-items-end">
                          <span data-active={done ? 'true' : 'false'} className="inline-flex items-center gap-1 text-[12px] font-medium text-success">
                            <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />{t('onboarding.mac.downloaded')}
                          </span>
                          <div data-active={done ? 'false' : 'true'} className="flex w-full items-center gap-2">
                            <div className="mlx-progress flex-1"><span style={{ width: `${Math.round(s.percent ?? 0)}%` }} /></div>
                            <span className="w-9 text-right text-[12px] text-muted-foreground mlx-num">{Math.round(s.percent ?? 0)}%</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
        </div>
        <div className="rounded-[12px] bg-foreground/[0.04] px-4 py-3 text-[13px] leading-[18px]">
          <p>{t('onboarding.done.tip')}</p>
          {choice.kind !== 'none' && (
            <p className="mt-1 text-muted-foreground">{t('onboarding.done.startsWith', { model: choice.name })}</p>
          )}
        </div>
      </div>
    </div>
  )
}
