/**
 * The `browser` tool as the model sees it (OpenAI function format, same shape
 * as BUILTIN_TOOLS in ../tools/registry.ts) and helpers for permissions and
 * approval cards. Pure.
 */

import type { ToolDefinition } from '../tools/registry'
import { BROWSER_ACTIONS, type BrowserArgs } from './agentBrowser'
import { describeTarget, normalizeDirection } from './snapshot'

export const BROWSER_TOOL_NAME = 'browser'

export const BROWSER_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: BROWSER_TOOL_NAME,
    description:
      'Use a web browser. "open" a URL, then read the page outline it returns: links, buttons and fields have refs like e12. ' +
      'Use the ref ids from the latest snapshot to click, type or select. Every action returns the page as it is afterwards. ' +
      'Use scroll to see more of a long page and screenshot to see how it looks.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...BROWSER_ACTIONS],
          description:
            'open: go to url. snapshot: read the page again. click: click ref. type: put text into ref. ' +
            'select: choose value in a dropdown ref. scroll: move the page. back: previous page. screenshot: image of the page. close: close the browser.',
        },
        url: { type: 'string', description: 'For open: full address, e.g. https://example.com' },
        ref: { type: 'string', description: 'For click, type, select: a ref from the latest snapshot, e.g. e12' },
        text: { type: 'string', description: 'For type: the text to enter (replaces what the field holds)' },
        submit: { type: 'boolean', description: 'For type: press Enter afterwards, e.g. to search or send. Default false' },
        value: { type: 'string', description: 'For select: the option to choose (its label or value)' },
        direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'For scroll. Default down' },
      },
      required: ['action'],
    },
  },
}

function parseArgs(args: unknown): BrowserArgs {
  if (typeof args === 'string') {
    try { return (JSON.parse(args) ?? {}) as BrowserArgs } catch { return {} }
  }
  return (args && typeof args === 'object' ? args : {}) as BrowserArgs
}

function actionOf(args: unknown): string {
  return String(parseArgs(args).action ?? '').trim().toLowerCase()
}

const READ = new Set(['open', 'goto', 'navigate', 'snapshot', 'read', 'scroll', 'back', 'screenshot', 'close'])

/**
 * 'read' for actions that only look (open, snapshot, scroll, back, screenshot,
 * close); 'act' for actions that change something on a page (click, type,
 * select) and for anything unrecognised.
 */
export function browserActionKind(args: unknown): 'read' | 'act' {
  return READ.has(actionOf(args)) ? 'read' : 'act'
}

function quoted(s: string, n = 80): string {
  return JSON.stringify(s.length > n ? `${s.slice(0, n - 1)}…` : s)
}

/**
 * One line for an approval card, using the latest snapshot to name the target:
 * "Click [button e8] Continue", "Type "hi" into [textbox e7 "Email"] and press Enter".
 * Text for password fields is masked.
 */
export function describeBrowserAction(args: unknown, snapshotText = ''): string {
  const a = parseArgs(args)
  const action = actionOf(a)
  const target = () => describeTarget(String(a.ref ?? ''), snapshotText)
  switch (action) {
    case 'open': case 'goto': case 'navigate': return `Open ${String(a.url ?? '').slice(0, 200)}`
    case 'snapshot': case 'read': return 'Read the page'
    case 'click': return `Click ${target()}`
    case 'type': case 'fill': {
      const t = target()
      const text = String(a.text ?? '')
      const shown = /type=password/.test(t) ? '•'.repeat(Math.min(text.length, 12)) || '""' : quoted(text)
      const enter = a.submit === true || /^(true|yes|1)$/i.test(String(a.submit ?? '')) ? ' and press Enter' : ''
      return `Type ${shown} into ${t}${enter}`
    }
    case 'select': return `Choose ${quoted(String(a.value ?? a.text ?? ''))} in ${target()}`
    case 'scroll': return `Scroll ${normalizeDirection(a.direction) ?? 'down'}`
    case 'back': return 'Go back'
    case 'screenshot': return 'Take a screenshot'
    case 'close': return 'Close the browser'
    default: return `Browser: ${action || 'unknown action'}`
  }
}
