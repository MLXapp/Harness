import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, ChevronRight, ChevronsUpDown, Loader2, Play, Plus, Search, SlidersHorizontal, Square } from 'lucide-react'
import { AccountGlyph } from '../accounts/AccountGlyph'
import { Reveal } from '../ui/Reveal'
import { useChatModel } from './ChatModelContext'
import { useSessionsContext, type SessionSummary } from '../../contexts/SessionsContext'
import { useProviders } from '../settings/useProviders'
import { useToast } from '../Toast'
import { useTranslation } from '../../i18n'
import { isImageSession } from '../../../../shared/sessionUtils'
import { FEATURED_ACCOUNTS, type FeaturedAccountId, type FeaturedCloudModel } from '../../../../shared/curated'
import {
  buildSwitcherGroups,
  describeSelection,
  featuredProviderModel,
  featuredReasoningLevels,
  selectableRows,
  sessionName,
  type SwitcherFeaturedRow,
  type SwitcherProviderRow,
  type SwitcherRow,
  type SwitcherSessionRow,
} from '../../../../shared/providers/switcherGroups'
import type { ProviderDraft, ProviderReasoningLevel } from '../../../../shared/providers/types'

/** Open the accounts sheet (built by Settings → Accounts). No account: the list of all. */
export function connectAccount(account?: FeaturedAccountId | 'custom'): void {
  window.dispatchEvent(new CustomEvent('vmlx:connect-account', { detail: account ? { account } : {} }))
}

