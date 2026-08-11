import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHECKPOINTS_DIR } from '../paths.js'
import { atomicWrite, removeFile } from '../store.js'

// A run's resume checkpoint. The design keeps this MINIMAL: everything the
// engine needs to fast-forward a retried run is reconstructed by REPLAYING the
// cached stage outputs (priors, kind, reuse branch, loop counters all rebuild
// as the same code re-executes). The only genuinely new state is `workspace` —
// so a resumed change-path run reattaches the SAME worktree/branch instead of
// cutting a fresh one — plus `imagePaths` (avoid re-downloading) and `marker`
// (invalidate the checkpoint if the human changed the ask).
export interface WorkspaceCk {
  repos: {
    name: string
    srcPath: string
    workdir: string
    base: string
    branch: string
    exclude: string[]
    shipDisabled: boolean
  }[]
  cwd: string
  multi: boolean
  useWorktree: boolean
}

export interface Checkpoint {
  runId: string
  ticketKey: string // `${project}:${identifier}`
  marker: string // latest-human-activity when this work started; new activity ⇒ discard
  imagePaths: string[]
  workspace?: WorkspaceCk // change path only (data path recreates its throwaway)
  // ckKey → the stage's successful output text. A stage that THREW is absent, so
  // it (and everything after) re-runs on resume; a completed stage replays.
  stageOutputs: Record<string, string>
  updatedAt: number
}

function ckFile(ticketKey: string): string {
  return join(CHECKPOINTS_DIR, encodeURIComponent(ticketKey) + '.json')
}

export function loadCheckpoint(ticketKey: string): Checkpoint | null {
  const f = ckFile(ticketKey)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Checkpoint
  } catch {
    return null // a corrupt checkpoint just means "start fresh" — never fatal
  }
}

export function saveCheckpoint(ck: Checkpoint): void {
  mkdirSync(CHECKPOINTS_DIR, { recursive: true })
  ck.updatedAt = Date.now()
  atomicWrite(ckFile(ck.ticketKey), JSON.stringify(ck))
}

export function deleteCheckpoint(ticketKey: string): void {
  const f = ckFile(ticketKey)
  if (existsSync(f)) {
    try {
      removeFile(f)
    } catch {
      /* best effort */
    }
  }
}
