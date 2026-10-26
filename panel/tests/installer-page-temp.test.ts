import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('installer window page', () => {
  it('is written into a fresh private temp folder, never to a predictable shared name', () => {
    const src = readFileSync('src/main/app-installer.ts', 'utf8')
    expect(src).toContain("mkdtempSync(join(app.getPath('temp'), 'mlx-harness-installer-'))")
    expect(src).toContain("writeFileSync(page, html, { flag: 'wx', mode: 0o600 })")
    expect(src).not.toMatch(/mlx-harness-installer-\$\{process\.pid\}/)
  })
})
