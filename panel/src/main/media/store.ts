/**
 * Media jobs (Image cloud, Video, Audio, Music tabs) in the app database.
 * One row per generation; the job itself is stored as JSON so the shape can
 * grow without migrations. The provider's prediction id stays here too (it is
 * not a secret) so a running cloud job resumes after a relaunch.
 */

import type Database from 'better-sqlite3'
import type { MediaKind } from '../../shared/media/catalog'
import type { MediaJob } from '../../shared/media/jobs'

export interface StoredMediaJob extends MediaJob {
  /** Provider prediction id (cloud jobs). */
  remoteId?: string
  /** Absolute paths of the files in `outputs`, same order (main process only). */
  files?: string[]
}

export function ensureMediaSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS media_jobs_kind_created ON media_jobs (kind, created_at DESC);
  `)
}

export class MediaJobStore {
  constructor(private readonly db: Database.Database) {
    ensureMediaSchema(db)
  }

  save(job: StoredMediaJob): void {
    this.db
      .prepare(
        `INSERT INTO media_jobs (id, kind, status, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(job.id, job.kind, job.status, JSON.stringify(job), job.createdAt, job.updatedAt)
  }

  get(id: string): StoredMediaJob | undefined {
    const row = this.db.prepare('SELECT json FROM media_jobs WHERE id = ?').get(id) as { json: string } | undefined
    return row ? parse(row.json) : undefined
  }

  list(kind: MediaKind, limit = 200): StoredMediaJob[] {
    const rows = this.db
      .prepare('SELECT json FROM media_jobs WHERE kind = ? ORDER BY created_at DESC LIMIT ?')
      .all(kind, limit) as Array<{ json: string }>
    return rows.map(r => parse(r.json)).filter((j): j is StoredMediaJob => !!j)
  }

  running(): StoredMediaJob[] {
    const rows = this.db.prepare("SELECT json FROM media_jobs WHERE status = 'running'").all() as Array<{ json: string }>
    return rows.map(r => parse(r.json)).filter((j): j is StoredMediaJob => !!j)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM media_jobs WHERE id = ?').run(id)
  }
}

function parse(json: string): StoredMediaJob | undefined {
  try {
    const job = JSON.parse(json)
    return job && typeof job.id === 'string' ? job : undefined
  } catch {
    return undefined
  }
}

/** What the renderer may see: no file paths, no prediction id. */
export function publicJob(job: StoredMediaJob): MediaJob {
  const { remoteId: _remoteId, files: _files, ...rest } = job
  return rest
}
