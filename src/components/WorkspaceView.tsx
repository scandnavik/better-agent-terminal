import { useEffect, useCallback, useState, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import type { Workspace, TerminalInstance, EnvVariable } from '../types'
import { workspaceStore } from '../stores/workspace-store'
import { settingsStore } from '../stores/settings-store'
import { ThumbnailBar } from './ThumbnailBar'
import { CloseConfirmDialog } from './CloseConfirmDialog'
import { ResizeHandle } from './ResizeHandle'
import { AgentPresetId, getAgentPreset } from '../types/agent-presets'

// Lazy load heavy components (xterm.js, Claude SDK, etc.)
const MainPanel = lazy(() => import('./MainPanel').then(m => ({ default: m.MainPanel })))
const FileTree = lazy(() => import('./FileTree').then(m => ({ default: m.FileTree })))
const GitPanel = lazy(() => import('./GitPanel').then(m => ({ default: m.GitPanel })))
const GitHubPanel = lazy(() => import('./GitHubPanel').then(m => ({ default: m.GitHubPanel })))

type WorkspaceTab = 'terminal' | 'files' | 'git' | 'github'
const TAB_KEY = 'better-terminal-workspace-tab'

function loadWorkspaceTab(): WorkspaceTab {
  try {
    const saved = localStorage.getItem(TAB_KEY)
    if (saved === 'terminal' || saved === 'files' || saved === 'git' || saved === 'github') return saved
  } catch { /* ignore */ }
  return 'terminal'
}

// ThumbnailBar panel settings
const THUMBNAIL_SETTINGS_KEY = 'better-terminal-thumbnail-settings'
const DEFAULT_THUMBNAIL_HEIGHT = 180
const MIN_THUMBNAIL_HEIGHT = 80
const MAX_THUMBNAIL_HEIGHT = 400

interface ThumbnailSettings {
  height: number
  collapsed: boolean
}

function loadThumbnailSettings(): ThumbnailSettings {
  try {
    const saved = localStorage.getItem(THUMBNAIL_SETTINGS_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (e) {
    console.error('Failed to load thumbnail settings:', e)
  }
  return { height: DEFAULT_THUMBNAIL_HEIGHT, collapsed: false }
}

function saveThumbnailSettings(settings: ThumbnailSettings): void {
  try {
    localStorage.setItem(THUMBNAIL_SETTINGS_KEY, JSON.stringify(settings))
  } catch (e) {
    console.error('Failed to save thumbnail settings:', e)
  }
}

interface WorkspaceViewProps {
  workspace: Workspace
  terminals: TerminalInstance[]
  focusedTerminalId: string | null
  isActive: boolean
}

// Helper to get shell path from settings
async function getShellFromSettings(): Promise<string | undefined> {
  const settings = settingsStore.getSettings()
  if (settings.shell === 'custom' && settings.customShellPath) {
    return settings.customShellPath
  }
  return window.electronAPI.settings.getShellPath(settings.shell)
}

// Helper to merge environment variables
function mergeEnvVars(global: EnvVariable[] = [], workspace: EnvVariable[] = []): Record<string, string> {
  const result: Record<string, string> = {}
  // Add global vars first
  for (const env of global) {
    if (env.enabled && env.key) {
      result[env.key] = env.value
    }
  }
  // Workspace vars override global
  for (const env of workspace) {
    if (env.enabled && env.key) {
      result[env.key] = env.value
    }
  }
  return result
}

// Track which workspaces have been initialized (outside component to persist across renders)
const initializedWorkspaces = new Set<string>()

// Allow clearing on profile switch so terminals re-initialize
export function clearInitializedWorkspaces(): void {
  initializedWorkspaces.clear()
}

export function WorkspaceView({ workspace, terminals, focusedTerminalId, isActive }: Readonly<WorkspaceViewProps>) {
  const { t } = useTranslation()
  const [showCloseConfirm, setShowCloseConfirm] = useState<string | null>(null)
  const [thumbnailSettings, setThumbnailSettings] = useState<ThumbnailSettings>(loadThumbnailSettings)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(loadWorkspaceTab)
  const [hasGithubRemote, setHasGithubRemote] = useState(false)

  // Detect GitHub remote
  useEffect(() => {
    window.electronAPI.git.getGithubUrl(workspace.folderPath).then(url => {
      setHasGithubRemote(!!url)
    }).catch(() => setHasGithubRemote(false))
  }, [workspace.folderPath])

  // Fallback if saved tab is 'github' but no GitHub remote
  useEffect(() => {
    if (activeTab === 'github' && !hasGithubRemote) {
      setActiveTab('terminal')
      try { localStorage.setItem(TAB_KEY, 'terminal') } catch { /* ignore */ }
    }
  }, [hasGithubRemote, activeTab])

  const handleTabChange = useCallback((tab: WorkspaceTab) => {
    setActiveTab(tab)
    try { localStorage.setItem(TAB_KEY, tab) } catch { /* ignore */ }
  }, [])

  // Listen for keyboard shortcut events to cycle/switch tabs
  useEffect(() => {
    if (!isActive) return

    const TABS: WorkspaceTab[] = hasGithubRemote ? ['terminal', 'files', 'git', 'github'] : ['terminal', 'files', 'git']

    const handleCycleTab = (e: Event) => {
      const { direction } = (e as CustomEvent).detail as { direction: number }
      setActiveTab(prev => {
        const idx = TABS.indexOf(prev)
        const next = TABS[(idx + direction + TABS.length) % TABS.length]
        try { localStorage.setItem(TAB_KEY, next) } catch { /* ignore */ }
        return next
      })
    }

    const handleSwitchTab = (e: Event) => {
      const { tab } = (e as CustomEvent).detail as { tab: WorkspaceTab }
      setActiveTab(tab)
      try { localStorage.setItem(TAB_KEY, tab) } catch { /* ignore */ }
    }

    window.addEventListener('workspace-cycle-tab', handleCycleTab)
    window.addEventListener('workspace-switch-tab', handleSwitchTab)
    return () => {
      window.removeEventListener('workspace-cycle-tab', handleCycleTab)
      window.removeEventListener('workspace-switch-tab', handleSwitchTab)
    }
  }, [isActive, hasGithubRemote])

  // Handle thumbnail bar resize
  const handleThumbnailResize = useCallback((delta: number) => {
    setThumbnailSettings(prev => {
      // Note: delta is negative when dragging up (making bar taller)
      const newHeight = Math.min(MAX_THUMBNAIL_HEIGHT, Math.max(MIN_THUMBNAIL_HEIGHT, prev.height - delta))
      const updated = { ...prev, height: newHeight }
      saveThumbnailSettings(updated)
      return updated
    })
  }, [])

  // Toggle thumbnail bar collapse
  const handleThumbnailCollapse = useCallback(() => {
    setThumbnailSettings(prev => {
      const updated = { ...prev, collapsed: !prev.collapsed }
      saveThumbnailSettings(updated)
      return updated
    })
    // Trigger resize so terminals/xterm can refit after layout change
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'))
    })
  }, [])

  // Reset thumbnail bar to default height
  const handleThumbnailResetHeight = useCallback(() => {
    setThumbnailSettings(prev => {
      const updated = { ...prev, height: DEFAULT_THUMBNAIL_HEIGHT }
      saveThumbnailSettings(updated)
      return updated
    })
  }, [])

  // Categorize terminals
  const agentTerminal = terminals.find(t => t.agentPreset && t.agentPreset !== 'none')
  const regularTerminals = terminals.filter(t => !t.agentPreset || t.agentPreset === 'none')
  const focusedTerminal = terminals.find(t => t.id === focusedTerminalId)
  const isAgentFocused = focusedTerminal?.agentPreset && focusedTerminal.agentPreset !== 'none'

  // Initialize terminals when workspace becomes active
  // If terminals were restored from a saved profile, start their PTY/agent processes
  // If no terminals exist, create default ones from settings
  useEffect(() => {
    if (!isActive || initializedWorkspaces.has(workspace.id)) return
    initializedWorkspaces.add(workspace.id)

    const initTerminals = async () => {
      const dlog = (...args: unknown[]) => window.electronAPI?.debug?.log(...args)
      const htmlT0 = (window as unknown as { __t0?: number }).__t0 || Date.now()
      dlog(`[startup] initTerminals start: +${Date.now() - htmlT0}ms from HTML`)
      const t0 = performance.now()
      const settings = settingsStore.getSettings()
      const shell = await getShellFromSettings()
      dlog(`[init] getShellFromSettings: ${(performance.now() - t0).toFixed(0)}ms`)
      const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)

      if (terminals.length > 0) {
        // Restored terminals: start PTY processes for non-Claude terminals
        // Claude agent terminals will be started by ClaudeAgentPanel on mount
        for (const terminal of terminals) {
          if (terminal.agentPreset === 'claude-code' || terminal.agentPreset === 'claude-code-v2' || terminal.agentPreset === 'claude-code-worktree') continue
          // claude-cli presets use startClaudeCliPty for bundled CLI + env setup
          if (terminal.agentPreset === 'claude-cli' || terminal.agentPreset === 'claude-cli-worktree') {
            startClaudeCliPty(terminal.id, terminal.cwd || workspace.folderPath, terminal.agentPreset === 'claude-cli-worktree')
            continue
          }
          window.electronAPI.pty.create({
            id: terminal.id,
            cwd: terminal.cwd || workspace.folderPath,
            type: 'terminal',
            agentPreset: terminal.agentPreset,
            shell,
            customEnv
          })
          // Auto-run agent command for non-Claude agents
          if (terminal.agentPreset && terminal.agentPreset !== 'none' && settings.agentAutoCommand) {
            const preset = getAgentPreset(terminal.agentPreset)
            if (preset?.command) {
              setTimeout(() => {
                window.electronAPI.pty.write(terminal.id, preset.command + '\r')
              }, 500)
            }
          }
        }
      } else {
        // No terminals: create defaults from settings
        const terminalCount = settings.defaultTerminalCount || 1
        const createAgentTerminal = settings.createDefaultAgentTerminal === true
        const defaultAgent = createAgentTerminal
          ? (workspace.defaultAgent || settings.defaultAgent || 'claude')
          : 'none'

        if (createAgentTerminal) {
          const agentTerminal = workspaceStore.addTerminal(workspace.id, defaultAgent as AgentPresetId)
          if (defaultAgent === 'claude-cli' || defaultAgent === 'claude-cli-worktree') {
            startClaudeCliPty(agentTerminal.id, workspace.folderPath, defaultAgent === 'claude-cli-worktree')
          } else if (defaultAgent !== 'claude-code' && defaultAgent !== 'claude-code-v2' && defaultAgent !== 'claude-code-worktree') {
            window.electronAPI.pty.create({
              id: agentTerminal.id,
              cwd: workspace.folderPath,
              type: 'terminal',
              agentPreset: defaultAgent as AgentPresetId,
              shell,
              customEnv
            })
            if (settings.agentAutoCommand) {
              const preset = getAgentPreset(defaultAgent)
              if (preset?.command) {
                setTimeout(() => {
                  window.electronAPI.pty.write(agentTerminal.id, preset.command + '\r')
                }, 500)
              }
            }
          }
        }

        for (let i = 0; i < terminalCount; i++) {
          const terminal = workspaceStore.addTerminal(workspace.id)
          window.electronAPI.pty.create({
            id: terminal.id,
            cwd: workspace.folderPath,
            type: 'terminal',
            shell,
            customEnv
          })
        }
        // Persist newly created default terminals
        workspaceStore.save()
      }
      dlog(`[init] initTerminals total: ${(performance.now() - t0).toFixed(0)}ms, terminals=${terminals.length}`)
      dlog(`[startup] initTerminals done: +${Date.now() - htmlT0}ms from HTML`)
    }
    initTerminals()
  }, [isActive, workspace.id, terminals.length, workspace.defaultAgent, workspace.folderPath, workspace.envVars])

  // Set default focus - only for active workspace
  useEffect(() => {
    if (isActive && !focusedTerminalId && terminals.length > 0) {
      // Focus the first terminal (agent or regular)
      const firstTerminal = agentTerminal || terminals[0]
      if (firstTerminal) {
        workspaceStore.setFocusedTerminal(firstTerminal.id)
      }
    }
  }, [isActive, focusedTerminalId, terminals, agentTerminal])

  const handleAddTerminal = useCallback(async () => {
    const terminal = workspaceStore.addTerminal(workspace.id)
    const shell = await getShellFromSettings()
    const settings = settingsStore.getSettings()
    const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)
    window.electronAPI.pty.create({
      id: terminal.id,
      cwd: workspace.folderPath,
      type: 'terminal',
      shell,
      customEnv
    })
    // Focus the new terminal
    workspaceStore.setFocusedTerminal(terminal.id)
    workspaceStore.save()
  }, [workspace.id, workspace.folderPath, workspace.envVars])

  const handleAddClaudeAgent = useCallback(() => {
    const agentTerminal = workspaceStore.addTerminal(workspace.id, 'claude-code' as AgentPresetId)
    // Claude Agent SDK session will be started by ClaudeAgentPanel on mount
    workspaceStore.setFocusedTerminal(agentTerminal.id)
    workspaceStore.save()
  }, [workspace.id])

  const handleAddClaudeAgentV2 = useCallback(() => {
    const agentTerminal = workspaceStore.addTerminal(workspace.id, 'claude-code-v2' as AgentPresetId)
    workspaceStore.setFocusedTerminal(agentTerminal.id)
    workspaceStore.save()
  }, [workspace.id])

  const handleAddClaudeWorktree = useCallback(() => {
    const agentTerminal = workspaceStore.addTerminal(workspace.id, 'claude-code-worktree' as AgentPresetId)
    workspaceStore.setFocusedTerminal(agentTerminal.id)
    workspaceStore.save()
  }, [workspace.id])

  /** Create a claude-cli PTY terminal with bundled CLI, CLAUDE_CODE_NO_FLICKER, and optional worktree */
  const startClaudeCliPty = useCallback(async (terminalId: string, cwd: string, isWorktree: boolean) => {
    const settings = settingsStore.getSettings()
    const shell = await getShellFromSettings()
    const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)
    const cliPath = await window.electronAPI.claude.getCliPath()

    // Set up worktree if needed
    let effectiveCwd = cwd
    if (isWorktree) {
      const wtResult = await window.electronAPI.worktree.create(terminalId, cwd)
      if (wtResult.success && wtResult.worktreePath) {
        effectiveCwd = wtResult.worktreePath
        workspaceStore.setTerminalWorktreeInfo(terminalId, wtResult.worktreePath, wtResult.branchName)
      }
    }

    window.electronAPI.pty.create({
      id: terminalId,
      cwd: effectiveCwd,
      type: 'terminal',
      agentPreset: isWorktree ? 'claude-cli-worktree' as AgentPresetId : 'claude-cli' as AgentPresetId,
      shell,
      customEnv: {
        ...customEnv,
        CLAUDE_CODE_NO_FLICKER: '1',
      }
    })

    // Build CLI command using bundled CLI
    const cmdParts = ['node', `"${cliPath}"`]
    if (settings.allowBypassPermissions) {
      cmdParts.push('--dangerously-skip-permissions')
    }
    const cmd = cmdParts.join(' ')

    setTimeout(() => {
      window.electronAPI.pty.write(terminalId, cmd + '\r')
    }, 500)
  }, [workspace.folderPath, workspace.envVars])

  const handleAddClaudeCli = useCallback(async () => {
    const terminal = workspaceStore.addTerminal(workspace.id, 'claude-cli' as AgentPresetId)
    workspaceStore.setFocusedTerminal(terminal.id)
    workspaceStore.save()
    await startClaudeCliPty(terminal.id, workspace.folderPath, false)
  }, [workspace.id, workspace.folderPath, startClaudeCliPty])

  const handleAddClaudeCliWorktree = useCallback(async () => {
    const terminal = workspaceStore.addTerminal(workspace.id, 'claude-cli-worktree' as AgentPresetId)
    workspaceStore.setFocusedTerminal(terminal.id)
    workspaceStore.save()
    await startClaudeCliPty(terminal.id, workspace.folderPath, true)
  }, [workspace.id, workspace.folderPath, startClaudeCliPty])

  const isDebugMode = window.electronAPI?.debug?.isDebugMode

  const handleCloseTerminal = useCallback((id: string) => {
    const terminal = terminals.find(t => t.id === id)
    // Show confirm for agent terminals
    if (terminal?.agentPreset && terminal.agentPreset !== 'none') {
      setShowCloseConfirm(id)
    } else {
      // Regular terminals always use PTY
      window.electronAPI.pty.kill(id)
      workspaceStore.removeTerminal(id)
      workspaceStore.save()
    }
  }, [terminals])

  const handleConfirmClose = useCallback((cleanWorktree = false) => {
    if (showCloseConfirm) {
      const terminal = terminals.find(t => t.id === showCloseConfirm)
      if (terminal?.agentPreset === 'claude-code' || terminal?.agentPreset === 'claude-code-v2' || terminal?.agentPreset === 'claude-code-worktree') {
        window.electronAPI.claude.stopSession(showCloseConfirm)
        if (cleanWorktree && terminal?.agentPreset === 'claude-code-worktree') {
          window.electronAPI.claude.cleanupWorktree(showCloseConfirm, true)
        }
      } else {
        window.electronAPI.pty.kill(showCloseConfirm)
        // Clean up worktree for claude-cli-worktree preset
        if (cleanWorktree && terminal?.agentPreset === 'claude-cli-worktree') {
          window.electronAPI.worktree.remove(showCloseConfirm, true)
        }
      }
      workspaceStore.removeTerminal(showCloseConfirm)
      workspaceStore.save()
      setShowCloseConfirm(null)
    }
  }, [showCloseConfirm, terminals])

  const handleRestart = useCallback(async (id: string) => {
    const terminal = terminals.find(t => t.id === id)
    if (terminal) {
      if (terminal.agentPreset === 'claude-code' || terminal.agentPreset === 'claude-code-v2' || terminal.agentPreset === 'claude-code-worktree') {
        // Stop and restart Claude session
        await window.electronAPI.claude.stopSession(id)
        await window.electronAPI.claude.startSession(id, {
          cwd: terminal.cwd,
          ...(terminal.agentPreset === 'claude-code-worktree' ? { useWorktree: true, worktreePath: terminal.worktreePath, worktreeBranch: terminal.worktreeBranch } : {}),
        })
      } else if (terminal.agentPreset === 'claude-cli' || terminal.agentPreset === 'claude-cli-worktree') {
        // Restart claude-cli PTY with bundled CLI
        await window.electronAPI.pty.kill(id)
        await startClaudeCliPty(id, terminal.cwd || workspace.folderPath, terminal.agentPreset === 'claude-cli-worktree')
      } else {
        const cwd = await window.electronAPI.pty.getCwd(id) || terminal.cwd
        const shell = await getShellFromSettings()
        await window.electronAPI.pty.restart(id, cwd, shell)
        workspaceStore.updateTerminalCwd(id, cwd)
      }
    }
  }, [terminals])

  const handleSwitchApiVersion = useCallback(async (id: string) => {
    const terminal = terminals.find(t => t.id === id)
    if (!terminal || (terminal.agentPreset !== 'claude-code' && terminal.agentPreset !== 'claude-code-v2')) return
    // Stop current session
    await window.electronAPI.claude.stopSession(id)
    // Switch agentPreset in store
    const newPreset = workspaceStore.switchTerminalApiVersion(id)
    if (!newPreset) return
    const newApiVersion = newPreset === 'claude-code-v2' ? 'v2' as const : 'v1' as const
    // Resume with the same sdkSessionId but new API version
    const sdkSessionId = terminal.sdkSessionId
    if (sdkSessionId) {
      await window.electronAPI.claude.resumeSession(id, sdkSessionId, terminal.cwd, terminal.model, newApiVersion)
    } else {
      await window.electronAPI.claude.startSession(id, { cwd: terminal.cwd, apiVersion: newApiVersion })
    }
    workspaceStore.save()
  }, [terminals])

  const handleFocus = useCallback((id: string) => {
    workspaceStore.setFocusedTerminal(id)
    // Switch back to terminal tab when clicking a terminal thumbnail
    if (activeTab !== 'terminal') {
      handleTabChange('terminal')
    }
  }, [activeTab, handleTabChange])

  const handleReorderTerminals = useCallback((orderedIds: string[]) => {
    workspaceStore.reorderTerminals(orderedIds)
  }, [])

  // Determine what to show
  // mainTerminal: the currently focused or first available terminal
  const mainTerminal = focusedTerminal || agentTerminal || terminals[0]

  // Send content to the active Claude agent session
  const handleSendToClaude = useCallback(async (content: string) => {
    if (!agentTerminal) return false
    await window.electronAPI.claude.sendMessage(agentTerminal.id, content)
    handleTabChange('terminal')
    workspaceStore.setFocusedTerminal(agentTerminal.id)
    return true
  }, [agentTerminal, handleTabChange])

  // Show all terminals in thumbnail bar (clicking switches focus)
  const thumbnailTerminals = terminals

  return (
    <div className="workspace-view">
      {/* Top tab bar: Terminal | Files | Git | GitHub */}
      <div className="workspace-tab-bar">
        <button
          className={`workspace-tab-btn ${activeTab === 'terminal' ? 'active' : ''}`}
          onClick={() => handleTabChange('terminal')}
        >
          {t('workspace.terminal')}
        </button>
        <button
          className={`workspace-tab-btn ${activeTab === 'files' ? 'active' : ''}`}
          onClick={() => handleTabChange('files')}
        >
          {t('workspace.files')}
        </button>
        <button
          className={`workspace-tab-btn ${activeTab === 'git' ? 'active' : ''}`}
          onClick={() => handleTabChange('git')}
        >
          {t('workspace.git')}
        </button>
        {hasGithubRemote && (
          <button
            className={`workspace-tab-btn ${activeTab === 'github' ? 'active' : ''}`}
            onClick={() => handleTabChange('github')}
          >
            {t('workspace.github')}
          </button>
        )}
      </div>

      {/* Main content area - terminals always rendered (keep processes alive) */}
      <Suspense fallback={<div className="loading-panel" />}>
        <div className={`terminals-container ${activeTab !== 'terminal' ? 'hidden' : ''}`}>
          {terminals.map(terminal => (
            <div
              key={terminal.id}
              className={`terminal-wrapper ${terminal.id === mainTerminal?.id ? 'active' : 'hidden'}`}
            >
              <MainPanel
                terminal={terminal}
                isActive={isActive && activeTab === 'terminal' && terminal.id === mainTerminal?.id}
                onClose={handleCloseTerminal}
                onRestart={handleRestart}
                onSwitchApiVersion={handleSwitchApiVersion}
                workspaceId={workspace.id}
              />
            </div>
          ))}
        </div>
      </Suspense>

      {activeTab === 'files' && (
        <Suspense fallback={<div className="loading-panel" />}>
          <div className="workspace-tab-content">
            <FileTree rootPath={workspace.folderPath} />
          </div>
        </Suspense>
      )}

      {activeTab === 'git' && (
        <Suspense fallback={<div className="loading-panel" />}>
          <div className="workspace-tab-content">
            <GitPanel
              workspaceFolderPath={workspace.folderPath}
              worktreePaths={terminals
                .filter(t => t.agentPreset === 'claude-code-worktree' && t.worktreePath)
                .map(t => ({ path: t.worktreePath!, branch: t.worktreeBranch || 'worktree' }))
              }
            />
          </div>
        </Suspense>
      )}

      {activeTab === 'github' && hasGithubRemote && (
        <Suspense fallback={<div className="loading-panel" />}>
          <div className="workspace-tab-content">
            <GitHubPanel workspaceFolderPath={workspace.folderPath} onSendToClaude={handleSendToClaude} />
          </div>
        </Suspense>
      )}

      {/* Resize handle for thumbnail bar */}
      {!thumbnailSettings.collapsed && (
        <ResizeHandle
          direction="vertical"
          onResize={handleThumbnailResize}
          onDoubleClick={handleThumbnailResetHeight}
        />
      )}

      <ThumbnailBar
        terminals={thumbnailTerminals}
        focusedTerminalId={focusedTerminalId}
        onFocus={handleFocus}
        onAddTerminal={handleAddTerminal}
        onAddClaudeAgent={handleAddClaudeAgent}
        onAddClaudeAgentV2={handleAddClaudeAgentV2}
        onAddClaudeWorktree={isDebugMode ? handleAddClaudeWorktree : undefined}
        onAddClaudeCli={handleAddClaudeCli}
        onAddClaudeCliWorktree={isDebugMode ? handleAddClaudeCliWorktree : undefined}
        onReorder={handleReorderTerminals}
        showAddButton={true}
        height={thumbnailSettings.height}
        collapsed={thumbnailSettings.collapsed}
        onCollapse={handleThumbnailCollapse}
      />

      {showCloseConfirm && (
        <CloseConfirmDialog
          onConfirm={() => handleConfirmClose(false)}
          onCancel={() => setShowCloseConfirm(null)}
          isWorktree={['claude-code-worktree', 'claude-cli-worktree'].includes(terminals.find(t => t.id === showCloseConfirm)?.agentPreset || '')}
          onConfirmAndClean={() => handleConfirmClose(true)}
        />
      )}
    </div>
  )
}
