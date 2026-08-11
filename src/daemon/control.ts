import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { CONTROL_FILE } from '../paths.js'
import { atomicWrite } from '../store.js'

// The pause switch lives in a tiny file so a SEPARATE process (the `pause` /
// `resume` CLI commands) can signal the running daemon. The daemon reads it
// before every scan and before every stage; the CLI just writes it.
//   - `paused`  : system-level — the whole loop halts.
//   - `tickets` : per-ticket pause, keyed by "<project>:<identifier>".
interface Control {
  paused: boolean
  since?: number
  tickets?: Record<string, true>
}

function read(): Control {
  try {
    if (!existsSync(CONTROL_FILE)) return { paused: false }
    return JSON.parse(readFileSync(CONTROL_FILE, 'utf8')) as Control
  } catch {
    return { paused: false } // an unreadable control file must never wedge the loop
  }
}

function write(c: Control): void {
  mkdirSync(dirname(CONTROL_FILE), { recursive: true })
  atomicWrite(CONTROL_FILE, JSON.stringify(c))
}

/** True if the whole loop is paused, or (when given) this specific ticket is. */
export function isPaused(ticketKey?: string): boolean {
  const c = read()
  if (c.paused) return true
  return !!(ticketKey && c.tickets && c.tickets[ticketKey])
}

/** System-level pause/resume — leaves per-ticket pauses untouched. */
export function setPaused(paused: boolean): void {
  const c = read()
  write({ ...c, paused, since: Date.now() })
}

/** Pause/resume a single ticket by its "<project>:<identifier>" key. */
export function setTicketPaused(ticketKey: string, paused: boolean): void {
  const c = read()
  const tickets = { ...(c.tickets || {}) }
  if (paused) tickets[ticketKey] = true
  else delete tickets[ticketKey]
  write({ ...c, tickets })
}

/** All currently ticket-paused keys. */
export function pausedTickets(): string[] {
  return Object.keys(read().tickets || {})
}
