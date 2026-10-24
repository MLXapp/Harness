import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaRunner } from '../src/main/media/runner'

describe('local video (Wan 2.2 TI2V 5B through vmlx_engine.video.job)', () => {
  it('runs the video job with the chosen size and length, shows each step, and returns an mp4', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mlx-video-'))
    const rows = new Map<string, any>()
    const store = { save: (j: any) => rows.set(j.id, JSON.parse(JSON.stringify(j))), get: (id: string) => rows.get(id), list: () => [...rows.values()], running: () => [], delete: (id: string) => rows.delete(id) }
    const seen: { args: string[]; prompt: string }[] = []
    const snapshots: any[] = []
    const runner = new MediaRunner({
      store: () => store as any, mediaRoot: () => root, resolveKey: () => undefined,
      python: () => ({ path: '/bundled/python3', env: {} }),
      spawn: (_cmd, args) => {
        const child: any = new EventEmitter()
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
        seen.push({ args, prompt: readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8') })
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from('{"event":"loading"}\n{"event":"generating"}\nnot json\n{"event":"step","step":1,"of":30}\n'))
          child.stdout.emit('data', Buffer.from('{"event":"step","step":2,"of":30}\n{"event":"finishing"}\n'))
          child.emit('close', 0)
        }, 0)
        return child
      },
      emit: (job) => snapshots.push(job),
    })
    const r = await runner.submit({ modelId: 'local:wan-2.2-ti2v-5b', prompt: 'A red ball', values: { duration: 3, aspect: '9:16', resolution: '720p' } })
    expect(r.ok).toBe(true)
    await new Promise(res => setTimeout(res, 10))
    const { args, prompt } = seen[0]
    expect(args.slice(0, 6)).toEqual(['-B', '-s', '-u', '-m', 'vmlx_engine.video.job', 'wan'])
    const at = (flag: string) => args[args.indexOf(flag) + 1]
    expect([at('--model'), at('--width'), at('--height'), at('--frames'), at('--steps')]).toEqual(['Anes1032/Wan2.2-TI2V-5B-mlx-q8', '704', '1280', '73', '30'])
    expect(at('--output')).toMatch(/\.mp4$/)
    expect(prompt).toBe('A red ball')
    expect([...new Set(snapshots.map(j => j.progress?.step).filter(Boolean))]).toEqual([1, 2])
    expect(snapshots.some(j => j.phase === 'finishing')).toBe(true)
    const job = rows.get((r as any).job.id)
    expect(job).toMatchObject({ status: 'done' })
    expect(job).not.toHaveProperty('progress')
    expect(job.outputs[0]).toMatchObject({ kind: 'file', mime: 'video/mp4' })
  })

  it('a cancelled run stays cancelled when late progress arrives, and its partial file is removed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mlx-video-'))
    const rows = new Map<string, any>()
    const store = { save: (j: any) => rows.set(j.id, JSON.parse(JSON.stringify(j))), get: (id: string) => rows.has(id) ? JSON.parse(JSON.stringify(rows.get(id))) : undefined, list: () => [...rows.values()], running: () => [], delete: (id: string) => rows.delete(id) }
    let child: any
    let out = ''
    const runner = new MediaRunner({
      store: () => store as any, mediaRoot: () => root, resolveKey: () => undefined,
      python: () => ({ path: '/bundled/python3', env: {} }),
      spawn: (_cmd, args) => {
        child = new EventEmitter()
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
        out = args[args.indexOf('--output') + 1]
        return child
      },
      emit: () => {},
    })
    const r = await runner.submit({ modelId: 'local:wan-2.2-ti2v-5b', prompt: 'A red ball', values: {} })
    const id = (r as any).job.id
    await new Promise(res => setTimeout(res, 5))
    writeFileSync(out, 'partial')
    runner.cancel(id)
    child.stdout.emit('data', Buffer.from('{"event":"step","step":3,"of":30}\n'))
    child.emit('close', null)
    expect(rows.get(id).status).toBe('cancelled')
    expect(existsSync(out)).toBe(false)
  })
})
