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
  'claude:set-permission-mode', 'claude:set-model', 'claude:set-effort', 'claude:set-1m-context', 'claude:reset-session',
  'claude:get-supported-models', 'claude:get-account-info', 'claude:get-supported-commands', 'claude:get-session-meta',
  'claude:resolve-permission', 'claude:resolve-ask-user',
  'claude:list-sessions', 'claude:resume-session', 'claude:fork-session', 'claude:stop-task', 'claude:rest-session',
  'claude:wake-session', 'claude:is-resting',
  'claude:archive-messages', 'claude:load-archived', 'claude:clear-archive',
  'claude:get-usage',
  // Workspace
  'workspace:save', 'workspace:load',
  // Settings
  'settings:save', 'settings:load', 'settings:get-shell-path',
  // Git
  'git:branch', 'git:log', 'git:diff', 'git:diff-files', 'git:status', 'git:get-github-url', 'git:getRoot',
  // FS
  'fs:readdir', 'fs:readFile', 'fs:search',
  // Snippet
  'snippet:getAll', 'snippet:getById', 'snippet:create', 'snippet:update',
  'snippet:delete', 'snippet:toggleFavorite', 'snippet:search',
  'snippet:getCategories', 'snippet:getFavorites',
  // Profile
  'profile:list', 'profile:load', 'profile:get-active-id', 'profile:set-active',
])

// Events pushed from host to remote clients
export const PROXIED_EVENTS = new Set([
  'pty:output', 'pty:exit',
  'claude:message', 'claude:tool-use', 'claude:tool-result',
  'claude:stream', 'claude:result', 'claude:error',
  'claude:status', 'claude:permission-request', 'claude:ask-user',
  'claude:modeChange', 'claude:history', 'claude:prompt-suggestion',
  'workspace:detached', 'workspace:reattached',
  'system:resume',
])
