import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { CONTROL_FILE } from '../paths.js'
import { atomicWrite } from '../store.js'

// The pause switch lives in a tiny file so a SEPARATE process (the `pause` /
// `resume` CLI commands) can signal the running daemon. The daemon reads it
// before every scan and before every stage; the CLI just writes it.
//   - `paused`  : system-level — the whole loop halts.
//   - `tickets` : per-ticket pause, keyed by "<project>:<identifier>".
//   - `ignored` : per-ticket NEVER-process, same key. Unlike a pause, this is not
//                 a "wait" — it removes the ticket from the candidate set for
//                 good. New comments do not wake it; only clearing the mark does.
//                 That is deliberate: the reason to ignore a ticket is usually
//                 that it keeps getting picked up wrongly, and a mark that new
//                 activity could undo would not fix that.
//   - `cancel`  : one-shot "stop this run NOW" request, same key. The daemon
//                 consumes it: it kills the in-flight agent subprocess rather
//                 than waiting for the current step to end (which is what a
//                 pause does). Written by the API, cleared by the daemon.
export interface IgnoreMark {
  at: number
  reason?: string
}

interface Control {
  paused: boolean
  since?: number
  tickets?: Record<string, true>
  ignored?: Record<string, IgnoreMark>
  cancel?: Record<string, true>
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

// ---- never-process ---------------------------------------------------------

/** True if this ticket is marked never-process. */
export function isIgnored(ticketKey: string): boolean {
  return !!read().ignored?.[ticketKey]
}

/** Mark / unmark a ticket as never-process. Clearing it makes the ticket a
 *  normal candidate again on the next scan. */
export function setTicketIgnored(ticketKey: string, ignored: boolean, reason?: string): void {
  const c = read()
  const map = { ...(c.ignored || {}) }
  if (ignored) map[ticketKey] = { at: Date.now(), ...(reason ? { reason } : {}) }
  else delete map[ticketKey]
  write({ ...c, ignored: map })
}

/** Every never-process mark, for the dashboard's "ignored" list. */
export function ignoredTickets(): Array<{ ticketKey: string } & IgnoreMark> {
  const map = read().ignored || {}
  return Object.entries(map).map(([ticketKey, mark]) => ({ ticketKey, ...mark }))
}

// ---- immediate stop --------------------------------------------------------

/** Request that an in-flight run be killed now, rather than at its next step
 *  boundary. Written by the API/CLI; the daemon acts on it and clears it. */
export function requestCancel(ticketKey: string): void {
  const c = read()
  write({ ...c, cancel: { ...(c.cancel || {}), [ticketKey]: true } })
}

/** True if a stop was requested for this ticket. */
export function isCancelRequested(ticketKey: string): boolean {
  return !!read().cancel?.[ticketKey]
}

/** Consume the request — a stop must fire once, not on every later run. */
export function clearCancel(ticketKey: string): void {
  const c = read()
  if (!c.cancel?.[ticketKey]) return
  const cancel = { ...c.cancel }
  delete cancel[ticketKey]
  write({ ...c, cancel })
}

/** Keys with a pending stop request, for the dashboard's live rows. */
export function cancelRequestedTickets(): string[] {
  return Object.keys(read().cancel || {})
}
