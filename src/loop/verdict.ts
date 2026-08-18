// Step results: pass | fail | wait | skip.
//
// The legacy engine's `parseVerdict` is two-valued, which is exactly the bug the
// workflow design set out to fix: "the deploy is queued for a human" and "the
// code is wrong" both came back as `fail` and both routed to the fix step. Here
// they are different results with different transitions.

import { log } from '../logger.js'
import type { StepResult } from '../catalog/types.js'
import type { WaitKind } from '../types.js'

export interface ParsedResult {
  result: StepResult
  reason: string
  blockerKind?: WaitKind
}

// Synonyms the models actually emit, mapped to the four results.
const PASS = /^(pass|clean|ok|success)$/i
const FAIL = /^(fail|issues|needs[-\s]?fix|failed)$/i
const WAIT = /^(wait|waiting|blocked[-\s]?external|pending)$/i
const SKIP = /^(skip|skipped|n\/?a|not[-\s]?applicable)$/i

/**
 * Parse the trailing verdict line. LAST verdict wins — a model may reason
 * through several before concluding.
 *
 * A missing verdict is fail-OPEN (treated as `pass`), matching the legacy
 * engine: a model that forgets the format must not be able to spin the repair
 * loop forever. The off-limits guardrail and human PR review stay the hard
 * backstops, not this line.
 */
export function parseResult(text: string): ParsedResult {
  const matches = [
    ...(text || '').matchAll(
      /VERDICT:\s*([a-z/\\-]+)(?:\[(provider|approval|deployment|external)\])?(.*)/gi,
    ),
  ]
  if (!matches.length) {
    log.warn('gate emitted no VERDICT line — treating as pass (fail-open)')
    return { result: 'pass', reason: '' }
  }
  const last = matches[matches.length - 1]
  const word = last[1]
  const blockerKind = last[2] as WaitKind | undefined
  const reason = (last[3] || '').replace(/^\s*[—:-]\s*/, '').trim()
  if (PASS.test(word)) return { result: 'pass', reason }
  if (WAIT.test(word)) return { result: 'wait', reason, blockerKind }
  if (SKIP.test(word)) return { result: 'skip', reason }
  if (FAIL.test(word)) return { result: 'fail', reason }
  // An unrecognized word is a real answer we cannot read. Treat it as a failure
  // rather than fail-open: unlike a missing line, the model DID try to conclude.
  log.warn(`unrecognized verdict "${word}" — treating as fail`)
  return { result: 'fail', reason: reason || `unrecognized verdict "${word}"` }
}

/** The routing field a `route` step emits, e.g. KIND from triage. */
export function parseRouteField(text: string, field: string): string | undefined {
  const re = new RegExp(`${field}:\\s*([\\w./-]+)`, 'i')
  const m = (text || '').match(re)
  return m ? m[1].trim().toLowerCase() : undefined
}

// A route step routes on a value, but the value alone never explains itself.
// "skipped — ineligible" tells a user nothing they could act on. This reads the
// one-line REASON a route step states alongside its decision, so the run record
// can say WHY it stopped. Last wins, matching parseResult: a model may think
// aloud before concluding.
const MAX_REASON = 300
export function parseRouteReason(text: string): string | undefined {
  const matches = [...(text || '').matchAll(/^[ \t]*REASON:[ \t]*(.+)$/gim)]
  if (!matches.length) return undefined
  const reason = matches[matches.length - 1][1].trim()
  if (!reason) return undefined
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1).trimEnd()}…` : reason
}
