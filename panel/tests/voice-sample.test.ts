import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeWav, mixToMono } from '../src/shared/media/wav'
import { mediaModel } from '../src/shared/media/catalog'
import { MediaRunner } from '../src/main/media/runner'

describe('voice sample WAV', () => {
  it('writes a mono 16-bit PCM file at the given rate', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 24000)
    const view = new DataView(wav.buffer)
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(wav.slice(8, 16))).toBe('WAVEfmt ')
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(24000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(8)
    expect([2, 3, 4].map(i => view.getInt16(42 + i * 2, true))).toEqual([32767, -32768, 16383])
  })

  it('mixes to mono, trims silence (keeping 0.1 s) and caps the length', () => {
    const rate = 100
    const left = new Float32Array(1000), right = new Float32Array(1000)
    for (let i = 300; i < 400; i++) { left[i] = 0.5; right[i] = 0.1 }
    const mono = mixToMono([left, right], rate)
    expect(mono.length).toBe(120)
    expect(mono[10]).toBeCloseTo(0.3)
    const loud = new Float32Array(5000).fill(0.2)
    expect(mixToMono([loud], rate, 20).length).toBe(2000)
  })
})

describe('speech in a voice sample', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'mlx-voice-'))
    const rows = new Map<string, any>()
    const store = { save: (j: any) => rows.set(j.id, JSON.parse(JSON.stringify(j))), get: (id: string) => rows.get(id), list: () => [...rows.values()], running: () => [], delete: (id: string) => rows.delete(id) }
    const seen: string[][] = []
    const runner = new MediaRunner({
      store: () => store as any, mediaRoot: () => root, resolveKey: () => undefined,
      python: () => ({ path: '/bundled/python3', env: {} }),
      spawn: (_cmd, args) => {
        const child: any = new EventEmitter()
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
        seen.push(args)
        setTimeout(() => child.emit('close', 0), 0)
        return child
      },
      emit: () => {},
    })
    return { root, rows, seen, runner }
  }
  const id = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7'

  it('Chatterbox Turbo is the model that can', () => {
    expect((mediaModel('local:chatterbox-turbo') as any).voiceCloning).toBe(true)
    expect((mediaModel('local:kokoro-82m') as any).voiceCloning).toBeUndefined()
  })

  it('passes the saved sample to the speech runner and keeps the file', async () => {
    const { root, rows, seen, runner } = setup()
    mkdirSync(join(root, 'voices'), { recursive: true })
    const sample = join(root, 'voices', `${id}.wav`)
    writeFileSync(sample, encodeWav(new Float32Array(10)))
    const r = await runner.submit({ modelId: 'local:chatterbox-turbo', prompt: 'Hello there', values: {}, voiceSample: id })
    expect(r.ok).toBe(true)
    await new Promise(res => setTimeout(res, 10))
    const args = seen[0]
    expect(args).toContain('tts')
    expect(args.slice(args.indexOf('--ref-audio'), args.indexOf('--ref-audio') + 2)).toEqual(['--ref-audio', sample])
    expect(rows.get((r as any).job.id).voiceSample).toBe(id)
    expect(existsSync(sample)).toBe(true)
  })

  it('refuses a sample that is missing, malformed, or given to a model that cannot use it', async () => {
    const { seen, runner } = setup()
    expect((await runner.submit({ modelId: 'local:chatterbox-turbo', prompt: 'Hi', values: {}, voiceSample: id }) as any).error).toMatch(/missing/)
    expect((await runner.submit({ modelId: 'local:chatterbox-turbo', prompt: 'Hi', values: {}, voiceSample: '../../etc/passwd' }) as any).error).toMatch(/missing/)
    expect((await runner.submit({ modelId: 'local:kokoro-82m', prompt: 'Hi', values: {}, voiceSample: id }) as any).error).toMatch(/cannot speak/)
    expect(seen).toEqual([])
  })
})
