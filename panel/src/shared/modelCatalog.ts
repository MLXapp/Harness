/**
 * The Models page's catalog: popular local models, each with its builds
 * (standard quantizations, and an abliterated build where one exists), with
 * real download sizes from Hugging Face (scripts/model-catalog/build.mjs).
 * Pure helpers here so the page and its tests agree.
 */
import data from './modelCatalog.json'
import { memoryToRunWell, searchFit, type SearchFit } from './searchFit'

export type CatalogCategory = 'general' | 'coding' | 'small' | 'vision' | 'large'
export const CATALOG_CATEGORIES: CatalogCategory[] = ['general', 'coding', 'small', 'vision', 'large']

export interface CatalogVariant { kind: 'standard' | 'abliterated'; label: string; repo: string; bytes: number }
export interface CatalogModel { id: string; name: string; maker: string; category: CatalogCategory; vision: boolean; variants: CatalogVariant[] }

export const CATALOG_CHECKED: string = (data as { checked: string }).checked
export const CATALOG: CatalogModel[] = (data as { models: CatalogModel[] }).models

/** i18n key part for a model id ("qwen3.8-27b" → "qwen3_8-27b"; keys can't hold dots). */
export function catalogKey(id: string): string {
  return id.replace(/\./g, '_')
}

/** "16.1 GB" (decimal GB, like Finder). */
export function formatGB(bytes: number): string {
  const gb = bytes / 1e9
  return `${gb >= 100 ? Math.round(gb) : gb >= 10 ? gb.toFixed(1) : gb.toFixed(gb < 1 ? 2 : 1)} GB`
}

/** Memory a Mac needs for a build to run well, in GB (the app's 60% rule). */
export function memoryNeededGB(bytes: number): number {
  return memoryToRunWell(bytes)
}

export function variantFit(bytes: number, memoryGB: number | undefined): SearchFit | null {
  return searchFit(bytes, memoryGB)
}

/** The smallest standard build (what "from N GB" shows). */
export function smallestStandard(model: CatalogModel): CatalogVariant | undefined {
  return model.variants.filter(v => v.kind === 'standard').sort((a, b) => a.bytes - b.bytes)[0]
}

/** The largest standard build that runs well here, else the smallest one. */
export function bestForMac(model: CatalogModel, memoryGB: number | undefined): CatalogVariant | undefined {
  const std = model.variants.filter(v => v.kind === 'standard').sort((a, b) => a.bytes - b.bytes)
  const good = std.filter(v => searchFit(v.bytes, memoryGB) === 'good')
  return good[good.length - 1] ?? std[0]
}

/** Room a download needs on disk beyond its files (partial files, metadata). */
export const DISK_HEADROOM_BYTES = 1e9

export interface DownloadCheck {
  /** Not enough free space: the download can't start. */
  noSpace: boolean
  /** How the build fits this Mac's memory (null when unknown). */
  fit: SearchFit | null
  /** Something to tell the user before downloading (even with "don't ask again"). */
  hasIssue: boolean
}

export function checkDownload(bytes: number, freeBytes: number | null, memoryGB: number | undefined): DownloadCheck {
  const noSpace = freeBytes !== null && freeBytes < bytes + DISK_HEADROOM_BYTES
  const fit = searchFit(bytes, memoryGB)
  return { noSpace, fit, hasIssue: noSpace || fit === 'tight' || fit === 'no' }
}

/** Matches a model's search text (name, maker, category). */
export function catalogMatches(model: CatalogModel, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${model.name} ${model.maker} ${model.id}`.toLowerCase().includes(q)
}
