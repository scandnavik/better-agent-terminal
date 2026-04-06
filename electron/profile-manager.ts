import { app } from 'electron'
import path from 'path'
import * as fs from 'fs/promises'
import type { WindowRegistry } from './window-registry'

export interface ProfileEntry {
  id: string
  name: string
  type: 'local' | 'remote'
  remoteHost?: string
  remotePort?: number
  remoteToken?: string
  remoteProfileId?: string  // which profile to load on the remote server
  createdAt: number
  updatedAt: number
}

export interface ProfileIndex {
  profiles: ProfileEntry[]
  activeProfileIds: string[]
  activeProfileId?: string // legacy — migrated to activeProfileIds on read
}

// V1 snapshot (legacy — single window)
export interface ProfileSnapshotV1 {
  id: string
  name: string
  version: 1
  workspaces: unknown[]
  activeWorkspaceId: string | null
  activeGroup: string | null
  terminals?: unknown[]
  activeTerminalId?: string | null
}

// Per-window state within a profile
export interface ProfileWindowSnapshot {
  workspaces: unknown[]
  activeWorkspaceId: string | null
  activeGroup: string | null
  terminals: unknown[]
  activeTerminalId: string | null
  bounds?: { x: number; y: number; width: number; height: number }
}

// V2 snapshot — profile as a set of windows
export interface ProfileSnapshot {
  id: string
  name: string
  version: 2
  windows: ProfileWindowSnapshot[]
}

function getProfilesDir(): string {
  return path.join(app.getPath('userData'), 'profiles')
}

function getIndexPath(): string {
  return path.join(getProfilesDir(), 'index.json')
}

function getProfilePath(id: string): string {
  return path.join(getProfilesDir(), `${id}.json`)
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '') || 'profile'
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(getProfilesDir(), { recursive: true })
}

async function readIndex(): Promise<ProfileIndex> {
  try {
    const data = await fs.readFile(getIndexPath(), 'utf-8')
    const raw = JSON.parse(data)
    // Migrate legacy activeProfileId → activeProfileIds
    if (!raw.activeProfileIds && raw.activeProfileId) {
      raw.activeProfileIds = [raw.activeProfileId]
      delete raw.activeProfileId
    }
    if (!raw.activeProfileIds) {
      raw.activeProfileIds = ['default']
    }
    return raw
  } catch {
    return { profiles: [], activeProfileIds: ['default'] }
  }
}

