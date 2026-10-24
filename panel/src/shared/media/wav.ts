/**
 * Voice samples (Audio tab, models that speak in a sample's voice): the page
 * decodes a file or a recording with Web Audio, mixes it to mono at 24 kHz,
 * keeps at most 20 seconds and sends it as a plain 16-bit WAV, the format the
 * speech runner reads everywhere. Pure (tests/voice-sample.test.ts).
 */

export const VOICE_SAMPLE_RATE = 24000
export const VOICE_SAMPLE_MAX_S = 20
/** Shorter than this, the voice barely comes through. */
export const VOICE_SAMPLE_MIN_S = 3

/** Mix channels to one, trimming quiet lead-in and tail (below ~-50 dB). */
export function mixToMono(channels: Float32Array[], rate: number, maxSeconds = VOICE_SAMPLE_MAX_S): Float32Array {
  const length = channels.length ? channels[0].length : 0
  const mono = new Float32Array(length)
  for (const ch of channels) for (let i = 0; i < length; i++) mono[i] += ch[i] / channels.length
  const quiet = 0.003
  let start = 0
  while (start < length && Math.abs(mono[start]) < quiet) start++
  let end = length
  while (end > start && Math.abs(mono[end - 1]) < quiet) end--
  // Keep a breath of silence either side (0.1 s), then the cap.
  const pad = Math.round(rate * 0.1)
  start = Math.max(0, start - pad)
  end = Math.min(length, end + pad, start + Math.round(maxSeconds * rate))
  return mono.slice(start, end)
}

/** A mono 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, rate = VOICE_SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i) }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return bytes
}
