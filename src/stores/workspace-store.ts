import { v4 as uuidv4 } from 'uuid'
import type { Workspace, TerminalInstance, AppState } from '../types'
import { AgentPresetId, getAgentPreset } from '../types/agent-presets'
import { clearPreviewCache } from '../components/TerminalThumbnail'
import { settingsStore } from './settings-store'

type Listener = () => void

class WorkspaceStore {
  private state: AppState = {
    workspaces: [],
    activeWorkspaceId: null,
    terminals: [],
    activeTerminalId: null,
    focusedTerminalId: null
  }

  private activeGroup: string | null = null
  private windowId: string | null = null
  private listeners: Set<Listener> = new Set()

  // Global Claude usage (shared across all panels)
  // Adaptive polling: backs off on rate limits, pauses when hidden, refreshes on focus
  private _claudeUsage: { fiveHour: number | null; sevenDay: number | null; fiveHourReset: string | null; sevenDayReset: string | null; fiveHourStale?: boolean } | null = null
  private _usageAccount: { email: string; orgName: string; tier: string } | null = null
  private _usageTimer: ReturnType<typeof setTimeout> | null = null
  private _usagePollingStarted = false
  private _usageInflight = false
  private _usageRateLimited = false                 // true while in rate-limit backoff — blocks refreshUsageNow
  private _usageRateLimitStreak = 0                 // consecutive 429s — drives cumulative backoff (60s × 2^streak, streak capped at 3 → max 480s)
  private _usageBaseInterval = 120 * 1000            // 2 min normal
  private _usageCurrentInterval = 120 * 1000
  private _usageMinInterval = 60 * 1000             // 1 min min (after activity)
  private _fiveHourStaleTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly _USAGE_CACHE_KEY = 'bat_claude_usage_cache'
  private static readonly _FIVE_HOUR_STALE_MS = 10 * 60 * 1000  // 10 min without fresh data → mark stale
  private _visibilityHandler: (() => void) | null = null

  get claudeUsage() { return this._claudeUsage }
  get usageAccount() { return this._usageAccount }

  /** Pacing analysis for 5h window: compare utilization vs time elapsed %.
   *  Returns null if data is insufficient. */
  getUsagePacing(): { onPace: boolean; timeElapsedPct: number; estimatedMinutesToLimit: number | null } | null {
    const u = this._claudeUsage
    if (!u || u.fiveHour == null || !u.fiveHourReset) return null
    const now = Date.now()
    const resetMs = new Date(u.fiveHourReset).getTime()
    const periodMs = 5 * 3_600_000
    const remainingMs = Math.max(0, resetMs - now)
    const elapsedMs = periodMs - remainingMs
    if (elapsedMs <= 0) return null
    const timeElapsedPct = (elapsedMs / periodMs) * 100
    const onPace = u.fiveHour <= timeElapsedPct
    let estimatedMinutesToLimit: number | null = null
    if (u.fiveHour > 0) {
      const ratePerMs = u.fiveHour / elapsedMs
      if (ratePerMs > 0) {
        const remainingPct = 100 - u.fiveHour
        const remainingMin = Math.round(remainingMs / 60_000)
        estimatedMinutesToLimit = Math.min(Math.round(remainingPct / ratePerMs / 60_000), remainingMin)
      }
    }
    return { onPace, timeElapsedPct, estimatedMinutesToLimit }
  }

  private _persistUsage() {
    if (!this._claudeUsage) return
    try {
      const { fiveHourStale: _, ...data } = this._claudeUsage
      localStorage.setItem(WorkspaceStore._USAGE_CACHE_KEY, JSON.stringify({ ...data, savedAt: new Date().toISOString() }))
    } catch { /* quota exceeded — non-fatal */ }
  }

  private _loadPersistedUsage() {
    try {
      const raw = localStorage.getItem(WorkspaceStore._USAGE_CACHE_KEY)
      if (!raw) return
      const cached = JSON.parse(raw) as { fiveHour: number | null; sevenDay: number | null; fiveHourReset: string | null; sevenDayReset: string | null }
      const now = Date.now()
      const fiveExpired = cached.fiveHourReset ? now > new Date(cached.fiveHourReset).getTime() : false
      const sevenExpired = cached.sevenDayReset ? now > new Date(cached.sevenDayReset).getTime() : false
      this._claudeUsage = {
        fiveHour:      fiveExpired  ? null : cached.fiveHour,
        fiveHourReset: fiveExpired  ? null : cached.fiveHourReset,
        sevenDay:      sevenExpired ? null : cached.sevenDay,
        sevenDayReset: sevenExpired ? null : cached.sevenDayReset,
        fiveHourStale: false,
      }
      this.notify()
    } catch { /* corrupt cache — ignore */ }
  }

