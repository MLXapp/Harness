import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Eye, ListChecks, PenLine, ShieldAlert, X, type LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Reveal } from '../ui/Reveal'
import type { AccessMode } from './CodeWorkspace'

/**
 * How the agent works in a Code session, chosen in the composer:
 *  - ask  → Read only preset: reads freely, asks before every change;
 *  - plan → reading tools only, ends with a plan (nothing is changed);
 *  - auto → Workspace preset: edits this folder, sandboxed commands;
 *  - full → Full access: no prompts.
 */
export type AgentMode = 'ask' | 'plan' | 'auto' | 'full'

export const MODES: Array<{ mode: AgentMode; key: string; Icon: LucideIcon }> = [
  { mode: 'ask', key: 'read-only', Icon: Eye },
  { mode: 'plan', key: 'plan', Icon: ListChecks },
  { mode: 'auto', key: 'workspace', Icon: PenLine },
  { mode: 'full', key: 'full', Icon: ShieldAlert },
]

export function modeOf(access: AccessMode, plan: boolean): AgentMode {
  if (plan) return 'plan'
  return access === 'read-only' ? 'ask' : access === 'full' ? 'full' : 'auto'
}

export function accessOf(mode: Exclude<AgentMode, 'plan'>): AccessMode {
  return mode === 'ask' ? 'read-only' : mode === 'full' ? 'full' : 'workspace'
}

export interface CodeModeValue {
  mode: AgentMode
  setMode: (mode: AgentMode) => Promise<void>
}

export const CodeModeContext = createContext<CodeModeValue | null>(null)
export const useCodeMode = () => useContext(CodeModeContext)

/** The mode chip in a Code session's composer; the menu opens upwards. */
export function AgentModeChip({ compact }: { compact?: boolean }) {
  const { t } = useTranslation()
  const ctx = useCodeMode()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc) }
  }, [open])
  if (!ctx) return null
  const current = MODES.find(m => m.mode === ctx.mode) ?? MODES[2]
  const tone = ctx.mode === 'full' ? 'text-warning' : ctx.mode === 'plan' ? 'text-[color:var(--sys-blue)]' : ''
  return (
    <div className="relative" onMouseDown={e => e.stopPropagation()}>
      <button type="button" data-vmlx-control="code-mode" data-vmlx-state={ctx.mode}
        onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}
        title={t(`code.modeHelp.${current.key}`)} aria-label={`${t('code.modeTitle')}: ${t(`code.mode.${current.key}`)}`}
        className={`mlx-chip ${tone}`}>
        <current.Icon className="h-3.5 w-3.5" strokeWidth={1.9} style={ctx.mode === 'plan' ? { color: 'var(--sys-blue)' } : ctx.mode === 'full' ? { color: 'rgb(var(--warning))' } : undefined} />
        {!compact && t(`code.mode.${current.key}`)}
        <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className="mlx-menu mlx-menu-in mlx-menu-up absolute bottom-[38px] left-0 z-50 w-[310px]">
          {MODES.map(({ mode, key, Icon }) => (
            <button key={mode} type="button" role="menuitemradio" aria-checked={ctx.mode === mode}
              data-vmlx-control={`code-mode-${mode}`}
              onClick={() => { setOpen(false); void ctx.setMode(mode) }}
              className="mlx-menu-item is-tall">
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${mode === 'full' ? 'text-warning' : mode === 'plan' ? 'text-[color:var(--sys-blue)]' : 'text-muted-foreground'}`} />
              <span className="flex-1">
                <span className="block font-medium">{t(`code.mode.${key}`)}</span>
                <span className="block text-[12.5px] leading-[17px] text-muted-foreground">{t(`code.modeHelp.${key}`)}</span>
              </span>
              {ctx.mode === mode && <Check className="mt-0.5 h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * After a Plan mode turn: carry the plan out in Auto or with full access, or
 * dismiss. Shown when a turn ends while Plan mode is on.
 */
export function PlanHandoff({ loading, onSend }: { loading: boolean; onSend: (text: string) => void }) {
  const { t } = useTranslation()
  const ctx = useCodeMode()
  const [show, setShow] = useState(false)
  const [revising, setRevising] = useState(false)
  const [note, setNote] = useState('')
  const noteRef = useRef<HTMLInputElement>(null)
  const was = useRef(loading)
  useEffect(() => {
    if (was.current && !loading && ctx?.mode === 'plan') setShow(true)
    if (loading) setShow(false)
    was.current = loading
  }, [loading, ctx?.mode])
  useEffect(() => { if (ctx?.mode !== 'plan') setShow(false) }, [ctx?.mode])
  useEffect(() => { if (!show) { setRevising(false); setNote('') } }, [show])
  if (!ctx) return null
  // "Keep planning": say what to change; the agent revises the plan (still in Plan mode).
  const revise = () => {
    const text = note.trim()
    if (!text) return
    setShow(false)
    onSend(t('code.handoff.revise', { note: text }))
  }
  const run = async (mode: 'auto' | 'full') => {
    setShow(false)
    await ctx.setMode(mode)
    onSend(t('code.handoff.go'))
  }
  return (
    <Reveal open={show}>
      <div data-vmlx-section="code-plan-handoff" className="mb-2 flex flex-wrap items-center gap-2 rounded-[16px] bg-[rgb(var(--bg-2-rgb))] px-3.5 py-2 shadow-[var(--elev-1)]">
        <ListChecks className="h-4 w-4 shrink-0 text-[color:var(--sys-blue)]" strokeWidth={1.9} />
        <span className="min-w-0 flex-1 text-[13.5px] font-medium">{t('code.handoff.ready')}</span>
        <button type="button" data-vmlx-control="code-handoff-auto" onClick={() => void run('auto')}
          className="flex h-8 items-center rounded-full bg-[color:var(--acc)] px-3.5 text-[13px] font-medium text-white hover:bg-[color:var(--acc-hi)] active:scale-[0.97] transition-[background-color,transform] duration-150">
          {t('code.handoff.auto')}
        </button>
        <button type="button" data-vmlx-control="code-handoff-full" onClick={() => void run('full')}
          className="mlx-chip text-warning">{t('code.handoff.full')}</button>
        <button type="button" data-vmlx-control="code-handoff-revise" aria-expanded={revising}
          onClick={() => { setRevising(r => !r); requestAnimationFrame(() => noteRef.current?.focus()) }}
          className={`mlx-chip ${revising ? 'is-on' : ''}`}>{t('code.handoff.keepPlanning')}</button>
        <button type="button" data-vmlx-control="code-handoff-dismiss" onClick={() => setShow(false)}
          aria-label={t('code.handoff.dismiss')} title={t('code.handoff.dismiss')}
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
        <div className="basis-full">
          <Reveal open={revising}>
            <form className="flex items-center gap-2 pt-1" onSubmit={e => { e.preventDefault(); revise() }}>
              <input ref={noteRef} value={note} onChange={e => setNote(e.target.value)} placeholder={t('code.handoff.revisePlaceholder')}
                data-vmlx-control="code-handoff-note"
                onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRevising(false) } }}
                className="h-8 min-w-0 flex-1 rounded-[9px] border border-input bg-background px-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring/50" />
              <button type="submit" disabled={!note.trim()} className="mlx-chip disabled:opacity-50">{t('code.handoff.reviseSend')}</button>
            </form>
          </Reveal>
        </div>
      </div>
    </Reveal>
  )
}
