/**
 * The live verdict under a key field. Every state is laid out in the same
 * cell and cross-fades; the line itself opens and closes by height.
 */
import type { ReactNode } from 'react'
import { useTranslation } from '../../i18n'
import { Reveal } from '../ui/Reveal'
import { StatusLine, countKey } from './ui'
import type { KeyCheckState } from './useKeyCheck'

type Shown = 'checking' | 'ok' | 'rejected' | 'no-credit' | 'network' | 'format'

export function keyStatusOf(state: KeyCheckState): Shown | null {
  if (state.phase === 'idle') return null
  if (state.phase === 'checking') return 'checking'
  return state.result.ok ? 'ok' : state.result.reason
}

export function KeyStatus({ state, site, service, onRetry, okText }: {
  state: KeyCheckState
  /** Where the key comes from ("DeepSeek Platform"); custom endpoints pass none. */
  site?: string
  service: string
  onRetry: () => void
  /** Overrides the "Works — N models" line. */
  okText?: string
}) {
  const { t } = useTranslation()
  const shown = keyStatusOf(state)
  const models = state.phase === 'done' && state.result.ok ? state.result.models : 0
  const lines: Array<[Shown, ReactNode]> = [
    ['checking', <StatusLine tone="checking">{t('accounts.key.checking')}</StatusLine>],
    ['ok', <StatusLine tone="ok">{okText ?? (models > 0 ? t(countKey('accounts.key.works', models), { count: models }) : t('accounts.key.worksNoCount'))}</StatusLine>],
    ['rejected', <StatusLine tone="error">{site ? t('accounts.key.rejected', { site }) : t('accounts.key.rejectedCustom')}</StatusLine>],
    ['no-credit', <StatusLine tone="warn">{site ? t('accounts.key.noCredit', { site }) : t('accounts.key.noCreditCustom')}</StatusLine>],
    ['network', (
      <span className="flex items-start gap-2">
        <StatusLine tone="warn">{t('accounts.key.network', { service })}</StatusLine>
        <button
          type="button"
          onClick={onRetry}
          tabIndex={shown === 'network' ? 0 : -1}
          className="-my-0.5 shrink-0 rounded-[6px] px-1.5 py-0.5 text-[13px] font-medium text-[color:var(--link)] transition-colors hover:bg-foreground/[0.06]"
        >
          {t('accounts.key.retry')}
        </button>
      </span>
    )],
    ['format', <StatusLine tone="error">{t('accounts.key.format')}</StatusLine>],
  ]
  return (
    <Reveal open={shown !== null}>
      <div className="mlx-xfade pt-2" role="status" aria-live="polite">
        {lines.map(([key, line]) => (
          <div key={key} data-active={shown === key ? 'true' : 'false'} aria-hidden={shown !== key}>
            {line}
          </div>
        ))}
      </div>
    </Reveal>
  )
}
