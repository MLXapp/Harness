/** A generation in the Image (cloud), Video, Audio or Music tab, as the renderer sees it. */

import type { MediaKind, MediaProviderId } from './catalog'

export type MediaJobStatus = 'running' | 'done' | 'failed' | 'cancelled'

/** Where a running job is: shown as one line under the card. */
export type MediaJobPhase = 'submitting' | 'queued' | 'generating' | 'loading' | 'downloading' | 'fetching' | 'finishing'

export type MediaJobOutput =
  | { kind: 'file'; /** mlx-media:// URL the page can play or show. */ url: string; mime: string; name: string }
  | { kind: 'text'; text: string }

export interface MediaJob {
  id: string
  kind: MediaKind
  modelId: string
  modelName: string
  where: 'local' | 'cloud'
  provider?: MediaProviderId
  prompt: string
  lyrics?: string
  /** Id of the voice sample the speech was made in (media/voices/<id>.wav). */
  voiceSample?: string
  values: Record<string, string | number | boolean>
  status: MediaJobStatus
  phase?: MediaJobPhase
  outputs: MediaJobOutput[]
  error?: string
  /** A local run that first downloaded its model (its time is not a speed). */
  downloadedModel?: boolean
  /** A long local run's place: denoising step `step` of `of`. */
  progress?: { step: number; of: number }
  /** List-price estimate shown before the run (USD). */
  estimateUsd?: number
  createdAt: number
  updatedAt: number
  finishedAt?: number
}

export interface MediaSubmitRequest {
  modelId: string
  prompt: string
  lyrics?: string
  /** A saved voice sample (media:saveVoiceSample), for models with voiceCloning. */
  voiceSample?: string
  values: Record<string, unknown>
}

export type MediaResult<T> = ({ ok: true } & T) | { ok: false; error: string }

/** Ids media:saveVoiceSample hands out (a UUID). */
export const VOICE_SAMPLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
