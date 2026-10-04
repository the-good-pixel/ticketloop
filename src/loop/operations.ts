// Durable intents outlive checkpoints. A failed lookup never authorizes a retry.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseResult } from './verdict.js'
import { DATA_DIR } from '../paths.js'
import { isPaused } from '../daemon/control.js'
import { readRuns, atomicWrite } from '../store.js'

export class OperationReviewError extends Error {}

export interface Operation {
  schema: 1
  id: string
  runId: string
  ticketKey: string
  ticketId: string
  nodeKey: string
  effect: string
  cwd: string
  branch?: string
  base?: string
  status: 'pending' | 'completed' | 'not-performed'
  review?: { at: number; reason: string }
  url?: string
  output?: string
}
export type Lookup = { state: 'found'; url: string } | { state: 'absent' } | { state: 'unknown' }
export type Reconciler = (operation: Operation) => Promise<Lookup>
const directory = join(DATA_DIR, 'operations')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const file = (id: string) => join(directory, `${id}.json`)
const ownerFile = (id: string) => join(directory, `${id}.owner.json`)

export function operationId(runId: string, nodeKey: string, effect: string): string {
  return hash(JSON.stringify([runId, nodeKey, effect]))
}
export function loadOperation(id: string): Operation | undefined {
  if (!existsSync(file(id))) return undefined
  let op: Operation
  try { op = JSON.parse(readFileSync(file(id), 'utf8')) as Operation }
  catch { throw new OperationReviewError(`Unreadable external-operation record ${file(id)}; recovery needs review.`) }
  if (!op || typeof op.ticketKey !== 'string' || op.schema !== 1 || op.id !== id || operationId(op.runId, op.nodeKey, op.effect) !== id || !['pending', 'completed', 'not-performed'].includes(op.status))
    throw new OperationReviewError(`Invalid external-operation record ${file(id)}; recovery needs review.`)
  if (op.status === 'completed' && (op.effect === 'create-pr' || op.effect === 'tracker-comment') &&
      (!op.url || (op.effect === 'tracker-comment' && !op.output)))
    throw new OperationReviewError('Completed external-operation record is missing its artifact; recovery needs review.')
  if (existsSync(ownerFile(id))) {
    let owner: { ticketKey: string }
    try { owner = JSON.parse(readFileSync(ownerFile(id), 'utf8')) }
    catch { throw new OperationReviewError(`Unreadable operation ownership ${ownerFile(id)}; recovery needs review.`) }
    if (owner.ticketKey !== op.ticketKey)
      throw new OperationReviewError(`Operation ownership mismatch ${file(id)}; recovery needs review.`)
  }
  return op
}
export function saveOperation(op: Operation): void {
  mkdirSync(directory, { recursive: true })
  // Persist ownership first so a damaged record can be isolated without reading it.
  atomicWrite(ownerFile(op.id), JSON.stringify({ ticketKey: op.ticketKey }))
  atomicWrite(file(op.id), JSON.stringify(op))
}
export function listOperations(ticketKey?: string): Operation[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .filter(name => {
      if (!ticketKey) return true
      const id = name.slice(0, -5)
      if (existsSync(ownerFile(id))) {
        try {
          const owner = JSON.parse(readFileSync(ownerFile(id), 'utf8'))
          if (typeof owner.ticketKey !== 'string') throw new Error('invalid owner')
          return owner.ticketKey === ticketKey
        } catch { throw new OperationReviewError(`Unreadable operation ownership ${ownerFile(id)}; recovery needs review.`) }
      }
      // Old records have no ownership file. Never ignore corruption with unknown ownership.
      const op = loadOperation(id)!
      atomicWrite(ownerFile(id), JSON.stringify({ ticketKey: op.ticketKey }))
      return op.ticketKey === ticketKey
    })
    .map(name => loadOperation(name.slice(0, -5))!)
    .filter(op => !ticketKey || op.ticketKey === ticketKey)
}
export function uncertainOperations(ticketKey: string, exceptRunId?: string): Operation[] {
  return listOperations(ticketKey).filter(op => op.runId !== exceptRunId && op.status === 'pending')
}

