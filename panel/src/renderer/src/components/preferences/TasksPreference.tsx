/**
 * Preferences → Tasks: prompts that run on a schedule, each in its own chat
 * (same model and settings as the chat it was made from). Make one here or
 * ask the agent ("every weekday at 8, summarize …").
 */
import { useEffect, useState } from 'react'
import { MessageSquare, Play, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useAppState } from '../../contexts/AppStateContext'
import type { Schedule, ScheduledTask } from '../../../../shared/schedule'
import { Reveal } from '../ui/Reveal'
import { Btn, Group, Spinner, StatusLine } from '../accounts/ui'

type Row = ScheduledTask & { running: boolean }
type Kind = Schedule['kind']

export function useTasks(): Row[] | null {
  const [rows, setRows] = useState<Row[] | null>(null)
  useEffect(() => {
    const api = window.api?.tasks
    if (!api) return
    const load = () => api.list().then(setRows).catch(() => setRows([]))
    load()
    return api.onChanged(load)
  }, [])
  return rows
}

export function TasksPreference() {
  const { t, locale } = useTranslation()
  const { state, dispatch } = useAppState()
  const rows = useTasks()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<Kind>('daily')
  const [time, setTime] = useState('08:00')
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [minutes, setMinutes] = useState(60)
  const [at, setAt] = useState('')
  const [error, setError] = useState<string | null>(null)

  const when = (ms?: number | null) => (ms ? new Date(ms).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '—')
  const dayName = (d: number) => new Date(2026, 0, 4 + d).toLocaleDateString(locale, { weekday: 'short' })
  const describe = (s: Schedule) => {
    switch (s.kind) {
      case 'once': return t('tasks.when.once', { at: when(s.at) })
      case 'daily': return t('tasks.when.daily', { time: s.time })
      case 'weekly': return t('tasks.when.weekly', { days: s.days.map(dayName).join(', '), time: s.time })
      case 'interval': return s.minutes % 60 === 0 ? t('tasks.when.hours', { n: s.minutes / 60 }) : t('tasks.when.minutes', { n: s.minutes })
    }
  }

  const create = async () => {
    if (!state.activeChatId) return
    const schedule: Schedule = kind === 'once' ? { kind, at: Date.parse(at) } : kind === 'daily' ? { kind, time } : kind === 'weekly' ? { kind, days, time } : { kind, minutes }
    const r = await window.api.tasks!.create(state.activeChatId, { title: title || prompt.slice(0, 60), prompt, schedule })
    if (r.ok) { setOpen(false); setTitle(''); setPrompt(''); setError(null) } else setError(r.error ?? t('memory.failed'))
  }
  const openChat = (chatId: string) => {
    dispatch({ type: 'CLOSE_PREFERENCES' })
    window.dispatchEvent(new CustomEvent('vmlx:open-chat', { detail: { chatId } }))
  }

  return (
    <div className="space-y-5" data-vmlx-surface="tasks-preference">
      <p className="px-1 text-[13px] leading-[19px] text-muted-foreground">{t('tasks.intro')}</p>
      <Group title={t('tasks.yours')}
        action={<Btn size="md" data-vmlx-control="tasks-new" onClick={() => setOpen(o => !o)}><Plus className="h-3.5 w-3.5" />{t('tasks.new')}</Btn>}
        footer={t('tasks.footer')}>
        <Reveal open={open}>
          <div className="space-y-2.5 px-4 py-3">
            {!state.activeChatId && <StatusLine tone="warn">{t('tasks.needChat')}</StatusLine>}
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t('tasks.titlePlaceholder')} maxLength={80}
              className="h-8 w-full rounded-[8px] border border-input bg-background px-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring/50" />
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={t('tasks.promptPlaceholder')} rows={3}
              className="w-full resize-y rounded-[8px] border border-input bg-background px-2.5 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring/50" />
            <div className="flex flex-wrap items-center gap-2">
              <div role="radiogroup" className="relative grid grid-cols-4 w-[300px] rounded-[9px] bg-[var(--seg-track)] p-[2px]">
                <div aria-hidden className="absolute top-[2px] bottom-[2px] left-[2px] rounded-[7px] bg-[var(--seg-thumb)] shadow-[var(--elev-1)] transition-transform duration-300 ease-mlx"
                  style={{ width: 'calc((100% - 4px) / 4)', transform: `translateX(${(['once', 'daily', 'weekly', 'interval'] as Kind[]).indexOf(kind) * 100}%)` }} />
                {(['once', 'daily', 'weekly', 'interval'] as Kind[]).map(k => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                    className={`relative h-6 rounded-[7px] text-[12px] font-medium ${kind === k ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{t(`tasks.kind.${k}`)}</button>
                ))}
              </div>
              {kind === 'once' && <input type="datetime-local" value={at} onChange={e => setAt(e.target.value)} className="h-8 rounded-[8px] border border-input bg-background px-2 text-[13px]" />}
              {(kind === 'daily' || kind === 'weekly') && <input type="time" value={time} onChange={e => setTime(e.target.value)} className="h-8 rounded-[8px] border border-input bg-background px-2 text-[13px]" />}
              {kind === 'interval' && (
                <select value={minutes} onChange={e => setMinutes(Number(e.target.value))} className="h-8 rounded-[8px] border border-input bg-background px-2 text-[13px]">
                  {[15, 30, 60, 120, 240, 720].map(m => <option key={m} value={m}>{m % 60 === 0 ? t('tasks.when.hours', { n: m / 60 }) : t('tasks.when.minutes', { n: m })}</option>)}
                </select>
              )}
            </div>
            {kind === 'weekly' && (
              <div className="flex flex-wrap gap-1">
                {[1, 2, 3, 4, 5, 6, 0].map(d => (
                  <button key={d} type="button" onClick={() => setDays(ds => ds.includes(d) ? ds.filter(x => x !== d) : [...ds, d])}
                    className={`mlx-chip ${days.includes(d) ? 'is-on' : ''}`}>{dayName(d)}</button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Btn variant="primary" size="lg" data-vmlx-control="tasks-create" disabled={!state.activeChatId || !prompt.trim() || (kind === 'once' && !at) || (kind === 'weekly' && days.length === 0)} onClick={() => void create()}>{t('tasks.create')}</Btn>
              {error && <StatusLine tone="error">{error}</StatusLine>}
            </div>
          </div>
        </Reveal>
        {rows && rows.length === 0 && !open && <p className="px-4 py-4 text-[13px] text-muted-foreground">{t('tasks.none')}</p>}
        {(rows ?? []).map(task => (
          <div key={task.id} className="space-y-1 px-4 py-3" data-vmlx-task-row={task.id}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{task.title}</span>
              <button type="button" role="switch" aria-checked={task.enabled} aria-label={t('tasks.enabled')}
                onClick={() => void window.api.tasks!.setEnabled(task.id, !task.enabled)}
                className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 ${task.enabled ? 'bg-[color:var(--acc)]' : 'bg-foreground/15'}`}>
                <span className={`absolute left-0 top-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ease-mlx ${task.enabled ? 'translate-x-[19px]' : 'translate-x-[3px]'}`} />
              </button>
            </div>
            <p className="text-[12.5px] text-muted-foreground">
              {describe(task.schedule)} · {task.enabled ? t('tasks.next', { at: when(task.nextRun) }) : t('tasks.paused')}
            </p>
            {task.lastRun && (
              <p className={`text-[12px] ${task.lastStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                {task.running ? <span className="inline-flex items-center gap-1.5"><Spinner className="h-3 w-3" />{t('tasks.running')}</span>
                  : t(task.lastStatus === 'error' ? 'tasks.lastFailed' : 'tasks.lastOk', { at: when(task.lastRun) })}
                {task.lastNote && !task.running ? ` · ${task.lastNote}` : ''}
              </p>
            )}
            <div className="flex gap-1 pt-0.5">
              <Btn size="md" variant="plain" disabled={task.running} onClick={() => void window.api.tasks!.runNow(task.id)}><Play className="h-3.5 w-3.5" />{t('tasks.runNow')}</Btn>
              <Btn size="md" variant="plain" onClick={() => openChat(task.chatId)}><MessageSquare className="h-3.5 w-3.5" />{t('tasks.openChat')}</Btn>
              <Btn size="md" variant="plain" className="text-destructive" onClick={() => void window.api.tasks!.delete(task.id)}><Trash2 className="h-3.5 w-3.5" />{t('tasks.delete')}</Btn>
            </div>
          </div>
        ))}
      </Group>
    </div>
  )
}
