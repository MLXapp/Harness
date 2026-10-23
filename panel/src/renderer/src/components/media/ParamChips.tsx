import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { MediaParam } from '../../../../shared/media/catalog'
import { paramValueLabel } from './format'

type Values = Record<string, string | number | boolean>

/** A model's settings as small pills in the composer: toggles flip, the rest open a menu. */
export function ParamChips({ params, values, onChange }: { params: MediaParam[]; values: Values; onChange: (key: string, value: string | number | boolean) => void }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {params.map(param => param.type === 'toggle'
        ? <ToggleChip key={param.key} param={param} value={values[param.key] as boolean} onChange={onChange} />
        : <MenuChip key={param.key} param={param} value={values[param.key] as string | number} onChange={onChange} />)}
    </div>
  )
}

function ToggleChip({ param, value, onChange }: { param: Extract<MediaParam, { type: 'toggle' }>; value: boolean; onChange: (k: string, v: boolean) => void }) {
  const { t } = useTranslation()
  const on = value ?? param.default
  return (
    <button type="button" role="switch" aria-checked={on} data-vmlx-control={`media-param-${param.key}`}
      onClick={() => onChange(param.key, !on)}
      className={`mlx-chip ${on ? 'is-on' : ''}`} title={t(`media.param.${param.label}`)}>
      {paramValueLabel(param.key, on, t)}
    </button>
  )
}

function MenuChip({ param, value, onChange }: { param: Exclude<MediaParam, { type: 'toggle' }>; value: string | number; onChange: (k: string, v: string | number) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const current = value ?? param.default

  useLayoutEffect(() => {
    if (!open) return
    const r = button.current?.getBoundingClientRect()
    if (r) setPos({ left: r.left, bottom: window.innerHeight - r.top + 6 })
  }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      const target = e.target as Node
      if (!button.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <>
      <button ref={button} type="button" data-vmlx-control={`media-param-${param.key}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(o => !o)} className="mlx-chip" title={t(`media.param.${param.label}`)}>
        {paramValueLabel(param.key, current, t)}
      </button>
      {open && pos && createPortal(
        <div ref={menu} role="menu" className="mlx-menu mlx-menu-in fixed min-w-[168px] max-h-[320px] overflow-y-auto"
          style={{ left: pos.left, bottom: pos.bottom, zIndex: 2147483000, transformOrigin: 'bottom left' }}>
          <div className="px-2.5 pt-1 pb-1.5 text-[12px] font-semibold text-muted-foreground">{t(`media.param.${param.label}`)}</div>
          {param.type === 'select' ? param.options.map(option => (
            <button key={String(option)} type="button" role="menuitemradio" aria-checked={option === current}
              onClick={() => { onChange(param.key, option); setOpen(false) }} className="mlx-menu-item">
              <span className="flex-1">{paramValueLabel(param.key, option, t)}</span>
              {option === current && <Check className="h-4 w-4 text-primary" />}
            </button>
          )) : (
            <div className="px-2.5 pb-2 pt-1 w-[220px]">
              <input type="range" className="cfg-slider" min={param.min} max={param.max} step={param.step}
                value={Number(current)} onChange={(e) => onChange(param.key, Number(e.target.value))} />
              <div className="mt-1 flex justify-between text-[12px] text-muted-foreground mlx-num">
                <span>{paramValueLabel(param.key, param.min, t)}</span>
                <span className="font-medium text-foreground">{paramValueLabel(param.key, Number(current), t)}</span>
                <span>{paramValueLabel(param.key, param.max, t)}</span>
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
