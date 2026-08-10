import { spawnSync } from 'node:child_process'
import { log } from '../../logger.js'

export interface OpenPrOpts {
  cwd: string
  branch: string
  base: string
  title: string
  body: string
}

export interface Repo {
  isGitRepo(path: string): boolean
  localBranchExists(cwd: string, branch: string): boolean
  ensureClean(cwd: string): { clean: boolean; detail?: string }
  createBranch(cwd: string, name: string): void
  diffStat(cwd: string): { files: number; insertions: number; deletions: number }
  changedFiles(cwd: string): string[]
  // committed (base...HEAD) + uncommitted (status) — the real "what changed"
  changedFilesVsBase(cwd: string, base: string): string[]
  hasChanges(cwd: string): boolean
  commitAll(cwd: string, message: string): void
  push(cwd: string, branch: string): void
  openPr(o: OpenPrOpts): Promise<string | null>
  defaultBranch(cwd: string): string
  // Fetch origin and return the base ref to branch off / diff against — the
  // REMOTE ref (origin/<branch>), so a stale local branch can't skew the
  // guardrail. `override` picks a branch other than the detected default.
  resolveBase(cwd: string, override?: string | null): string
  // Worktree isolation: create a fresh worktree on a new branch off `base`,
  // returning its path. removeWorktree cleans it up (branch is kept).
  createWorktree(repoPath: string, wtPath: string, branch: string, base: string): void
  // Check out an EXISTING branch (possibly remote-only, opened by a human/other
  // agent) into a worktree, to refresh its PR. Returns false if it can't fetch it.
  reuseWorktree(repoPath: string, wtPath: string, branch: string): boolean
  removeWorktree(repoPath: string, wtPath: string): void
  // Current HEAD commit of a worktree — the guardrail base for a reused PR (so
  // only the model's new delta is checked, not the PR's already-made changes).
  tipSha(cwd: string): string
  // Force-delete a local branch (used to drop empty branches of untouched repos).
  deleteBranch(repoPath: string, branch: string): void
}

function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

export class GitHubRepo implements Repo {
  isGitRepo(path: string): boolean {
    return git(path, ['rev-parse', '--is-inside-work-tree']).out === 'true'
  }
  localBranchExists(cwd: string, branch: string): boolean {
    return git(cwd, ['rev-parse', '--verify', '--quiet', branch]).code === 0
  }
  ensureClean(cwd: string) {
    const r = git(cwd, ['status', '--porcelain'])
    return r.out ? { clean: false, detail: r.out } : { clean: true }
  }
  defaultBranch(cwd: string): string {
    const r = git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
    if (r.code === 0 && r.out) return r.out.split('/').pop() as string
    const b = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return b.out || 'main'
  }
  resolveBase(cwd: string, override?: string | null): string {
    const branch = override || this.defaultBranch(cwd)
    // Fetch so origin/<branch> reflects the TRUE latest. The local <branch> ref
    // is often behind, and diffing the guardrail against a stale base makes
    // pulled-in upstream commits look like this branch's own changes.
    git(cwd, ['fetch', 'origin', branch]) // best-effort (offline / no remote → fall back)
    const remote = `origin/${branch}`
    return git(cwd, ['rev-parse', '--verify', '--quiet', remote]).code === 0 ? remote : branch
  }
  createBranch(cwd: string, name: string) {
    // Idempotent: reuse the branch if it already exists (re-processing in-place).
    if (this.localBranchExists(cwd, name)) {
      const c = git(cwd, ['checkout', name])
      if (c.code !== 0) throw new Error(`git checkout ${name} failed: ${c.err}`)
      return
    }
    const r = git(cwd, ['checkout', '-b', name])
    if (r.code !== 0) throw new Error(`git checkout -b failed: ${r.err}`)
  }
  hasChanges(cwd: string): boolean {
    return !!git(cwd, ['status', '--porcelain']).out
  }
  changedFiles(cwd: string): string[] {
    const r = git(cwd, ['status', '--porcelain'])
    return r.out ? r.out.split('\n').map((l) => l.slice(3)) : []
  }
  changedFilesVsBase(cwd: string, base: string): string[] {
    const set = new Set<string>()
    // committed changes on the branch relative to its base
    const committed = git(cwd, ['diff', '--name-only', `${base}...HEAD`])
    if (committed.code === 0) {
      for (const f of committed.out.split('\n')) if (f) set.add(f)
    }
    // plus anything still uncommitted in the working tree
    for (const f of this.changedFiles(cwd)) set.add(f)
    return [...set]
  }
  diffStat(cwd: string) {
    const r = git(cwd, ['diff', '--numstat', 'HEAD'])
    let insertions = 0
    let deletions = 0
    let files = 0
    for (const line of r.out.split('\n').filter(Boolean)) {
      const [add, del] = line.split('\t')
      files++
      insertions += Number(add) || 0
      deletions += Number(del) || 0
    }
    return { files, insertions, deletions }
  }
  commitAll(cwd: string, message: string) {
    git(cwd, ['add', '-A'])
    const r = git(cwd, ['commit', '-m', message])
    if (r.code !== 0) throw new Error(`git commit failed: ${r.err || r.out}`)
  }
  push(cwd: string, branch: string) {
    const r = git(cwd, ['push', '-u', 'origin', branch])
    if (r.code !== 0) throw new Error(`git push failed: ${r.err}`)
  }
  async openPr(o: OpenPrOpts): Promise<string | null> {
    const r = spawnSync(
      'gh',
      ['pr', 'create', '--base', o.base, '--head', o.branch, '--title', o.title, '--body', o.body],
      { cwd: o.cwd, encoding: 'utf8' },
    )
    if ((r.status ?? 1) !== 0) {
      log.error(`gh pr create failed: ${r.stderr?.trim()}`)
      return null
    }
    const url = (r.stdout || '').trim().split('\n').pop() || null
    return url
  }
  createWorktree(repoPath: string, wtPath: string, branch: string, base: string) {
    // Best-effort cleanup of a stale worktree dir from a prior run.
    spawnSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath], { encoding: 'utf8' })
    // resolveBranch hands us a name with no local branch → fresh off base. (The
    // reuse arm only fires if a caller passes an existing local branch.)
    const args = this.localBranchExists(repoPath, branch)
      ? ['worktree', 'add', wtPath, branch]
      : ['worktree', 'add', '-b', branch, wtPath, base]
    const r = git(repoPath, args)
    if (r.code !== 0) throw new Error(`git worktree add failed: ${r.err}`)
  }
  reuseWorktree(repoPath: string, wtPath: string, branch: string): boolean {
    git(repoPath, ['fetch', 'origin', branch]) // the branch may be remote-only
    spawnSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath], { encoding: 'utf8' })
    if (this.localBranchExists(repoPath, branch)) {
      return git(repoPath, ['worktree', 'add', wtPath, branch]).code === 0
    }
    const remote = `refs/remotes/origin/${branch}`
    if (git(repoPath, ['rev-parse', '--verify', '--quiet', remote]).code !== 0) return false
    return git(repoPath, ['worktree', 'add', '-b', branch, wtPath, remote]).code === 0
  }
  removeWorktree(repoPath: string, wtPath: string) {
    const r = git(repoPath, ['worktree', 'remove', '--force', wtPath])
    if (r.code !== 0) log.warn(`git worktree remove failed (leaving it): ${r.err}`)
  }
  tipSha(cwd: string): string {
    return git(cwd, ['rev-parse', 'HEAD']).out
  }
  deleteBranch(repoPath: string, branch: string) {
    // best-effort: only called for repos we know are untouched (empty branch),
    // or in-place mode where the branch may not exist — never fatal.
    git(repoPath, ['branch', '-D', branch])
  }
}

