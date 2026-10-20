import { describe, expect, it } from 'vitest'
import { findBoundModel, groupPickerEntries } from '../src/shared/providers/pickerGroups'
import type { ProviderView } from '../src/shared/providers/types'

const view = (over: Partial<ProviderView>): ProviderView => ({
  id: 'p', kind: 'catalog', displayName: 'P', api: 'openai-completions', baseURL: 'https://p.example/v1',
  models: [{ id: 'm', input: ['text'] }], createdAt: 0, headerNames: [], configured: true, needsKey: true, ...over,
})

describe('model picker grouping', () => {
  it('puts this Mac first, then local servers, then cloud providers and remote connections', () => {
    const sessions = [
      { id: 's-stopped', modelPath: '/m/a', status: 'stopped', type: 'local' as const },
      { id: 's-remote', modelPath: 'remote://gpt@api', status: 'running', type: 'remote' as const },
      { id: 's-run', modelPath: '/m/b', status: 'running', type: 'local' as const },
      { id: 's-legacy', modelPath: '/m/c', status: 'standby' },
    ]
    const local = [
      view({ id: 'ollama', kind: 'local-server', needsKey: false, reachable: true, models: [{ id: 'llama3.2', input: ['text'] }] }),
      view({ id: 'lmstudio', kind: 'local-server', needsKey: false, reachable: true, models: [] }),
    ]
    const providers = [
      view({ id: 'anthropic', models: [{ id: 'claude', input: ['text', 'image'] }] }),
      view({ id: 'openai', configured: false }),
      view({ id: 'empty', models: [] }),
      view({ id: 'gw', kind: 'custom', needsKey: false, configured: false }),
    ]
    const groups = groupPickerEntries(sessions, local, providers)
    expect(groups.onThisMac.map(s => s.id)).toEqual(['s-run', 's-legacy', 's-stopped'])
    expect(groups.localServers.map(g => g.provider.id)).toEqual(['ollama'])
    // Catalog providers without a key, and providers without models, are not offered.
    expect(groups.cloud.map(g => g.provider.id)).toEqual(['anthropic', 'gw'])
    expect(groups.remoteSessions.map(s => s.id)).toEqual(['s-remote'])
  })

  it('finds the bound model in either list', () => {
    const local = [view({ id: 'ollama', kind: 'local-server', models: [{ id: 'qwen', input: ['text'] }] })]
    const providers = [view({ id: 'anthropic', models: [{ id: 'claude', name: 'Claude', input: ['text'] }] })]
    expect(findBoundModel({ providerId: 'anthropic', modelId: 'claude' }, local, providers).model?.name).toBe('Claude')
    expect(findBoundModel({ providerId: 'ollama', modelId: 'qwen' }, local, providers).provider?.id).toBe('ollama')
    expect(findBoundModel({ providerId: 'gone', modelId: 'x' }, local, providers)).toEqual({ provider: undefined, model: undefined })
    expect(findBoundModel(null, local, providers)).toEqual({})
  })
})

describe('model picker wiring', () => {
  it('renders the switcher groups top models first, then this Mac, then accounts, and binds provider chats without a session endpoint', async () => {
    const { readFileSync } = await import('node:fs')
    const switcher = readFileSync('src/renderer/src/components/chat/ModelSwitcher.tsx', 'utf8')
    const order = ['groups.featured.map(renderRow)', 'groups.onThisMac.map(renderRow)', 'groups.more.map(group', 'groups.remoteSessions.map(renderRow)']
      .map(marker => switcher.indexOf(marker))
    expect(order.every(i => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // Picking a session clears the provider binding first; picking a provider model stores it.
    expect(switcher).toContain('if (binding) await chat.setBinding(null)')
    expect(switcher).toContain('providerId: row.provider.id, modelId: row.model.id')
    // The top toolbar no longer lists models.
    const toolbar = readFileSync('src/renderer/src/components/layout/ChatModeToolbar.tsx', 'utf8')
    expect(toolbar).not.toContain('groupPickerEntries')

    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(app).toContain('sessionEndpoint={providerBinding ? undefined : sessionEndpoint}')
    expect(app).toContain('window.api.providers.setChatModel(next)')
    expect(app).toContain('<ChatModelContext.Provider value={chatModel}>')
  })
})
