/**
 * Agent 預設配置
 * 定義支援的 AI Agent CLI 工具及其屬性
 */

export interface AgentPreset {
  id: string;
  name: string;
  icon: string;
  color: string;
  command?: string;  // 可選的自動啟動命令
  debug?: boolean;   // 僅在 debug 模式下顯示
}

export type AgentPresetId = 'claude-code' | 'claude-code-v2' | 'claude-code-worktree' | 'claude-cli' | 'claude-cli-worktree' | 'gemini-cli' | 'codex-cli' | 'copilot-cli' | 'none';

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: '✦',
    color: '#d97706',
    command: 'claude --continue'
  },
  {
    id: 'claude-code-v2',
    name: 'Claude Code V2',
    icon: '✦',
    color: '#eab308',
  },
  {
    id: 'claude-code-worktree',
    name: 'Claude Code (Worktree)',
    icon: '🌳',
    color: '#22c55e',
    debug: true,
  },
  {
    id: 'claude-cli',
    name: 'Claude CLI',
    icon: '▶',
    color: '#d97706',
  },
  {
    id: 'claude-cli-worktree',
    name: 'Claude CLI (Worktree)',
    icon: '🌳',
    color: '#22c55e',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI', 
    icon: '◇', 
    color: '#4285f4', 
    command: 'gemini' 
  },
  { 
    id: 'codex-cli', 
    name: 'Codex', 
    icon: '⬡', 
    color: '#10a37f', 
    command: 'codex' 
  },
  { 
    id: 'copilot-cli', 
    name: 'GitHub Copilot', 
    icon: '⬢', 
    color: '#6e40c9', 
    command: 'gh copilot' 
  },
  { 
    id: 'none', 
    name: 'Terminal', 
    icon: '⌘', 
    color: '#888888' 
  },
];

export function getAgentPreset(id: string): AgentPreset | undefined {
  return AGENT_PRESETS.find(p => p.id === id);
}

export function getDefaultAgentPreset(): AgentPreset {
  return AGENT_PRESETS.find(p => p.id === 'claude-code') || AGENT_PRESETS[0];
}

/** Get presets visible in UI, filtering debug-only presets unless BAT_DEBUG is set */
export function getVisiblePresets(): AgentPreset[] {
  const isDebug = typeof window !== 'undefined' && (window as unknown as { electronAPI?: { debug?: { isDebugMode?: boolean } } }).electronAPI?.debug?.isDebugMode
  return AGENT_PRESETS.filter(p => !p.debug || isDebug)
}
