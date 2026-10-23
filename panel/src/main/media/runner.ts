/**
 * Runs media jobs: cloud jobs are submitted to WaveSpeed AI or Atlas Cloud and
 * polled until they finish, then their files are downloaded into MLX
 * Harness's media folder (provider URLs are temporary); local speech jobs run
 * `python -m vmlx_engine.audio.job` with the bundled Python.
 *
 * Rules from the providers' docs: a submit is never retried automatically
 * (a dropped submit may still have been charged); polls start at 2 s and back
 * off; 429/5xx on a poll just waits. API keys come from the account store in
 * the main process and never reach the renderer or the job rows.
 */

import { randomUUID } from 'crypto'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ChildProcess } from 'child_process'
import { estimateCost, mediaModel, MEDIA_PROVIDER_NAMES, type MediaKind, type MediaProviderId } from '../../shared/media/catalog'
import type { MediaJob, MediaJobOutput, MediaResult, MediaSubmitRequest } from '../../shared/media/jobs'
import { buildCloudRequest, buildQuoteRequest, coerceParam, nextPollDelayMs, outputExtension, parsePoll, parseQuote, parseSubmit, pollUrl } from '../../shared/media/request'
import { mediaUrl, mimeFor } from './protocol'
import { publicJob, type MediaJobStore, type StoredMediaJob } from './store'

type Fetch = typeof fetch

export interface MediaRunnerDeps {
  /** The job table (a getter: the database can be reopened). */
  store: () => MediaJobStore
  mediaRoot: () => string
  /** Decrypted provider key (main process only). */
  resolveKey: (provider: MediaProviderId) => string | undefined
  /** Python that has vmlx_engine and mlx-audio, plus its env; null when none. */
  python: () => { path: string; env: NodeJS.ProcessEnv; cwd?: string } | null
  spawn: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string }) => ChildProcess
  emit: (job: MediaJob) => void
  fetch?: Fetch
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
}

const MAX_DOWNLOAD_BYTES = 2 * 1024 ** 3

export class MediaRunner {
  private readonly fetch: Fetch
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly cancelled = new Set<string>()
  private readonly processes = new Map<string, ChildProcess>()

