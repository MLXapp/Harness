import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ clipboard: {} }))
vi.mock('../src/main/database', () => ({ db: { getSetting: vi.fn(() => undefined) } }))
import { discoverSkills, loadSkill, parseSkillFile, renderSkillIndex } from '../src/main/agent/skills'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'mlx-skills-')); roots.push(d); return d }
function skill(root: string, name: string, desc: string, body = 'Do it well.') {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: "${desc}"\n---\n${body}\n`)
}

describe('skills', () => {
  it('parses front matter, folded lines and quotes', () => {
    const p = parseSkillFile('---\nname: pdf\ndescription: >\n  Read and fill\n  PDF forms\n---\n# Body')
    expect(p).toMatchObject({ name: 'pdf', description: 'Read and fill PDF forms', body: '# Body' })
  })

  it('finds user and project skills; the project wins on the same name', () => {
    const home = dir()
    const project = dir()
    skill(join(home, '.claude', 'skills'), 'pdf', 'User pdf skill')
    skill(join(home, '.mlx-harness', 'skills'), 'notes', 'Apple Notes')
    skill(join(project, '.claude', 'skills'), 'pdf', 'Project pdf skill', 'Project body')
    mkdirSync(join(project, '.claude', 'skills', 'broken'))
    writeFileSync(join(project, '.claude', 'skills', 'broken', 'SKILL.md'), 'no front matter')
    const list = discoverSkills(project, home)
    expect(list.map(s => `${s.name}:${s.scope}`)).toEqual(['notes:user', 'pdf:project'])
    expect(renderSkillIndex(list)).toContain('- pdf: Project pdf skill')
    writeFileSync(join(project, '.claude', 'skills', 'pdf', 'fill.py'), 'print(1)')
    const loaded = loadSkill(list, 'PDF')
    expect(loaded.ok).toBe(true)
    expect(loaded.text).toContain('Project body')
    expect(loaded.text).toContain('Other files: fill.py')
    expect(loadSkill(list, 'nope')).toMatchObject({ ok: false })
    expect(renderSkillIndex([])).toBeNull()
  })

  it('is wired: tool registered, offered only with skills, listed in the system prompt', () => {
    const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
    expect(chat).toContain('if (discoverSkills(overrides?.workingDirectory || undefined).length === 0) disabled.add("use_skill");')
    expect(chat).toContain('renderSkillIndex(discoverSkills(overrides?.workingDirectory || undefined))')
    const exec = readFileSync('src/main/tools/executor.ts', 'utf8')
    expect(exec).toContain("case 'use_skill': {")
  })
})
