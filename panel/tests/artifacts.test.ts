import { describe, expect, it } from 'vitest'
import { extractArtifacts, hasPreview, looksLikeReactComponent, previewFiles, safeArtifactPath, worthACard } from '../src/shared/artifacts'

const site = [
  'Here is your landing page.',
  '',
  '**index.html**',
  '```html',
  '<!doctype html>',
  '<html><head><title>Bakery</title></head>',
  '<body><h1>Hi</h1></body></html>',
  '```',
  '',
  '`style.css`',
  '```css',
  'body { margin: 0; }',
  'h1 { color: red; }',
  'p { color: blue; }',
  '```',
  '',
  '```javascript',
  'document.querySelector("h1")',
  '  .addEventListener("click", () => {',
  '    alert(1) })',
  '```',
].join('\n')

describe('workspace artifacts', () => {
  it('finds a site in html, css and js blocks, with names and a title', () => {
    const set = extractArtifacts(site)
    expect(set.files.map(f => [f.path, f.kind])).toEqual([['index.html', 'web'], ['style.css', 'code'], ['script.js', 'code']])
    expect(set.entry).toBe('index.html')
    expect(set.title).toBe('Bakery')
    const p = previewFiles(set)!
    const html = p.files.find(f => f.path === 'index.html')!.content
    expect(html).toContain('<link rel="stylesheet" href="style.css">\n</head>')
    expect(html).toContain('<script src="script.js"></script>\n</body>')
  })

  it('names from the fence, keeps a revised file once, skips one-liners and output', () => {
    const md = '```python app.py\nimport os\nprint(1)\nprint(2)\n```\n\n```bash\nls\n```\n\n```py title="app.py"\nprint(3)\nprint(4)\nprint(5)\n```\n\n```text\na\nb\nc\n```'
    const set = extractArtifacts(md)
    expect(set.files.map(f => f.path)).toEqual(['app.py'])
    expect(set.files[0].code).toContain('print(3)')
    expect(hasPreview(set)).toBe(false)
  })

  it('previews a React component and an SVG', () => {
    const jsx = 'export default function Counter() {\n  const [n, setN] = useState(0)\n  return <button onClick={() => setN(n + 1)}>{n}</button>\n}'
    expect(looksLikeReactComponent(jsx)).toBe(true)
    const set = extractArtifacts('```jsx\n' + jsx + '\n```')
    expect(set.files[0]).toMatchObject({ path: 'App.jsx', kind: 'react' })
    const p = previewFiles(set)!
    expect(p.entry).toBe('index.html')
    expect(p.files.find(f => f.path === 'index.html')!.content).toContain('react@18.3.1')
    const svg = extractArtifacts('```svg\n<svg xmlns="http://www.w3.org/2000/svg">\n<circle r="4"/>\n</svg>\n```')
    expect(svg.entry).toBe('image.svg')
    expect(previewFiles(svg)!.entry).toBe('index.html')
  })

  it('marks a block still being written, and refuses unsafe paths', () => {
    const set = extractArtifacts('```html\n<!doctype html>\n<html>\n<body>')
    expect(set.files[0]).toMatchObject({ path: 'index.html', open: true })
    expect(safeArtifactPath('../etc/passwd')).toBeNull()
    expect(safeArtifactPath('.env')).toBeNull()
    expect(safeArtifactPath('src/App.jsx')).toBe('src/App.jsx')
  })

  it('gives a card to pages, named files and long files, not to a short snippet', () => {
    expect(worthACard(extractArtifacts(site))).toBe(true)
    expect(worthACard(extractArtifacts('```swift\nList {\n  Text("a")\n}\n```'))).toBe(false)
    expect(worthACard(extractArtifacts('**main.swift**\n```swift\nimport Foundation\nprint(1)\nprint(2)\n```'))).toBe(true)
  })
})
