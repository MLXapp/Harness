/**
 * Text shown for approval must look like what runs. Direction overrides and
 * isolates (which can reorder what is displayed), zero-width characters and
 * other invisible control characters are written out as ⟨U+XXXX⟩, so the
 * user sees they are there. Newlines and tabs stay as they are.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]/g

export function showInvisibleCharacters(text: string): string {
  return String(text ?? '').replace(INVISIBLE, ch => `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`)
}

/** Longest subject an approval card shows; a longer call is refused rather than shown in part. */
export const APPROVAL_SUBJECT_MAX_CHARS = 10_000
