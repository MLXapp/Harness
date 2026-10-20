/**
 * The browser preview (panel/preview) replaces the preload bridge with a mock.
 * Every method the preload exposes must exist on the mock, so screenshots of
 * new screens never hit a silent gap. Add a missing method to preview/mockApi.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { createMockApi, PreviewEvents } from '../preview/mockApi'
import { buildFixtures, SCENARIOS } from '../preview/fixtures'

function preloadSurface(): Record<string, string[]> {
  const file = join(__dirname, '../src/preload/index.ts')
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  let surface: Record<string, string[]> | null = null
  const name = (n: ts.PropertyName) => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : n.getText())
  source.forEachChild(function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'api' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      surface = {}
      for (const ns of node.initializer.properties) {
        if (!ts.isPropertyAssignment(ns) || !ts.isObjectLiteralExpression(ns.initializer)) continue
        surface[name(ns.name)] = ns.initializer.properties
          .filter(p => p.name)
          .map(p => name(p.name!))
      }
    }
    node.forEachChild(visit)
  })
  if (!surface) throw new Error('const api = { ... } not found in src/preload/index.ts')
  return surface
}

describe('browser preview mock api', () => {
  const surface = preloadSurface()

  it('reads a non-trivial preload surface', () => {
    expect(Object.keys(surface).length).toBeGreaterThan(10)
  })

  for (const scenario of SCENARIOS) {
    it(`implements every preload method (${scenario})`, () => {
      const api = createMockApi(buildFixtures(scenario, { engineInstalled: true }), new PreviewEvents()) as unknown as Record<string, Record<string, unknown>>
      const missing: string[] = []
      for (const [ns, methods] of Object.entries(surface)) {
        for (const method of methods) {
          if (typeof api[ns]?.[method] !== 'function') missing.push(`${ns}.${method}`)
        }
      }
      expect(missing, 'add these to panel/preview/mockApi.ts').toEqual([])
    })
  }

  it('listeners return an unsubscribe function and receive emitted events', () => {
    const events = new PreviewEvents()
    const api = createMockApi(buildFixtures('default', { engineInstalled: true }), events)
    const seen: unknown[] = []
    const off = api.sessions.onReady(data => seen.push(data))
    events.emit('session:ready', { sessionId: 's' })
    off()
    events.emit('session:ready', { sessionId: 't' })
    expect(seen).toEqual([{ sessionId: 's' }])
  })
})
