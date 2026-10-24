import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateCost, mediaModel, MEDIA_MODELS, modelsFor, wanLocalFrames, wanLocalSize, type CloudMediaModel } from '../src/shared/media/catalog'
import { canRun, localPossible, mediaFit, recommendedModel } from '../src/shared/media/fit'
import { buildCloudRequest, coerceParam, nextPollDelayMs, outputExtension, parsePoll, parseSubmit, pollUrl } from '../src/shared/media/request'

const none = new Set<never>()
const ws = new Set(['wavespeed' as const])
const at = new Set(['atlascloud' as const])
const cloud = (id: string) => mediaModel(id) as CloudMediaModel

describe('media catalog', () => {
  it('has unique ids, and every model belongs to its tab with sane parameters', () => {
    const ids = MEDIA_MODELS.map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const m of MEDIA_MODELS) {
      expect(['image', 'video', 'audio', 'music']).toContain(m.kind)
      for (const p of m.params) {
        if (p.type === 'select') expect(p.options).toContain(p.default)
        if (p.type === 'number') expect(p.default).toBeGreaterThanOrEqual(p.min)
      }
      if (m.where === 'local') {
        expect(m.minMemoryGB).toBeLessThanOrEqual(m.recMemoryGB)
        if (m.cloudTwin) expect(mediaModel(m.cloudTwin)?.where).toBe('cloud')
        if (m.available) expect(m.repo).toBeTruthy()
      }
    }
  })

  it('keeps Wan 3.0 cloud-only (no open weights); Wan 2.2 TI2V 5B is the one local video model', () => {
    expect(modelsFor('video').filter(m => m.name === 'Wan 3.0').every(m => m.where === 'cloud')).toBe(true)
    const local = modelsFor('video').filter(m => m.where === 'local' && m.available)
    expect(local.map(m => m.id)).toEqual(['local:wan-2.2-ti2v-5b'])
  })

  it('sizes local Wan clips in multiples of 32 within 1280 × 704 pixels, 4n + 1 frames', () => {
    for (const aspect of ['16:9', '9:16', '1:1']) {
      for (const res of ['480p', '720p']) {
        const { width, height } = wanLocalSize(aspect, res)
        expect(width % 32 + height % 32).toBe(0)
        expect(width * height).toBeLessThanOrEqual(1280 * 704)
      }
    }
    expect([2, 3, 5].map(wanLocalFrames)).toEqual([49, 73, 121])
    expect([49, 73, 121].every(f => (f - 1) % 4 === 0)).toBe(true)
  })

  it('estimates from list prices', () => {
    expect(estimateCost(cloud('at:wan-3.0'), { duration: 5 })).toBeCloseTo(0.2)
    expect(estimateCost(cloud('ws:z-image-turbo'), {})).toBe(0.005)
    expect(estimateCost(cloud('at:elevenlabs-v3'), {}, 'x'.repeat(2500))).toBeCloseTo(0.3)
    expect(estimateCost(cloud('ws:ace-step-1.5'), { duration: 60 })).toBeCloseTo(0.018)
    expect(estimateCost(cloud('ws:qwen3-tts'), {})).toBe(0.005)
    // Matches WaveSpeed's own quotes for Wan 3.0 (5 s): 480p $0.2375, 720p $0.475, 1080p $0.95.
    expect(estimateCost(cloud('ws:wan-3.0'), { duration: 5, resolution: '720p' })).toBeCloseTo(0.475)
    expect(estimateCost(cloud('ws:wan-3.0'), { duration: 10, resolution: '1080p' })).toBeCloseTo(1.9)
    // WaveSpeed quotes (23 Oct 2026): ElevenLabs Music v2.5 60 s $0.75; ACE-Step 180 s $0.054; Mureka V9.5 $0.225.
    expect(estimateCost(cloud('ws:elevenlabs-music-v2.5'), { duration: 60000 })).toBeCloseTo(0.75)
    expect(estimateCost(cloud('ws:ace-step-1.5'), { duration: 180 })).toBeCloseTo(0.054)
    expect(estimateCost(cloud('ws:mureka-v9.5'), {})).toBe(0.225)
  })
})

