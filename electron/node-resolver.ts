/**
 * Resolve the node binary path for Electron apps.
 *
 * When launched from Dock/Launchpad, macOS provides a minimal PATH that
 * doesn't include nvm, Homebrew, or Volta. This module finds the node
 * binary by checking common installation paths as fallback.
 *
 * Uses lazy resolution (not at module load time) to ensure PATH fixes
 * in main.ts have a chance to run first.
 */

import * as fs from 'fs'
import * as path from 'path'

const HOME = process.env.HOME || process.env.USERPROFILE || ''

interface NodeCandidate {
  type: 'versioned'
  dir: string
  binSubpath: string  // path from version dir to node binary
}

interface DirectCandidate {
  type: 'direct'
  path: string
}

type Candidate = NodeCandidate | DirectCandidate

function getCandidates(): Candidate[] {
  if (process.platform === 'darwin') {
    return [
      { type: 'versioned', dir: path.join(HOME, '.nvm', 'versions', 'node'), binSubpath: 'bin/node' },
      { type: 'versioned', dir: path.join(HOME, '.fnm', 'node-versions'), binSubpath: 'installation/bin/node' },
      { type: 'direct', path: '/opt/homebrew/bin/node' },
      { type: 'direct', path: '/usr/local/bin/node' },
      { type: 'direct', path: path.join(HOME, '.volta', 'bin', 'node') },
    ]
  } else if (process.platform === 'linux') {
    return [
      { type: 'versioned', dir: path.join(HOME, '.nvm', 'versions', 'node'), binSubpath: 'bin/node' },
      { type: 'versioned', dir: path.join(HOME, '.fnm', 'node-versions'), binSubpath: 'installation/bin/node' },
      { type: 'direct', path: '/usr/local/bin/node' },
      { type: 'direct', path: '/usr/bin/node' },
      { type: 'direct', path: path.join(HOME, '.volta', 'bin', 'node') },
    ]
  } else {
    // Windows
    const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')
    return [
      { type: 'versioned', dir: path.join(HOME, 'AppData', 'Roaming', 'nvm'), binSubpath: 'node.exe' },
      { type: 'direct', path: 'C:\\Program Files\\nodejs\\node.exe' },
      { type: 'direct', path: path.join(HOME, '.volta', 'bin', 'node.exe') },
      // Claude Code iex installer bundled node
      { type: 'direct', path: path.join(LOCALAPPDATA, 'Programs', 'claude-code', 'node.exe') },
      { type: 'direct', path: path.join(HOME, '.claude', 'local', 'node.exe') },
      // fnm on Windows
      { type: 'versioned', dir: path.join(LOCALAPPDATA, 'fnm_multishells'), binSubpath: 'node.exe' },
      { type: 'versioned', dir: path.join(HOME, '.fnm', 'node-versions'), binSubpath: 'installation/node.exe' },
    ]
  }
}

/**
 * Compare two semver-like version strings (e.g., "v20.19.3" vs "v18.0.0").
 * Returns positive if a > b, negative if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Find the latest node binary in a versioned directory (e.g., ~/.nvm/versions/node/).
 * Returns the absolute path to the node binary, or null if not found.
 */
export function findLatestInVersionedDir(dir: string, binSubpath: string): string | null {
  try {
    const versions = fs.readdirSync(dir).filter(v => v.startsWith('v'))
    if (versions.length === 0) return null
    versions.sort(compareVersions)
    const latest = versions[versions.length - 1]
    const nodeBin = path.join(dir, latest, binSubpath)
    if (fs.existsSync(nodeBin)) return nodeBin
  } catch { /* directory doesn't exist */ }
  return null
}

/**
 * Scan process.env.PATH for a node binary.
 */
function findNodeInPath(): string | null {
  const pathDirs = (process.env.PATH || '').split(path.delimiter)
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  for (const dir of pathDirs) {
    if (!dir) continue
    const candidate = path.join(dir, nodeName)
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate
      }
    } catch { /* skip */ }
  }
  return null
}

/**
 * Resolve the node binary path.
 * First checks if node is already accessible via process.env.PATH,
 * then falls back to common installation locations.
 */
export function resolveNodePath(): string {
  // 1. Check current PATH
  const fromPath = findNodeInPath()
  if (fromPath) return fromPath

  // 2. Check common installation locations
  for (const entry of getCandidates()) {
    if (entry.type === 'versioned') {
      const found = findLatestInVersionedDir(entry.dir, entry.binSubpath)
      if (found) return found
    } else {
      if (fs.existsSync(entry.path)) return entry.path
    }
  }

  return 'node' // last resort
}

// Lazy cached resolution
let cachedPath: string | null = null

/**
 * Get the resolved node binary path (lazy, cached).
 * First call triggers resolution; subsequent calls return cached result.
 */
export function getNodeExecutable(): string {
  if (cachedPath === null) {
    cachedPath = resolveNodePath()
  }
  return cachedPath
}

/**
 * Get extra bin directories for PATH augmentation (nvm, fnm, etc.).
 * Returns an array of bin directories that contain node.
 *
 * Not used internally — exported for external consumers and testing.
 */
export function getExtraNodePaths(): string[] {
  const extraPaths: string[] = []
  for (const entry of getCandidates()) {
    if (entry.type === 'versioned') {
      const found = findLatestInVersionedDir(entry.dir, entry.binSubpath)
      if (found) extraPaths.push(path.dirname(found))
    }
  }
  return extraPaths
}

/**
 * Reset cached path (for testing only).
 */
export function _resetCache(): void {
  cachedPath = null
}
