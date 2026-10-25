#!/usr/bin/env node
/**
 * Builds src/shared/modelCatalog.json from families.mjs: checks every build
 * exists on Hugging Face and records its real download size (sum of the
 * repo's files). Run: node scripts/model-catalog/build.mjs
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAMILIES, QUANTS } from './families.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '../../src/shared/modelCatalog.json')
const LABEL = { '4bit': '4-bit', '5bit': '5-bit', '6bit': '6-bit', '8bit': '8-bit', bf16: '16-bit' }

async function repo(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://huggingface.co/api/models/${id}?blobs=true`)
    if (r.status === 404 || r.status === 401) return null
    if (!r.ok) { await new Promise(res => setTimeout(res, 1000 * (attempt + 1))); continue }
    const j = await r.json()
    if (j.gated || j.private || j.disabled) return null
    const files = j.siblings ?? []
    const bytes = files.reduce((n, f) => n + (f.size ?? 0), 0)
    if (!files.some(f => /\.safetensors$/.test(f.rfilename)) || !bytes) return null
    return { bytes, pipeline: j.pipeline_tag ?? null }
  }
  throw new Error(`Hugging Face did not answer for ${id}`)
}

function quantLabel(id) {
  const m = /(\d(?:\.\d+)?)[-_]?bit/i.exec(id) || /oQ(\d(?:\.\d+)?)/.exec(id)
  if (/fp16|bf16|bfloat16/i.test(id)) return '16-bit'
  return m ? `${m[1]}-bit` : 'MLX'
}

const out = []
for (const f of FAMILIES) {
  const variants = []
  const builds = f.builds ?? QUANTS.map(q => [`${f.base}-${q}`, LABEL[q]])
  for (const [id, label] of builds) {
    const info = await repo(id)
    if (info) variants.push({ kind: 'standard', label, repo: id, bytes: info.bytes })
    else console.log(`  (no ${id})`)
  }
  for (const id of f.abliterated ?? []) {
    const info = await repo(id)
    if (info) variants.push({ kind: 'abliterated', label: quantLabel(id), repo: id, bytes: info.bytes })
    else console.log(`  (no abliterated ${id})`)
  }
  if (!variants.some(v => v.kind === 'standard')) { console.log(`skip ${f.id}: no builds`); continue }
  out.push({ id: f.id, name: f.name, maker: f.maker, category: f.category, vision: !!f.vision, variants })
  console.log(`${f.id}: ${variants.map(v => `${v.kind[0]}:${v.label} ${(v.bytes / 1e9).toFixed(1)}GB`).join(', ')}`)
}
writeFileSync(OUT, JSON.stringify({ checked: new Date().toISOString().slice(0, 10), models: out }, null, 1) + '\n')
console.log(`wrote ${out.length} models to ${OUT}`)
