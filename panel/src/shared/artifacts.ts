/**
 * Workspace artifacts: the files a reply makes (a website, a component, a
 * script, a document), taken from its fenced code blocks, with names and a
 * previewable entry page. Pure, so the chat, the workspace panel, the main
 * process and the tests agree on what a reply produced.
 */

export type ArtifactKind = 'web' | 'react' | 'svg' | 'markdown' | 'code'

export interface ArtifactFile {
  /** Relative path, e.g. "index.html", "src/App.jsx". */
  path: string
  language: string
  code: string
  kind: ArtifactKind
  /** The block is still being written (no closing fence yet). */
  open?: boolean
  /** The reply named the file (not a default name). */
  named?: boolean
}

export interface ArtifactSet {
  files: ArtifactFile[]
  /** The file the preview starts from, or null when nothing previews. */
  entry: string | null
  title: string
}

const LANG_ALIASES: Record<string, string> = {
  htm: 'html', xhtml: 'html', javascript: 'js', mjs: 'js', cjs: 'js', typescript: 'ts', jsx: 'jsx', tsx: 'tsx',
  python: 'py', py3: 'py', shell: 'sh', bash: 'sh', zsh: 'sh', yml: 'yaml', markdown: 'md', rust: 'rs', golang: 'go',
  'c++': 'cpp', csharp: 'cs', 'c#': 'cs', kotlin: 'kt', ruby: 'rb', text: 'txt', plaintext: 'txt',
}

const EXT_FOR_LANG: Record<string, string> = {
  html: 'html', css: 'css', js: 'js', ts: 'ts', jsx: 'jsx', tsx: 'tsx', json: 'json', py: 'py', sh: 'sh', yaml: 'yaml',
  md: 'md', svg: 'svg', rs: 'rs', go: 'go', java: 'java', cpp: 'cpp', c: 'c', cs: 'cs', kt: 'kt', rb: 'rb', php: 'php',
  swift: 'swift', sql: 'sql', xml: 'xml', toml: 'toml', txt: 'txt', vue: 'vue', svelte: 'svelte', scss: 'scss', lua: 'lua',
}

const LANG_FOR_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT_FOR_LANG).map(([l, e]) => [e, l]))
LANG_FOR_EXT.htm = 'html'
LANG_FOR_EXT.mjs = 'js'
LANG_FOR_EXT.yml = 'yaml'
LANG_FOR_EXT.markdown = 'md'

const DEFAULT_NAME: Record<string, string> = { html: 'index.html', css: 'style.css', js: 'script.js', jsx: 'App.jsx', tsx: 'App.tsx', svg: 'image.svg', md: 'README.md', py: 'main.py' }

/** Smallest block worth showing as a file (one-liners stay plain code). */
const MIN_LINES = 3

const FILE_RE = /([\w][\w.-]*(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,8})/

function normLang(raw: string): string {
  const l = raw.trim().toLowerCase()
  return LANG_ALIASES[l] ?? l
}

/** A safe relative path, or null. */
export function safeArtifactPath(p: string): string | null {
  const parts = p.replace(/\\/g, '/').split('/').filter(s => s && s !== '.')
  if (parts.length === 0 || parts.length > 6 || parts.some(s => s === '..' || s.startsWith('.') || !/^[\w.-]{1,80}$/.test(s))) return null
  return parts.join('/')
}