/** ⌘⇧M (Ctrl+Shift+M elsewhere) opens the switcher. */
export function isSwitcherShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): boolean {
  return (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'm'
}

const PILL_NAME_MAX = 220
const POPOVER_MS = 160

function formatPrice(model: FeaturedCloudModel): string | undefined {
  if (!model.price) return undefined
  const value = model.price.input
  return `$${value < 1 ? value.toFixed(2).replace(/0$/, '') : String(value)}`
}

const BADGE_KEYS: Record<NonNullable<FeaturedCloudModel['badge']>, string> = {
  Best: 'chat.switcher.badge.best',
  'Best value': 'chat.switcher.badge.bestValue',
  Fast: 'chat.switcher.badge.fast',
}

/**
 * The model pill at the bottom-left of the composer and its popover: top
 * models of the connected accounts, models on this Mac, the rest of each
 * account behind "More from …", and the reasoning level of the selected model.
 */
export function ModelSwitcher({ compact = false }: { compact?: boolean }) {
  const chat = useChatModel()
  const { t } = useTranslation()
  const { showToast } = useToast()
  const { sessions: allSessions } = useSessionsContext()
  const { providers, localServers, probe } = useProviders()
  const sessions = useMemo(() => allSessions.filter(s => !isImageSession(s)), [allSessions])

  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [shown, setShown] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const wrapRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [labelWidth, setLabelWidth] = useState<number | null>(null)
  const listId = useId()

  const binding = chat?.binding ?? null
  const activeSession = chat?.activeSessionId ? sessions.find(s => s.id === chat.activeSessionId) : undefined
  const selection = useMemo(
    () => describeSelection({ binding, session: activeSession, localServers, providers }),
    [binding, activeSession, localServers, providers],
  )
  const searching = query.trim().length > 0
  const groups = useMemo(
    () => buildSwitcherGroups({ sessions, localServers, providers, query }),
    [sessions, localServers, providers, query],
  )
  const rows = useMemo(() => selectableRows(groups, expanded, searching), [groups, expanded, searching])

  // ── Open / close with a 160 ms fade and scale ────────────────────────────
  useEffect(() => {
    if (open) {
      setMounted(true)
      let second = 0
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setShown(true)) })
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
    }
    setShown(false)
    const timer = window.setTimeout(() => setMounted(false), POPOVER_MS + 40)
    return () => window.clearTimeout(timer)
  }, [open])

  const close = useCallback((refocus = true) => {
    setOpen(false)
    if (refocus) requestAnimationFrame(() => pillRef.current?.focus())
  }, [])

  const toggle = useCallback(() => {
    setOpen(prev => {
      if (!prev) {
        setQuery('')
        setActive(0)
        void probe()
      }
      return !prev
    })
  }, [probe])

  // Start on the selected row (opening its "More from …" group); focus the search field.
  useEffect(() => {
    if (!open) return
    const holder = binding && groups.more.find(g => g.provider.id === binding.providerId && g.rows.some(r => r.model.id === binding.modelId))
    if (holder && !expanded.has(holder.provider.id)) {
      setExpanded(prev => new Set(prev).add(holder.provider.id))
      const index = selectableRows(groups, new Set(expanded).add(holder.provider.id), false).findIndex(row => isSelected(row))
      setActive(index >= 0 ? index : 0)
      requestAnimationFrame(() => searchRef.current?.focus())
      return
    }
    const index = rows.findIndex(row => isSelected(row))
    setActive(index >= 0 ? index : 0)
    requestAnimationFrame(() => searchRef.current?.focus())
    // Only when opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => { setActive(0) }, [query])

  // Outside click closes.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) close(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, close])

  // ⌘⇧M anywhere on the chat page.
  useEffect(() => {
    if (!chat) return
    const onKey = (event: KeyboardEvent) => {
      if (!isSwitcherShortcut(event)) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chat, toggle])

  // Keep the keyboard row in view (again once a "More from …" group has unfolded).
  useEffect(() => {
    if (!open) return
    const reveal = () => listRef.current
      ?.querySelector<HTMLElement>(`[data-row-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    reveal()
    const timer = window.setTimeout(reveal, 380)
    return () => window.clearTimeout(timer)
  }, [active, open])

  // The pill's label width glides when the name changes or the composer narrows.
  const pillText = selection.none ? t('chat.switcher.chooseModel') : selection.name
  const effortText = selection.effort ? t(`chat.switcher.levels.${selection.effort}`) : ''
  useLayoutEffect(() => {
    const el = measureRef.current
    if (!el) return
    setLabelWidth(Math.min(Math.ceil(el.getBoundingClientRect().width), PILL_NAME_MAX + 80))
  }, [pillText, effortText])

  if (!chat) return null

  function isSelected(row: SwitcherRow<SessionSummary>): boolean {
    if (row.kind === 'session') return !binding && chat?.activeSessionId === row.session.id
    if (!binding) return false
    if (row.kind === 'featured') return binding.providerId === row.providerId && binding.modelId === row.modelId
    return binding.providerId === row.provider.id && binding.modelId === row.model.id
  }

  // `work` returns false when it already reported a failure: the popover stays open.
  const run = async (work: () => Promise<void | boolean>) => {
    setBusy(true)
    try {
      if (await work() !== false) close()
    } catch (error) {
      showToast('error', t('providers.picker.switchFailed'), (error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const chooseFeatured = (row: SwitcherFeaturedRow) => run(async () => {
    const provider = row.provider
    if (!provider) { connectAccount(row.model.account); return }
    let levels = provider.models.find(m => m.id === row.modelId)?.reasoningEfforts
    if (!row.present) {
      // The account does not list this model yet: add it, then bind.
      const entry = featuredProviderModel(row.model, row.modelId)
      const draft: ProviderDraft = {
        id: provider.id,
        kind: provider.kind,
        displayName: provider.displayName,
        api: provider.api,
        baseURL: provider.baseURL,
        models: [...provider.models, entry],
      }
      const saved = await window.api.providers.save(draft)
      if (!saved.ok) throw new Error(saved.error)
      levels = entry.reasoningEfforts
    }
    const effort = row.model.effort && (levels ?? featuredReasoningLevels(row.model) ?? []).includes(row.model.effort)
      ? row.model.effort
      : undefined
    await chat.setBinding({ chatId: chat.chatId, providerId: row.providerId, modelId: row.modelId, ...(effort ? { reasoningEffort: effort } : {}) })
  })

  const chooseProviderModel = (row: SwitcherProviderRow) => run(async () => {
    // Keep the chosen reasoning level when the new model offers it.
    const keep = binding?.reasoningEffort
    const reasoningEffort = keep && row.model.reasoningEfforts?.includes(keep) ? keep : undefined
    await chat.setBinding({ chatId: chat.chatId, providerId: row.provider.id, modelId: row.model.id, ...(reasoningEffort ? { reasoningEffort } : {}) })
  })

  const startSession = async (session: SessionSummary) => {
    try {
      const result = await window.api.sessions.start(session.id)
      if (!result?.success) throw new Error(result?.error || t('chat.interface.toast.failedToStart'))
    } catch (error) {
      showToast('error', t('chat.interface.toast.failedToStart'), (error as Error).message)
    }
  }

  const chooseSession = (row: SwitcherSessionRow<SessionSummary>) => run(async () => {
    // Leaving a provider model: the chat goes back to MLX sessions.
    if (binding) await chat.setBinding(null)
    try {
      await chat.selectSession(row.session.id)
    } catch (error) {
      showToast('error', t('layout.chatToolbar.sessionSwitchFailed'), (error as Error).message)
      return false
    }
    // A stopped model starts when picked, so the next message has somewhere to go.
    if (row.session.status === 'stopped' || row.session.status === 'error') void startSession(row.session)
    return true
  })

  const choose = (row: SwitcherRow<SessionSummary> | undefined) => {
    if (!row || busy) return
    if (row.kind === 'featured') void chooseFeatured(row)
    else if (row.kind === 'provider-model') void chooseProviderModel(row)
    else void chooseSession(row)
  }

  const setEffort = async (level: ProviderReasoningLevel) => {
    if (!binding) return
    try {
      await chat.setBinding({ ...binding, reasoningEffort: level })
    } catch (error) {
      showToast('error', t('providers.picker.switchFailed'), (error as Error).message)
    }
  }

  const openPreferences = () => {
    close(false)
    window.dispatchEvent(new CustomEvent('vmlx:navigate', { detail: { mode: 'server', panel: 'about' } }))
  }

  const addLocalModel = () => {
    close(false)
    window.dispatchEvent(new CustomEvent('vmlx:navigate', { detail: { mode: 'chat', panel: 'create', modelPath: null } }))
  }

  const onConnect = (account?: FeaturedAccountId) => {
    close(false)
    connectAccount(account)
  }

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (rows.length) setActive(i => (i + 1) % rows.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length) setActive(i => (i - 1 + rows.length) % rows.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(rows[active])
    }
  }

  // Esc closes; Tab stays inside the popover.
  const onPopoverKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'Tab' || !popRef.current) return
    const focusables = Array.from(popRef.current.querySelectorAll<HTMLElement>('input, button:not([disabled]):not([tabindex="-1"])'))
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  const toggleGroup = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  // ── Rows ─────────────────────────────────────────────────────────────────
  let rowIndex = 0
  // Rows of a closing "More from …" group stay visible while it folds away but
  // are not counted (the keyboard order is `rows`).
  const rowProps = (row: SwitcherRow<SessionSummary>, countable = true) => {
    const index = countable ? rowIndex++ : -1
    const selected = isSelected(row)
    return {
      id: index >= 0 ? `${listId}-${index}` : undefined,
      role: 'option' as const,
      'aria-selected': selected,
      'data-row-index': index >= 0 ? index : undefined,
      'data-active': index === active ? 'true' : undefined,
      onMouseMove: () => { if (index >= 0 && index !== active) setActive(index) },
      onClick: () => choose(row),
      className: `group relative flex w-full cursor-default items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors duration-150 ${
        index >= 0 && index === active ? 'bg-foreground/[0.07]' : ''
      }`,
      selected,
    }
  }

  const selectedMark = (on: boolean) => (
    <Check className={`h-4 w-4 flex-shrink-0 text-primary transition-opacity duration-150 ${on ? 'opacity-100' : 'opacity-0'}`} aria-hidden />
  )

  const renderFeatured = (row: SwitcherFeaturedRow) => {
    const { selected, ...props } = rowProps(row)
    const price = formatPrice(row.model)
    return (
      <div key={row.key} {...props} className={`${props.className} py-2`} data-vmlx-switcher-row="featured">
        <AccountGlyph providerId={row.model.account} size={24} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-foreground">{row.model.name}</span>
            {row.model.badge && (
              <span className="flex-shrink-0 rounded-full bg-primary/12 px-1.5 text-[11px] font-medium leading-[18px] text-primary">
                {t(BADGE_KEYS[row.model.badge])}
              </span>
            )}
          </div>
          <div className="flex items-baseline gap-2 text-[12px] text-muted-foreground">
            <span className="min-w-0 flex-1 truncate" title={row.model.blurb}>
              {row.model.blurb}
              {row.via === 'wavespeed' ? ` · ${t('chat.switcher.viaWavespeed')}` : ''}
            </span>
            {price && (
              <span
                className="flex-shrink-0 text-[11px] mlx-num"
                title={t('chat.switcher.priceTitle', { input: `$${row.model.price!.input}`, output: `$${row.model.price!.output}` })}
              >
                {t('chat.switcher.from', { price })}
              </span>
            )}
          </div>
        </div>
        {selectedMark(selected)}
      </div>
    )
  }

  const sessionState = (session: SessionSummary): { label: string; tone: string } | null => {
    if (session.status === 'running' || session.status === 'standby') return { label: t('chat.switcher.loaded'), tone: 'bg-success' }
    if (session.status === 'loading') return { label: t('chat.switcher.starting'), tone: 'bg-warning animate-pulse' }
    return null
  }

  const renderSession = (row: SwitcherSessionRow<SessionSummary>) => {
    const { selected, ...props } = rowProps(row)
    const s = row.session
    const name = sessionName(s)
    const state = sessionState(s)
    const remote = s.type === 'remote'
    const running = s.status === 'running' || s.status === 'standby' || s.status === 'loading'
    return (
      <div key={row.key} {...props} className={`${props.className} h-10`} data-vmlx-switcher-row="session">
        {remote ? <AccountGlyph name={name} size={20} /> : <AccountGlyph local size={20} />}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground" title={s.modelPath}>{name}</span>
        {state && (
          <span className="flex flex-shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${state.tone}`} />
            {state.label}
          </span>
        )}
        {selected && (
          <button
            type="button"
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation()
              if (running) void window.api.sessions.stop(s.id)
              else void startSession(s)
            }}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
            title={running ? t('sessions.toolbar.stopModel') : t('sessions.toolbar.startModel')}
            aria-label={running ? t('sessions.toolbar.stopModel') : t('sessions.toolbar.startModel')}
          >
            {running ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
        )}
        {selectedMark(selected)}
      </div>
    )
  }

  const renderProviderModel = (row: SwitcherProviderRow, countable = true) => {
    const { selected, ...props } = rowProps(row, countable)
    return (
      <div key={row.key} {...props} className={`${props.className} h-10`} title={row.model.id} data-vmlx-switcher-row="provider">
        {row.local ? <AccountGlyph local size={20} /> : <AccountGlyph providerId={row.provider.id} name={row.provider.displayName} size={20} />}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{row.model.name || row.model.id}</span>
        {row.local && <span className="flex-shrink-0 truncate text-[11px] text-muted-foreground max-w-[110px]">{row.provider.displayName}</span>}
        {selectedMark(selected)}
      </div>
    )
  }

  const renderRow = (row: SwitcherRow<SessionSummary>) =>
    row.kind === 'featured' ? renderFeatured(row) : row.kind === 'session' ? renderSession(row) : renderProviderModel(row)

  const header = (text: string) => (
    <div className="px-2.5 pb-1 pt-3 text-[11px] font-semibold text-muted-foreground" role="presentation">{text}</div>
  )

  const nothing = searching && rows.length === 0
  const levels = selection.levels
  const effort = selection.effort

  return (
    <div ref={wrapRef} className="relative min-w-0" data-vmlx-control="chat-model-switcher">
      <button
        ref={pillRef}
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={compact || selection.none ? `${pillText} (⌘⇧M)` : t('chat.switcher.title')}
        className={`flex h-7 min-w-0 items-center gap-1.5 rounded-full pl-1.5 pr-2 text-[13px] font-medium transition-colors duration-150 hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
          open ? 'bg-foreground/[0.06]' : ''
        } ${selection.none ? 'text-primary' : 'text-foreground'}`}
      >
        {selection.none
          ? <Plus className="h-4 w-4 flex-shrink-0" aria-hidden />
          : selection.local
            ? <AccountGlyph local size={16} />
            : <AccountGlyph providerId={selection.providerId} name={selection.name} size={16} />}
        {/* Label: width glides between names and to zero when the composer is narrow. */}
        <span
          className="relative flex items-center overflow-hidden whitespace-nowrap transition-[width,opacity] duration-200 ease-mlx"
          style={{ width: compact ? 0 : labelWidth ?? undefined, opacity: compact ? 0 : 1 }}
          aria-hidden={compact}
        >
          <span ref={measureRef} className="inline-flex items-center gap-1.5">
            <span className="truncate" style={{ maxWidth: PILL_NAME_MAX }}>{pillText}</span>
            {effortText && <span className="font-normal text-muted-foreground">· {effortText}</span>}
            <ChevronsUpDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />
          </span>
        </span>
        {compact && <span className="sr-only">{pillText}</span>}
      </button>

      {mounted && (
        <div
          ref={popRef}
          onKeyDown={onPopoverKey}
          role="dialog"
          aria-label={t('chat.switcher.title')}
          style={{ transitionDuration: `${POPOVER_MS}ms` }}
          className={`absolute bottom-full left-0 z-40 mb-2 flex max-h-[440px] w-[340px] max-w-[calc(100vw-32px)] origin-bottom-left flex-col overflow-hidden rounded-2xl border border-border/80 bg-popover text-popover-foreground shadow-[0_2px_6px_var(--lg-depth),0_28px_60px_-24px_var(--shadow-deep)] transition-[opacity,transform] ease-mlx ${
            shown ? 'scale-100 opacity-100' : 'pointer-events-none scale-[0.98] opacity-0'
          }`}
          data-vmlx-surface="chat-model-switcher"
        >
          <div className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-border/70 px-3">
            <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder={t('chat.switcher.searchPlaceholder')}
              aria-controls={listId}
              aria-activedescendant={rows.length ? `${listId}-${active}` : undefined}
              role="combobox"
              aria-expanded
              aria-autocomplete="list"
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            {busy && <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground" aria-hidden />}
          </div>

          <div ref={listRef} id={listId} role="listbox" aria-label={t('chat.switcher.title')} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
            {groups.featured.length > 0 && (
              <div role="group" aria-label={t('chat.switcher.topModels')}>
                {header(t('chat.switcher.topModels'))}
                {groups.featured.map(renderRow)}
              </div>
            )}

            {groups.showConnect && (
              <div className="pb-1" data-vmlx-switcher-connect>
                {header(t('chat.switcher.topModels'))}
                <button
                  type="button"
                  onClick={() => onConnect()}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/[0.07]"
                >
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                    <Plus className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-foreground">{t('chat.switcher.connectAccount')}</span>
                    <span className="block text-[12px] leading-snug text-muted-foreground">{t('chat.switcher.connectHint')}</span>
                  </span>
                </button>
                <div className="flex flex-wrap gap-1.5 px-2.5 pb-1 pt-1.5">
                  {FEATURED_ACCOUNTS.map(account => (
                    <button
                      key={account.id}
                      type="button"
                      onClick={() => onConnect(account.id)}
                      className="flex h-7 items-center gap-1.5 rounded-full border border-border/80 pl-1 pr-2.5 text-[12px] font-medium text-foreground transition-colors duration-150 hover:bg-foreground/[0.06]"
                    >
                      <AccountGlyph providerId={account.id} size={18} />
                      {account.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(groups.onThisMac.length > 0 || !searching) && (
              <div role="group" aria-label={t('chat.switcher.onThisMac')}>
                {header(t('chat.switcher.onThisMac'))}
                {groups.onThisMac.map(renderRow)}
                {!searching && (
                  <button
                    type="button"
                    onClick={addLocalModel}
                    className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.07] hover:text-foreground"
                  >
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center"><Plus className="h-4 w-4" aria-hidden /></span>
                    {t('chat.switcher.addLocal')}
                  </button>
                )}
              </div>
            )}

            {groups.more.map(group => {
              const isOpen = searching || expanded.has(group.provider.id)
              return (
                <div key={group.provider.id} role="group" aria-label={t('chat.switcher.moreFrom', { account: group.label })}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.provider.id)}
                    aria-expanded={isOpen}
                    className="mt-1 flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.07] hover:text-foreground"
                  >
                    <ChevronRight className={`h-4 w-4 flex-shrink-0 transition-transform duration-200 ease-mlx ${isOpen ? 'rotate-90' : ''}`} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{t('chat.switcher.moreFrom', { account: group.label })}</span>
                    <span className="flex-shrink-0 text-[11px] mlx-num">{group.rows.length}</span>
                  </button>
                  <Reveal open={isOpen} appear={!searching}>
                    {group.rows.map(row => renderProviderModel(row, isOpen))}
                  </Reveal>
                </div>
              )
            })}

            {groups.remoteSessions.length > 0 && (
              <div role="group" aria-label={t('chat.switcher.otherConnections')}>
                {header(t('chat.switcher.otherConnections'))}
                {groups.remoteSessions.map(renderRow)}
              </div>
            )}

            {nothing && (
              <p className="px-2.5 py-6 text-center text-[13px] text-muted-foreground">{t('chat.switcher.noMatches', { query: query.trim() })}</p>
            )}
          </div>

          <Reveal open={!!levels && levels.length > 0}>
            {levels && levels.length > 0 && (
              <div className="flex flex-col gap-1.5 border-t border-border/70 px-3 pb-3 pt-2" data-vmlx-switcher-reasoning>
                <span className="text-[12px] font-medium text-muted-foreground">{t('chat.switcher.reasoning')}</span>
                <ReasoningControl
                  levels={levels}
                  value={effort}
                  defaultLevel={selection.defaultEffort}
                  label={t('chat.switcher.reasoning')}
                  defaultLabel={t('chat.switcher.defaultLevel')}
                  labelFor={level => t(`chat.switcher.levels.${level}`)}
                  onChange={level => void setEffort(level)}
                />
              </div>
            )}
          </Reveal>

          <div className="flex flex-shrink-0 items-center gap-1 border-t border-border/70 p-1.5">
            <button
              type="button"
              onClick={openPreferences}
              className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.07] hover:text-foreground"
            >
              <SlidersHorizontal className="h-4 w-4" aria-hidden />
              {t('chat.switcher.manageModels')}
            </button>
            {!groups.showConnect && (
              <button
                type="button"
                onClick={() => onConnect()}
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.07] hover:text-foreground"
              >
                <Plus className="h-4 w-4" aria-hidden />
                {t('chat.switcher.connectAccount')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Segmented control with a sliding thumb; only the model's own levels. */
function ReasoningControl({ levels, value, defaultLevel, label, defaultLabel, labelFor, onChange }: {
  levels: ProviderReasoningLevel[]
  value?: ProviderReasoningLevel
  defaultLevel?: ProviderReasoningLevel
  label: string
  defaultLabel: string
  labelFor: (level: ProviderReasoningLevel) => string
  onChange: (level: ProviderReasoningLevel) => void
}) {
  const index = value ? levels.indexOf(value) : -1
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = event.key === 'ArrowRight' ? 1 : -1
    const next = levels[Math.min(levels.length - 1, Math.max(0, (index < 0 ? 0 : index) + step))]
    onChange(next)
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      className="relative grid h-8 w-full min-w-0 rounded-[9px] bg-foreground/[0.06] p-[2px]"
      style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}
    >
      <div
        aria-hidden
        className={`absolute bottom-[2px] left-[2px] top-[2px] rounded-[7px] bg-card shadow-[0_1px_2px_var(--lg-depth),0_2px_8px_-4px_var(--shadow)] ring-1 ring-border/50 transition-[transform,opacity] duration-200 ease-mlx ${index < 0 ? 'opacity-0' : 'opacity-100'}`}
        style={{ width: `calc((100% - 4px) / ${levels.length})`, transform: `translateX(${Math.max(0, index) * 100}%)` }}
      />
      {levels.map((level, i) => (
        <button
          key={level}
          type="button"
          role="radio"
          aria-checked={i === index}
          tabIndex={i === (index < 0 ? 0 : index) ? 0 : -1}
          onClick={() => onChange(level)}
          title={level === defaultLevel ? `${labelFor(level)} · ${defaultLabel}` : labelFor(level)}
          className={`relative z-[1] flex min-w-0 items-center justify-center gap-1 rounded-[7px] px-1 text-[12px] font-medium transition-colors duration-150 ${
            i === index ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <span className="truncate">{labelFor(level)}</span>
          {level === defaultLevel && <span className="h-1 w-1 flex-shrink-0 rounded-full bg-primary" aria-label={defaultLabel} />}
        </button>
      ))}
    </div>
  )
}
