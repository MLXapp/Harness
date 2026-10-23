/**
 * Skills: folders with a SKILL.md (the format Claude Code and agentskills.io
 * use: YAML front matter with `name` and `description`, then instructions).
 *
 * Where they come from, later ones winning on the same name:
 *   ~/.claude/skills/<name>/SKILL.md        (skills you already have)
 *   ~/.mlx-harness/skills/<name>/SKILL.md   (MLX Harness's own)
 *   <project>/.claude/skills/<name>/SKILL.md and <project>/.agents/skills/…
 *
 * Only names and one-line descriptions go into the system prompt (stable
 * while the files are unchanged, so the cached prefix stays valid). The body
 * loads when the model calls `use_skill`. Scripts a skill mentions are run
 * with the normal tools, so they ask like any other command.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, relative } from 'path'

export interface Skill {
  name: string
  description: string
  dir: string
  file: string
  scope: 'project' | 'user'
}

const MAX_SKILLS = 60
const MAX_BODY_BYTES = 64 * 1024
const MAX_FILES_LISTED = 40

/** Front matter `name` / `description`, tolerant of quotes and folded lines. */
export function parseSkillFile(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { body: text }
  const fields: Record<string, string> = {}
  let key: string | null = null
  for (const raw of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw)
    if (kv) {
      key = kv[1].toLowerCase()
      fields[key] = kv[2].replace(/^[>|]-?\s*$/, '').trim()
    } else if (key && /^\s+\S/.test(raw)) {
      fields[key] = `${fields[key]} ${raw.trim()}`.trim()
    }
  }
  const unquote = (v?: string) => v?.replace(/^(['"])([\s\S]*)\1$/, '$2').trim()
  return { name: unquote(fields.name), description: unquote(fields.description), body: m[2] }
}

export function skillRoots(workingDirectory?: string, home = homedir()): Array<{ dir: string; scope: Skill['scope'] }> {
  const roots: Array<{ dir: string; scope: Skill['scope'] }> = [
    { dir: join(home, '.claude', 'skills'), scope: 'user' },
    { dir: join(home, '.mlx-harness', 'skills'), scope: 'user' },
  ]
  if (workingDirectory) {
    roots.push({ dir: join(workingDirectory, '.claude', 'skills'), scope: 'project' })
    roots.push({ dir: join(workingDirectory, '.agents', 'skills'), scope: 'project' })
  }
  return roots
}

const validName = (n: string) => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(n)

export function discoverSkills(workingDirectory?: string, home = homedir()): Skill[] {
  const byName = new Map<string, Skill>()
  for (const root of skillRoots(workingDirectory, home)) {
    let entries: string[] = []
    try {
      if (!existsSync(root.dir) || !statSync(root.dir).isDirectory()) continue
      entries = readdirSync(root.dir).sort()
    } catch { continue }
    for (const entry of entries) {
      const dir = join(root.dir, entry)
      const file = join(dir, 'SKILL.md')
      try {
        if (!statSync(dir).isDirectory() || !existsSync(file)) continue
        const head = readFileSync(file, 'utf-8').slice(0, 4096)
        const meta = parseSkillFile(head)
        const name = meta.name && validName(meta.name) ? meta.name : validName(entry) ? entry : null
        if (!name || !meta.description) continue
        byName.set(name.toLowerCase(), { name, description: meta.description.slice(0, 300), dir, file, scope: root.scope })
      } catch { /* unreadable: skip */ }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SKILLS)
}

/** The system prompt block: one line per skill, or null without skills. */
export function renderSkillIndex(skills: Skill[]): string | null {
  if (skills.length === 0) return null
  return [
    '# Skills',
    'These skills hold instructions for particular kinds of work. When a task matches one, call use_skill with its name first and follow what it says.',
    ...skills.map(s => `- ${s.name}: ${s.description}`),
  ].join('\n')
}

/** use_skill: the body of SKILL.md plus a list of the skill's other files. */
export function loadSkill(skills: Skill[], name: string): { ok: true; text: string } | { ok: false; text: string } {
  const skill = skills.find(s => s.name.toLowerCase() === String(name || '').toLowerCase())
  if (!skill) {
    return { ok: false, text: `No skill named "${name}". Available: ${skills.map(s => s.name).join(', ') || 'none'}.` }
  }
  let body: string
  try {
    const raw = readFileSync(skill.file, 'utf-8')
    body = parseSkillFile(raw.length > MAX_BODY_BYTES ? raw.slice(0, MAX_BODY_BYTES) : raw).body.trim()
  } catch (err) {
    return { ok: false, text: `Could not read ${skill.file}: ${(err as Error).message}` }
  }
  const files: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 2 || files.length >= MAX_FILES_LISTED) return
    let names: string[] = []
    try { names = readdirSync(dir).sort() } catch { return }
    for (const n of names) {
      if (n.startsWith('.') || files.length >= MAX_FILES_LISTED) continue
      const p = join(dir, n)
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1)
        else if (p !== skill.file) files.push(relative(skill.dir, p))
      } catch { /* skip */ }
    }
  }
  walk(skill.dir, 0)
  return {
    ok: true,
    text:
      `Skill: ${skill.name} (${skill.scope === 'project' ? 'this project' : 'yours'})\nFolder: ${skill.dir}\n` +
      (files.length ? `Other files: ${files.join(', ')}\n` : '') +
      `\n${body}`,
  }
}
