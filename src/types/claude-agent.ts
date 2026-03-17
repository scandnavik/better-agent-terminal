export interface ClaudeMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  thinking?: string
  timestamp: number
}

export interface ClaudeToolCall {
  id: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  status: 'running' | 'completed' | 'error'
  result?: string
  description?: string
  denyReason?: string
  denied?: boolean
  timestamp: number
}

export interface ClaudeSessionState {
  sessionId: string
  messages: (ClaudeMessage | ClaudeToolCall)[]
  isStreaming: boolean
  totalCost?: number
  totalTokens?: number
}

// Discriminator helper
export function isToolCall(item: ClaudeMessage | ClaudeToolCall): item is ClaudeToolCall {
  return 'toolName' in item
}
