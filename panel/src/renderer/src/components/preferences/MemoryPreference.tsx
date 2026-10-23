/**
 * Preferences → Memory: what MLX Harness remembers across chats. Every entry
 * can be edited or removed here; the agent adds and removes entries only with
 * visible tool calls. Off: nothing is saved or sent.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Reveal } from '../ui/Reveal'
import { Btn, Group } from '../accounts/ui'

type Entry = { id: string; text: string; createdAt: number; updatedAt: number }

export function MemoryPreference() {
  const { t } = useTranslation()
  const [on, setOn] = useState<boolean | null>(null)
  const [items, setItems] = useState<Entry[]>([])
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const addRef = useRef<HTMLInputElement>(null)

  const load = () => { window.api.memory?.list().then(setItems).catch(() => undefined) }
  useEffect(() => {
    window.api.memory?.enabled().then(setOn).catch(() => setOn(false))
    load()
    return window.api.memory?.onChanged(load)
  }, [])

  const errorText = (e?: string) => (e === 'secret' ? t('memory.secret') : e ? t('memory.failed') : null)
  const add = async () => {
    const r = await window.api.memory!.add(draft)
    if (r.ok) { setDraft(''); setAdding(false); setError(null) } else setError(errorText(r.error))
  }
  const save = async (id: string) => {
    const r = await window.api.memory!.update(id, editText)
    if (r.ok) { setEditing(null); setError(null) } else setError(errorText(r.error))
  }

  return (
    <div className="space-y-5" data-vmlx-surface="memory-preference">
      <Group>
        <div className="flex items-start gap-4 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium">{t('memory.toggle')}</p>
            <p className="mt-0.5 text-[12.5px] leading-[17px] text-muted-foreground">{t('memory.help')}</p>
          </div>
          <button type="button" role="switch" aria-checked={!!on} data-vmlx-control="memory-enabled"
            disabled={on === null}
            onClick={async () => setOn(await window.api.memory!.setEnabled(!on))}
            className={`relative mt-0.5 h-[26px] w-[44px] shrink-0 rounded-full transition-colors duration-200 ${on ? 'bg-[color:var(--acc)]' : 'bg-foreground/15'}`}>
            <span className={`absolute left-0 top-[3px] h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ease-mlx ${on ? 'translate-x-[21px]' : 'translate-x-[3px]'}`} />
          </button>
        </div>
      </Group>

      <Group title={t('memory.saved', { n: items.length })}
        action={<Btn size="md" data-vmlx-control="memory-add" onClick={() => { setAdding(a => !a); requestAnimationFrame(() => addRef.current?.focus()) }}><Plus className="h-3.5 w-3.5" />{t('memory.add')}</Btn>}
        footer={items.length > 0 ? (
          <span className="flex items-center gap-2">
            {!confirmClear
              ? <button type="button" className="text-destructive hover:underline" onClick={() => setConfirmClear(true)}>{t('memory.clear')}</button>
              : <>
                  <span>{t('memory.clearConfirm')}</span>
                  <button type="button" className="font-medium text-destructive hover:underline" onClick={async () => { await window.api.memory!.clear(); setConfirmClear(false) }}>{t('memory.clearYes')}</button>
                  <button type="button" className="hover:underline" onClick={() => setConfirmClear(false)}>{t('common.cancel')}</button>
                </>}
          </span>
        ) : undefined}>
        <Reveal open={adding}>
          <div className="flex items-center gap-2 px-4 py-2.5">
            <input ref={addRef} value={draft} onChange={e => setDraft(e.target.value)} maxLength={500}
              onKeyDown={e => { if (e.key === 'Enter' && draft.trim()) void add(); if (e.key === 'Escape') setAdding(false) }}
              placeholder={t('memory.addPlaceholder')} data-vmlx-control="memory-add-input"
              className="h-8 min-w-0 flex-1 rounded-[8px] border border-input bg-background px-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring/50" />
            <Btn size="lg" disabled={!draft.trim()} onClick={() => void add()}>{t('memory.addSave')}</Btn>
          </div>
        </Reveal>
        {items.length === 0 && !adding && <p className="px-4 py-4 text-[13px] text-muted-foreground">{t('memory.none')}</p>}
        {items.map(e => (
          <div key={e.id} className="group flex min-h-[44px] items-center gap-2 px-4 py-2" data-vmlx-memory-row={e.id}>
            {editing === e.id ? (
              <>
                <input autoFocus value={editText} onChange={ev => setEditText(ev.target.value)} maxLength={500}
                  onKeyDown={ev => { if (ev.key === 'Enter') void save(e.id); if (ev.key === 'Escape') setEditing(null) }}
                  className="h-8 min-w-0 flex-1 rounded-[8px] border border-input bg-background px-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring/50" />
                <button type="button" onClick={() => void save(e.id)} className="mlx-icon-btn" aria-label={t('common.save')}><Check className="h-4 w-4 text-primary" /></button>
                <button type="button" onClick={() => setEditing(null)} className="mlx-icon-btn" aria-label={t('common.cancel')}><X className="h-4 w-4" /></button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 text-[13.5px] leading-[19px]">{e.text}</span>
                <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground/70 md:inline">{e.id}</span>
                <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
                  <button type="button" onClick={() => { setEditing(e.id); setEditText(e.text) }} className="mlx-icon-btn" aria-label={t('memory.edit')} title={t('memory.edit')}><Pencil className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => void window.api.memory!.delete(e.id)} className="mlx-icon-btn" aria-label={t('memory.forget')} title={t('memory.forget')} data-vmlx-control={`memory-forget-${e.id}`}><Trash2 className="h-3.5 w-3.5 text-destructive" /></button>
                </span>
              </>
            )}
          </div>
        ))}
      </Group>
      <Reveal open={!!error}><p role="alert" className="px-1 text-[12.5px] text-destructive">{error}</p></Reveal>
    </div>
  )
}
