import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { capacityRoundTrip } from './helpers/providers-capacity'

const LOCALES = ['en', 'zh', 'ko', 'ja', 'es']
const locale = (code: string) => JSON.parse(readFileSync(join(__dirname, '../src/renderer/src/i18n/locales', `${code}.json`), 'utf8'))
const lookup = (catalog: any, key: string) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), catalog)

const FILES = [
  ...readdirSync(join(__dirname, '../src/renderer/src/components/settings')).map(f => `src/renderer/src/components/settings/${f}`),
  'src/renderer/src/components/layout/ChatModeToolbar.tsx',
]

describe('provider UI copy', () => {
  it('every providers.* key the UI uses exists in all five locales', () => {
    const used = new Set<string>()
    for (const file of FILES) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8')
      for (const match of src.matchAll(/['`](providers\.[A-Za-z.]+)['`]/g)) used.add(match[1])
      // Template keys: providers.levels.${level}
      if (src.includes('providers.levels.${')) {
        for (const level of ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max']) used.add(`providers.levels.${level}`)
      }
    }
    expect(used.size).toBeGreaterThan(40)
    for (const code of LOCALES) {
      const catalog = locale(code)
      const missing = [...used].filter(key => typeof lookup(catalog, key) !== 'string')
      expect(missing, `${code} is missing`).toEqual([])
    }
  })

  it('reads typed capacities like 128K and 1M', () => {
    expect(capacityRoundTrip(['128K', '1M', '131072', '200,000', '1.5K', 'abc', ''])).toEqual([
      ['128K', 128000, '128K'],
      ['1M', 1000000, '1M'],
      ['131072', 131072, '131072'],
      ['200,000', 200000, '200K'],
      ['1.5K', 1500, '1500'],
      ['abc', NaN, 'NaN'],
      ['', undefined, ''],
    ])
  })
})
