/**
 * Git Worktree Manager
 * Manages git worktree lifecycle for isolated agent sessions.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import { logger } from './logger'

const execFileAsync = promisify(execFile)

export interface WorktreeInfo {
  sessionId: string
  worktreePath: string
  branchName: string
  gitRoot: string
  originalCwd: string
  sourceBranch: string
  createdAt: number
}

const WORKTREE_DIR = '.bat-worktrees'

export class WorktreeManager {
  private activeWorktrees = new Map<string, WorktreeInfo>()

  /**
   * Get the git root for a given directory.
   */
  async getGitRoot(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd })
      return stdout.trim()
    } catch {
      return null
    }
  }

  /**
   * Get the current branch name.
   */
  private async getCurrentBranch(cwd: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
      return stdout.trim()
    } catch {
      return 'HEAD'
    }
  }

  /**
   * Create a git worktree for a session.
   */
  async createWorktree(sessionId: string, cwd: string, branchName?: string): Promise<WorktreeInfo> {
    const gitRoot = await this.getGitRoot(cwd)
    if (!gitRoot) {
      throw new Error('Not a git repository')
    }

    const shortId = sessionId.slice(0, 8)
    const worktreeBase = path.join(gitRoot, WORKTREE_DIR)
    const worktreePath = path.join(worktreeBase, shortId)
    const branch = branchName || `bat/worktree-${shortId}`
    const sourceBranch = await this.getCurrentBranch(gitRoot)

    // Ensure .bat-worktrees/ directory exists
    await fsPromises.mkdir(worktreeBase, { recursive: true })

    // Add .bat-worktrees/ to .git/info/exclude if not already present
    await this.addToGitExclude(gitRoot)

    // If directory already exists, do NOT delete it — it may contain valuable work.
    // Fail and let the caller decide (e.g. rehydrate the existing one).
    if (fs.existsSync(worktreePath)) {
      throw new Error(`Worktree already exists at ${worktreePath}. Use rehydrate() to reuse it.`)
    }

    // Check if branch already exists, if so try with suffix
    let finalBranch = branch
    try {
      await execFileAsync('git', ['rev-parse', '--verify', branch], { cwd: gitRoot })
      // Branch exists, append timestamp suffix
      finalBranch = `${branch}-${Date.now().toString(36)}`
      logger.log(`[Worktree] Branch ${branch} exists, using ${finalBranch}`)
    } catch {
      // Branch doesn't exist, use as-is
    }

    // Create the worktree with a new branch
    logger.log(`[Worktree] Creating worktree at ${worktreePath} on branch ${finalBranch}`)
    await execFileAsync('git', ['worktree', 'add', worktreePath, '-b', finalBranch], { cwd: gitRoot })

    // Link untracked .claude/ items
    await this.linkClaudeUntracked(gitRoot, worktreePath)

    const info: WorktreeInfo = {
      sessionId,
      worktreePath,
      branchName: finalBranch,
      gitRoot,
      originalCwd: cwd,
      sourceBranch,
      createdAt: Date.now(),
    }
    this.activeWorktrees.set(sessionId, info)

    logger.log(`[Worktree] Created worktree for session ${shortId}: ${worktreePath} (branch: ${finalBranch}, source: ${sourceBranch})`)
    return info
  }

  /**
   * Link untracked .claude/ items from original repo to worktree.
   * Git tracked files are already present via checkout; only untracked items need linking.
   */
  private async linkClaudeUntracked(gitRoot: string, worktreePath: string): Promise<void> {
    const claudeDir = path.join(gitRoot, '.claude')
    if (!fs.existsSync(claudeDir)) return

    // Get list of untracked items under .claude/
    let untrackedItems: string[]
    try {
      const { stdout } = await execFileAsync(
        'git', ['ls-files', '--others', '--exclude-standard', '.claude/'],
        { cwd: gitRoot }
      )
      // Get unique top-level entries under .claude/ (directories and files)
      const items = stdout.trim().split('\n').filter(Boolean)
      const topLevel = new Set<string>()
      for (const item of items) {
        // item is like ".claude/memory/foo.md" or ".claude/plans/bar.md"
        const relative = item.replace(/^\.claude\//, '')
        const firstPart = relative.split('/')[0]
        if (firstPart) topLevel.add(firstPart)
      }
      untrackedItems = [...topLevel]
    } catch {
      logger.warn('[Worktree] Failed to list untracked .claude/ items')
      return
    }

    if (untrackedItems.length === 0) return

    // Ensure .claude/ exists in worktree
    const worktreeClaudeDir = path.join(worktreePath, '.claude')
    await fsPromises.mkdir(worktreeClaudeDir, { recursive: true })

    const isWindows = process.platform === 'win32'

    for (const item of untrackedItems) {
      const srcPath = path.join(claudeDir, item)
      const destPath = path.join(worktreeClaudeDir, item)

      // Skip if destination already exists (git tracked)
      if (fs.existsSync(destPath)) continue

      try {
        const stat = await fsPromises.stat(srcPath)
        if (stat.isDirectory()) {
          if (isWindows) {
            // Use directory junction on Windows (no admin required)
            await fsPromises.symlink(srcPath, destPath, 'junction')
          } else {
            await fsPromises.symlink(srcPath, destPath)
          }
          logger.log(`[Worktree] Linked .claude/${item} → worktree`)
        } else {
          // For files, symlink on Unix, copy on Windows (file symlinks need admin)
          if (isWindows) {
            await fsPromises.copyFile(srcPath, destPath)
          } else {
            await fsPromises.symlink(srcPath, destPath)
          }
          logger.log(`[Worktree] Linked .claude/${item} → worktree`)
        }
      } catch (err) {
        logger.warn(`[Worktree] Failed to link .claude/${item}: ${err}`)
      }
    }
  }

  /**
   * Add .bat-worktrees/ to .git/info/exclude.
   */
  private async addToGitExclude(gitRoot: string): Promise<void> {
    const excludeFile = path.join(gitRoot, '.git', 'info', 'exclude')
    const pattern = `/${WORKTREE_DIR}/`
    try {
      await fsPromises.mkdir(path.dirname(excludeFile), { recursive: true })
      let content = ''
      try {
        content = await fsPromises.readFile(excludeFile, 'utf8')
      } catch {
        // File doesn't exist yet
      }
      if (!content.includes(pattern)) {
        const newContent = content.endsWith('\n') || content === '' ? content : content + '\n'
        await fsPromises.writeFile(excludeFile, newContent + pattern + '\n', 'utf8')
        logger.log(`[Worktree] Added ${pattern} to .git/info/exclude`)
      }
    } catch (err) {
      logger.warn(`[Worktree] Failed to update .git/info/exclude: ${err}`)
    }
  }

  /**
   * Remove a worktree for a session.
   */
  async removeWorktree(sessionId: string, deleteBranch = true): Promise<void> {
    const info = this.activeWorktrees.get(sessionId)
    if (!info) {
      logger.warn(`[Worktree] No worktree found for session ${sessionId}`)
      return
    }

    await this.forceRemoveWorktree(info.gitRoot, info.worktreePath, deleteBranch ? info.branchName : undefined)
    this.activeWorktrees.delete(sessionId)
    logger.log(`[Worktree] Removed worktree for session ${sessionId.slice(0, 8)}`)
  }

  /**
   * Force remove a worktree path and optionally its branch.
   */
  private async forceRemoveWorktree(gitRoot: string, worktreePath: string, branchToDelete?: string): Promise<void> {
    try {
      await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: gitRoot })
    } catch {
      // If git worktree remove fails, try manual cleanup
      try {
        await fsPromises.rm(worktreePath, { recursive: true, force: true })
        await execFileAsync('git', ['worktree', 'prune'], { cwd: gitRoot })
      } catch (err) {
        logger.warn(`[Worktree] Manual cleanup failed for ${worktreePath}: ${err}`)
      }
    }

    if (branchToDelete) {
      try {
        await execFileAsync('git', ['branch', '-D', branchToDelete], { cwd: gitRoot })
      } catch {
        // Branch may not exist or already deleted
      }
    }
  }

  /**
   * Rehydrate a worktree from persisted state (e.g. after app restart).
   * Registers the worktree in the active map without creating it.
   */
  rehydrate(sessionId: string, originalCwd: string, worktreePath: string, branchName: string): WorktreeInfo {
    // Try to detect gitRoot and sourceBranch from the worktree path
    const gitRoot = path.resolve(worktreePath, '..', '..')
    const info: WorktreeInfo = {
      sessionId,
      worktreePath,
      branchName,
      gitRoot,
      originalCwd,
      sourceBranch: '', // Unknown after restart, will be resolved on merge
      createdAt: 0,
    }
    this.activeWorktrees.set(sessionId, info)

    // Try to resolve sourceBranch async
    this.getCurrentBranch(gitRoot).then(branch => {
      info.sourceBranch = branch
    }).catch(() => {})

    logger.log(`[Worktree] Rehydrated session ${sessionId.slice(0, 8)}: ${worktreePath} (branch: ${branchName})`)
    return info
  }

  /**
   * Get worktree info for a session.
   */
  getWorktreeInfo(sessionId: string): WorktreeInfo | null {
    return this.activeWorktrees.get(sessionId) || null
  }

  /**
   * Get diff between worktree branch and source branch.
   */
  async getDiff(sessionId: string): Promise<string | null> {
    const info = this.activeWorktrees.get(sessionId)
    if (!info) return null

    try {
      const { stdout } = await execFileAsync(
        'git', ['diff', `${info.sourceBranch}...${info.branchName}`],
        { cwd: info.gitRoot, maxBuffer: 10 * 1024 * 1024 }
      )
      return stdout
    } catch (err) {
      logger.warn(`[Worktree] Failed to get diff for session ${sessionId}: ${err}`)
      return null
    }
  }

  /**
   * Get worktree status (diff, branch, path).
   */
  async getWorktreeStatus(sessionId: string): Promise<{ diff: string; branchName: string; worktreePath: string; sourceBranch: string } | null> {
    const info = this.activeWorktrees.get(sessionId)
    if (!info) return null

    const diff = await this.getDiff(sessionId) || ''
    return {
      diff,
      branchName: info.branchName,
      worktreePath: info.worktreePath,
      sourceBranch: info.sourceBranch,
    }
  }

  /**
   * Merge worktree branch back to source branch.
   */
  async mergeWorktree(sessionId: string, strategy: 'merge' | 'cherry-pick' = 'merge'): Promise<{ success: boolean; error?: string }> {
    const info = this.activeWorktrees.get(sessionId)
    if (!info) return { success: false, error: 'No worktree found for this session' }

    try {
      // Remember current branch so we can restore it after merge
      const { stdout: currentBranch } = await execFileAsync(
        'git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: info.gitRoot }
      )
      const prevBranch = currentBranch.trim()

      // Checkout source branch before merging
      if (prevBranch !== info.sourceBranch) {
        await execFileAsync('git', ['checkout', info.sourceBranch], { cwd: info.gitRoot })
      }

      try {
        if (strategy === 'merge') {
          await execFileAsync('git', ['merge', info.branchName, '--no-ff', '-m', `Merge worktree branch ${info.branchName}`], { cwd: info.gitRoot })
        } else {
          // cherry-pick: get commits on worktree branch since it diverged
          const { stdout: logOutput } = await execFileAsync(
            'git', ['log', '--format=%H', `${info.sourceBranch}..${info.branchName}`],
            { cwd: info.gitRoot }
          )
          const commits = logOutput.trim().split('\n').filter(Boolean).reverse()
          if (commits.length === 0) {
            // Restore previous branch before returning
            if (prevBranch !== info.sourceBranch) {
              await execFileAsync('git', ['checkout', prevBranch], { cwd: info.gitRoot }).catch(() => {})
            }
            return { success: false, error: 'No commits to cherry-pick' }
          }
          await execFileAsync('git', ['cherry-pick', ...commits], { cwd: info.gitRoot })
        }
      } catch (mergeErr) {
        // Restore previous branch on merge failure
        if (prevBranch !== info.sourceBranch) {
          await execFileAsync('git', ['checkout', prevBranch], { cwd: info.gitRoot }).catch(() => {})
        }
        throw mergeErr
      }

      logger.log(`[Worktree] Merged ${info.branchName} into ${info.sourceBranch} via ${strategy}`)

      // Push after merge
      try {
        await execFileAsync('git', ['push'], { cwd: info.gitRoot })
        logger.log(`[Worktree] Pushed ${info.sourceBranch} after merge`)
      } catch (pushErr) {
        const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr)
        logger.warn(`[Worktree] Merge succeeded but push failed: ${pushMsg}`)
        // Restore previous branch
        if (prevBranch !== info.sourceBranch) {
          await execFileAsync('git', ['checkout', prevBranch], { cwd: info.gitRoot }).catch(() => {})
        }
        return { success: true, error: `Merged but push failed: ${pushMsg}` }
      }

      // Restore previous branch after successful merge+push
      if (prevBranch !== info.sourceBranch) {
        await execFileAsync('git', ['checkout', prevBranch], { cwd: info.gitRoot }).catch(() => {})
      }

      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[Worktree] Merge failed: ${msg}`)
      return { success: false, error: msg }
    }
  }

  /**
   * List orphaned worktrees (not tracked by this manager).
   * Does NOT delete them — caller must ask the user for confirmation first.
   */
  async listOrphaned(gitRoot: string): Promise<string[]> {
    const worktreeBase = path.join(gitRoot, WORKTREE_DIR)
    if (!fs.existsSync(worktreeBase)) return []

    const orphaned: string[] = []
    try {
      const entries = await fsPromises.readdir(worktreeBase)
      const activeSessionIds = new Set([...this.activeWorktrees.values()].map(w => path.basename(w.worktreePath)))

      for (const entry of entries) {
        if (activeSessionIds.has(entry)) continue

        const entryPath = path.join(worktreeBase, entry)
        const stat = await fsPromises.stat(entryPath).catch(() => null)
        if (!stat?.isDirectory()) continue

        orphaned.push(entryPath)
      }
    } catch (err) {
      logger.warn(`[Worktree] Failed to list orphaned worktrees: ${err}`)
    }
    return orphaned
  }

  /**
   * Explicitly remove an orphaned worktree by path (only call after user confirms).
   */
  async removeOrphanedByPath(gitRoot: string, worktreePath: string): Promise<void> {
    const entry = path.basename(worktreePath)
    const branchName = `bat/worktree-${entry}`
    await this.forceRemoveWorktree(gitRoot, worktreePath, branchName)
    logger.log(`[Worktree] Removed orphaned worktree: ${entry}`)
  }

  /**
   * Dispose — only clears in-memory tracking. Does NOT delete worktrees from disk.
   */
  async dispose(): Promise<void> {
    // Intentionally only clear the in-memory map.
    // Worktrees on disk are preserved and will be rehydrated on next start.
    this.activeWorktrees.clear()
  }

}

// Singleton instance
export const worktreeManager = new WorktreeManager()