describe('fit on this Mac', () => {
  it('greys out what does not fit, says "soon" for runners not in this build', () => {
    const kokoro = mediaModel('local:kokoro-82m')!
    expect(mediaFit(kokoro, { memoryGB: 8 }, none)).toEqual({ state: 'good' })
    const ltx = mediaModel('local:ltx-2.3-int8')!
    expect(mediaFit(ltx, { memoryGB: 16 }, none)).toMatchObject({ state: 'soon', wouldFit: 'no', needGB: 32, haveGB: 16 })
    expect(mediaFit(ltx, { memoryGB: 64 }, none)).toMatchObject({ state: 'soon', wouldFit: 'good' })
    const chatterbox = mediaModel('local:chatterbox-turbo')!
    expect(mediaFit(chatterbox, { memoryGB: 8 }, none)).toMatchObject({ state: 'tight', needGB: 16 })
    expect(canRun(mediaFit(cloud('ws:wan-3.0'), null, none))).toBe(false)
    expect(canRun(mediaFit(cloud('ws:wan-3.0'), null, ws))).toBe(true)
  })

  it('recommends a local model that runs well, else a connected cloud model, preferring best value', () => {
    expect(recommendedModel('audio', { memoryGB: 8 }, none)?.id).toBe('local:kokoro-82m')
    expect(recommendedModel('video', { memoryGB: 128 }, at)?.id).toBe('at:wan-3.0')
    // Local video takes minutes: this Mac's model only when no cloud account is connected.
    expect(recommendedModel('video', { memoryGB: 128 }, none)?.id).toBe('local:wan-2.2-ti2v-5b')
    expect(recommendedModel('video', { memoryGB: 16 }, ws)?.id).toBe('ws:wan-3.0')
    expect(recommendedModel('music', { memoryGB: 16 }, at)?.id).toBe('at:minimax-music-3')
    expect(recommendedModel('music', { memoryGB: 16 }, ws)?.id).toBe('ws:ace-step-1.5')
    // MiniMax Music 3 runs well from 48 GB, on the bundled mlx-audio: private and free.
    expect(recommendedModel('music', { memoryGB: 64 }, ws)?.id).toBe('local:minimax-music-3-4bit')
    expect(recommendedModel('music', { memoryGB: 32 }, ws)?.id).toBe('ws:ace-step-1.5')
    // Nothing connected: still the best-value cloud model (the composer offers to connect).
    expect(recommendedModel('video', { memoryGB: 16 }, none)?.id).toBe('ws:wan-3.0')
  })

  it('tells the tab what this Mac can do', () => {
    expect(localPossible('audio', { memoryGB: 8 })).toEqual({ runsHere: true, couldRunHere: true })
    expect(localPossible('video', { memoryGB: 8 })).toEqual({ runsHere: false, couldRunHere: false })
    expect(localPossible('video', { memoryGB: 16 })).toEqual({ runsHere: false, couldRunHere: true })
  })
})

