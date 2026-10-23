// Preferences row: MLX Node — Installed / Not installed — Open / Install.
import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { MLX_DOWNLOAD_URL } from '../../../../shared/mlxNetwork'
import { useMlxNode } from './useMlxNode'

export function MlxNodePreference() {
  const { t } = useTranslation()
  const node = useMlxNode(10_000)
  const s = node.status
  const lastError = useRef(node.error)
  if (node.error) lastError.current = node.error

  const label = node.state === 'checking' ? t('network.appChecking')
    : node.state === 'installing' ? t('app.about.mlxNodeInstalling')
    : s?.installed ? t('app.about.mlxNodeInstalled') : t('app.about.mlxNodeMissing')
  const dot = node.state === 'running' ? 'bg-success'
    : node.state === 'installed' || node.state === 'installing' ? 'bg-warning'
    : 'bg-muted-foreground/40'
  const button = 'h-8 px-3.5 rounded-full text-sm font-semibold inline-flex items-center gap-1.5 transition-opacity duration-300'

  return (
    <div className="border border-border rounded-lg p-5" data-vmlx-surface="mlx-node-preference">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">{t('app.about.mlxNode')}</h3>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <span className={`h-2 w-2 shrink-0 rounded-full transition-colors duration-300 ${dot}`} />
            <span data-vmlx-state={node.state} className="font-medium">{label}</span>
            {s?.installed && s.version && <span className="text-xs text-muted-foreground">· {t('network.appVersion', { version: s.version })}</span>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('app.about.mlxNodeDesc')}</p>
        </div>
        <div className={`shrink-0 transition-opacity duration-300 ${s == null ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
          {s?.installed ? (
            <button data-vmlx-control="preferences-mlx-node-open" onClick={() => void node.open()} disabled={node.busy != null}
              className={`${button} btn-core`}>
              {t('app.about.mlxNodeOpen')}
            </button>
          ) : s?.bundled ? (
            <button data-vmlx-control="preferences-mlx-node-install" onClick={() => void node.install()} disabled={node.busy != null}
              className={`${button} btn-core disabled:opacity-60`}>
              {t('app.about.mlxNodeInstall')}
            </button>
          ) : (
            <a data-vmlx-control="preferences-mlx-node-get" href={MLX_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer"
              className={`${button} border border-border hover:bg-accent`}>
              {t('app.about.mlxNodeGet')}<ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>
      <YieldRow version={s?.installed ? s.version : undefined} />
      <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-mlx ${node.error ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
        aria-hidden={!node.error || undefined}>
        <div className="min-h-0 overflow-hidden">
          <p className="pt-3 text-xs text-muted-foreground">
            {lastError.current ? t(`main.dialog.mlxNodeFailed.${lastError.current}`) : ''}{' '}
            <a href={MLX_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[color:var(--link)] hover:underline">
              {t('app.about.mlxNodeGet')}<ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}

const atLeast = (a: string | undefined, b: string) => {
  if (!a) return false
  const pa = a.split('.').map(n => parseInt(n, 10) || 0), pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return true
}

/** "Pause MLX Node while a model runs here" (MLX Node 0.9.5 and newer). */
function YieldRow({ version }: { version?: string }) {
  const { t } = useTranslation()
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => { window.api.network.yieldEnabled?.().then(setOn).catch(() => setOn(true)) }, [])
  const supported = atLeast(version, '0.9.5')
  return (
    <div className="mt-4 flex items-start gap-4 border-t border-border pt-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t('mlxNode.yield.title')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('mlxNode.yield.help')}{version && !supported ? ` ${t('mlxNode.yield.update', { version })}` : ''}
        </p>
      </div>
      <button type="button" role="switch" aria-checked={!!on} data-vmlx-control="preferences-mlx-node-yield" disabled={on === null}
        onClick={async () => setOn(await window.api.network.setYieldEnabled!(!on))}
        className={`relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 ${on ? 'bg-[color:var(--acc)]' : 'bg-foreground/15'}`}>
        <span className={`absolute left-0 top-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ease-mlx ${on ? 'translate-x-[19px]' : 'translate-x-[3px]'}`} />
      </button>
    </div>
  )
}
