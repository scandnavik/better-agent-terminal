import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { MarkdownPreview } from './FileTree'

interface MarkdownPreviewPanelProps {
  filePath: string
  onClose: () => void
}

export function MarkdownPreviewPanel({ filePath, onClose }: MarkdownPreviewPanelProps) {
  const { t } = useTranslation()
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const watchingDir = useRef<string | null>(null)

  const fileName = filePath.split(/[/\\]/).pop() || filePath

  const loadContent = useCallback(() => {
    window.electronAPI.fs.readFile(filePath).then(text => {
      setContent(text)
      setError(null)
    }).catch(err => {
      setError(String(err))
      setContent(null)
    })
  }, [filePath])

  // Load content on mount and when filePath changes
  useEffect(() => {
    loadContent()
  }, [loadContent])

  // Watch for file changes
  useEffect(() => {
    // Get parent directory (JS string manipulation, no path module needed)
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
    const dir = lastSlash > 0 ? filePath.substring(0, lastSlash) : filePath

    window.electronAPI.fs.watch(dir)
    watchingDir.current = dir

    const unsub = window.electronAPI.fs.onChanged((changedDir: string) => {
      if (filePath.startsWith(changedDir)) {
        loadContent()
      }
    })

    return () => {
      if (watchingDir.current) {
        window.electronAPI.fs.unwatch(watchingDir.current)
        watchingDir.current = null
      }
      unsub()
    }
  }, [filePath, loadContent])

  return (
    <div className="md-preview-panel">
      <div className="md-preview-header">
        <span className="md-preview-filename" title={filePath}>{fileName}</span>
        <div className="md-preview-actions">
          <button
            className="md-preview-action-btn"
            onClick={() => navigator.clipboard.writeText(filePath)}
            title={t('sidebar.copyPath')}
          >
            &#x2398;
          </button>
          <button
            className="md-preview-action-btn"
            onClick={() => window.electronAPI.shell.openPath(filePath)}
            title={t('sidebar.openInExplorer')}
          >
            &#x2197;
          </button>
          <button className="md-preview-action-btn" onClick={onClose} title={t('common.close')}>
            &times;
          </button>
        </div>
      </div>
      <div className="md-preview-content">
        {error && <div className="md-preview-error">{error}</div>}
        {content !== null && <MarkdownPreview content={content} />}
      </div>
    </div>
  )
}