describe('provider requests', () => {
  it('WaveSpeed: the model is the path, the body holds only its parameters', () => {
    const req = buildCloudRequest(cloud('ws:wan-3.0'), { prompt: '  a wave  ', values: { duration: 8, aspect: '9:16', resolution: '1080p', audio: false } })
    expect(req.url).toBe('https://api.wavespeed.ai/api/v3/alibaba/wan-3.0/text-to-video')
    expect(req.body).toEqual({ prompt: 'a wave', duration: 8, aspect_ratio: '9:16', resolution: '1080p', generate_audio: false })
  })

  it('Atlas Cloud: the model id goes in the body and the endpoint follows the output type', () => {
    const video = buildCloudRequest(cloud('at:wan-3.0'), { prompt: 'x', values: { duration: 3 } })
    expect(video.url).toBe('https://api.atlascloud.ai/api/v1/model/generateVideo')
    expect(video.body).toMatchObject({ model: 'alibaba/wan-3.0/text-to-video', prompt: 'x', duration: 3, ratio: '16:9', audio: true })
    const song = buildCloudRequest(cloud('at:minimax-music-3'), { prompt: 'lofi', lyrics: '[Verse]\nla', values: { instrumental: false } })
    expect(song.url).toBe('https://api.atlascloud.ai/api/v1/model/generateAudio')
    expect(song.body).toEqual({ model: 'minimax/music-3.0', prompt: 'lofi', lyrics: '[Verse]\nla', is_instrumental: false, format: 'mp3' })
  })

  it('never sends a value the control does not allow, and refuses an empty prompt', () => {
    const wan = cloud('ws:wan-3.0')
    expect(buildCloudRequest(wan, { prompt: 'p', values: { duration: 99, aspect: '7:3', audio: 'yes' } }).body)
      .toMatchObject({ duration: 5, aspect_ratio: '16:9', generate_audio: true })
    expect(() => buildCloudRequest(wan, { prompt: '   ', values: {} })).toThrow()
    expect(coerceParam({ key: 'speed', field: 'speed', type: 'number', min: 0.5, max: 2, step: 0.1, default: 1, label: 'speed' }, 1.26)).toBe(1.3)
  })

  it('reads submit and poll replies of both providers', () => {
    expect(parseSubmit({ code: 200, message: 'success', data: { id: 'abc', status: 'created' } }, 200)).toEqual({ id: 'abc' })
    expect(parseSubmit({ code: 401, msg: 'invalid token' }, 401)).toEqual({ error: 'invalid token' })
    expect(parsePoll('wavespeed', { data: { status: 'processing', outputs: [] } }, 200)).toEqual({ state: 'pending', status: 'processing' })
    expect(parsePoll('wavespeed', { data: { status: 'completed', outputs: ['https://cdn.x/a.mp4'] } }, 200))
      .toEqual({ state: 'done', outputs: [{ kind: 'url', url: 'https://cdn.x/a.mp4' }] })
    expect(parsePoll('atlascloud', { data: { status: 'succeeded', outputs: ['https://cdn.x/a.png'] } }, 200)).toMatchObject({ state: 'done' })
    expect(parsePoll('wavespeed', { data: { status: 'failed', error: 'moderation', code: 1200 } }, 200)).toEqual({ state: 'failed', error: 'moderation', code: 1200 })
    expect(parsePoll('atlascloud', {}, 503)).toMatchObject({ state: 'pending' })
    expect(parsePoll('atlascloud', { msg: 'invalid token' }, 401)).toMatchObject({ state: 'failed', error: 'invalid token' })
    expect(parsePoll('wavespeed', { data: { status: 'completed', outputs: [] } }, 200)).toMatchObject({ state: 'failed' })
    expect(pollUrl('wavespeed', 'a/b')).toBe('https://api.wavespeed.ai/api/v3/predictions/a%2Fb/result')
    expect(pollUrl('atlascloud', 'id1')).toBe('https://api.atlascloud.ai/api/v1/model/prediction/id1')
  })

  it('polls no faster than every 2 s and picks safe file extensions', () => {
    expect(nextPollDelayMs('video', 0)).toBe(2000)
    expect(nextPollDelayMs('image', 50)).toBe(5000)
    expect(nextPollDelayMs('video', 50)).toBe(10000)
    expect(outputExtension('https://cdn.x/out.MP4?sig=1', 'video')).toBe('mp4')
    expect(outputExtension('https://cdn.x/out.exe', 'video')).toBe('mp4')
    expect(outputExtension('https://cdn.x/a.jpeg', 'image')).toBe('jpg')
  })
})

