import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface AgentItem {
  name: string
  description: string
  model?: string
}

interface AgentsPanelProps {
  isVisible: boolean
  activeSessionId: string | null
}

export function AgentsPanel({ isVisible, activeSessionId }: AgentsPanelProps) {
  const { t } = useTranslation()
  const [agents, setAgents] = useState<AgentItem[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const retryRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch agents from SDK — retry until available (queryInstance needs first query)
  useEffect(() => {
    if (retryRef.current) { clearInterval(retryRef.current); retryRef.current = null }
    if (!activeSessionId) {
      setAgents([])
      return
    }

    const fetchAgents = () => {
      window.electronAPI.claude.getSupportedAgents(activeSessionId).then(result => {
        if (result?.length) {
          setAgents(result)
          if (retryRef.current) { clearInterval(retryRef.current); retryRef.current = null }
        }
      }).catch(() => {})
    }

    fetchAgents()
    retryRef.current = setInterval(fetchAgents, 3000)

    return () => {
      if (retryRef.current) { clearInterval(retryRef.current); retryRef.current = null }
    }
  }, [activeSessionId])

  // Listen for broadcast from ClaudeAgentPanel
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { agents: AgentItem[] } | undefined
      if (detail?.agents?.length) {
        setAgents(detail.agents)
        if (retryRef.current) { clearInterval(retryRef.current); retryRef.current = null }
      }
    }
    window.addEventListener('claude-agents-updated', handler)
    return () => window.removeEventListener('claude-agents-updated', handler)
  }, [])

  const filtered = useMemo(() => {
    if (!searchQuery) return agents
    const q = searchQuery.toLowerCase()
    return agents.filter(a => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
  }, [agents, searchQuery])

  if (!isVisible) return null

  return (
    <div className="skills-sidebar">
      <div className="skills-sidebar-search">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder={t('agents.searchAgents')}
        />
      </div>

      <div className="skills-sidebar-body">
        {filtered.length > 0 ? (
          <div className="skills-section">
            <div className="skills-section-list">
              {filtered.map(agent => (
                <div key={agent.name} className="skills-item" title={agent.description}>
                  <span className="skills-item-name">{agent.name}</span>
                  {agent.model && <span className="agents-model-badge">{agent.model}</span>}
                  {agent.description && (
                    <span className="skills-item-desc">{agent.description}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="skills-empty">
            {agents.length === 0
              ? activeSessionId
                ? t('agents.waitingForUpdate')
                : t('agents.noSession')
              : t('agents.noMatchingAgents')}
          </div>
        )}
      </div>
    </div>
  )
}