  constructor(private readonly deps: MediaRunnerDeps) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  }

  /** Pick up cloud jobs that were still running when the app quit; local ones cannot resume. */
  resume(): void {
    for (const job of this.deps.store().running()) {
      if (job.where === 'cloud' && job.remoteId && job.provider) this.schedulePoll(job, 0)
      else this.finish(job, { status: 'failed', error: 'MLX Harness quit before this finished' })
    }
  }

  list(kind: MediaKind): MediaJob[] {
    return this.deps.store().list(kind).map(publicJob)
  }

  async submit(request: MediaSubmitRequest): Promise<MediaResult<{ job: MediaJob }>> {
    const model = mediaModel(request.modelId)
    if (!model) return { ok: false, error: 'Unknown model' }
    const prompt = String(request.prompt ?? '').trim()
    if (!prompt) return { ok: false, error: 'Write a prompt first' }
    const values = Object.fromEntries(model.params.map(p => [p.key, coerceParam(p, request.values?.[p.key])]))
    const now = this.now()
    const job: StoredMediaJob = {
      id: randomUUID(),
      kind: model.kind,
      modelId: model.id,
      modelName: model.name,
      where: model.where,
      ...(model.where === 'cloud' ? { provider: model.provider } : {}),
      prompt,
      ...(request.lyrics ? { lyrics: String(request.lyrics) } : {}),
      values,
      status: 'running',
      phase: 'submitting',
      outputs: [],
      estimateUsd: estimateCost(model, values, prompt),
      createdAt: now,
      updatedAt: now,
    }

    if (model.where === 'local') {
      if (!model.available) return { ok: false, error: `${model.name} is not available in this version of MLX Harness yet` }
      if (model.runner !== 'mlx-audio' || model.task !== 'text-to-speech' || !model.repo) return { ok: false, error: 'This model cannot run here yet' }
      const python = this.deps.python()
      if (!python) return { ok: false, error: 'The built-in engine is missing, so speech cannot run on this Mac' }
      this.save(job)
      void this.runLocalSpeech(job, model.repo, python)
      return { ok: true, job: publicJob(job) }
    }

    const key = this.deps.resolveKey(model.provider)
    if (!key) return { ok: false, error: `Connect ${MEDIA_PROVIDER_NAMES[model.provider]} first` }
    let req
    try {
      req = buildCloudRequest(model, { prompt, lyrics: request.lyrics, values })
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
    this.save(job)
    void (async () => {
      try {
        const res = await this.fetch(req.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(60_000),
        })
        const json = await res.json().catch(() => ({}))
        const submitted = parseSubmit(json, res.status)
        if ('error' in submitted) return this.finish(job, { status: 'failed', error: submitted.error })
        job.remoteId = submitted.id
        job.phase = 'queued'
        this.save(job)
        this.schedulePoll(job, 0)
      } catch (error) {
        // Never resubmit on our own: the provider may have taken (and billed) it.
        this.finish(job, { status: 'failed', error: networkMessage(error) })
      }
    })()
    return { ok: true, job: publicJob(job) }
  }

  /** The provider's own price for this request (nothing runs, nothing is charged). */
  async quote(request: MediaSubmitRequest): Promise<MediaResult<{ usd: number }>> {
    const model = mediaModel(request.modelId)
    if (!model || model.where !== 'cloud') return { ok: false, error: 'No quote for this model' }
    const key = this.deps.resolveKey(model.provider)
    if (!key) return { ok: false, error: 'Not connected' }
    const values = Object.fromEntries(model.params.map(p => [p.key, coerceParam(p, request.values?.[p.key])]))
    let req
    try {
      req = buildQuoteRequest(model, { prompt: String(request.prompt || 'preview'), lyrics: request.lyrics, values })
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
    try {
      const res = await this.fetch(req.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(15_000),
      })
      const json = await res.json().catch(() => ({}))
      const usd = res.ok ? parseQuote(json) : undefined
      return usd === undefined ? { ok: false, error: 'No quote' } : { ok: true, usd }
    } catch {
      return { ok: false, error: 'No quote' }
    }
  }

  cancel(id: string): MediaResult<object> {
    const job = this.deps.store().get(id)
    if (!job) return { ok: false, error: 'Not found' }
    if (job.status !== 'running') return { ok: true }
    this.cancelled.add(id)
    this.processes.get(id)?.kill('SIGTERM')
    this.finish(job, { status: 'cancelled' })
    return { ok: true }
  }

  delete(id: string): MediaResult<object> {
    const job = this.deps.store().get(id)
    if (!job) return { ok: true }
    if (job.status === 'running') this.cancel(id)
    for (const file of job.files ?? []) {
      try { rmSync(file, { force: true }) } catch { /* already gone */ }
    }
    this.deps.store().delete(id)
    return { ok: true }
  }

  /** Absolute path of a job's n-th file (for Save As / Show in Finder). */
  filePath(id: string, index = 0): string | undefined {
    return this.deps.store().get(id)?.files?.[index]
  }

  // ── cloud ────────────────────────────────────────────────────────────────

  private schedulePoll(job: StoredMediaJob, attempt: number): void {
    this.setTimer(() => void this.poll(job.id, attempt), attempt === 0 ? 2000 : nextPollDelayMs(job.kind, attempt))
  }

  private async poll(id: string, attempt: number): Promise<void> {
    if (this.cancelled.has(id)) return
    const job = this.deps.store().get(id)
    if (!job || job.status !== 'running' || !job.remoteId || !job.provider) return
    const key = this.deps.resolveKey(job.provider)
    if (!key) return this.finish(job, { status: 'failed', error: `${MEDIA_PROVIDER_NAMES[job.provider]} was disconnected` })
    let state
    try {
      const res = await this.fetch(pollUrl(job.provider, job.remoteId), {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      const json = await res.json().catch(() => ({}))
      state = parsePoll(job.provider, json, res.status)
    } catch {
      state = { state: 'pending' as const, status: 'retrying' }
    }
    if (this.cancelled.has(id)) return
    if (state.state === 'pending') {
      const phase = state.status === 'created' || state.status === 'queued' ? 'queued' : 'generating'
      if (job.phase !== phase) { job.phase = phase; this.save(job) }
      // Give up after ~2 hours of polling.
      if (attempt > 900) return this.finish(job, { status: 'failed', error: 'The service did not finish in time' })
      return this.schedulePoll(job, attempt + 1)
    }
    if (state.state === 'failed') return this.finish(job, { status: 'failed', error: state.error })
    job.phase = 'downloading'
    this.save(job)
    try {
      const outputs: MediaJobOutput[] = []
      const files: string[] = []
      let n = 0
      for (const out of state.outputs) {
        if (out.kind === 'text') { outputs.push(out); continue }
        const name = `${job.id.slice(0, 8)}-${n++}.${outputExtension(out.url, job.kind)}`
        const path = await this.download(out.url, job.kind, name)
        files.push(path)
        outputs.push({ kind: 'file', url: mediaUrl(job.kind, name), mime: mimeFor(name), name })
      }
      job.files = files
      this.finish(job, { status: 'done', outputs })
    } catch (error) {
      this.finish(job, { status: 'failed', error: `The result could not be saved: ${(error as Error).message}` })
    }
  }

  private async download(url: string, kind: MediaKind, name: string): Promise<string> {
    if (!/^https:\/\//i.test(url)) throw new Error('unexpected result address')
    const dir = join(this.deps.mediaRoot(), kind)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    const res = await this.fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
    if (!res.ok || !res.body) throw new Error(`download answered ${res.status}`)
    const length = Number(res.headers.get('content-length') ?? 0)
    if (length > MAX_DOWNLOAD_BYTES) throw new Error('file too large')
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(path))
    return path
  }

  // ── local speech ─────────────────────────────────────────────────────────

  private async runLocalSpeech(job: StoredMediaJob, repo: string, python: { path: string; env: NodeJS.ProcessEnv; cwd?: string }): Promise<void> {
    const dir = join(this.deps.mediaRoot(), job.kind)
    mkdirSync(dir, { recursive: true })
    const name = `${job.id.slice(0, 8)}-0.wav`
    const out = join(dir, name)
    const input = join(dir, `${job.id.slice(0, 8)}.txt`)
    writeFileSync(input, job.prompt, 'utf8')
    const args = ['-B', '-s', '-u', '-m', 'vmlx_engine.audio.job', 'tts', '--model', repo, '--input', input, '--output', out]
    if (typeof job.values.voice === 'string') args.push('--voice', job.values.voice)
    if (typeof job.values.speed === 'number') args.push('--speed', String(job.values.speed))
    job.phase = 'loading'
    this.save(job)
    let child: ChildProcess
    try {
      child = this.deps.spawn(python.path, args, { env: python.env, cwd: python.cwd })
    } catch (error) {
      return this.finish(job, { status: 'failed', error: (error as Error).message })
    }
    this.processes.set(job.id, child)
    let lastError = ''
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('{')) continue
        try {
          const event = JSON.parse(line)
          if (event.event === 'generating' && job.phase !== 'generating') { job.phase = 'generating'; this.save(job) }
          if (event.event === 'error' && typeof event.message === 'string') lastError = event.message
        } catch { /* not ours */ }
      }
    })
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000) })
    child.on('error', (error) => { lastError = error.message })
    child.on('close', (code) => {
      this.processes.delete(job.id)
      try { rmSync(input, { force: true }) } catch { /* ignore */ }
      if (this.cancelled.has(job.id)) return
      if (code === 0) {
        job.files = [out]
        this.finish(job, { status: 'done', outputs: [{ kind: 'file', url: mediaUrl(job.kind, name), mime: 'audio/wav', name }] })
      } else {
        const tail = stderrTail.trim().split('\n').pop() ?? ''
        this.finish(job, { status: 'failed', error: lastError || tail || `Speech stopped (exit ${code})` })
      }
    })
  }

  // ── bookkeeping ──────────────────────────────────────────────────────────

  private save(job: StoredMediaJob): void {
    job.updatedAt = this.now()
    this.deps.store().save(job)
    this.deps.emit(publicJob(job))
  }

  private finish(job: StoredMediaJob, change: { status: 'done' | 'failed' | 'cancelled'; outputs?: MediaJobOutput[]; error?: string }): void {
    job.status = change.status
    delete job.phase
    if (change.outputs) job.outputs = change.outputs
    if (change.error) job.error = change.error
    job.finishedAt = this.now()
    this.save(job)
  }
}

function networkMessage(error: unknown): string {
  const name = (error as Error)?.name
  if (name === 'TimeoutError' || name === 'AbortError') return 'The service did not answer in time. Check its history before trying again.'
  return 'Could not reach the service. Check your connection.'
}

