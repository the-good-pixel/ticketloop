// Typed artifacts parsed out of a step's free text.
//
// Free text is fine as context for the next model call, but it is NOT fine as
// the record of "a PR exists at this URL" or "the deploy is waiting for
// approval". Those decide outcomes and drive revalidation on resume, so they get
// parsed once, typed, and stored.

import type { Artifact, CatalogStep, DeploymentArtifact, FileArtifact, PrArtifact } from '../catalog/types.js'

const trim = (s: string) => s.replace(/[).,;]+$/, '')

/** The PR the ship step opened. `gh` prints the URL on success. */
export function parsePr(text: string, repo: string): PrArtifact | undefined {
  const m = (text || '').match(/https?:\/\/\S*\/pull\/(\d+)/)
  if (!m) return undefined
  return { type: 'github-pr', repo, url: trim(m[0]), number: Number(m[1]), state: 'open' }
}

/**
 * The deploy step's outcome. A step that reports `wait` is not failed — it is a
 * deployment that exists and has not landed yet, which is what lets a resumed
 * run revalidate instead of redeploying.
 */
export function parseDeployment(text: string, result: 'pass' | 'fail' | 'wait' | 'skip'): DeploymentArtifact | undefined {
  if (result === 'skip') return undefined
  const url = (text || '').match(/https?:\/\/\S+/)
  const status: DeploymentArtifact['status'] =
    result === 'pass' ? 'live' : result === 'fail' ? 'failed' : /approv/i.test(text) ? 'waiting-approval' : 'pending'
  return { type: 'deployment', environment: 'dev', status, url: url ? trim(url[0]) : undefined }
}

/** The export step's file. Models report it as a path; take the last one named. */
export function parseFile(text: string): FileArtifact | undefined {
  const m = [...(text || '').matchAll(/(?:^|\s)((?:\.?\/|~\/)?[\w./-]+\.(?:csv|tsv|json|xlsx?|txt|md))\b/gi)]
  if (!m.length) return undefined
  return { type: 'file', path: trim(m[m.length - 1][1]) }
}

/** Where a post step said it landed. */
export function parseCommentUrl(text: string): string | undefined {
  const tagged = (text || '').match(/COMMENT_URL:\s*(\S+)/i)
  if (tagged) return trim(tagged[1])
  const bare = (text || '').match(/https:\/\/linear\.app\/\S+#comment-\S+/i)
  return bare ? trim(bare[0]) : undefined
}

/**
 * Pull whatever typed artifact a step's declared `produces` calls for. A step
 * that produces plain text yields nothing — that is the normal case.
 */
export function extractArtifact(
  step: CatalogStep,
  text: string,
  result: 'pass' | 'fail' | 'wait' | 'skip',
  repo: string,
): Artifact | undefined {
  switch (step.produces.type) {
    case 'github-pr':
      return parsePr(text, repo)
    case 'deployment':
      return parseDeployment(text, result)
    case 'file':
      return parseFile(text)
    default:
      return undefined
  }
}

/** An artifact counts as "achieved" only when the external system really got there. */
export function artifactSucceeded(a: Artifact | undefined): boolean {
  if (!a) return false
  if (a.type === 'deployment') return a.status === 'live'
  if (a.type === 'github-pr') return !!a.url
  return true
}
