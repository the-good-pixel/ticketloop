// Git workspace management + the ONE deterministic safety guardrail.
//
// Extracted from engine.ts so the legacy engine and the workflow interpreter run
// EXACTLY the same isolation and off-limits logic — a second copy of this is the
// last thing this codebase should ever have. Behavior is unchanged.

import { join, isAbsolute } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import type { ProjectConfig } from '../types.js'
import type { Repo } from '../adapters/repo/github.js'
import type { WorkspaceCk } from './checkpoint.js'
import { matchesAny } from './glob.js'
import { DATA_DIR } from '../paths.js'
import { log } from '../logger.js'

/** The slice of engine context the git plumbing needs. Both engines satisfy it. */
export interface RepoCtx {
  repo: Repo
  mock: boolean
}


export function worktreePath(project: ProjectConfig, ticketId: string): string {
  const base = project.worktreeBase || join(DATA_DIR, 'worktrees', project.name)
  return join(base, ticketId)
}

// ---- Workspace (single- or multi-repo) -------------------------------------
// A WorkRepo is one git repo the change path operates on. Single-repo projects
// produce a one-element list (today's behaviour); multi-repo projects (`repos`
// set) produce one per entry, each in its own worktree under a shared root.
export interface WorkRepo {
  name: string
  srcPath: string // absolute source repo (for worktree ops / in-place)
  workdir: string // where edits happen (worktree path or in-place)
  base: string // PR base branch
  branch: string // this run's working branch (may be versioned on re-processing)
  exclude: string[] // repo-relative extra excludes
  shipDisabled: boolean
}

