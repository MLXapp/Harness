import { useState } from 'react'
import { useTranslation } from '../../i18n'
import { ImageTab } from '../image/ImageTab'
import { MediaWorkspace } from './MediaWorkspace'
import { readStored, writeStored } from './hooks'

type Where = 'local' | 'cloud'
const KEY = 'mlx.image.where'

/**
 * The Image tab: the on-device image studio (mflux, the default: images are
 * quick to make on Apple silicon) or cloud image models, switched by a small
 * segmented control. Each side keeps its own state while the other shows.
 */
export function ImageWorkspace() {
  const { t } = useTranslation()
  const [where, setWhere] = useState<Where>(() => (readStored(KEY) === 'cloud' ? 'cloud' : 'local'))
  const set = (w: Where) => { setWhere(w); writeStored(KEY, w) }
  const options: Array<[Where, string]> = [['local', t('media.onThisMac')], ['cloud', t('media.section.cloud')]]
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center px-5 mlx-hair-b">
        <div role="radiogroup" aria-label={t('shell.tabs.image')} className="relative grid grid-cols-2 rounded-[10px] bg-[var(--seg-track)] p-[3px]">
          <div aria-hidden className="absolute top-[3px] bottom-[3px] left-[3px] rounded-[8px] bg-[var(--seg-thumb)] shadow-[var(--elev-1)] transition-transform duration-300 ease-mlx"
            style={{ width: 'calc((100% - 6px) / 2)', transform: `translateX(${where === 'cloud' ? 100 : 0}%)` }} />
          {options.map(([w, label]) => (
            <button key={w} role="radio" aria-checked={where === w} data-vmlx-control={`image-where-${w}`} onClick={() => set(w)}
              className={`relative h-7 px-3.5 text-[13px] font-medium rounded-[8px] ${where === w ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className={`absolute inset-0 transition-opacity duration-300 ${where === 'local' ? 'opacity-100' : 'pointer-events-none opacity-0'}`} aria-hidden={where !== 'local' || undefined}>
          <ImageTab />
        </div>
        <div className={`absolute inset-0 transition-opacity duration-300 ${where === 'cloud' ? 'opacity-100' : 'pointer-events-none opacity-0'}`} aria-hidden={where !== 'cloud' || undefined}>
          <MediaWorkspace kind="image" />
        </div>
      </div>
    </div>
  )
}