// Per-repo mock changes keyed by the workspace dir name, so multi-repo runs
// exercise N repos with different diffs — and a "no changes" repo (→ skipped).
function mockChangesFor(cwd: string): string[] {
  const base = cwd.split('/').pop() || ''
  if (/front/.test(base)) return ['src/lib/i18n/zh-HK.ts']
  if (/back/.test(base)) return ['internal/handlers/label.go']
  if (/infra|iac/.test(base)) return [] // untouched → shipped as skipped
  return ['src/lib/i18n/zh-HK.ts'] // single-repo default
}

export class MockRepo implements Repo {
  isGitRepo() {
    return true
  }
  localBranchExists() {
    return false
  }
  ensureClean() {
    return { clean: true }
  }
  defaultBranch() {
    return 'main'
  }
  resolveBase(_c: string, override?: string | null) {
    return override || 'main'
  }
  createBranch(_c: string, name: string) {
    log.info(`[mock] git checkout -b ${name}`)
  }
  hasChanges() {
    return true
  }
  changedFiles(cwd: string) {
    return mockChangesFor(cwd)
  }
  changedFilesVsBase(cwd: string) {
    return mockChangesFor(cwd)
  }
  diffStat() {
    return { files: 1, insertions: 1, deletions: 1 }
  }
  commitAll(_c: string, message: string) {
    log.info(`[mock] git commit -m "${message}"`)
  }
  push(_c: string, branch: string) {
    log.info(`[mock] git push origin ${branch}`)
  }
  async openPr(o: OpenPrOpts) {
    log.info(`[mock] gh pr create "${o.title}"`)
    const repo = o.cwd.split('/').pop() || 'demo-app'
    const n = 100 + (repo.length % 90)
    return `https://github.com/demo/${repo}/pull/${n}`
  }
  createWorktree(_r: string, wtPath: string, branch: string) {
    log.info(`[mock] git worktree add -b ${branch} ${wtPath}`)
  }
  reuseWorktree(_r: string, wtPath: string, branch: string) {
    log.info(`[mock] reuse worktree on existing branch ${branch} at ${wtPath}`)
    return true
  }
  removeWorktree(_r: string, wtPath: string) {
    log.info(`[mock] git worktree remove ${wtPath}`)
  }
  tipSha() {
    return 'mock-tip-sha'
  }
  deleteBranch(_r: string, branch: string) {
    log.info(`[mock] git branch -D ${branch}`)
  }
}

export function makeRepo(mock: boolean): Repo {
  return mock ? new MockRepo() : new GitHubRepo()
}
