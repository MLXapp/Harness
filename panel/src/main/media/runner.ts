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

import { randomInt, randomUUID } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ChildProcess } from 'child_process'
import { estimateCost, mediaModel, MEDIA_PROVIDER_NAMES, type MediaKind, type MediaProviderId } from '../../shared/media/catalog'
import { VOICE_SAMPLE_ID, type MediaJob, type MediaJobOutput, type MediaResult, type MediaSubmitRequest } from '../../shared/media/jobs'
import { buildCloudRequest, buildQuoteRequest, coerceValues, nextPollDelayMs, outputExtension, parsePoll, parseQuote, parseSubmit, pollUrl, songText } from '../../shared/media/request'
import { mediaUrl, mimeFor } from './paths'
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

type LocalPython = { path: string; env: NodeJS.ProcessEnv; cwd?: string }

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
    const values = coerceValues(model, request.values)
    const now = this.now()
    const job: StoredMediaJob = {
      id: randomUUID(),
      kind: model.kind,
      modelId: model.id,
      modelName: model.name,
      where: model.where,
      ...(model.where === 'cloud' ? { provider: model.provider } : {}),
      prompt,
      ...(request.lyrics && !values.instrumental ? { lyrics: String(request.lyrics) } : {}),
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
      const speech = model.task === 'text-to-speech'
      if (model.runner !== 'mlx-audio' || !(speech || model.task === 'song') || !model.repo) return { ok: false, error: 'This model cannot run here yet' }
      if (request.voiceSample) {
        const id = String(request.voiceSample)
        if (!speech || !model.voiceCloning) return { ok: false, error: `${model.name} cannot speak in a voice sample` }
        if (!VOICE_SAMPLE_ID.test(id) || !existsSync(this.voicePath(id))) return { ok: false, error: 'The voice sample is missing. Add it again.' }
        job.voiceSample = id
      }
      let song
      if (!speech) {
        try { song = songText(model, { prompt, lyrics: request.lyrics, values }) } catch (error) { return { ok: false, error: (error as Error).message } }
      }
      const python = this.deps.python()
      if (!python) return { ok: false, error: `The built-in engine is missing, so ${speech ? 'speech' : 'music'} cannot run on this Mac` }
      this.save(job)
      if (speech) void this.runLocalSpeech(job, model.repo, python)
      else void this.runLocalMusic(job, model.repo, song!, python)
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
    const values = coerceValues(model, request.values)
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

  // ── local speech and music ───────────────────────────────────────────────

  /** A saved voice sample (media:saveVoiceSample writes it). */
  voicePath(id: string): string {
    return join(this.deps.mediaRoot(), 'voices', `${id}.wav`)
  }

  private async runLocalSpeech(job: StoredMediaJob, repo: string, python: LocalPython): Promise<void> {
    const dir = join(this.deps.mediaRoot(), job.kind)
    mkdirSync(dir, { recursive: true })
    const input = join(dir, `${job.id.slice(0, 8)}.txt`)
    writeFileSync(input, job.prompt, 'utf8')
    const args = ['tts', '--model', repo, '--input', input]
    if (typeof job.values.voice === 'string') args.push('--voice', job.values.voice)
    if (typeof job.values.speed === 'number') args.push('--speed', String(job.values.speed))
    // The sample stays (it can be used again); only the text file is removed after.
    if (job.voiceSample) args.push('--ref-audio', this.voicePath(job.voiceSample))
    this.runLocalJob(job, args, [input], python, 'Speech')
  }

  private async runLocalMusic(job: StoredMediaJob, repo: string, song: { prompt: string; lyrics?: string }, python: LocalPython): Promise<void> {
    const dir = join(this.deps.mediaRoot(), job.kind)
    mkdirSync(dir, { recursive: true })
    // Text goes in files: lyrics can be long and hold any character.
    const caption = join(dir, `${job.id.slice(0, 8)}.caption.txt`)
    const lyrics = join(dir, `${job.id.slice(0, 8)}.lyrics.txt`)
    writeFileSync(caption, song.prompt, 'utf8')
    writeFileSync(lyrics, song.lyrics ?? '', 'utf8')
    const args = ['music', '--model', repo, '--caption-file', caption, '--lyrics-file', lyrics]
    if (typeof job.values.duration === 'number') args.push('--duration', String(job.values.duration))
    // A new seed each time, so the same prompt again is a new take.
    args.push('--seed', String(randomInt(0, 2 ** 31 - 1)))
    this.runLocalJob(job, args, [caption, lyrics], python, 'Music')
  }

  /** `python -m vmlx_engine.audio.job <args> --output <wav>`, reading its JSON progress lines. */
  private runLocalJob(job: StoredMediaJob, args: string[], inputs: string[], python: LocalPython, what: string): void {
    const dir = join(this.deps.mediaRoot(), job.kind)
    const name = `${job.id.slice(0, 8)}-0.wav`
    const out = join(dir, name)
    const cleanup = () => { for (const f of inputs) { try { rmSync(f, { force: true }) } catch { /* ignore */ } } }
    job.phase = 'loading'
    this.save(job)
    let child: ChildProcess
    try {
      child = this.deps.spawn(python.path, ['-B', '-s', '-u', '-m', 'vmlx_engine.audio.job', ...args, '--output', out], { env: python.env, cwd: python.cwd })
    } catch (error) {
      cleanup()
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
          // First use of a model: it is downloaded before it loads.
          const phase = event.event === 'downloading' ? 'fetching' : event.event === 'loading' ? 'loading' : event.event === 'generating' ? 'generating' : null
          if (phase === 'fetching') job.downloadedModel = true
          if (phase && job.phase !== phase) { job.phase = phase; this.save(job) }
          if (event.event === 'error' && typeof event.message === 'string') lastError = event.message
        } catch { /* not ours */ }
      }
    })
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000) })
    child.on('error', (error) => { lastError = error.message })
    child.on('close', (code) => {
      this.processes.delete(job.id)
      cleanup()
      if (this.cancelled.has(job.id)) return
      if (code === 0) {
        job.files = [out]
        this.finish(job, { status: 'done', outputs: [{ kind: 'file', url: mediaUrl(job.kind, name), mime: 'audio/wav', name }] })
      } else {
        const tail = stderrTail.trim().split('\n').pop() ?? ''
        this.finish(job, { status: 'failed', error: lastError || tail || `${what} stopped (exit ${code})` })
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

