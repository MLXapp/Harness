import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isTooBroadModelRoot, looksLikeModelFolder } from '../src/main/modelFolder'

describe('model folders', () => {
  it('refuses scan folders that are a disk, a system folder or home and above', () => {
    const home = '/Users/someone'
    for (const p of ['/', '/Users', '/Users/someone', '/Users/someone/', '/System', '/Volumes', '/Library']) {
      expect(isTooBroadModelRoot(p, home)).toBe(true)
    }
    for (const p of ['/Users/someone/models', '/Volumes/SSD', '/Volumes/SSD/models', '/Users/someone/.mlxstudio/models']) {
      expect(isTooBroadModelRoot(p, home)).toBe(false)
    }
  })

  it('deletes only things that look like a model', () => {
    const root = mkdtempSync(join(tmpdir(), 'vmlx-models-'))
    try {
      mkdirSync(join(root, 'qwen'), { recursive: true })
      writeFileSync(join(root, 'qwen', 'config.json'), '{}')
      mkdirSync(join(root, 'models--org--name', 'snapshots'), { recursive: true })
      mkdirSync(join(root, 'flux', 'transformer'), { recursive: true })
      mkdirSync(join(root, 'Documents'), { recursive: true })
      writeFileSync(join(root, 'Documents', 'taxes.pdf'), 'x')
      writeFileSync(join(root, 'w.safetensors'), 'x')
      writeFileSync(join(root, 'notes.txt'), 'x')
      expect(looksLikeModelFolder(join(root, 'qwen'))).toBe(true)
      expect(looksLikeModelFolder(join(root, 'models--org--name'))).toBe(true)
      expect(looksLikeModelFolder(join(root, 'flux'))).toBe(true)
      expect(looksLikeModelFolder(join(root, 'w.safetensors'))).toBe(true)
      expect(looksLikeModelFolder(join(root, 'Documents'))).toBe(false)
      expect(looksLikeModelFolder(join(root, 'notes.txt'))).toBe(false)
      expect(looksLikeModelFolder(join(root, 'missing'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