/** A filename named right before a block: "**index.html**", "`style.css`", "### app.py", "File: x.js". */
function nameFromLine(line: string): string | null {
  const t = line.trim()
  if (!t || t.length > 140) return null
  const m = /^(?:#{1,6}\s*)?(?:\d+[.)]\s*)?(?:[*_`]{0,3})?(?:(?:file(?:name)?|path)\s*[:：]\s*)?[*_`]{0,3}([\w][\w.-]*(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,8})[*_`]{0,3}\s*:?\s*(?:[-–—(].{0,60})?$/i.exec(t)
  return m ? m[1] : null
}

function kindFor(lang: string, code: string): ArtifactKind {
  if (lang === 'html' || (/^\s*<!doctype html|^\s*<html[\s>]/i.test(code))) return 'web'
  if (lang === 'svg' || (lang === 'xml' && /^\s*<svg[\s>]/i.test(code))) return 'svg'
  if ((lang === 'jsx' || lang === 'tsx' || lang === 'js') && looksLikeReactComponent(code)) return 'react'
  if (lang === 'md') return 'markdown'
  return 'code'
}

/** A React component the preview can mount: JSX plus an exported or named App/component. */
export function looksLikeReactComponent(code: string): boolean {
  const jsx = /return\s*\(?\s*<[A-Za-z]/.test(code) || /=>\s*\(?\s*<[A-Za-z]/.test(code)
  const exported = /export\s+default\s+/.test(code) || /\bfunction\s+App\s*\(/.test(code) || /\bconst\s+App\s*=/.test(code)
  return jsx && exported
}

interface Block { info: string; code: string; before: string; open: boolean }

function fencedBlocks(markdown: string): Block[] {
  const out: Block[] = []
  const lines = markdown.split('\n')
  let i = 0
  let prose: string[] = []
  while (i < lines.length) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (!fence) { prose.push(lines[i]); i++; continue }
    const marker = fence[1]
    const info = fence[2].trim()
    const body: string[] = []
    i++
    let closed = false
    while (i < lines.length) {
      const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).exec(lines[i])
      if (close) { closed = true; i++; break }
      body.push(lines[i])
      i++
    }
    const before = [...prose].reverse().find(l => l.trim()) ?? ''
    out.push({ info, code: body.join('\n'), before, open: !closed })
    prose = []
  }
  return out
}

/**
 * The files in a reply. A block counts when it is a known language or names
 * a file, and has a few lines; names come from the fence ("html index.html",
 * "html title=index.html"), the line before it, or the language's default.
 */
export function extractArtifacts(markdown: string): ArtifactSet {
  const files: ArtifactFile[] = []
  const used = new Set<string>()
  for (const b of fencedBlocks(markdown || '')) {
    const [rawLang = '', ...rest] = b.info.split(/\s+/)
    let lang = normLang(rawLang.replace(/[{}]/g, ''))
    let name: string | null = null
    const meta = rest.join(' ')
    const metaName = /(?:title|file(?:name)?|path)\s*=\s*["']?([^"'\s]+)/i.exec(meta)?.[1] ?? FILE_RE.exec(meta)?.[1] ?? null
    if (/^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(rawLang) && LANG_FOR_EXT[rawLang.split('.').pop()!.toLowerCase()]) {
      name = rawLang
      lang = LANG_FOR_EXT[rawLang.split('.').pop()!.toLowerCase()]
    } else if (rawLang.includes(':')) {
      const [l, n] = rawLang.split(':')
      lang = normLang(l)
      name = n || null
    }
    name = name ?? metaName ?? nameFromLine(b.before)
    if (!lang && name) lang = LANG_FOR_EXT[name.split('.').pop()!.toLowerCase()] ?? ''
    if (!lang && /^\s*<!doctype html|^\s*<html[\s>]/i.test(b.code)) lang = 'html'
    const lines = b.code.split('\n').length
    if (!lang || lang === 'txt' || lang === 'output' || lang === 'console' || lang === 'diff') continue
    if (lines < MIN_LINES && !name) continue
    // A named file whose extension disagrees with the block's language keeps the name's language.
    if (name) {
      const ext = name.split('.').pop()!.toLowerCase()
      if (LANG_FOR_EXT[ext] && LANG_FOR_EXT[ext] !== lang && !(lang === 'js' && ext === 'jsx')) lang = LANG_FOR_EXT[ext]
    }
    let path = name ? safeArtifactPath(name) : null
    if (!path) {
      const base = DEFAULT_NAME[lang] ?? `file.${EXT_FOR_LANG[lang] ?? 'txt'}`
      path = base
    }
    // The same name again replaces the earlier version (a revised file).
    const existing = files.findIndex(f => f.path === path)
    const file: ArtifactFile = { path, language: lang, code: b.code, kind: kindFor(lang, b.code), open: b.open || undefined, named: name ? true : undefined }
    if (existing >= 0 && name) { files[existing] = file; continue }
    if (used.has(path)) {
      const dot = path.lastIndexOf('.')
      let n = 2
      while (used.has(`${path.slice(0, dot)}-${n}${path.slice(dot)}`)) n++
      file.path = `${path.slice(0, dot)}-${n}${path.slice(dot)}`
    }
    used.add(file.path)
    files.push(file)
  }
  const entry = pickEntry(files)
  return { files, entry, title: titleFor(files, entry) }
}

function pickEntry(files: ArtifactFile[]): string | null {
  const web = files.filter(f => f.kind === 'web')
  return (web.find(f => /(^|\/)index\.html?$/.test(f.path)) ?? web[0] ?? files.find(f => f.kind === 'react') ?? files.find(f => f.kind === 'svg'))?.path ?? null
}

function titleFor(files: ArtifactFile[], entry: string | null): string {
  const page = files.find(f => f.path === entry && f.kind === 'web')
  const title = page ? /<title>([^<]{1,120})<\/title>/i.exec(page.code)?.[1]?.trim() : undefined
  return title || entry || files[0]?.path || ''
}

/** A block this long is a file worth its own card even without a name. */
export const CARD_MIN_LINES = 40

/**
 * Whether a reply made something worth a card in the chat: a page to
 * preview, a file it named, or a long file. A short snippet in an answer
 * stays just code.
 */
export function worthACard(set: ArtifactSet): boolean {
  return set.entry !== null || set.files.some(f => f.named || f.code.split('\n').length >= CARD_MIN_LINES)
}

/** Whether a reply has something the workspace can show as a page. */
export function hasPreview(set: ArtifactSet): boolean {
  return set.entry !== null
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Pinned React and Babel builds for previewing a component (loaded by the preview page). */
export const REACT_PREVIEW_SCRIPTS = [
  'https://unpkg.com/react@18.3.1/umd/react.development.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js',
  'https://unpkg.com/@babel/standalone@7.26.4/babel.min.js',
]

/**
 * The files to serve for a preview: every artifact, plus a generated
 * `index.html` when the entry isn't a page (React component, SVG), and the
 * stylesheets and scripts the page doesn't link yet linked in, so separate
 * html / css / js blocks show as one site.
 */
export function previewFiles(set: ArtifactSet): { files: Array<{ path: string; content: string }>; entry: string } | null {
  if (!set.entry) return null
  const files = set.files.map(f => ({ path: f.path, content: f.code }))
  const entryFile = set.files.find(f => f.path === set.entry)!
  if (entryFile.kind === 'web') {
    let html = entryFile.code
    const css = set.files.filter(f => f.language === 'css' && !html.includes(f.path))
    const js = set.files.filter(f => f.language === 'js' && f.kind !== 'react' && !html.includes(f.path))
    const links = css.map(f => `<link rel="stylesheet" href="${escapeAttr(f.path)}">`).join('\n')
    const scripts = js.map(f => `<script src="${escapeAttr(f.path)}"></script>`).join('\n')
    if (links) html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${links}\n</head>`) : `${links}\n${html}`
    if (scripts) html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${scripts}\n</body>`) : `${html}\n${scripts}`
    const i = files.findIndex(f => f.path === entryFile.path)
    files[i] = { path: entryFile.path, content: html }
    return { files, entry: entryFile.path }
  }
  const page = entryFile.kind === 'svg' ? svgPage(entryFile) : reactPage(entryFile, set.files.filter(f => f.language === 'css'))
  const name = files.some(f => f.path === 'index.html') ? '__preview.html' : 'index.html'
  files.push({ path: name, content: page })
  return { files, entry: name }
}

function svgPage(file: ArtifactFile): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeAttr(file.path)}</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#fff}body>svg,body>img{max-width:96vw;max-height:96vh}</style></head>
<body><img src="${escapeAttr(file.path)}" alt="${escapeAttr(file.path)}"></body></html>`
}

function reactPage(file: ArtifactFile, styles: ArtifactFile[]): string {
  // Imports of React itself are dropped (React is global here); "export
  // default" becomes the component that is mounted.
  const source = file.code
    .replace(/^\s*import\s+[^;]*?from\s+['"]react(?:-dom(?:\/client)?)?['"];?\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+\.css['"];?\s*$/gm, '')
    .replace(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)/, 'function $1')
    .replace(/export\s+default\s+/, 'window.__App = ')
  const name = /export\s+default\s+function\s+([A-Za-z_$][\w$]*)/.exec(file.code)?.[1]
  const mount = `const __Root = window.__App || ${name ?? 'typeof App !== "undefined" ? App : null'};`
  const json = JSON.stringify(`const { useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, createContext, Fragment } = React;\n${source}\n${mount}\nReactDOM.createRoot(document.getElementById('root')).render(React.createElement(__Root));`)
    .replace(/<\/script/gi, '<\\/script')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeAttr(file.path)}</title>
${REACT_PREVIEW_SCRIPTS.map(s => `<script src="${s}"></script>`).join('\n')}
<script src="https://cdn.tailwindcss.com/3.4.16"></script>
${styles.map(s => `<link rel="stylesheet" href="${escapeAttr(s.path)}">`).join('\n')}
<style>body{margin:0;font-family:-apple-system,system-ui,sans-serif}#__err{white-space:pre-wrap;color:#b00020;font:13px ui-monospace,monospace;padding:16px}</style></head>
<body><div id="root"></div><div id="__err"></div>
<script>
try {
  const out = Babel.transform(${json}, { presets: [['react', { runtime: 'classic' }], ['typescript', { allExtensions: true, isTSX: true }]], filename: ${JSON.stringify(file.path)} }).code;
  new Function(out)();
} catch (e) { document.getElementById('__err').textContent = String(e && e.stack || e); }
</script></body></html>`
}