// The harness must put the worktree on SOME branch before any model step runs
// (a worktree needs a branch; the guardrail diffs against a base). So it picks a
// safe DEFAULT — a fresh branch off the current base, i.e. a clean new PR. It
// does NOT decide new-vs-update-an-existing-PR: that judgment, if wanted, lives
// in the `prepare`/`ship` instruction, where the model can run `gh pr list` and
// check out an open PR's branch itself. Here we only avoid colliding with a
// branch a prior run left behind (which would sit at stale/merged code).
export function resolveBranch(ctx: RepoCtx, srcPath: string, ticketId: string): string {
  const base = `ticketloop/${ticketId.toLowerCase()}`
  if (ctx.mock) return base
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`
    if (!ctx.repo.localBranchExists(srcPath, name)) return name
  }
}
export interface Workspace {
  repos: WorkRepo[]
  cwd: string // where plan→verify run (workspace root for multi, the repo for single)
  multi: boolean
  useWorktree: boolean
}

/** Display contracts for the worktree lifecycle enforced by both engines. */
export const WORKTREE_SETUP_STEP = {
  id: 'create-worktree',
  name: 'Create worktree',
  timing: 'Before repository work',
  description: 'When a workflow first needs a writable repository, Ticketloop creates an isolated worktree and branch from the current base. Resumes reattach the same worktree.',
  locked: true,
} as const

export const WORKTREE_CLEANUP_STEP = {
  id: 'remove-worktree',
  name: 'Remove worktree',
  timing: 'After delivered work',
  description: 'After an export is delivered or every changed repository has a pull request, Ticketloop removes the isolated worktree and keeps branches that still back pull requests.',
  runOn: ['exported', 'pr-opened', 'pr-opened-with-findings', 'deployed', 'merged'],
  locked: true,
} as const

export const WORKTREE_SYSTEM_STEPS = [WORKTREE_SETUP_STEP, WORKTREE_CLEANUP_STEP] as const

/**
 * Remove an isolated workspace after its useful state exists somewhere durable.
 * The caller decides when that is true: data exports are already delivered, or
 * every changed repo has a successfully opened PR. Paused/waiting/failed runs
 * never call this because their checkpoint still points at these worktrees.
 *
 * Branches with PRs must remain for review. Empty branches created for context-
 * only repos have no durable purpose, so remove those along with the worktree.
 */
export function cleanupWorkspace(
  ctx: RepoCtx,
  ws: Workspace | undefined,
  durableBranches: ReadonlySet<string> = new Set(),
): void {
  if (!ws?.useWorktree) return
  for (const r of ws.repos) {
    ctx.repo.removeWorktree(r.srcPath, r.workdir)
    if (!durableBranches.has(r.name)) ctx.repo.deleteBranch(r.srcPath, r.branch)
  }
}

// Serialize a live Workspace into the checkpoint so a resumed run can reattach.
export function toWorkspaceCk(ws: Workspace): WorkspaceCk {
  return { repos: ws.repos.map((r) => ({ ...r })), cwd: ws.cwd, multi: ws.multi, useWorktree: ws.useWorktree }
}

// Rebuild the Workspace from a checkpoint WITHOUT touching git — the worktrees
// and branches from the interrupted attempt are still on disk. Returns null if
// they're gone (user cleaned up), so the caller starts fresh instead.
export function reattachWorkspace(resumeWs: WorkspaceCk, skipDiskCheck = false): Workspace | null {
  if (resumeWs.useWorktree && !skipDiskCheck) {
    for (const r of resumeWs.repos) {
      // A git worktree has a `.git` file (not dir) pointing at the main repo.
      if (!existsSync(join(r.workdir, '.git'))) return null
    }
  }
  return {
    repos: resumeWs.repos.map((r) => ({ ...r })),
    cwd: resumeWs.cwd,
    multi: resumeWs.multi,
    useWorktree: resumeWs.useWorktree,
  }
}

// Create the worktrees/branches and return the workspace. Throws on a dirty
// in-place repo (caught by the outer handler → 'failed').
export function setupWorkspace(
  ctx: RepoCtx,
  project: ProjectConfig,
  ticketId: string,
  reuseBranch?: string,
  resumeWs?: WorkspaceCk,
): Workspace {
  const useWorktree = project.useWorktree !== false
  const multi = !!(project.repos && project.repos.length)

  // RESUME: reattach the interrupted attempt's worktree/branch as-is.
  if (resumeWs) {
    const re = reattachWorkspace(resumeWs, ctx.mock)
    if (re) {
      log.info(`  ⤿ reattached workspace at ${re.cwd} (${re.repos.map((r) => r.branch).join(', ')})`)
      return re
    }
    log.warn(`  checkpoint workspace missing on disk — starting fresh`)
  }

  // Single-repo PR refresh: `locate` found an open PR → check out its branch and
  // guard only the model's new delta (base = the branch tip at checkout).
  if (!multi && reuseBranch && useWorktree) {
    const src = project.repoPath
    const workdir = worktreePath(project, ticketId)
    if (ctx.repo.reuseWorktree(src, workdir, reuseBranch)) {
      const base = ctx.repo.tipSha(workdir)
      return {
        repos: [{ name: project.name, srcPath: src, workdir, base, branch: reuseBranch, exclude: [], shipDisabled: false }],
        cwd: workdir,
        multi,
        useWorktree,
      }
    }
    log.warn(`locate named branch "${reuseBranch}" but it couldn't be checked out — starting fresh`)
  }

  if (multi) {
    const root = worktreePath(project, ticketId)
    if (useWorktree) mkdirSync(root, { recursive: true })
    const repos: WorkRepo[] = []
    for (const r of project.repos!) {
      const src = isAbsolute(r.path) ? r.path : join(project.repoPath, r.path)
      const base = ctx.repo.resolveBase(src, r.base) // origin/<branch> — fetched, never stale
      const branch = resolveBranch(ctx, src, ticketId)
      let workdir = src
      if (useWorktree) {
        workdir = join(root, r.name)
        ctx.repo.createWorktree(src, workdir, branch, base)
      } else if (!ctx.mock) {
        const clean = ctx.repo.ensureClean(src)
        if (!clean.clean) throw new Error(`Repo "${r.name}" not clean before starting:\n${clean.detail?.slice(0, 200)}`)
        ctx.repo.createBranch(src, branch)
      }
      repos.push({ name: r.name, srcPath: src, workdir, base, branch, exclude: r.exclude || [], shipDisabled: !!r.shipDisabled })
    }
    return { repos, cwd: useWorktree ? root : project.repoPath, multi, useWorktree }
  }

  // Single-repo: same flow, one repo.
  const base = ctx.repo.resolveBase(project.repoPath) // origin/<branch> — fetched, never stale
  const branch = resolveBranch(ctx, project.repoPath, ticketId)
  let workdir = project.repoPath
  if (useWorktree) {
    workdir = worktreePath(project, ticketId)
    ctx.repo.createWorktree(project.repoPath, workdir, branch, base)
  } else if (!ctx.mock) {
    const clean = ctx.repo.ensureClean(project.repoPath)
    if (!clean.clean) throw new Error(`Repo not clean before starting:\n${clean.detail?.slice(0, 200)}`)
    ctx.repo.createBranch(project.repoPath, branch)
  }
  return {
    repos: [{ name: project.name, srcPath: project.repoPath, workdir, base, branch, exclude: [], shipDisabled: false }],
    cwd: workdir,
    multi,
    useWorktree,
  }
}

// The ONE deterministic safety check, now over every repo. Returns the dirty
// repos to ship, or a `block` reason if an off-limits path/repo was touched.
export function scanRepos(
  ctx: RepoCtx,
  project: ProjectConfig,
  ws: Workspace,
): { dirty: WorkRepo[]; block?: string } {
  const dirty: WorkRepo[] = []
  for (const r of ws.repos) {
    const changed = ctx.repo.changedFilesVsBase(r.workdir, r.base)
    if (!changed.length) continue
    // A read-only repo must never be modified.
    if (r.shipDisabled)
      return { dirty, block: `Off-limits repo "${r.name}" was modified (read-only). Aborted before ship.` }
    for (const f of changed) {
      // project.exclude matches repo-PREFIXED paths in multi mode (so existing
      // patterns like `backend/migrations/**` keep working); repo.exclude
      // matches the repo-relative path.
      const projPath = ws.multi ? `${r.name}/${f}` : f
      const hit = matchesAny(projPath, project.exclude || []) || matchesAny(f, r.exclude)
      if (hit) return { dirty, block: `Off-limits path touched: ${projPath} (matches "${hit}"). Aborted before ship.` }
    }
    dirty.push(r)
  }
  return { dirty }
}
