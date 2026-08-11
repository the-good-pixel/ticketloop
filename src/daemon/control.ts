import { existsSync, readFileSync } from 'node:fs'
import { CONTROL_FILE } from '../paths.js'
import { atomicWrite } from '../store.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// The pause switch lives in a tiny file so a SEPARATE process (the `pause` /
// `resume` CLI commands) can signal the running daemon. The daemon reads it
// before every scan and before every stage; the CLI just writes it.
interface Control {
  paused: boolean
  since?: number
}

export function isPaused(): boolean {
  try {
    if (!existsSync(CONTROL_FILE)) return false
    const c = JSON.parse(readFileSync(CONTROL_FILE, 'utf8')) as Control
    return !!c.paused
  } catch {
    return false // an unreadable control file must never wedge the loop
  }
}

export function setPaused(paused: boolean): void {
  mkdirSync(dirname(CONTROL_FILE), { recursive: true })
  atomicWrite(CONTROL_FILE, JSON.stringify({ paused, since: Date.now() }))
}
