import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronsUpDown, Cloud, Cpu } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { mediaModel, MEDIA_PROVIDER_NAMES, type MediaKind, type MediaModel, type MediaProviderId } from '../../../../shared/media/catalog'
import { canRun, pickerSections, type MediaFit } from '../../../../shared/media/fit'
import type { HardwareInfo } from '../../../../shared/hardware'
import { AccountGlyph } from '../accounts/AccountGlyph'
import { openConnectAccount } from '../accounts/events'
import { fitLine, priceLabel } from './format'

/** The model chip in a media composer and its menu: On this Mac, then Cloud. */
export function ModelPicker({ kind, model, mac, connected, onPick }: {
  kind: MediaKind
  model: MediaModel | undefined
  mac: HardwareInfo | null
  connected: ReadonlySet<MediaProviderId>
  onPick: (model: MediaModel) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const r = button.current?.getBoundingClientRect()
    if (r) setPos({ left: Math.max(12, r.left - 8), bottom: window.innerHeight - r.top + 8 })
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

  const sections = pickerSections(kind, mac, connected)
  const pick = (m: MediaModel) => { onPick(m); setOpen(false) }

  return (
    <>
      <button ref={button} type="button" data-vmlx-control="media-model" onClick={() => setOpen(o => !o)}
        aria-haspopup="menu" aria-expanded={open}
        className="flex h-8 min-w-0 max-w-[300px] items-center gap-2 rounded-full px-2.5 text-[13.5px] font-medium hover:bg-foreground/[0.06]">
        {model ? <ModelGlyph model={model} size={18} /> : null}
        <span className="truncate">{model?.name ?? t('media.chooseModel')}</span>
        {model?.where === 'cloud' && <span className="truncate text-muted-foreground font-normal">{MEDIA_PROVIDER_NAMES[model.provider]}</span>}
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && pos && createPortal(
        <div ref={menu} role="menu" data-vmlx-surface="media-model-menu"
          className="mlx-menu mlx-menu-in fixed w-[440px] max-h-[min(560px,calc(100vh-120px))] overflow-y-auto"
          style={{ left: pos.left, bottom: pos.bottom, zIndex: 2147483000, transformOrigin: 'bottom left' }}>
          {(() => {
            // What can run comes first: on this Mac when something runs here,
            // otherwise the cloud, with the local models after it as "coming".
            const localFirst = sections.local.some(r => canRun(r.fit))
            const local = sections.local.length > 0 && (
              <Section key="local" icon={<Cpu className="h-3.5 w-3.5" />} title={t('media.section.local')}
                note={mac ? t('media.yourMac', { chip: mac.chip.replace(/^Apple /, ''), gb: mac.memoryGB }) : undefined}>
                {sections.local.map(({ model: m, fit }) => (
                  <Row key={m.id} model={m} fit={fit} selected={m.id === model?.id} onPick={pick} compact={!localFirst} />
                ))}
              </Section>
            )
            const cloud = (
              <Section key="cloud" icon={<Cloud className="h-3.5 w-3.5" />} title={t('media.section.cloud')}>
                {sections.cloud.map(({ model: m, fit }) => (
                  <Row key={m.id} model={m} fit={fit} selected={m.id === model?.id} onPick={pick} />
                ))}
              </Section>
            )
            return localFirst ? [local, cloud] : [cloud, local]
          })()}
        </div>,
        document.body,
      )}
    </>
  )
}

export function ModelGlyph({ model, size = 20 }: { model: MediaModel; size?: number }) {
  return model.where === 'local'
    ? <AccountGlyph local size={size} />
    : <AccountGlyph providerId={model.provider} size={size} />
}

function Section({ icon, title, note, children }: { icon: React.ReactNode; title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="py-1">
      <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-[12px] font-semibold text-muted-foreground">
        {icon}<span>{title}</span>
        {note && <span className="ml-auto font-normal">{note}</span>}
      </div>
      {children}
    </div>
  )
}