/** Explicit local operator decision. Does not send a remote request. */
export function resolveOperation(id: string, resolution: string, reason: string): void {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid operation ID.')
  const op = loadOperation(id)
  if (!op) throw new Error('Operation not found.')
  if (!reason.trim()) throw new Error('A review reason is required.')
  if (!isPaused(op.ticketKey) || readRuns().some(run => run.project + ':' + run.ticket === op.ticketKey && run.outcome === 'running'))
    throw new Error('Pause the ticket and wait for its current step to finish before resolving an operation.')
  if (op.status !== 'pending') throw new Error('Only a pending operation can be resolved.')
  if (resolution === 'not-performed') {
    op.status = 'not-performed'
  } else if (resolution === 'performed' && op.effect === 'deploy-dev') {
    op.status = 'completed'
    op.output = 'Operator confirmed completed DEV deployment.\nVERDICT: pass'
  } else {
    const valid = op.effect === 'tracker-comment' ? /^https:\/\/linear\.app\//.test(resolution)
      : op.effect === 'create-pr' ? /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(resolution) : false
    if (!valid) throw new Error('Supply a matching comment/PR URL, performed for a verified DEV deployment, or not-performed after verifying no action occurred.')
    op.url = resolution
    op.status = 'completed'
    if (op.effect === 'tracker-comment') op.output = `Operator confirmed delivered comment.\nCOMMENT_URL: ${resolution}`
  }
  op.review = { at: Date.now(), reason }
  saveOperation(op)
}
export function marker(op: Operation): string { return `<!-- tlk:${op.id} -->` }
export function operationPrompt(op: Operation): string {
  if (op.effect === 'tracker-comment')
    return `Include the exact marker ${marker(op)} in the comment body. Before posting, look for that marker on this issue. Reuse a matching comment; never post a second copy. If lookup fails or completion is uncertain, stop without posting.`
  if (op.effect === 'create-pr')
    return `Use only head branch ${op.branch} for this repository. Look for its existing PR before creating one and include ${marker(op)} in a new PR body. ${op.url ? `The PR already exists: ${op.url}. Do not create another PR. Continue the shipping checks; an existing PR does not mean CI passed.` : 'If a PR exists, update that PR. If lookup fails or completion is uncertain, stop without creating a PR.'}`
  return ''
}

