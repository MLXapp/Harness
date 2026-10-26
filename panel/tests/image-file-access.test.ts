import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/sessions', () => ({ sessionManager: {} }))
vi.mock('../src/main/database', () => ({ db: {} }))

import { generatedImagePath } from '../src/main/ipc/image'

describe('image:readFile / image:saveFile paths', () => {
  it('accept only images inside the generated folder, links resolved', () => {
    const home = mkdtempSync(join(tmpdir(), 'vmlx-img-'))
    try {
      const root = join(home, '.mlxstudio', 'generated')
      mkdirSync(join(root, 's1'), { recursive: true })
      mkdirSync(join(home, '.mlxstudio-other'), { recursive: true })
      writeFileSync(join(root, 's1', 'a.png'), 'x')
      writeFileSync(join(root, 's1', 'notes.txt'), 'x')
      writeFileSync(join(home, '.mlxstudio-other', 'b.png'), 'x')
      writeFileSync(join(home, 'secret.png'), 'x')
      symlinkSync(join(home, 'secret.png'), join(root, 's1', 'link.png'))

      expect(generatedImagePath(join(root, 's1', 'a.png'), root)).toMatch(/a\.png$/)
      expect(generatedImagePath(join(root, 's1', 'notes.txt'), root)).toBeNull()
      expect(generatedImagePath(join(home, '.mlxstudio-other', 'b.png'), root)).toBeNull()
      expect(generatedImagePath(join(root, 's1', '..', '..', '..', 'secret.png'), root)).toBeNull()
      expect(generatedImagePath(join(root, 's1', 'link.png'), root)).toBeNull()
      expect(generatedImagePath(join(root, 's1'), root)).toBeNull()
      expect(generatedImagePath(undefined, root)).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
