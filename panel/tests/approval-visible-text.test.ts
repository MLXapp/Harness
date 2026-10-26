import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { APPROVAL_SUBJECT_MAX_CHARS, showInvisibleCharacters } from '../src/shared/visibleText'

describe('approval cards show what runs', () => {
  it('writes out direction overrides, zero-width and control characters', () => {
    expect(showInvisibleCharacters('rm a‮txt.sh')).toBe('rm a⟨U+202E⟩txt.sh')
    expect(showInvisibleCharacters('a​b⁦c⁩')).toBe('a⟨U+200B⟩b⟨U+2066⟩c⟨U+2069⟩')
    expect(showInvisibleCharacters('x\u0007y\u001b[2Jz')).toBe('x⟨U+0007⟩y⟨U+001B⟩[2Jz')
    expect(showInvisibleCharacters('line one\n\tline two')).toBe('line one\n\tline two')
    expect(showInvisibleCharacters('naïve café 東京')).toBe('naïve café 東京')
  })

  it('refuses a call too long to show instead of cutting it', () => {
    const chat = readFileSync('src/main/ipc/chat.ts', 'utf8')
    expect(chat).toContain('shownSubject.length > APPROVAL_SUBJECT_MAX_CHARS')
    expect(chat).not.toMatch(/subject\.slice\(0, 10000\)/)
    expect(APPROVAL_SUBJECT_MAX_CHARS).toBe(10_000)
    const card = readFileSync('src/renderer/src/components/chat/ApprovalCards.tsx', 'utf8')
    expect(card).toContain('showInvisibleCharacters(card.subject)')
  })
})
