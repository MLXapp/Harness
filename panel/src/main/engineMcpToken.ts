/**
 * A random token made once per app launch and handed to every engine this
 * app starts (environment variable). The engine then runs MCP tools
 * (/v1/mcp/*) only for requests carrying it: the app's own main process,
 * which asks the user first. Engines left over from an earlier launch have
 * the old token, so their MCP tools work again after the model restarts.
 */

import { randomBytes } from 'crypto'

export const ENGINE_MCP_TOKEN_ENV = 'VMLX_MCP_CONTROL_TOKEN'
export const ENGINE_MCP_TOKEN_HEADER = 'x-mlx-mcp-token'

const token = randomBytes(32).toString('hex')

export function engineMcpToken(): string {
  return token
}

/** The header the app adds to its own /v1/mcp/* calls. */
export function engineMcpHeaders(): Record<string, string> {
  return { [ENGINE_MCP_TOKEN_HEADER]: token }
}