function Row({ model, fit, selected, onPick, compact = false }: { model: MediaModel; fit: MediaFit; selected: boolean; onPick: (m: MediaModel) => void; compact?: boolean }) {
  const { t } = useTranslation()
  const line = fitLine(model, fit, t)
  const runnable = canRun(fit)
  const needsConnect = fit.state === 'cloud' && !fit.connected
  const disabled = !runnable && !needsConnect
  const twin = model.where === 'local' ? mediaModel(model.cloudTwin) : undefined
  const price = model.where === 'cloud' ? priceLabel(model.price, t) : null
  const dot = line.tone === 'good' ? 'bg-success' : line.tone === 'warn' ? 'bg-warning' : line.tone === 'cloud' ? (needsConnect ? 'bg-muted-foreground/50' : 'bg-[var(--sys-blue)]') : 'bg-muted-foreground/40'
  return (
    <div role="menuitemradio" aria-checked={selected} aria-disabled={disabled || undefined}
      data-vmlx-control={`media-model-${model.id}`} data-vmlx-state={fit.state}
      onClick={() => { if (!disabled) onPick(model) }}
      className={`group flex gap-3 rounded-[9px] px-2.5 py-2 ${disabled ? 'cursor-default' : 'cursor-pointer hover:bg-[rgb(var(--primary)/0.09)]'}`}>
      <span className={disabled ? 'opacity-45 grayscale' : ''}><ModelGlyph model={model} size={compact ? 22 : 28} /></span>
      <div className="min-w-0 flex-1">
        <div className={`flex items-center gap-1.5 ${disabled ? 'text-muted-foreground' : ''}`}>
          <span className="truncate text-[13.5px] font-medium">{model.name}</span>
          <span className="truncate text-[12px] text-muted-foreground">{model.where === 'cloud' ? MEDIA_PROVIDER_NAMES[model.provider] : model.maker}</span>
          {model.badge && !disabled && <span className="mlx-badge">{t(`media.badge.${badgeKey(model.badge)}`)}</span>}
          {!model.license.commercial && <span className="mlx-badge mlx-badge-warn">{t('media.badge.nonCommercial')}</span>}
          <span className="flex-1" />
          {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
        </div>
        {!compact && <p className={`text-[12.5px] leading-[17px] ${disabled ? 'text-muted-foreground/70' : 'text-muted-foreground'}`}>{model.blurb}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />{line.text}
          </span>
          {price && <span className="text-muted-foreground">· {price}</span>}
          {model.where === 'local' && model.downloadGB !== undefined && !compact && <span className="text-muted-foreground">· {t('media.download', { gb: model.downloadGB })}</span>}
          {needsConnect && model.where === 'cloud' && (
            <button type="button" onClick={(e) => { e.stopPropagation(); openConnectAccount(model.provider) }}
              className="ml-auto rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[12px] font-medium text-foreground hover:bg-foreground/[0.12]">
              {t('media.connect', { name: MEDIA_PROVIDER_NAMES[model.provider] })}
            </button>
          )}
          {disabled && twin && fit.state === 'no' && (
            <button type="button" onClick={(e) => { e.stopPropagation(); onPick(twin) }}
              className="ml-auto rounded-full bg-[rgb(var(--primary)/0.12)] px-2 py-0.5 text-[12px] font-medium text-[color:var(--link)] hover:bg-[rgb(var(--primary)/0.2)]">
              {t('media.useCloud', { name: twin.name })}
            </button>
          )}
        </div>
        {model.where === 'local' && model.speed && !disabled && (
          <p className="mt-0.5 text-[11.5px] text-muted-foreground/80">{model.speed}</p>
        )}
      </div>
    </div>
  )
}

function badgeKey(badge: NonNullable<MediaModel['badge']>): string {
  return badge === 'Best value' ? 'value' : badge === 'Best' ? 'best' : badge === 'Fast' ? 'fast' : 'new'
}

