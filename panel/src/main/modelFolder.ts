/**
 * Checks for the model folder IPC: a scan folder must not be a whole disk,
 * system folder or the home folder, and "delete this model" only deletes
 * something that is a model (weights, a model config, a Hugging Face repo
 * folder), never an arbitrary folder that happens to sit in a scan folder.
 */

import { readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { resolve, sep } from 'path'

const TOP_LEVEL_REFUSED = new Set(['/System', '/Library', '/Applications', '/Users', '/usr', '/bin', '/sbin', '/etc', '/private', '/var', '/tmp', '/Volumes', '/opt', '/cores', '/dev'])

/** A folder too broad to scan for models (and so to delete models from): /, top-level system folders, home and above. */
export function isTooBroadModelRoot(path: string, home = homedir()): boolean {
  const p = resolve(path).replace(/\/+$/, '') || '/'
  if (p === '/' || TOP_LEVEL_REFUSED.has(p)) return true
  const h = resolve(home).replace(/\/+$/, '')
  // home itself, or any folder that contains it
  return h === p || h.startsWith(p + sep)
}

const WEIGHT_FILE = /\.(safetensors|gguf|npz|bin|pt|pth|ckpt|mlpackage)$/i
const MODEL_MARKERS = new Set(['config.json', 'model_index.json', 'jang_config.json', 'params.json', 'tokenizer.json', 'snapshots'])
const DIFFUSERS_PARTS = new Set(['transformer', 'unet', 'text_encoder', 'vae'])

/** Something "delete model" may remove: a weights file, or a folder holding a model config, weights or a Hugging Face snapshot list. */
export function looksLikeModelFolder(realPath: string): boolean {
  try {
    const st = statSync(realPath)
    if (st.isFile()) return WEIGHT_FILE.test(realPath)
    if (!st.isDirectory()) return false
    const names = readdirSync(realPath)
    return names.some(n => MODEL_MARKERS.has(n) || DIFFUSERS_PARTS.has(n) || WEIGHT_FILE.test(n))
  } catch {
    return false
  }
}

