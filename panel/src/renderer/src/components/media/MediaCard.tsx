import { AlertTriangle, Download, FolderOpen, RotateCcw, Trash2, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { mediaModel, MEDIA_PROVIDER_NAMES } from '../../../../shared/media/catalog'
import type { MediaJob } from '../../../../shared/media/jobs'
import { useElapsed } from './hooks'
import { paramValueLabel, usd } from './format'
import { ModelGlyph } from './ModelPicker'
import { Waveform } from './Waveform'

/** One generation: the result (or a live placeholder), its prompt and what made it. */
export function MediaCard({ job, onReuse, onDeleted }: { job: MediaJob; onReuse: (job: MediaJob) => void; onDeleted: (id: string) => void }) {
  const { t } = useTranslation()
  const running = job.status === 'running'
  const elapsed = useElapsed(job.createdAt, running)
  const model = mediaModel(job.modelId)
  const file = job.outputs.find(o => o.kind === 'file')
  const text = job.outputs.find(o => o.kind === 'text')
  const tall = job.kind === 'image' || job.kind === 'video'
  const facts = Object.entries(job.values).slice(0, 3).map(([k, v]) => paramValueLabel(k, v, t))

  const actions = running ? (
    <IconButton title={t('common.cancel')} onClick={() => void window.api.media.cancel(job.id)}><X className="h-4 w-4" /></IconButton>
  ) : (
    <>
      {file && <IconButton title={t('media.save')} onClick={() => void window.api.media.save(job.id)}><Download className="h-4 w-4" /></IconButton>}
      {file && <IconButton title={t('media.reveal')} onClick={() => void window.api.media.reveal(job.id)}><FolderOpen className="h-4 w-4" /></IconButton>}
      <IconButton title={t('media.reuse')} onClick={() => onReuse(job)}><RotateCcw className="h-4 w-4" /></IconButton>
      <IconButton title={t('common.delete')} onClick={async () => { await window.api.media.delete(job.id); onDeleted(job.id) }}><Trash2 className="h-4 w-4" /></IconButton>
    </>
  )

  return (
    <article data-vmlx-surface="media-card" data-vmlx-state={job.status}
      className="group mlx-group overflow-hidden mlx-view-in">
      {tall && (
        <div className="relative aspect-video bg-[rgb(var(--bg-3-rgb))]">
          {running && <Pending phase={job.phase} progress={job.progress} seconds={elapsed} sizeGB={model?.where === 'local' ? model.downloadGB : undefined} />}
          {file && file.mime.startsWith('image/') && <img src={file.url} alt={job.prompt} className="h-full w-full object-cover" />}
          {file && file.mime.startsWith('video/') && <video src={file.url} controls playsInline preload="metadata" className="h-full w-full bg-black object-contain" />}
          {job.status === 'failed' && <Failed error={job.error} />}
          {job.status === 'cancelled' && <div className="absolute inset-0 grid place-items-center text-[13px] text-muted-foreground">{t('media.cancelled')}</div>}
          {/* Actions float over the picture, in a glass pill, on hover. */}
          <div className="mlx-card-actions">{actions}</div>
        </div>
      )}
      <div className="space-y-2 p-3.5">
        {!tall && running && <div className="relative h-14 overflow-hidden rounded-[10px] bg-[rgb(var(--bg-3-rgb))]"><Pending phase={job.phase} progress={job.progress} seconds={elapsed} sizeGB={model?.where === 'local' ? model.downloadGB : undefined} compact /></div>}
        {!tall && file && file.mime.startsWith('audio/') && <Waveform id={job.id} url={file.url} />}
        {!tall && job.status === 'failed' && <div className="relative min-h-[56px] rounded-[10px] bg-destructive/[0.06]"><Failed error={job.error} /></div>}
        {text && <p className="whitespace-pre-wrap text-[13.5px]">{text.text}</p>}
        <p className="line-clamp-2 text-[13.5px] leading-[19px]">{job.prompt}</p>
        <div className="flex min-h-[28px] items-center gap-2 text-[12px] text-muted-foreground">
          {model && <ModelGlyph model={model} size={15} />}
          <span className="min-w-0 truncate">{job.modelName}{job.provider ? ` · ${MEDIA_PROVIDER_NAMES[job.provider]}` : ` · ${t('media.onThisMac')}`}</span>
          {/* Some licences ask for the model's name with the work. */}
          {model?.license.credit && job.status === 'done' && (
            <span className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-[1px] text-[11px]" title={model.license.name} data-vmlx-section="media-credit">
              {t('media.madeWith', { name: model.license.credit })}
            </span>
          )}
          <span className="flex-1" />
          <span className="shrink-0 truncate mlx-num">
            {[...facts, ...(job.estimateUsd !== undefined && job.status === 'done' ? [`≈ ${usd(job.estimateUsd)}`] : [])].join(' · ')}
          </span>
          {!tall && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
        </div>
      </div>
    </article>
  )
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground">
      {children}
    </button>
  )
}

function Pending({ phase, progress, seconds, sizeGB, compact = false }: { phase?: MediaJob['phase']; progress?: MediaJob['progress']; seconds: number; sizeGB?: number; compact?: boolean }) {
  const { t } = useTranslation()
  const m = Math.floor(seconds / 60)
  const s = String(seconds % 60).padStart(2, '0')
  // A long local run says which step it is on, with a bar that glides between
  // steps, fills and fades out while the video is finished (no jump cut).
  const stepping = phase === 'generating' && progress
  const finishing = phase === 'finishing' && !!progress
  return (
    <div className="mlx-shimmer absolute inset-0 flex items-center justify-center">
      <div className={`flex items-center gap-2 text-muted-foreground ${compact ? 'text-[12.5px]' : 'text-[13px]'}`}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        <span className={stepping ? 'mlx-num' : ''}>
          {stepping ? t('media.phase.step', { step: progress.step, of: progress.of })
            : phase === 'fetching' && sizeGB ? t('media.phase.fetchingSize', { gb: sizeGB }) : t(`media.phase.${phase ?? 'generating'}`)}
        </span>
        <span className="mlx-num">{m}:{s}</span>
      </div>
      {progress && (
        <div className="mlx-fade-in absolute inset-x-0 bottom-0" data-vmlx-section="media-step-progress">
          <div className={`h-[3px] bg-foreground/[0.06] transition-opacity duration-500 ${finishing ? 'opacity-0 delay-500' : 'opacity-100'}`}>
            <div className="h-full origin-left bg-primary transition-transform duration-700 ease-out"
              style={{ transform: `scaleX(${finishing ? 1 : Math.max(0.02, progress.step / progress.of)})` }} />
          </div>
        </div>
      )}
    </div>
  )
}

function Failed({ error }: { error?: string }) {
  const { t } = useTranslation()
  return (
    <div className="absolute inset-0 flex items-center justify-center p-4">
      <p className="flex max-w-[90%] items-start gap-2 text-[12.5px] text-foreground">
        <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-warning" />
        <span className="line-clamp-3">{error || t('media.failed')}</span>
      </p>
    </div>
  )
}
