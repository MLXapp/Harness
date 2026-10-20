/**
 * Download state for the recommended local models: which are on disk, which
 * are downloading (percent from the real download events), and start/cancel.
 * Text models download by repo; image models through the image downloader so
 * they land where the Image tab looks (~/.mlxstudio/models/image).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalPick } from '../../../../shared/curated'
import { pathMatchesRepo } from '../../../../shared/accountSetup'
import { getImageModel } from '../../../../shared/imageModels'

export type PickPhase = 'idle' | 'queued' | 'downloading' | 'done' | 'error'

export interface PickState {
  phase: PickPhase
  percent?: number
  jobId?: string
  /** Local path once on disk (text models). */
  path?: string
  error?: string
}

/** The quantize level whose repo is the pick's repo (image picks). */
export function imageQuantizeFor(pick: LocalPick): number | undefined {
  if (!pick.imageModelId) return undefined
  const model = getImageModel(pick.imageModelId)
  if (!model) return undefined
  const hit = Object.entries(model.repoMap ?? {}).find(([, repo]) => repo === pick.repo)
  return hit ? Number(hit[0]) : undefined
}

export function usePickDownloads(picks: readonly LocalPick[]) {
  const [states, setStates] = useState<Record<string, PickState>>({})
  const picksRef = useRef(picks)
  picksRef.current = picks
  const mounted = useRef(true)

  const patch = useCallback((repo: string, next: Partial<PickState> | ((prev: PickState) => PickState)) => {
    if (!mounted.current) return
    setStates(prev => {
      const before = prev[repo] ?? { phase: 'idle' as const }
      const after = typeof next === 'function' ? next(before) : { ...before, ...next }
      return { ...prev, [repo]: after }
    })
  }, [])

  /** Read what is on disk and what is in flight. */
  const refresh = useCallback(async () => {
    const api = window.api?.models
    if (!api) return
    const current = picksRef.current
    try {
      const scanned: Array<{ path: string }> = await api.scan('text').catch(() => [])
      for (const pick of current.filter(p => p.purpose !== 'image')) {
        const hit = scanned.find(m => pathMatchesRepo(m.path, pick.repo))
        if (hit) patch(pick.repo, prev => (prev.phase === 'downloading' || prev.phase === 'queued' ? prev : { phase: 'done', path: hit.path }))
      }
      for (const pick of current.filter(p => p.purpose === 'image')) {
        const q = imageQuantizeFor(pick)
        if (!pick.imageModelId || q === undefined) continue
        const local = await api.checkImageModel(pick.imageModelId, q).catch(() => null)
        if (local?.available) patch(pick.repo, { phase: 'done', path: local.localPath })
      }
      const status = await api.getDownloadStatus().catch(() => null)
      for (const job of status?.activeAll ?? []) {
        if (current.some(p => p.repo === job.repoId)) {
          patch(job.repoId, { phase: 'downloading', jobId: job.jobId, percent: job.progress?.percent })
        }
      }
      for (const job of status?.queue ?? []) {
        if (current.some(p => p.repo === job.repoId)) patch(job.repoId, { phase: 'queued', jobId: job.jobId })
      }
    } catch {
      // Nothing known yet: every row offers Download.
    }
  }, [patch])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const api = window.api?.models
    if (!api) return () => { mounted.current = false }
    const ours = (repoId?: string) => !!repoId && picksRef.current.some(p => p.repo === repoId)
    const offs = [
      api.onDownloadQueued?.((d: any) => { if (ours(d.repoId)) patch(d.repoId, { phase: 'queued', jobId: d.jobId }) }),
      api.onDownloadStarted?.((d: any) => { if (ours(d.repoId)) patch(d.repoId, { phase: 'downloading', jobId: d.jobId }) }),
      api.onDownloadProgress((d: any) => {
        if (ours(d.repoId)) patch(d.repoId, { phase: 'downloading', jobId: d.jobId, percent: d.progress?.percent })
      }),
      api.onDownloadComplete((d: any) => {
        if (!ours(d.repoId)) return
        if (d.status === 'complete') {
          patch(d.repoId, { phase: 'done', percent: 100 })
          window.dispatchEvent(new CustomEvent('vmlx:models-changed'))
          void refresh()
        } else {
          patch(d.repoId, { phase: 'idle', percent: undefined, jobId: undefined })
        }
      }),
      api.onDownloadError((d: any) => {
        if (ours(d.repoId)) patch(d.repoId, { phase: 'error', error: String(d.error ?? ''), jobId: undefined })
      }),
    ]
    return () => {
      mounted.current = false
      for (const off of offs) off?.()
    }
  }, [patch, refresh])

  // Picks change with the Mac's memory (first answer may come late).
  const pickKey = picks.map(p => p.repo).join('|')
  useEffect(() => { void refresh() }, [pickKey, refresh])

  const start = useCallback(async (pick: LocalPick) => {
    patch(pick.repo, { phase: 'queued', percent: 0, error: undefined })
    try {
      const q = imageQuantizeFor(pick)
      // startDownload answers { jobId, status } (its declared type predates the queue).
      const result = (pick.imageModelId && q !== undefined
        ? await window.api.models.downloadImageModel(pick.imageModelId, q)
        : await window.api.models.startDownload(pick.repo)) as { status?: string; jobId?: string; localPath?: string } | undefined
      if (result?.status === 'already_downloaded') {
        patch(pick.repo, { phase: 'done', path: result.localPath })
      } else if (result?.jobId) {
        patch(pick.repo, prev => ({ ...prev, jobId: result.jobId, phase: prev.phase === 'idle' ? 'queued' : prev.phase }))
      }
    } catch (error) {
      patch(pick.repo, { phase: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }, [patch])

  const cancel = useCallback(async (pick: LocalPick) => {
    const jobId = states[pick.repo]?.jobId
    // Without a job id the main process would cancel whatever is first in line.
    if (!jobId) return
    patch(pick.repo, { phase: 'idle', percent: undefined, jobId: undefined })
    try {
      await window.api.models.cancelDownload(jobId)
    } catch {
      void refresh()
    }
  }, [patch, refresh, states])

  return { states, start, cancel, refresh }
}
