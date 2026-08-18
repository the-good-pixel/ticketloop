export type StageTimeoutKind = 'wall-clock' | 'idle'

export interface StageWatchdog {
  touch: () => void
  clear: () => void
  timedOut: () => StageTimeoutKind | null
}

/**
 * A wall-clock limit bounds the whole stage. The idle limit is separate: it
 * catches a model or tool subprocess that is still alive but has stopped
 * producing output. Long stages can disable the wall-clock limit without also
 * disabling hung-process protection.
 */
export function createStageWatchdog(
  wallClockSec: number,
  idleSec: number,
  onTimeout: (kind: StageTimeoutKind) => void,
): StageWatchdog {
  let reason: StageTimeoutKind | null = null
  let wallTimer: NodeJS.Timeout | null = null
  let idleTimer: NodeJS.Timeout | null = null

  const clear = () => {
    if (wallTimer) clearTimeout(wallTimer)
    if (idleTimer) clearTimeout(idleTimer)
    wallTimer = null
    idleTimer = null
  }

  const fire = (kind: StageTimeoutKind) => {
    if (reason) return
    reason = kind
    clear()
    onTimeout(kind)
  }

  const touch = () => {
    if (reason || idleSec <= 0) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => fire('idle'), idleSec * 1000)
  }

  if (wallClockSec > 0) wallTimer = setTimeout(() => fire('wall-clock'), wallClockSec * 1000)
  touch()

  return { touch, clear, timedOut: () => reason }
}

export function stageTimeoutMessage(kind: StageTimeoutKind, runner: { stageTimeoutSec?: number; stageIdleTimeoutSec?: number }): string {
  const seconds = kind === 'idle' ? runner.stageIdleTimeoutSec ?? 1800 : runner.stageTimeoutSec ?? 900
  const label = kind === 'idle' ? 'produced no output' : 'exceeded its total runtime'
  return `stage ${label} for ${seconds}s and was killed; Continue run will retry this step from the saved checkpoint`
}
