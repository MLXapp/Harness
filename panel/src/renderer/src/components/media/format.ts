import type { MediaModel, MediaPrice } from '../../../../shared/media/catalog'
import type { MediaFit } from '../../../../shared/media/fit'

type T = (key: string, params?: Record<string, string | number>) => string

export function usd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.1) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(3).replace(/0$/, '')}`
  return `$${n.toPrecision(2).replace(/0+$/, '')}`
}

export function priceLabel(price: MediaPrice | undefined, t: T): string | null {
  if (!price) return null
  const label = t(`media.price.${price.per}`, { price: usd(price.usd) })
  return price.from ? t('media.price.from', { price: label }) : label
}

/** One line under a model in the picker. */
export function fitLine(_model: MediaModel, fit: MediaFit, t: T): { text: string; tone: 'good' | 'warn' | 'off' | 'cloud' } {
  switch (fit.state) {
    case 'good':
      return { text: t('media.fit.good'), tone: 'good' }
    case 'tight':
      return { text: t('media.fit.tight', { need: fit.needGB }), tone: 'warn' }
    case 'no':
      return { text: t('media.fit.no', { need: fit.needGB, have: fit.haveGB }), tone: 'off' }
    case 'soon':
      return {
        text: fit.wouldFit === 'no'
          ? t('media.fit.soonNo', { need: fit.needGB, have: fit.haveGB })
          : t('media.fit.soonYes'),
        tone: 'off',
      }
    case 'cloud':
      return { text: fit.connected ? t('media.fit.cloudReady') : t('media.fit.cloudConnect'), tone: 'cloud' }
  }
}

export function paramValueLabel(key: string, value: string | number | boolean, t: T): string {
  if (typeof value === 'boolean') {
    if (key === 'audio') return value ? t('media.value.soundOn') : t('media.value.soundOff')
    if (key === 'instrumental') return value ? t('media.value.instrumental') : t('media.value.vocals')
    return value ? t('media.value.on') : t('media.value.off')
  }
  if (key === 'duration') {
    const seconds = typeof value === 'number' && value > 1000 ? value / 1000 : Number(value)
    return t('media.value.seconds', { n: seconds })
  }
  if (key === 'speed') return `${Number(value).toFixed(1)}×`
  if (key === 'size') return String(value).replace('*', '×')
  if (key === 'language' && value === 'auto') return t('media.value.autoLanguage')
  if (key === 'resolution') return /k$/i.test(String(value)) ? String(value).toUpperCase() : String(value)
  return String(value).replace(/_/g, ' ')
}
