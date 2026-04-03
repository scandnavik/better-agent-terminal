export type RemoteFrameType = 'invoke' | 'invoke-result' | 'invoke-error' | 'event' | 'auth' | 'auth-result' | 'ping' | 'pong'

export interface RemoteFrame {
  type: RemoteFrameType
  id: string
  channel?: string
  args?: unknown[]
  result?: unknown
  error?: string
  token?: string
}

// Channels proxied to remote host
export const PROXIED_CHANNELS = new Set([
  // PTY
  'pty:create', 'pty:write', 'pty:resize', 'pty:kill', 'pty:restart', 'pty:get-cwd',
  // Claude
  'claude:start-session', 'claude:send-message', 'claude:stop-session',
  'claude:set-permission-mode', 'claude:set-model', 'claude:set-effort', 'claude:reset-session',
  'claude:get-supported-models', 'claude:get-account-info', 'claude:get-supported-commands', 'claude:get-supported-agents', 'claude:get-session-meta',
  'claude:get-worktree-status', 'claude:cleanup-worktree',
  'claude:resolve-permission', 'claude:resolve-ask-user',
  'claude:list-sessions', 'claude:resume-session', 'claude:fork-session', 'claude:stop-task', 'claude:rest-session',
  'claude:wake-session', 'claude:is-resting',
  'claude:archive-messages', 'claude:load-archived', 'claude:clear-archive', 'claude:fetch-subagent-messages',
  'claude:get-usage', 'claude:get-usage-account',
  'claude:scan-skills', 'claude:get-context-usage',
  'claude:auth-login', 'claude:auth-status', 'claude:auth-logout',
  'claude:get-cli-path',
  // Standalone worktree operations (for claude-cli preset)
  'worktree:create', 'worktree:remove', 'worktree:status', 'worktree:merge', 'worktree:rehydrate',
  // Workspace
  'workspace:save', 'workspace:load',
  // Settings
  'settings:save', 'settings:load', 'settings:get-shell-path',
  // GitHub
  'github:check-cli', 'github:pr-list', 'github:issue-list', 'github:pr-view', 'github:issue-view',
  'github:pr-comment', 'github:issue-comment',
  // Git
  'git:branch', 'git:log', 'git:diff', 'git:diff-files', 'git:status', 'git:get-github-url', 'git:getRoot',
  // FS
  'fs:readdir', 'fs:readFile', 'fs:search', 'fs:watch', 'fs:unwatch',
  // Snippet
  'snippet:getAll', 'snippet:getById', 'snippet:create', 'snippet:update',
  'snippet:delete', 'snippet:toggleFavorite', 'snippet:search',
  'snippet:getCategories', 'snippet:getFavorites', 'snippet:getByWorkspace',
  // Profile
  'profile:list', 'profile:load', 'profile:get-active-ids', 'profile:activate', 'profile:deactivate',
])

// Events pushed from host to remote clients
export const PROXIED_EVENTS = new Set([
  'pty:output', 'pty:exit',
  'claude:message', 'claude:tool-use', 'claude:tool-result',
  'claude:stream', 'claude:result', 'claude:error',
  'claude:status', 'claude:permission-request', 'claude:permission-resolved', 'claude:ask-user', 'claude:ask-user-resolved',
  'claude:modeChange', 'claude:history', 'claude:prompt-suggestion', 'claude:session-reset', 'claude:worktree-info',
  'fs:changed',
  'workspace:detached', 'workspace:reattached',
  'system:resume',
])
