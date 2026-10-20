import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROJECT_INSTRUCTION_BUDGET_BYTES,
  discoverInstructionFiles,
  findWorkspaceRoot,
  loadProjectInstructions,
  renderProjectInstructions,
} from '../src/main/agent/projectInstructions'

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `mlx-agent-${name}-`))

describe('project instructions', () => {
  function workspace() {
    const root = tmp('ws')
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'panel', 'src'), { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), 'root agents rules')
    writeFileSync(join(root, 'CLAUDE.md'), 'root agents rules\n') // duplicate content: loaded once
    writeFileSync(join(root, 'panel', 'CLAUDE.md'), 'panel rules')
    writeFileSync(join(root, 'panel', 'CLAUDE.local.md'), 'my local panel rules')
    return root
  }

  it('walks from the working directory up to the workspace root, broadest first', () => {
    const root = workspace()
    const cwd = join(root, 'panel', 'src')
    expect(findWorkspaceRoot(cwd)).toBe(root)
    const files = discoverInstructionFiles(cwd)
    expect(files.map(f => f.displayPath)).toEqual(['AGENTS.md', 'panel/CLAUDE.md', 'panel/CLAUDE.local.md'])
    const rendered = loadProjectInstructions(cwd)!
    expect(rendered.text.indexOf('root agents rules')).toBeLessThan(rendered.text.indexOf('panel rules'))
    expect(rendered.omitted).toEqual([])
  })

  it('without a workspace marker reads only the working directory', () => {
    const dir = tmp('nogit')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'AGENTS.md'), 'parent')
    writeFileSync(join(dir, 'sub', 'AGENTS.md'), 'child')
    // The temp parent has no .git, so the root is the working dir itself.
    expect(discoverInstructionFiles(join(dir, 'sub')).map(f => f.content)).toEqual(['child'])
  })

  it('drops broader files before truncating the most specific one', () => {
    const files = [
      { path: '/r/AGENTS.md', displayPath: 'AGENTS.md', content: 'R'.repeat(40_000) },
      { path: '/r/a/AGENTS.md', displayPath: 'a/AGENTS.md', content: 'A'.repeat(30_000) },
      { path: '/r/a/b/AGENTS.md', displayPath: 'a/b/AGENTS.md', content: 'B'.repeat(20_000) },
    ]
    const rendered = renderProjectInstructions(files)!
    expect(rendered.omitted).toEqual(['AGENTS.md'])
    expect(rendered.included).toEqual(['a/AGENTS.md', 'a/b/AGENTS.md'])
    expect(rendered.truncated).toEqual([])
    expect(rendered.bytes).toBeLessThanOrEqual(PROJECT_INSTRUCTION_BUDGET_BYTES)

    const huge = renderProjectInstructions([
      { path: '/r/AGENTS.md', displayPath: 'AGENTS.md', content: 'R'.repeat(1000) },
      { path: '/r/a/AGENTS.md', displayPath: 'a/AGENTS.md', content: 'é'.repeat(70_000) },
    ])!
    expect(huge.omitted).toEqual(['AGENTS.md'])
    expect(huge.truncated).toEqual(['a/AGENTS.md'])
    expect(huge.bytes).toBeLessThanOrEqual(PROJECT_INSTRUCTION_BUDGET_BYTES)
    expect(huge.text).toContain('truncated to fit')
    expect(huge.text).not.toContain('�')
  })

  it('is deterministic and empty without files or a valid folder', () => {
    const root = workspace()
    expect(loadProjectInstructions(root)!.text).toBe(loadProjectInstructions(root)!.text)
    expect(loadProjectInstructions(undefined)).toBeNull()
    expect(loadProjectInstructions(join(root, 'missing'))).toBeNull()
    expect(renderProjectInstructions([])).toBeNull()
  })
})