describe('media runner (cloud)', () => {
  it('submits once, polls until done, downloads into the media folder and never exposes the key', async () => {
    const { MediaRunner } = await import('../src/main/media/runner')
    const root = mkdtempSync(join(tmpdir(), 'mlx-media-'))
    const rows = new Map<string, any>()
    const store: any = {
      save: (j: any) => rows.set(j.id, JSON.parse(JSON.stringify(j))),
      get: (id: string) => (rows.has(id) ? JSON.parse(JSON.stringify(rows.get(id))) : undefined),
      list: () => [...rows.values()],
      running: () => [...rows.values()].filter(j => j.status === 'running'),
      delete: (id: string) => rows.delete(id),
    }
    const calls: Array<{ url: string; init?: any }> = []
    let polls = 0
    const fakeFetch = async (url: string, init?: any) => {
      calls.push({ url, init })
      if (url.endsWith('/alibaba/wan-3.0/text-to-video')) return new Response(JSON.stringify({ code: 200, data: { id: 'pred-1', status: 'created' } }), { status: 200 })
      if (url.includes('/predictions/pred-1/result')) {
        polls++
        const done = polls >= 2
        return new Response(JSON.stringify({ data: { status: done ? 'completed' : 'processing', outputs: done ? ['https://cdn.example/v.mp4'] : [] } }), { status: 200 })
      }
      if (url === 'https://cdn.example/v.mp4') return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      return new Response('{}', { status: 404 })
    }
    const timers: Array<() => void> = []
    const emitted: any[] = []
    const runner = new MediaRunner({
      store: () => store,
      mediaRoot: () => root,
      resolveKey: (p) => (p === 'wavespeed' ? 'ws-secret-key' : undefined),
      python: () => null,
      spawn: () => { throw new Error('no python') },
      emit: (job) => emitted.push(job),
      fetch: fakeFetch as any,
      setTimer: (fn) => { timers.push(fn) },
    })
    const result = await runner.submit({ modelId: 'ws:wan-3.0', prompt: 'a wave', values: { duration: 5 } })
    expect(result.ok).toBe(true)
    const id = (result as any).job.id
    // Let the submit finish, then run the scheduled polls.
    for (let i = 0; i < 20 && rows.get(id)?.status === 'running'; i++) {
      await new Promise(r => setTimeout(r, 0))
      const next = timers.shift()
      if (next) { next(); await new Promise(r => setTimeout(r, 5)) }
    }
    const job = rows.get(id)
    expect(job.status).toBe('done')
    expect(calls.filter(c => c.init?.method === 'POST')).toHaveLength(1)
    expect(calls[0].init.headers.Authorization).toBe('Bearer ws-secret-key')
    expect(job.outputs[0]).toMatchObject({ kind: 'file', mime: 'video/mp4' })
    expect(job.outputs[0].url).toMatch(/^mlx-media:\/\/media\/video\//)
    expect(existsSync(job.files[0])).toBe(true)
    expect([...readFileSync(job.files[0])]).toEqual([1, 2, 3])
    for (const e of emitted) {
      expect(JSON.stringify(e)).not.toContain('ws-secret-key')
      expect(e).not.toHaveProperty('remoteId')
      expect(e).not.toHaveProperty('files')
    }
  })

  it('refuses a cloud job without a key and a local model that is not in this build', async () => {
    const { MediaRunner } = await import('../src/main/media/runner')
    const runner = new MediaRunner({
      store: () => ({ save() {}, get() {}, list: () => [], running: () => [], delete() {} } as any),
      mediaRoot: () => tmpdir(), resolveKey: () => undefined, python: () => null,
      spawn: () => { throw new Error('x') }, emit: () => {},
    })
    expect(await runner.submit({ modelId: 'at:wan-3.0', prompt: 'p', values: {} })).toEqual({ ok: false, error: 'Connect Atlas Cloud first' })
    expect((await runner.submit({ modelId: 'local:ltx-2.3-int4', prompt: 'p', values: {} })).ok).toBe(false)
    expect((await runner.submit({ modelId: 'local:kokoro-82m', prompt: 'p', values: {} }) as any).error).toMatch(/engine/)
  })
})

describe('music requests', () => {
  const body = (id: string, input: { prompt: string; lyrics?: string; values?: Record<string, unknown> }) =>
    buildCloudRequest(cloud(id), { prompt: input.prompt, lyrics: input.lyrics, values: input.values ?? {} })

  it('Mureka: sings the lyrics, picks a singer only when asked, and makes instrumentals on its BGM endpoint', () => {
    const song = body('ws:mureka-v9.5', { prompt: 'indie pop', lyrics: '[Verse]\nhello', values: { singer: '' } })
    expect(song.url).toBe('https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-song')
    expect(song.body).toEqual({ prompt: 'indie pop', lyrics: '[Verse]\nhello' })
    expect(body('ws:mureka-v9.5', { prompt: 'p', lyrics: 'la', values: { singer: 'female' } }).body).toMatchObject({ gender: 'female' })
    const bgm = body('ws:mureka-v9.5', { prompt: 'calm piano', lyrics: 'ignored', values: { instrumental: true, singer: 'male' } })
    expect(bgm.url).toBe('https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-bgm')
    expect(bgm.body).toEqual({ prompt: 'calm piano' })
    expect(() => body('ws:mureka-v9.5', { prompt: 'pop', lyrics: '  ' })).toThrow(/lyrics/)
    expect(() => body('ws:mureka-v9.5', { prompt: 'x'.repeat(1100), lyrics: 'la' })).toThrow(/1024/)
  })

  it('Lyria and ElevenLabs take lyrics in the prompt; each asks for an instrumental its own way', () => {
    expect(body('ws:lyria-3.5', { prompt: 'soul', lyrics: 'oh yeah' }).body).toEqual({ prompt: 'soul\n\nLyrics:\noh yeah' })
    expect(body('ws:lyria-3.5', { prompt: 'soul', lyrics: 'oh yeah', values: { instrumental: true } }).body)
      .toEqual({ prompt: 'soul\n\nInstrumental only, no vocals.' })
    expect(body('ws:elevenlabs-music-v2.5', { prompt: 'score', values: { duration: 60000 } }).body)
      .toEqual({ prompt: 'score', music_length_ms: 60000, force_instrumental: false })
    expect(body('ws:elevenlabs-music-v2.5', { prompt: 'score', values: { instrumental: true } }).body).toMatchObject({ force_instrumental: true })
  })

  it('ACE-Step and MiniMax: "[instrumental]" lyrics or is_instrumental', () => {
    expect(body('ws:ace-step-1.5', { prompt: 'funk', values: { instrumental: true, duration: 30 } }).body)
      .toEqual({ tags: 'funk', lyrics: '[instrumental]', duration: 30 })
    expect(body('ws:ace-step-1.5', { prompt: 'funk', lyrics: '[Chorus]\ngo', values: { duration: 30 } }).body)
      .toEqual({ tags: 'funk', lyrics: '[Chorus]\ngo', duration: 30 })
    expect(() => body('ws:ace-step-1.5', { prompt: 'funk' })).toThrow(/Instrumental/)
    expect(body('at:minimax-music-3', { prompt: 'rock', values: { instrumental: true } }).body)
      .toEqual({ model: 'minimax/music-3.0', prompt: 'rock', lyrics: '', is_instrumental: true, format: 'mp3' })
    expect(body('at:minimax-music-3', { prompt: 'rock', lyrics: 'yeah' }).body).toMatchObject({ lyrics: 'yeah', is_instrumental: false })
  })

  it('runs MiniMax Music 3 on this Mac through the bundled engine, saying when it first downloads the model', async () => {
    const { EventEmitter } = await import('node:events')
    const { MediaRunner } = await import('../src/main/media/runner')
    const root = mkdtempSync(join(tmpdir(), 'mlx-music-'))
    const rows = new Map<string, any>()
    const store = { save: (j: any) => rows.set(j.id, JSON.parse(JSON.stringify(j))), get: (id: string) => rows.get(id), list: () => [...rows.values()], running: () => [], delete: (id: string) => rows.delete(id) }
    let seen: { cmd: string; args: string[]; caption: string; lyrics: string } | null = null
    const runner = new MediaRunner({
      store: () => store as any, mediaRoot: () => root, resolveKey: () => undefined,
      python: () => ({ path: '/bundled/python3', env: {} }),
      spawn: (cmd, args) => {
        const child: any = new EventEmitter()
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
        const at = (flag: string) => args[args.indexOf(flag) + 1]
        seen = { cmd, args, caption: readFileSync(at('--caption-file'), 'utf8'), lyrics: readFileSync(at('--lyrics-file'), 'utf8') }
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from('{"event":"downloading"}\n{"event":"loading"}\n{"event":"generating"}\n'))
          child.emit('close', 0)
        }, 0)
        return child
      },
      emit: () => {},
    })
    const r = await runner.submit({ modelId: 'local:minimax-music-3-4bit', prompt: 'lo-fi, Rhodes', values: { instrumental: true, duration: 30 } })
    expect(r.ok).toBe(true)
    await new Promise(res => setTimeout(res, 10))
    expect(seen!.cmd).toBe('/bundled/python3')
    expect(seen!.args.slice(0, 7)).toEqual(['-B', '-s', '-u', '-m', 'vmlx_engine.audio.job', 'music', '--model'])
    expect(seen!.args).toContain('mlx-community/MiniMax-Music3-4bit')
    expect(seen!.args.slice(seen!.args.indexOf('--duration'), seen!.args.indexOf('--duration') + 2)).toEqual(['--duration', '30'])
    expect(seen!).toMatchObject({ caption: 'lo-fi, Rhodes', lyrics: '[instrumental]' })
    const job = rows.get((r as any).job.id)
    expect(job).toMatchObject({ status: 'done', downloadedModel: true })
    expect(job.outputs[0]).toMatchObject({ kind: 'file', mime: 'audio/wav' })
    expect(job).not.toHaveProperty('lyrics')
    // A song with vocals and no lyrics is refused before anything runs.
    expect((await runner.submit({ modelId: 'local:minimax-music-3-4bit', prompt: 'pop', values: {} }) as any).error).toMatch(/lyrics/)
  })
})

describe('mlx-media protocol paths', () => {
  it('serves only <kind>/<plain file> inside the media folder', async () => {
    const { resolveMediaPath } = await import('../src/main/media/paths')
    expect(resolveMediaPath('/m', 'mlx-media://media/video/ab12-0.mp4')).toBe('/m/video/ab12-0.mp4')
    expect(resolveMediaPath('/m', 'mlx-media://media/video/..%2F..%2Fetc%2Fpasswd')).toBeNull()
    expect(resolveMediaPath('/m', 'mlx-media://media/secrets/a.mp4')).toBeNull()
    expect(resolveMediaPath('/m', 'mlx-media://other/video/a.mp4')).toBeNull()
    expect(resolveMediaPath('/m', 'file:///m/video/a.mp4')).toBeNull()
    expect(resolveMediaPath('/m', 'mlx-media://media/video/a/b.mp4')).toBeNull()
  })
})