/** Read only. No commentCreate, PR creation or other remote writes here. */
export async function lookupOperation(op: Operation, trackerKey?: string): Promise<Lookup> {
  try {
    if (op.effect === 'create-pr') {
      if (!op.branch) return { state: 'unknown' }
      const result = spawnSync('gh', ['pr', 'list', '--state', 'all', '--head', op.branch,
        '--limit', '100', '--json', 'url,headRefName,baseRefName,body'],
        { cwd: op.cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000 })
      if (result.status !== 0) return { state: 'unknown' }
      const rows = JSON.parse(result.stdout) as { url: string; headRefName: string; baseRefName: string; body: string }[]
      const hits = rows.filter(row => row.headRefName === op.branch)
      // The repository comes from gh's cwd. A reused worktree's guardrail base
      // can be a commit SHA, so it cannot always serve as a PR base-name filter.
      if (hits.length === 1 && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(hits[0].url))
        return { state: 'found', url: hits[0].url }
      return hits.length ? { state: 'unknown' } : { state: 'absent' }
    }
    if (op.effect !== 'tracker-comment' || !trackerKey) return { state: 'unknown' }
    const urls: string[] = []
    let after: string | null = null
    for (let page = 0; page < 100; page++) {
      const response = await fetch('https://api.linear.app/graphql', {
        method: 'POST', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', Authorization: trackerKey },
        body: JSON.stringify({ query: `query($id:String!,$after:String){ viewer { id } issue(id:$id){ id comments(first:100,after:$after){ nodes { body url user { id } } pageInfo { hasNextPage endCursor } } } }`,
          variables: { id: op.ticketId, after } }),
      })
      if (!response.ok) return { state: 'unknown' }
      const json = await response.json() as { errors?: unknown; data?: {
        viewer: { id: string }; issue: { id: string; comments: { nodes: { body: string; url: string; user: { id: string } | null }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null } }
      if (json.errors || !json.data?.issue || json.data.issue.id !== op.ticketId || !json.data.viewer?.id)
        return { state: 'unknown' }
      const { comments } = json.data.issue
      for (const comment of comments.nodes) {
        if (comment.body.includes(marker(op)) && comment.user?.id === json.data.viewer.id) urls.push(comment.url)
      }
      if (!comments.pageInfo.hasNextPage) {
        if (urls.length === 1 && /^https:\/\/linear\.app\//.test(urls[0])) return { state: 'found', url: urls[0] }
        return urls.length ? { state: 'unknown' } : { state: 'absent' }
      }
      if (!comments.pageInfo.endCursor || comments.pageInfo.endCursor === after) return { state: 'unknown' }
      after = comments.pageInfo.endCursor
    }
  } catch { /* Network/tool failure leaves completion uncertain. */ }
  return { state: 'unknown' }
}

export interface OperationInput {
  runId: string; ticketKey: string; ticketId: string; nodeKey: string
  effects: string[]; cwd: string; branch?: string; base?: string
}
export type Prepared = { operations: Operation[]; prompt: string; recoveredOutput?: string } | { wait: string }

export async function prepareOperations(input: OperationInput, reconcile: Reconciler, mock = false): Promise<Prepared> {
  const operations: Operation[] = []
  // Reconcile every prior effect before writing any new intent.
  for (const effect of input.effects) {
    const id = operationId(input.runId, input.nodeKey, effect)
    const prior = loadOperation(id)
    if (prior && (prior.ticketId !== input.ticketId || prior.ticketKey !== input.ticketKey || prior.cwd !== input.cwd || prior.branch !== input.branch))
      return { wait: 'External-operation context changed. Review the saved operation before continuing.' }
    const { effects, ...details } = input
    const op: Operation = prior || { schema: 1, id, ...details, effect, status: 'pending' }
    if (prior && prior.status === 'pending' && !['create-pr', 'tracker-comment'].includes(effect) && !mock)
      return { wait: `Recovery for "${effect}" needs review; automatic reconciliation is not supported.` }
    if (prior?.status === 'pending') {
      const lookup = await reconcile(op)
      if (lookup.state === 'found') {
        op.url = lookup.url
        // A recovered comment is its whole effect; a recovered PR still needs
        // the shipping gate. Do not manufacture a passing CI verdict.
        if (effect === 'tracker-comment' && input.effects.length === 1)
          op.output = `Recovered delivered comment.\nCOMMENT_URL: ${lookup.url}`
      } else if (!mock) {
        return { wait: `Completion of "${effect}" is uncertain. Review remote state before continuing; no automatic retry was sent.` }
      }
    }
    if (op.status === 'not-performed') { op.status = 'pending'; op.output = undefined; op.url = undefined }
    if (op.effect === 'tracker-comment' && op.url && input.effects.length > 1 && !mock)
      return { wait: 'This step combines a delivered comment with other effects. Review recovery before repeating any remaining work.' }
    operations.push(op)
  }
  for (const op of operations) saveOperation(op)
  const recovered = operations.length === 1 && (operations[0].effect === 'tracker-comment' || (operations[0].effect === 'deploy-dev' && operations[0].status === 'completed')) ? operations[0].output : undefined
  return { operations, prompt: operations.map(operationPrompt).filter(Boolean).join('\n'), recoveredOutput: recovered }
}

export function completeOperations(operations: Operation[], output: string): void {
  for (const op of operations) {
    // Absence of an artifact URL is not proof that the remote action failed.
    const url = op.effect === 'tracker-comment' ? output.match(/COMMENT_URL:\s*(https:\/\/\S+)/i)?.[1]
      : op.effect === 'create-pr' ? output.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/)?.[0] : undefined
    if (!url && (op.effect === 'tracker-comment' || op.effect === 'create-pr')) continue
    if (op.effect === 'deploy-dev') {
      // Require an explicit passing verdict; missing verdicts are not completion evidence.
      if (!/VERDICT:/i.test(output) || parseResult(output).result !== 'pass') continue
    } else if (!['create-pr', 'tracker-comment'].includes(op.effect)) continue
    op.status = 'completed'
    op.output = output
    op.url = url?.replace(/[).,]+$/, '') || op.url
    saveOperation(op)
  }
}
