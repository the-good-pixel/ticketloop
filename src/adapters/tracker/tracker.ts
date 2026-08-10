import type { Ticket, TrackerConfig } from '../../types.js'

export interface Tracker {
  /** Tickets eligible for the loop (by label + state), newest first. */
  listCandidates(): Promise<Ticket[]>
  getTicket(id: string): Promise<Ticket | null>
  /**
   * Post a comment; returns a URL to it. If `dedupeKey` is given and a bot
   * comment carrying that key already exists on the ticket, posting is skipped
   * (returns the existing URL) — so a crash-retry can't double-comment.
   */
  comment(ticketId: string, body: string, dedupeKey?: string): Promise<string | null>
}

/** Build a tracker client from a RESOLVED per-project tracker config + key. */
export function makeTracker(tc: TrackerConfig, key = ''): Tracker {
  if (tc.type === 'linear') return new LinearTracker(tc, key)
  return new MockTracker(tc)
}

import { LinearTracker } from './linear.js'
import { MockTracker } from './mock.js'
export { LinearTracker, MockTracker }
export type { Ticket }
