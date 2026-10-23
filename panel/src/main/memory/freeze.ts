/**
 * The memory block a chat sees stays the same while the chat is in use, so a
 * note saved elsewhere does not invalidate its cached prompt mid-session. It
 * catches up after 10 idle minutes (the cache is cold by then anyway), and at
 * once after anything is forgotten, edited or memory is switched off: a
 * removed note must never be sent again.
 */
const blocks = new Map<string, { block: string | null; lastTurn: number }>()
export const MEMORY_REFRESH_IDLE_MS = 10 * 60_000

export function frozenMemoryBlock(chatId: string, current: string | null, now = Date.now()): string | null {
  const seen = blocks.get(chatId)
  if (seen && (seen.block === current || now - seen.lastTurn < MEMORY_REFRESH_IDLE_MS)) {
    seen.lastTurn = now
    return seen.block
  }
  blocks.set(chatId, { block: current, lastTurn: now })
  if (blocks.size > 200) blocks.delete(blocks.keys().next().value as string)
  return current
}

/** Something was removed or changed: every chat takes the current block next turn. */
export function thawMemoryBlocks(): void {
  blocks.clear()
}

export function forgetChatMemoryBlock(chatId: string): void {
  blocks.delete(chatId)
}