async function writeIndex(index: ProfileIndex): Promise<void> {
  await ensureDir()
  await fs.writeFile(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8')
}

function migrateSnapshot(raw: ProfileSnapshotV1 | ProfileSnapshot): ProfileSnapshot {
  if ('version' in raw && raw.version === 2) return raw as ProfileSnapshot
  // V1 → V2: wrap flat fields into a single-element windows array
  const v1 = raw as ProfileSnapshotV1
  return {
    id: v1.id,
    name: v1.name,
    version: 2,
    windows: [{
      workspaces: v1.workspaces,
      activeWorkspaceId: v1.activeWorkspaceId,
      activeGroup: v1.activeGroup,
      terminals: v1.terminals || [],
      activeTerminalId: v1.activeTerminalId || null,
    }],
  }
}

async function readSnapshot(id: string): Promise<ProfileSnapshot | null> {
  try {
    const data = await fs.readFile(getProfilePath(id), 'utf-8')
    const raw = JSON.parse(data)
    return migrateSnapshot(raw)
  } catch {
    return null
  }
}

async function writeSnapshot(snapshot: ProfileSnapshot): Promise<void> {
  await ensureDir()
  await fs.writeFile(getProfilePath(snapshot.id), JSON.stringify(snapshot, null, 2), 'utf-8')
}

// Initialize on first use: create default profile from current workspaces.json
async function ensureInitialized(): Promise<ProfileIndex> {
  const index = await readIndex()
  if (index.profiles.length > 0) return index

  // First time: create default profile from existing workspaces
  const now = Date.now()
  const defaultEntry: ProfileEntry = {
    id: 'default',
    name: 'Default',
    type: 'local',
    createdAt: now,
    updatedAt: now,
  }

  // Read current workspaces.json to seed the default profile
  let workspacesData: { workspaces: unknown[]; activeWorkspaceId: string | null; activeGroup: string | null; terminals?: unknown[]; activeTerminalId?: string | null } = {
    workspaces: [],
    activeWorkspaceId: null,
    activeGroup: null,
    terminals: [],
    activeTerminalId: null,
  }
  try {
    const raw = await fs.readFile(path.join(app.getPath('userData'), 'workspaces.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    workspacesData = {
      workspaces: parsed.workspaces || [],
      activeWorkspaceId: parsed.activeWorkspaceId || null,
      activeGroup: parsed.activeGroup || null,
      terminals: parsed.terminals || [],
      activeTerminalId: parsed.activeTerminalId || null,
    }
  } catch { /* no existing workspaces */ }

  const snapshot: ProfileSnapshot = {
    id: 'default',
    name: 'Default',
    version: 2,
    windows: [{
      workspaces: workspacesData.workspaces,
      activeWorkspaceId: workspacesData.activeWorkspaceId,
      activeGroup: workspacesData.activeGroup,
      terminals: workspacesData.terminals || [],
      activeTerminalId: workspacesData.activeTerminalId || null,
    }],
  }

  const newIndex: ProfileIndex = {
    profiles: [defaultEntry],
    activeProfileIds: ['default'],
  }

  await writeSnapshot(snapshot)
  await writeIndex(newIndex)
  return newIndex
}

export class ProfileManager {
  private windowRegistry: WindowRegistry | null = null

  setWindowRegistry(registry: WindowRegistry): void {
    this.windowRegistry = registry
  }

  async list(): Promise<{ profiles: ProfileEntry[]; activeProfileIds: string[] }> {
    const index = await ensureInitialized()
    return { profiles: index.profiles, activeProfileIds: index.activeProfileIds }
  }

  async create(name: string, options?: { type?: 'local' | 'remote'; remoteHost?: string; remotePort?: number; remoteToken?: string; remoteProfileId?: string }): Promise<ProfileEntry> {
    const index = await ensureInitialized()
    let id = toSlug(name)
    // Ensure unique ID
    if (index.profiles.some(p => p.id === id)) {
      id = `${id}-${Date.now()}`
    }

    const now = Date.now()
    const entry: ProfileEntry = {
      id,
      name,
      type: options?.type || 'local',
      remoteHost: options?.remoteHost,
      remotePort: options?.remotePort,
      remoteToken: options?.remoteToken,
      remoteProfileId: options?.remoteProfileId,
      createdAt: now,
      updatedAt: now,
    }

    // Only create snapshot for local profiles
    if (entry.type === 'local') {
      const snapshot: ProfileSnapshot = {
        id,
        name,
        version: 2,
        windows: [],
      }
      await writeSnapshot(snapshot)
    }

    index.profiles.push(entry)
    await writeIndex(index)
    return entry
  }

  // Save all windows belonging to this profile into its snapshot
  async save(profileId: string): Promise<boolean> {
    const index = await ensureInitialized()
    const entry = index.profiles.find(p => p.id === profileId)
    if (!entry) return false
    if (!this.windowRegistry) return false

    const allWindows = await this.windowRegistry.readAll()
    const profileWindows = allWindows.filter(w => w.profileId === profileId)

    // If no windows are currently open for this profile, keep existing snapshot
    if (profileWindows.length === 0) return false

    const windowSnapshots: ProfileWindowSnapshot[] = profileWindows.map(w => ({
      workspaces: w.workspaces,
      activeWorkspaceId: w.activeWorkspaceId,
      activeGroup: w.activeGroup,
      terminals: w.terminals,
      activeTerminalId: w.activeTerminalId,
      bounds: w.bounds,
    }))

    const snapshot: ProfileSnapshot = {
      id: profileId,
      name: entry.name,
      version: 2,
      windows: windowSnapshots,
    }

    await writeSnapshot(snapshot)
    entry.updatedAt = Date.now()
    await writeIndex(index)
    return true
  }

  // Load a profile snapshot (pure read, no side effects)
  async loadSnapshot(profileId: string): Promise<ProfileSnapshot | null> {
    const index = await ensureInitialized()
    if (!index.profiles.some(p => p.id === profileId)) return null
    return readSnapshot(profileId)
  }

  // Load a profile: mark as active and return snapshot (window creation handled by caller)
  async load(profileId: string): Promise<ProfileSnapshot | null> {
    const snapshot = await this.loadSnapshot(profileId)
    if (!snapshot) return null

    // Add to active profiles
    await this.activateProfile(profileId)

    return snapshot
  }

  async delete(profileId: string): Promise<boolean> {
    if (profileId === 'default') return false // Cannot delete default

    const index = await ensureInitialized()
    const idx = index.profiles.findIndex(p => p.id === profileId)
    if (idx === -1) return false

    index.profiles.splice(idx, 1)

    // Remove from active profiles if present
    index.activeProfileIds = index.activeProfileIds.filter(id => id !== profileId)

    await writeIndex(index)

    // Remove snapshot file
    try { await fs.unlink(getProfilePath(profileId)) } catch { /* ignore */ }

    return true
  }

  async rename(profileId: string, newName: string): Promise<boolean> {
    const index = await ensureInitialized()
    const entry = index.profiles.find(p => p.id === profileId)
    if (!entry) return false

    entry.name = newName
    entry.updatedAt = Date.now()
    await writeIndex(index)

    // Also update snapshot name
    const snapshot = await readSnapshot(profileId)
    if (snapshot) {
      snapshot.name = newName
      await writeSnapshot(snapshot)
    }

    return true
  }

  async duplicate(profileId: string, newName: string): Promise<ProfileEntry | null> {
    const snapshot = await readSnapshot(profileId)
    if (!snapshot) return null

    const entry = await this.create(newName)

    // Copy workspace data from source
    const newSnapshot: ProfileSnapshot = {
      ...snapshot,
      id: entry.id,
      name: newName,
    }
    await writeSnapshot(newSnapshot)

    return entry
  }

  async update(profileId: string, updates: { remoteHost?: string; remotePort?: number; remoteToken?: string; remoteProfileId?: string }): Promise<boolean> {
    const index = await ensureInitialized()
    const entry = index.profiles.find(p => p.id === profileId)
    if (!entry) return false

    if (updates.remoteHost !== undefined) entry.remoteHost = updates.remoteHost
    if (updates.remotePort !== undefined) entry.remotePort = updates.remotePort
    if (updates.remoteToken !== undefined) entry.remoteToken = updates.remoteToken
    if (updates.remoteProfileId !== undefined) entry.remoteProfileId = updates.remoteProfileId
    entry.updatedAt = Date.now()
    await writeIndex(index)
    return true
  }

  async getProfile(profileId: string): Promise<ProfileEntry | null> {
    const index = await ensureInitialized()
    return index.profiles.find(p => p.id === profileId) || null
  }

  async getActiveProfileIds(): Promise<string[]> {
    const index = await ensureInitialized()
    return index.activeProfileIds
  }

  async activateProfile(profileId: string): Promise<void> {
    const index = await ensureInitialized()
    if (!index.activeProfileIds.includes(profileId)) {
      index.activeProfileIds.push(profileId)
      await writeIndex(index)
    }
  }

  async deactivateProfile(profileId: string): Promise<void> {
    const index = await ensureInitialized()
    index.activeProfileIds = index.activeProfileIds.filter(id => id !== profileId)
    await writeIndex(index)
  }
}