  private _startStaleTimer() {
    if (this._fiveHourStaleTimer) return  // already running
    this._fiveHourStaleTimer = setTimeout(() => {
      this._fiveHourStaleTimer = null
      if (this._claudeUsage) {
        this._claudeUsage = { ...this._claudeUsage, fiveHourStale: true }
        this.notify()
      }
    }, WorkspaceStore._FIVE_HOUR_STALE_MS)
  }

  private _clearStaleTimer() {
    if (this._fiveHourStaleTimer) {
      clearTimeout(this._fiveHourStaleTimer)
      this._fiveHourStaleTimer = null
    }
  }

  private async _fetchUsage() {
    if (this._usageInflight) return
    this._usageInflight = true
    try {
      const u = await window.electronAPI.claude.getUsage()
      if (!u) return

      // Handle rate-limit response — cumulative backoff: 60s × 2^streak, streak capped at 3
      if ('rateLimited' in u && (u as any).rateLimited) {
        this._usageRateLimitStreak++
        this._usageRateLimited = true
        const exp = Math.min(this._usageRateLimitStreak, 3)
        this._usageCurrentInterval = 60_000 * Math.pow(2, exp)
        this._startStaleTimer()
        return
      }

      // Success — reset streak, interval, stale state
      this._usageRateLimitStreak = 0
      this._usageRateLimited = false
      this._usageCurrentInterval = this._usageBaseInterval
      this._clearStaleTimer()
      this._claudeUsage = { ...u, fiveHourStale: false }
      this._persistUsage()
      this.notify()
    } catch {
      // Network error — same cumulative backoff as rate-limit
      this._usageRateLimitStreak++
      this._usageRateLimited = true
      const exp = Math.min(this._usageRateLimitStreak, 3)
      this._usageCurrentInterval = 60_000 * Math.pow(2, exp)
      this._startStaleTimer()
    } finally {
      this._usageInflight = false
    }
  }

  private _scheduleNextPoll() {
    if (this._usageTimer) clearTimeout(this._usageTimer)
    this._usageTimer = setTimeout(async () => {
      await this._fetchUsage()
      this._scheduleNextPoll()
    }, this._usageCurrentInterval)
  }

  startUsagePolling() {
    if (this._usagePollingStarted) return
    this._usagePollingStarted = true

    // Restore persisted usage immediately so UI doesn't flash empty on startup
    this._loadPersistedUsage()

    // Fetch account info once (org name, email, plan tier for tooltip)
    window.electronAPI.claude.getUsageAccount().then(info => {
      if (info) { this._usageAccount = info; this.notify() }
    }).catch(() => {})

    // Initial fetch
    this._fetchUsage().then(() => this._scheduleNextPoll())

    // Visibility-aware: pause when hidden, immediate refresh on focus
    this._visibilityHandler = () => {
      if (document.hidden) {
        // Pause polling when tab/window is hidden
        if (this._usageTimer) {
          clearTimeout(this._usageTimer)
          this._usageTimer = null
        }
      } else {
        // Window regained focus — fetch immediately then resume schedule
        this._fetchUsage().then(() => this._scheduleNextPoll())
      }
    }
    document.addEventListener('visibilitychange', this._visibilityHandler)
  }

  /** Call after agent activity (turn completed, session ended) for a timely refresh */
  refreshUsageNow() {
    if (!this._usagePollingStarted) return
    if (this._usageRateLimited) return  // don't hammer during backoff
    // Use shorter interval temporarily after activity
    this._usageCurrentInterval = this._usageMinInterval
    this._fetchUsage().then(() => this._scheduleNextPoll())
  }

  getState(): AppState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(listener => listener())
  }

  // Workspace actions
  addWorkspace(name: string, folderPath: string): Workspace {
    const workspace: Workspace = {
      id: uuidv4(),
      name,
      folderPath,
      createdAt: Date.now()
    }

    this.state = {
      ...this.state,
      workspaces: [...this.state.workspaces, workspace],
      activeWorkspaceId: workspace.id
    }

    this.notify()
    return workspace
  }

  removeWorkspace(id: string): void {
    const terminals = this.state.terminals.filter(t => t.workspaceId !== id)
    const workspaces = this.state.workspaces.filter(w => w.id !== id)

    this.state = {
      ...this.state,
      workspaces,
      terminals,
      activeWorkspaceId: this.state.activeWorkspaceId === id
        ? (workspaces[0]?.id ?? null)
        : this.state.activeWorkspaceId
    }

    this.notify()
  }

  setActiveWorkspace(id: string): void {
    if (this.state.activeWorkspaceId === id) return

    this.state = {
      ...this.state,
      activeWorkspaceId: id,
      focusedTerminalId: null
    }

    this.notify()
  }

  renameWorkspace(id: string, alias: string): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, alias: alias.trim() || undefined } : w
      )
    }

    this.notify()
  }

  reorderWorkspaces(workspaceIds: string[]): void {
    const workspaceMap = new Map(this.state.workspaces.map(w => [w.id, w]))
    const reordered = workspaceIds
      .map(id => workspaceMap.get(id))
      .filter((w): w is Workspace => w !== undefined)

    this.state = {
      ...this.state,
      workspaces: reordered
    }

    this.notify()
    this.save()
  }

  // Workspace environment variables
  setWorkspaceEnvVars(id: string, envVars: import('../types').EnvVariable[]): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, envVars } : w
      )
    }
    this.notify()
    this.save()
  }

  addWorkspaceEnvVar(id: string, envVar: import('../types').EnvVariable): void {
    const workspace = this.state.workspaces.find(w => w.id === id)
    if (!workspace) return
    const envVars = [...(workspace.envVars || []), envVar]
    this.setWorkspaceEnvVars(id, envVars)
  }

  removeWorkspaceEnvVar(id: string, key: string): void {
    const workspace = this.state.workspaces.find(w => w.id === id)
    if (!workspace) return
    const envVars = (workspace.envVars || []).filter(e => e.key !== key)
    this.setWorkspaceEnvVars(id, envVars)
  }

  updateWorkspaceEnvVar(id: string, key: string, updates: Partial<import('../types').EnvVariable>): void {
    const workspace = this.state.workspaces.find(w => w.id === id)
    if (!workspace) return
    const envVars = (workspace.envVars || []).map(e =>
      e.key === key ? { ...e, ...updates } : e
    )
    this.setWorkspaceEnvVars(id, envVars)
  }

  // SDK session persistence — per terminal
  setTerminalSdkSessionId(terminalId: string, sdkSessionId: string | undefined): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, sdkSessionId } : t
      )
    }
    this.notify()
    this.save()
  }

  setTerminalSessionMeta(terminalId: string, meta: { totalCost: number; inputTokens: number; outputTokens: number; durationMs: number; numTurns: number; contextWindow: number; cacheReadTokens?: number; cacheCreationTokens?: number }): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, sessionMeta: meta } : t
      )
    }
    // Don't notify — this is a background persistence update, no UI re-render needed
    this.save()
  }

  setTerminalPendingPrompt(terminalId: string, prompt: string, images?: string[]): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === terminalId ? { ...t, pendingPrompt: prompt, pendingImages: images } : t
      )
    }
    this.notify()
  }

  // Legacy: also store on workspace for backwards compatibility
  setLastSdkSessionId(workspaceId: string, sdkSessionId: string): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === workspaceId ? { ...w, lastSdkSessionId: sdkSessionId } : w
      )
    }
    this.notify()
    this.save()
  }

  // Terminal actions
  addTerminal(workspaceId: string, agentPreset?: AgentPresetId): TerminalInstance {
    const workspace = this.state.workspaces.find(w => w.id === workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const existingTerminals = this.state.terminals.filter(
      t => t.workspaceId === workspaceId && !t.agentPreset
    )

    // Get agent preset info for title
    const preset = agentPreset ? getAgentPreset(agentPreset) : null
    const title = preset && preset.id !== 'none'
      ? preset.name
      : 'New Terminal'

    const terminal: TerminalInstance = {
      id: uuidv4(),
      workspaceId,
      type: 'terminal',
      agentPreset,
      title,
      cwd: workspace.folderPath,
      scrollbackBuffer: [],
      lastActivityTime: Date.now()
    }

    // Auto-focus if it's an agent terminal or no current focus
    const shouldFocus = (agentPreset && agentPreset !== 'none') || !this.state.focusedTerminalId

    this.state = {
      ...this.state,
      terminals: [...this.state.terminals, terminal],
      focusedTerminalId: shouldFocus ? terminal.id : this.state.focusedTerminalId
    }

    this.notify()
    return terminal
  }

  removeTerminal(id: string): void {
    clearPreviewCache(id)
    const terminals = this.state.terminals.filter(t => t.id !== id)

    this.state = {
      ...this.state,
      terminals,
      focusedTerminalId: this.state.focusedTerminalId === id
        ? (terminals[0]?.id ?? null)
        : this.state.focusedTerminalId
    }

    this.notify()
  }

  switchTerminalApiVersion(id: string): 'claude-code' | 'claude-code-v2' | null {
    const terminal = this.state.terminals.find(t => t.id === id)
    if (!terminal) return null
    const newPreset = terminal.agentPreset === 'claude-code' ? 'claude-code-v2' as const : 'claude-code' as const
    const newTitle = newPreset === 'claude-code-v2' ? 'Claude Code V2' : 'Claude Code'
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, agentPreset: newPreset, title: t.alias || newTitle } : t
      )
    }
    this.notify()
    return newPreset
  }

  renameTerminal(id: string, title: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, title } : t
      )
    }

    this.notify()
  }

  setFocusedTerminal(id: string | null): void {
    if (this.state.focusedTerminalId === id) return

    this.state = {
      ...this.state,
      focusedTerminalId: id
    }

    this.notify()
  }

  updateTerminalCwd(id: string, cwd: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, cwd } : t
      )
    }

    this.notify()
  }

  updateTerminalModel(id: string, model: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, model } : t
      )
    }

    this.notify()
    this.save()
  }

  appendScrollback(id: string, data: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, scrollbackBuffer: [...t.scrollbackBuffer, data] } : t
      )
    }
    // Don't notify for scrollback updates to avoid re-renders
  }

  clearScrollback(id: string): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, scrollbackBuffer: [] } : t
      )
    }

    this.notify()
  }

  reorderTerminals(terminalIds: string[]): void {
    const terminalMap = new Map(this.state.terminals.map(t => [t.id, t]))
    const reordered = terminalIds
      .map(id => terminalMap.get(id))
      .filter((t): t is TerminalInstance => t !== undefined)

    // Append any terminals not in the provided list (e.g. from other workspaces)
    for (const t of this.state.terminals) {
      if (!terminalIds.includes(t.id)) {
        reordered.push(t)
      }
    }

    this.state = {
      ...this.state,
      terminals: reordered
    }

    this.notify()
    this.save()
  }

  // Get terminals for current workspace
  getWorkspaceTerminals(workspaceId: string): TerminalInstance[] {
    return this.state.terminals.filter(t => t.workspaceId === workspaceId)
  }

  // Get agent terminal for workspace (first agent terminal, regardless of type)
  getAgentTerminal(workspaceId: string): TerminalInstance | undefined {
    return this.state.terminals.find(
      t => t.workspaceId === workspaceId && t.agentPreset && t.agentPreset !== 'none'
    )
  }

  // Legacy compatibility - alias for getAgentTerminal
  getClaudeCodeTerminal(workspaceId: string): TerminalInstance | undefined {
    return this.getAgentTerminal(workspaceId)
  }

  getRegularTerminals(workspaceId: string): TerminalInstance[] {
    return this.state.terminals.filter(
      t => t.workspaceId === workspaceId && (!t.agentPreset || t.agentPreset === 'none')
    )
  }

  // Group management
  getActiveGroup(): string | null {
    return this.activeGroup
  }

  setActiveGroup(group: string | null): void {
    this.activeGroup = group

    // Auto-select first workspace in the group if current is not visible
    if (group) {
      const visibleWorkspaces = this.state.workspaces.filter(w => w.group === group)
      const currentVisible = visibleWorkspaces.some(w => w.id === this.state.activeWorkspaceId)
      if (!currentVisible && visibleWorkspaces.length > 0) {
        this.state = {
          ...this.state,
          activeWorkspaceId: visibleWorkspaces[0].id,
          focusedTerminalId: null
        }
      } else {
        // Force new reference so React re-renders the sidebar filter
        this.state = { ...this.state }
      }
    } else {
      this.state = { ...this.state }
    }

    this.notify()
    this.save()
  }

  setWorkspaceGroup(id: string, group: string | undefined): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, group } : w
      )
    }
    this.notify()
    this.save()
  }

  setWorkspaceColor(id: string, color: string | undefined): void {
    this.state = {
      ...this.state,
      workspaces: this.state.workspaces.map(w =>
        w.id === id ? { ...w, color } : w
      )
    }
    this.notify()
    this.save()
  }

  getGroups(): string[] {
    const groups = new Set<string>()
    for (const w of this.state.workspaces) {
      if (w.group) groups.add(w.group)
    }
    return Array.from(groups).sort()
  }

  // Activity tracking
  private lastActivityNotify: number = 0
  private _savePromise: Promise<void> = Promise.resolve()
  private _savePending = false

  updateTerminalActivity(id: string): void {
    const now = Date.now()
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, lastActivityTime: now } : t
      )
    }
    // Throttle notifications to avoid excessive re-renders (max once per 500ms)
    if (now - this.lastActivityNotify > 500) {
      this.lastActivityNotify = now
      this.notify()
    }
  }

  setTerminalPendingAction(id: string, pending: boolean): void {
    this.state = {
      ...this.state,
      terminals: this.state.terminals.map(t =>
        t.id === id ? { ...t, hasPendingAction: pending } : t
      )
    }
    this.notify()
    this.updateDockBadge()
  }

  private updateDockBadge(): void {
    const settings = settingsStore.getSettings()
    if (settings.showDockBadge === false) return
    const count = this.state.terminals.filter(t => t.hasPendingAction).length
    window.electronAPI?.app?.setDockBadge?.(count)
  }

  getWorkspaceLastActivity(workspaceId: string): number | null {
    const terminals = this.getWorkspaceTerminals(workspaceId)
    const lastActivities = terminals
      .map(t => t.lastActivityTime)
      .filter((time): time is number => time !== undefined)

    return lastActivities.length > 0 ? Math.max(...lastActivities) : null
  }

  // Window identity for cross-window drag
  setWindowId(id: string): void { this.windowId = id }
  getWindowId(): string | null { return this.windowId }

  listenForReload(): () => void {
    return window.electronAPI.workspace.onReload(() => {
      this.load()
    })
  }

  // Persistence — serialized to prevent concurrent writes from corrupting the file
  async save(): Promise<void> {
    // If a save is already queued, skip — the queued save will capture the latest state
    if (this._savePending) return
    this._savePending = true

    // Wait for any in-flight save to finish, then perform ours
    this._savePromise = this._savePromise.then(async () => {
      this._savePending = false
      const savedTerminals = this.state.terminals.map(t => ({
        id: t.id,
        workspaceId: t.workspaceId,
        type: t.type,
        agentPreset: t.agentPreset,
        title: t.title,
        alias: t.alias,
        cwd: t.cwd,
        sdkSessionId: t.sdkSessionId,
        model: t.model,
        sessionMeta: t.sessionMeta,
      }))
      const data = JSON.stringify({
        workspaces: this.state.workspaces,
        activeWorkspaceId: this.state.activeWorkspaceId,
        activeGroup: this.activeGroup,
        terminals: savedTerminals,
        activeTerminalId: this.state.activeTerminalId,
      })
      await window.electronAPI.workspace.save(data)
    }).catch(e => {
      console.error('Failed to save workspace data:', e)
    })

    return this._savePromise
  }

  async load(): Promise<void> {
    const data = await window.electronAPI.workspace.load()
    if (data) {
      try {
        const parsed = JSON.parse(data)
        // Restore terminals with empty runtime fields
        const workspaces: Workspace[] = parsed.workspaces || []
        const workspaceMap = new Map(workspaces.map((w: Workspace) => [w.id, w]))
        const terminals: TerminalInstance[] = (parsed.terminals || []).map((t: Partial<TerminalInstance>) => {
          const ws = t.workspaceId ? workspaceMap.get(t.workspaceId) : undefined
          const cwd = t.cwd || ws?.folderPath || ''
          if (!cwd) {
            window.electronAPI?.debug?.log?.(`[workspace-store] Warning: terminal ${t.id} has no cwd and no workspace folderPath`)
          }
          return {
            id: t.id || '',
            workspaceId: t.workspaceId || '',
            type: 'terminal' as const,
            agentPreset: t.agentPreset,
            title: t.title || 'Terminal',
            alias: t.alias,
            cwd,
            sdkSessionId: t.sdkSessionId,
            model: t.model,
            sessionMeta: t.sessionMeta,
            scrollbackBuffer: [],
            pid: undefined,
          }
        })
        this.state = {
          ...this.state,
          workspaces,
          activeWorkspaceId: parsed.activeWorkspaceId || null,
          terminals,
          activeTerminalId: parsed.activeTerminalId || null,
        }
        this.activeGroup = parsed.activeGroup || null
        this.notify()
      } catch (e) {
        window.electronAPI?.debug?.log?.(`Failed to parse workspace data: ${e}`)
        console.error('Failed to parse workspace data:', e)
      }
    }
  }
}

export const workspaceStore = new WorkspaceStore()
